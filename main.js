// Modules to control application life and create native browser window
const electron = require("electron");
const process = require("process");
const prompt = require("electron-prompt");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { pathToFileURL, fileURLToPath } = require("url");
const {
    cleanVisibleString,
    firstNonEmptyVisibleString,
    normalizeTikTokImageUrl,
    collectTikTokBadges,
    getBadgeImageUrl
} = require('./tiktok-badges');
const {
    installTikTokSignServerFallback,
    createTikTokEnvironment
} = require('./tiktok/connection-manager');
const {
    LOCAL_STORAGE_SETTING_KEYS,
    readSettingsBackupFile,
    writeSettingsBackupFile
} = require('./settings-backup');
const crypto = require("node:crypto");
const {
    app,
    Menu,
    Tray,
    BrowserWindow,
    BrowserView,
    webFrameMain,
    desktopCapturer,
    ipcMain,
    screen,
    shell,
    globalShortcut,
    session,
    safeStorage,
    dialog,
    clipboard
} = require('electron')
const { exec, spawn } = require('child_process');
const http = require('http');
const contextMenu = require("electron-context-menu");
const Yargs = require("yargs/yargs");
const {
    resolveEarlyDataPaths,
    prepareEarlyDataPaths,
    initializePortableProfile,
    markPortableProfileInitialized
} = require('./resources/portable-data-paths');
const { getTrustedStandaloneCustomJsPageType } = require('./resources/custom-js-page-trust');
const {
    DEFAULT_LOCAL_WEBSOCKET_HOST,
    DEFAULT_LOCAL_WEBSOCKET_PORT,
    LEGACY_LOCAL_WEBSOCKET_PORT,
    LAN_LOCAL_WEBSOCKET_HOST,
    isLoopbackHost,
    normalizeLocalWebSocketHost,
    normalizeLocalWebSocketPort,
    resolveLocalWebSocketConfig
} = require('./resources/local-websocket-config');

let earlyDataPaths = resolveEarlyDataPaths();
let portableMigrationPending = null;
if (earlyDataPaths) {
    try {
        prepareEarlyDataPaths(earlyDataPaths);
        if (earlyDataPaths.mode === 'portable') {
            const legacyOverride = String(process.env.SSAPP_PORTABLE_LEGACY_USER_DATA_DIR || '').trim();
            const legacyUserData = legacyOverride
                ? path.resolve(legacyOverride)
                : path.join(app.getPath('appData'), app.name);
            const migration = initializePortableProfile(earlyDataPaths, {
                legacyUserData,
                choice: process.env.SSAPP_PORTABLE_MIGRATION_CHOICE
            });
            if (migration.action === 'pending') portableMigrationPending = migration;
            console.log(`[SSAPP] Portable profile initialization: ${migration.action}`);
        }
        app.setPath('userData', earlyDataPaths.userData);
        app.setPath('sessionData', earlyDataPaths.sessionData);
        app.setPath('crashDumps', earlyDataPaths.crashes);
        app.setAppLogsPath(earlyDataPaths.logs);
        console.log(`[SSAPP] Using ${earlyDataPaths.mode} data directory: ${earlyDataPaths.dataRoot}`);
    } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        if (earlyDataPaths.mode === 'portable') {
            const message = [
                'Social Stream Ninja cannot write its portable data folder.',
                '',
                `Data folder: ${earlyDataPaths.dataRoot}`,
                `Windows reported: ${detail}`,
                '',
                'Move the portable EXE to a writable folder, close other Social Stream Ninja windows, then try again.'
            ].join('\n');
            console.error('[SSAPP] Portable data directory is not writable:', detail);
            electron.dialog.showErrorBox('Portable data folder unavailable', message);
            process.exit(1);
        }
        console.warn('[SSAPP] Failed to apply SSAPP_USER_DATA_DIR override:', detail);
        earlyDataPaths = null;
    }
}

function spawnPortableMigrationRunner(legacyUserData) {
    const runnerPath = path.join(__dirname, 'resources', 'portable-migration-runner.js');
    const portableExecutablePath = String(process.env.PORTABLE_EXECUTABLE_FILE || '').trim();
    if (!portableExecutablePath || !fs.existsSync(portableExecutablePath)) {
        throw new Error('The original portable executable could not be found for restart.');
    }

    const child = spawn(process.execPath, [runnerPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true
    });
    child.stdin.end(JSON.stringify({
        legacyUserData,
        dataRoot: earlyDataPaths.dataRoot,
        userData: earlyDataPaths.userData,
        parentPid: process.pid,
        execPath: portableExecutablePath,
        appArgs: process.argv.slice(1)
    }));
    child.unref();
}

async function handlePendingPortableMigration() {
    if (!portableMigrationPending || !earlyDataPaths || earlyDataPaths.mode !== 'portable') return false;
    const legacyUserData = portableMigrationPending.legacyUserData;
    const result = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Copy existing data and restart', 'Start fresh'],
        defaultId: 1,
        cancelId: 1,
        title: 'Set up portable data',
        message: 'Existing Social Stream Ninja data was found in Windows AppData.',
        detail: [
            'Copy it into the portable data folder?',
            '',
            'This includes settings, browser sessions, sign-ins, and downloaded models. Disposable caches will start fresh.',
            'The original AppData files will remain unchanged.',
            'Close any other Social Stream Ninja window before copying.',
            '',
            `Existing data: ${legacyUserData}`,
            `Portable data: ${earlyDataPaths.userData}`
        ].join('\n')
    });

    if (result.response !== 0) {
        markPortableProfileInitialized(earlyDataPaths, 'fresh');
        portableMigrationPending = null;
        return false;
    }

    spawnPortableMigrationRunner(legacyUserData);
    markStabilitySessionGraceful('portable-profile-migration');
    app.quit();
    return true;
}

const fetch = require("electron-fetch").default;
const TikTokAuthModule = require('./tiktok-auth');
const TikTokAuth = TikTokAuthModule;
const TIKTOK_AUTH_PARTITION = TikTokAuthModule.AUTH_PARTITION || 'persist:tiktok-auth';
const configureTikTokAuthPartition = typeof TikTokAuthModule.configureAuthPartition === 'function'
    ? TikTokAuthModule.configureAuthPartition
    : () => {};
const clearTikTokAuthSession = typeof TikTokAuthModule.clearTikTokAuthSession === 'function'
    ? TikTokAuthModule.clearTikTokAuthSession
    : async () => {};
let tikTokSignerHelper = null;
try {
    tikTokSignerHelper = require('./tiktok-signing/electron-signer');
} catch (error) {
    console.warn('[TikTok] Signing helper unavailable:', error && error.message ? error.message : error);
}
const { setupWebSocketMonitor } = require('./websocket-monitor');
const {
    attachFramePump,
    installFramePump,
    isFramePumpDisabled,
    isWaylandSession,
    readFramePumpStats
} = require('./hidden-window-keepalive');
const {
    setupSpotifyOAuthWithLocalServer,
    setupSpotifyOAuthWithIntercept
} = require('./resources/electron-spotify-handler');
const { setupYouTubeOAuthHandler, clearYouTubeOwnerAuthStore } = require('./resources/electron-youtube-handler');
const { setupTwitchOAuthHandler } = require('./resources/electron-twitch-handler');
const { setupFacebookOAuthHandler } = require('./resources/electron-facebook-handler');
const { setupVeloraOAuthHandler } = require('./resources/electron-velora-handler');
const { setupKickOAuthHandler } = require('./resources/electron-kick-handler');
const { setupVpzoneOAuthHandler } = require('./resources/electron-vpzone-handler');
const { setupMediaUploadHandler } = require('./resources/electron-media-upload-handler');
const { setupElectronLocalMedia } = require('./resources/electron-local-media-server');
const { createControlApiRouter } = require('./resources/electron-control-api');
const { SourceObservationService } = require('./resources/source-observation-service');
const { AppWindowControlService } = require('./resources/app-window-control-service');
const { AppDialogService } = require('./resources/app-dialog-service');
const { buildMcpLaunchConfig } = require('./resources/mcp-launch-config');
const { KickWsClient } = require('./resources/kick-ws-client');

const SOCIAL_STREAM_REMOTE_HOSTS = new Set([
    'socialstream.ninja',
    'beta.socialstream.ninja',
    'cache.socialstream.ninja'
]);

function getUrlPathForMatch(urlValue) {
    const raw = String(urlValue || '');
    if (!raw) return '';
    try {
        return new URL(raw).pathname.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    } catch (_) {
        return raw.split(/[?#]/)[0].replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }
}

function matchesSocialStreamPagePath(urlValue, pagePath) {
    const pathName = getUrlPathForMatch(urlValue);
    const normalized = String(pagePath || '').replace(/^\/+/, '').replace(/\.html$/i, '').toLowerCase();
    if (!pathName || !normalized) return false;
    return pathName.endsWith(`/${normalized}`) || pathName.endsWith(`/${normalized}.html`) || pathName === normalized || pathName === `${normalized}.html`;
}

function isSocialStreamRemoteUrl(urlValue) {
    try {
        return SOCIAL_STREAM_REMOTE_HOSTS.has(new URL(String(urlValue || '')).hostname.toLowerCase());
    } catch (_) {
        return false;
    }
}

const {
    fetch: undiciFetch
} = require('undici');
const isMac = process.platform === "darwin";
const WebSocket = require('ws');
const { Worker } = require('worker_threads');


const Store = require("electron-store");
const store = new Store();
const localWebSocketConfig = resolveLocalWebSocketConfig({
    argv: process.argv,
    env: process.env,
    storedPort: store.get('localWebSocket.port'),
    storedHost: store.get('localWebSocket.host')
});
if (localWebSocketConfig.invalidSources.length) {
    console.warn(`[Local WebSocket] Ignored invalid configuration from: ${localWebSocketConfig.invalidSources.join(', ')}`);
}
if (!isLoopbackHost(localWebSocketConfig.host)) {
    console.warn(`[Local WebSocket] LAN access enabled on ${localWebSocketConfig.host}; traffic is not authenticated or encrypted.`);
}
let localMediaService = null;
const reporter = require('./error-reporter');
reporter.init(store);
const POPUP_UNCLICKABLE_ALL_KEY = 'popupUnclickableAll';
const CUSTOM_JS_FILE_STORE_KEY = 'customJsFile';
const CUSTOM_JS_MAX_BYTES = 1024 * 1024;
let popupUnclickableEnabled = false;
try {
    popupUnclickableEnabled = store.get(POPUP_UNCLICKABLE_ALL_KEY) === true;
} catch (_) { }

function parseBooleanLikeFlag(value) {
    if (typeof value === 'boolean') return value;
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim().toLowerCase();
    if (!normalized) return null;
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return null;
}

function parseWindowsBuildNumber() {
    if (process.platform !== 'win32') return 0;
    try {
        const release = os.release();
        const parts = String(release || '').split('.');
        if (parts.length < 3) return 0;
        const build = Number.parseInt(parts[2], 10);
        return Number.isFinite(build) ? build : 0;
    } catch (_) {
        return 0;
    }
}

function normalizeMacPerformanceModeCandidate(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'aggressive') return 'aggressive';
    if (normalized === 'balanced') return 'balanced';
    return '';
}

function readStartupFlagsSnapshot() {
    try {
        const raw = store.get('startupFlags');
        if (raw && typeof raw === 'object') {
            return raw;
        }
    } catch (_) { }
    return {};
}

const WINDOWS_BUILD_NUMBER = parseWindowsBuildNumber();
const IS_WINDOWS_11 = process.platform === 'win32' && WINDOWS_BUILD_NUMBER >= 22000;
const IS_WINDOWS_10 = process.platform === 'win32' && WINDOWS_BUILD_NUMBER > 0 && WINDOWS_BUILD_NUMBER < 22000;
const startupFlagsSnapshot = readStartupFlagsSnapshot();
const WINDOW_STATE_DIAGNOSTICS_ENABLED = process.argv.includes('--window-state-diagnostics');
const WINDOW_STATE_DIAGNOSTICS_REPORT_PATH = (() => {
    const arg = process.argv.find((value) => typeof value === 'string' && value.startsWith('--window-state-report='));
    if (!arg) return null;
    return arg.slice('--window-state-report='.length);
})();
const HIDDEN_CAPTURE_DIAGNOSTICS_ENABLED = process.argv.includes('--hidden-capture-diagnostics');
const HIDDEN_CAPTURE_SOAK_ENABLED = process.argv.includes('--hidden-capture-soak');
const HIDDEN_CAPTURE_DIAGNOSTICS_REPORT_PATH = (() => {
    const arg = process.argv.find((value) => typeof value === 'string' && value.startsWith('--hidden-capture-report='));
    if (!arg) return null;
    return arg.slice('--hidden-capture-report='.length);
})();
// Set when createWindow registers the source-window IPC handler, so diagnostics can build
// a source window through the same path the renderer uses.
let sourceWindowCreateHandler = null;
const TTS_DIAGNOSTICS_ENABLED = process.argv.includes('--tts-diagnostics');
const TTS_DIAGNOSTICS_REPORT_PATH = (() => {
    const arg = process.argv.find((value) => typeof value === 'string' && value.startsWith('--tts-report='));
    if (!arg) return null;
    return arg.slice('--tts-report='.length);
})();
const DIAGNOSTICS_SAFE_GPU =
    TTS_DIAGNOSTICS_ENABLED ||
    parseBooleanLikeFlag(process.env.SSAPP_TTS_DIAGNOSTICS_SAFE_GPU) === true ||
    parseBooleanLikeFlag(process.env.SSAPP_DIAGNOSTICS_SAFE_GPU) === true;

const win10TransparencyCompatRequested = (() => {
    const envFlag = parseBooleanLikeFlag(process.env.SSAPP_WIN10_TRANSPARENCY_COMPAT);
    if (envFlag !== null) return envFlag;
    if (typeof startupFlagsSnapshot.win10TransparencyCompat === 'boolean') {
        return startupFlagsSnapshot.win10TransparencyCompat;
    }
    return IS_WINDOWS_10;
})();

const WIN10_TRANSPARENCY_COMPAT_ENABLED = IS_WINDOWS_10 && win10TransparencyCompatRequested;
const APPLY_WIN_FRAMELESS_WORKAROUND = process.platform === 'win32' && !WIN10_TRANSPARENCY_COMPAT_ENABLED;

const MAC_PERFORMANCE_MODE = (() => {
    const envValue = normalizeMacPerformanceModeCandidate(
        process.env.SSAPP_MAC_PERFORMANCE_MODE || process.env.SSAPP_MAC_PERF_MODE
    );
    if (envValue) return envValue;
    const storedValue = normalizeMacPerformanceModeCandidate(startupFlagsSnapshot.macPerformanceMode);
    if (storedValue) return storedValue;
    return isMac ? 'balanced' : 'aggressive';
})();

const IS_MAC_BALANCED_MODE = isMac && MAC_PERFORMANCE_MODE === 'balanced';

process.env.SSAPP_WIN10_TRANSPARENCY_COMPAT_EFFECTIVE = WIN10_TRANSPARENCY_COMPAT_ENABLED ? '1' : '0';
process.env.SSAPP_MAC_PERFORMANCE_MODE_EFFECTIVE = MAC_PERFORMANCE_MODE;
if (process.platform === 'win32' && WINDOWS_BUILD_NUMBER) {
    process.env.SSAPP_WINDOWS_BUILD = String(WINDOWS_BUILD_NUMBER);
}

const STABILITY_RUNTIME_STORE_KEY = 'stabilityRuntime';
const STABILITY_CRASH_WINDOW_MS = 15 * 60 * 1000;
const STABILITY_REVERT_UPTIME_MS = 45 * 60 * 1000;
const STABILITY_GPU_RASTERIZATION_FALLBACK_LEVEL = 3;
const STABILITY_GPU_SANDBOX_FALLBACK_LEVEL = 4;
const STABILITY_MAX_GPU_FALLBACK_LEVEL = STABILITY_GPU_SANDBOX_FALLBACK_LEVEL;
const STABILITY_GPU_PROFILE_LABELS = {
    0: 'Default GPU profile',
    1: 'Stability profile L1 (WebGPU disabled)',
    2: 'Stability profile L2 (blocklist respected)',
    3: 'Stability profile L3 (rasterization relaxed)',
    4: 'Stability profile L4 (GPU sandbox relaxed)'
};
const STABILITY_CRASH_REASONS = new Set(['abnormal-exit', 'crashed', 'oom', 'launch-failed', 'integrity-failure']);

let stabilityCrashSignalSeenThisSession = false;
let stabilityGracefulExitMarked = false;
let stabilityPendingStartupNotice = null;

function getDefaultStabilityRuntimeState() {
    return {
        sessionActive: false,
        sessionStartAt: 0,
        lastExitAt: 0,
        lastExitReason: 'unknown',
        lastCrashReason: null,
        lastCrashSignalAt: 0,
        crashEvents: [],
        gpuFallbackLevel: 0,
        lastFallbackChangeAt: 0,
        pendingNotice: null
    };
}

function clampGpuFallbackLevel(value) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(STABILITY_MAX_GPU_FALLBACK_LEVEL, Math.max(0, numeric));
}

function loadStabilityRuntimeState() {
    const defaults = getDefaultStabilityRuntimeState();
    try {
        const raw = store.get(STABILITY_RUNTIME_STORE_KEY);
        const merged = {
            ...defaults,
            ...(raw && typeof raw === 'object' ? raw : {})
        };
        const rawEvents = Array.isArray(merged.crashEvents) ? merged.crashEvents : [];
        merged.crashEvents = rawEvents
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value > 0);
        merged.gpuFallbackLevel = clampGpuFallbackLevel(merged.gpuFallbackLevel);
        return merged;
    } catch (_) {
        return defaults;
    }
}

function saveStabilityRuntimeState(state) {
    const defaults = getDefaultStabilityRuntimeState();
    const next = {
        ...defaults,
        ...(state && typeof state === 'object' ? state : {})
    };
    next.gpuFallbackLevel = clampGpuFallbackLevel(next.gpuFallbackLevel);
    next.crashEvents = (Array.isArray(next.crashEvents) ? next.crashEvents : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0);
    try {
        store.set(STABILITY_RUNTIME_STORE_KEY, next);
    } catch (error) {
        console.warn('[Stability] Failed to persist runtime state:', error && error.message ? error.message : error);
    }
    return next;
}

function pruneCrashEvents(events, now = Date.now()) {
    return (Array.isArray(events) ? events : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0 && (now - value) <= STABILITY_CRASH_WINDOW_MS);
}

function isStabilityCrashReason(reason) {
    const normalized = String(reason || '').trim().toLowerCase();
    if (!normalized) return false;
    return STABILITY_CRASH_REASONS.has(normalized);
}

function isGpuChildProcessCrashReason(reason) {
    return String(reason || '').trim().toLowerCase() === 'child-process-gone:gpu:crashed';
}

function isStabilityGracefulExitReason(reason) {
    const normalized = String(reason || '').trim().toLowerCase();
    if (!normalized || normalized === 'unknown') return false;
    if (normalized.includes('crash') || normalized.includes('unclean')) return false;
    return true;
}

// Linux is included alongside Windows because these are the mitigations that matter for the
// GPU crashes Linux actually hits: the app forces --ignore-gpu-blocklist and
// --enable-gpu-rasterization by default, and on a blocklisted or flaky driver those are what
// keeps crashing. Without this the escalation ladder changed nothing on Linux - the app would
// count the crashes, tell the user "Stability mode enabled automatically", and apply exactly
// the same flags as before. These only take effect after repeated crashes, so the downside is
// limited to sessions that are already failing.
//
// macOS is left out: it has its own balanced-mode handling and a different GPU stack. The
// sandbox rung below stays Windows-only on purpose - relaxing the GPU sandbox is a security
// trade-off, not just a stability knob, so it is not something to start doing on Linux as a
// side effect of crash recovery.
const STABILITY_GPU_FALLBACK_PLATFORMS = new Set(['win32', 'linux']);

function buildGpuProfileFromFallbackLevel(level) {
    const normalizedLevel = clampGpuFallbackLevel(level);
    const laddered = STABILITY_GPU_FALLBACK_PLATFORMS.has(process.platform);
    return {
        level: normalizedLevel,
        disableUnsafeWebGpu: laddered && normalizedLevel >= 1,
        disableIgnoreGpuBlocklist: laddered && normalizedLevel >= 2,
        disableGpuRasterization: laddered && normalizedLevel >= STABILITY_GPU_RASTERIZATION_FALLBACK_LEVEL,
        disableGpuSandbox: process.platform === 'win32' && normalizedLevel >= STABILITY_GPU_SANDBOX_FALLBACK_LEVEL
    };
}

function initializeStabilityRuntimeForStartup() {
    const now = Date.now();
    const state = loadStabilityRuntimeState();
    const previousSessionActive = state.sessionActive === true;
    const previousSessionStartAt = Number(state.sessionStartAt) || 0;
    const previousExitAt = Number(state.lastExitAt) || 0;
    const previousExitReason = typeof state.lastExitReason === 'string' ? state.lastExitReason : 'unknown';
    const previousRunDuration = (previousExitAt >= previousSessionStartAt && previousSessionStartAt > 0)
        ? (previousExitAt - previousSessionStartAt)
        : 0;

    let crashEvents = pruneCrashEvents(state.crashEvents, now);
    let level = clampGpuFallbackLevel(state.gpuFallbackLevel);
    let latestCrashReason = null;
    const notices = [];

    if (DIAGNOSTICS_SAFE_GPU && level < STABILITY_GPU_SANDBOX_FALLBACK_LEVEL) {
        level = STABILITY_GPU_SANDBOX_FALLBACK_LEVEL;
        state.lastFallbackChangeAt = now;
        notices.push('[Stability] Diagnostics forcing stability GPU profile L4.');
    }

    if (previousSessionActive) {
        const inferredCrashAt = Number(state.lastCrashSignalAt) > 0
            ? Number(state.lastCrashSignalAt)
            : (previousSessionStartAt || now);
        crashEvents.push(inferredCrashAt);
        const crashReason = state.lastCrashReason || 'unclean-exit';
        latestCrashReason = crashReason;
        state.lastExitReason = crashReason;
        state.lastExitAt = inferredCrashAt;
        notices.push(`[Stability] Unclean exit detected (${crashReason}).`);
    } else if (isStabilityGracefulExitReason(previousExitReason) && level > 0 && previousRunDuration >= STABILITY_REVERT_UPTIME_MS) {
        level -= 1;
        notices.push(`[Stability] Stable session detected; reducing fallback to level ${level}.`);
        state.lastFallbackChangeAt = now;
        state.pendingNotice = {
            level,
            type: 'revert',
            message: `Stability mode eased automatically. ${STABILITY_GPU_PROFILE_LABELS[level] || `GPU fallback level ${level}`}.`
        };
    }

    crashEvents = pruneCrashEvents(crashEvents, now);
    const canEscalateStandardGpuFallback = level < STABILITY_GPU_RASTERIZATION_FALLBACK_LEVEL;
    const canEscalateGpuSandboxFallback = level === STABILITY_GPU_RASTERIZATION_FALLBACK_LEVEL && isGpuChildProcessCrashReason(latestCrashReason);
    if (crashEvents.length >= 2 && (canEscalateStandardGpuFallback || canEscalateGpuSandboxFallback)) {
        level += 1;
        state.lastFallbackChangeAt = now;
        state.pendingNotice = {
            level,
            type: 'escalate',
            message: `Stability mode enabled automatically. ${STABILITY_GPU_PROFILE_LABELS[level] || `GPU fallback level ${level}`}.`
        };
        notices.push(`[Stability] Crash loop detected; escalating fallback to level ${level}.`);
        crashEvents = [now];
    }

    state.gpuFallbackLevel = level;
    state.crashEvents = crashEvents;
    state.sessionActive = true;
    state.sessionStartAt = now;
    state.lastCrashReason = null;
    state.lastCrashSignalAt = 0;
    if (!state.lastExitReason) {
        state.lastExitReason = 'unknown';
    }

    const persisted = saveStabilityRuntimeState(state);
    notices.forEach((line) => console.warn(line));
    return persisted;
}

function consumePendingStabilityNotice() {
    const state = loadStabilityRuntimeState();
    const notice = state.pendingNotice && typeof state.pendingNotice === 'object' ? state.pendingNotice : null;
    if (notice) {
        state.pendingNotice = null;
        saveStabilityRuntimeState(state);
    }
    return notice;
}

function recordStabilityCrashSignal(reason, details = null) {
    try {
        const state = loadStabilityRuntimeState();
        state.lastCrashReason = reason || 'runtime-crash-signal';
        state.lastCrashSignalAt = Date.now();
        saveStabilityRuntimeState(state);
        stabilityCrashSignalSeenThisSession = true;
        const payload = details && typeof details === 'object' ? details : { detail: details };
        console.error('[Stability] Crash signal observed:', state.lastCrashReason, payload);
    } catch (error) {
        console.error('[Stability] Failed to record crash signal:', error && error.message ? error.message : error);
    }
}

function markStabilitySessionGraceful(reason = 'graceful_quit', options = {}) {
    if (stabilityGracefulExitMarked) return;
    if (stabilityCrashSignalSeenThisSession && !options.force) {
        console.warn('[Stability] Skipping graceful marker due to prior crash signal.');
        return;
    }
    const now = Date.now();
    const state = loadStabilityRuntimeState();
    state.sessionActive = false;
    state.lastExitAt = now;
    state.lastExitReason = reason || 'graceful_quit';
    state.lastCrashReason = null;
    state.lastCrashSignalAt = 0;
    saveStabilityRuntimeState(state);
    stabilityGracefulExitMarked = true;
}

const stabilityRuntimeStateAtLaunch = initializeStabilityRuntimeForStartup();
const stabilityGpuProfile = buildGpuProfileFromFallbackLevel(stabilityRuntimeStateAtLaunch.gpuFallbackLevel);
stabilityPendingStartupNotice = consumePendingStabilityNotice();
if (process.platform === 'win32') {
    const profileLabel = STABILITY_GPU_PROFILE_LABELS[stabilityGpuProfile.level] || `GPU fallback level ${stabilityGpuProfile.level}`;
    if (stabilityGpuProfile.level > 0) {
        console.warn(`[Stability] ${profileLabel} is active for this launch.`);
    } else {
        console.log(`[Stability] ${profileLabel} is active for this launch.`);
    }
}

function queueStabilityStartupNotice() {
    if (!stabilityPendingStartupNotice || typeof stabilityPendingStartupNotice !== 'object') {
        return;
    }
    const notice = stabilityPendingStartupNotice;
    stabilityPendingStartupNotice = null;

    const level = notice.type === 'escalate' ? 'warning' : 'info';
    const label = STABILITY_GPU_PROFILE_LABELS[clampGpuFallbackLevel(notice.level)];
    const message = typeof notice.message === 'string' && notice.message.trim()
        ? notice.message
        : `Automatic stability adjustment applied. ${label || 'GPU profile updated.'}`;
    queueInjectorToast(level, 'Stability Mode', message);
}

function shouldUseWin10TransparencyCompat(frame, transparent) {
    return WIN10_TRANSPARENCY_COMPAT_ENABLED && frame === false && transparent === true;
}

function getUrlSearchParams(url) {
    if (!url || typeof url !== "string") return null;
    try {
        return new URL(url).searchParams;
    } catch (_) {
        try {
            return new URL(url, "https://socialstream.local/").searchParams;
        } catch (_) {
            return null;
        }
    }
}

function hasUrlSearchParam(url, key) {
    const params = getUrlSearchParams(url);
    if (params) return params.has(key);
    return url.includes(`?${key}`) || url.includes(`&${key}`);
}

function getUrlSearchParamValue(url, key) {
    const params = getUrlSearchParams(url);
    if (params) return params.get(key);

    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(url || "").match(new RegExp(`[?&]${escapedKey}=([^&#]*)`));
    if (!match) return null;

    try {
        return decodeURIComponent(match[1].replace(/\+/g, " "));
    } catch (_) {
        return match[1];
    }
}

function isTranslucentChromaValue(value) {
    if (value === null || value === undefined) return false;
    const normalized = String(value).trim().replace(/^#/, "");

    if (/^0{3}[0-9a-f]$/i.test(normalized)) {
        return parseInt(normalized.slice(-1), 16) < 15;
    }
    if (/^0{6}[0-9a-f]{2}$/i.test(normalized)) {
        return parseInt(normalized.slice(-2), 16) < 255;
    }

    return false;
}

function shouldUseFramelessForUrl(url) {
    return (
        hasUrlSearchParam(url, "transparent") ||
        hasUrlSearchParam(url, "transparency") ||
        hasUrlSearchParam(url, "chroma")
    );
}

function shouldUseTransparentWindowForUrl(url) {
    return (
        hasUrlSearchParam(url, "transparent") ||
        hasUrlSearchParam(url, "transparency") ||
        isTranslucentChromaValue(getUrlSearchParamValue(url, "chroma"))
    );
}

function applyPlatformWindowCompatibility(config) {
    if (!config || typeof config !== 'object') return config;
    if (shouldUseWin10TransparencyCompat(config.frame, config.transparent)) {
        config.resizable = false;
    }
    return config;
}

function shouldDisableBackgroundThrottlingForGeneralWindows() {
    if (IS_MAC_BALANCED_MODE) {
        return false;
    }
    return true;
}

const TRANSFER_BACKUP_STORE_KEY = 'transferBackup';
const DEFAULT_TRANSFER_BACKUP_CONFIG = {
    enabled: false,
    folderPath: null,
    fileName: 'ssapp-transfer-backup.ssappbk',
    includeCaches: false,
    idleGateMs: 5 * 60 * 1000,
    minIntervalMs: 60 * 60 * 1000,
    lastSuccessAt: 0,
    lastAttemptAt: 0,
    lastError: null,
    password: {
        method: null,
        encrypted: null
    }
};

const transferBackupRuntime = {
    sourcesActive: false,
    lastBecameInactiveAt: Date.now(),
    idleGateTimer: null,
    periodicTimer: null,
    inProgress: false,
    currentProgressId: null
};

const TRANSFER_BACKUP_NOTIFICATION_ICON = path.join(__dirname, "assets", "icons", "png", "256x256.png");

function setTransferBackupProgressIndicator(progress) {
    try {
        if (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.setProgressBar === 'function') {
            if (progress === true) {
                mainWindow.setProgressBar(-1);
                return;
            }
            if (progress === false || progress == null) {
                mainWindow.setProgressBar(0);
                return;
            }
            if (typeof progress === 'number' && Number.isFinite(progress)) {
                const clamped = Math.max(0, Math.min(1, progress));
                mainWindow.setProgressBar(clamped <= 0 ? 0.0001 : clamped);
            }
        }
    } catch (_) { }
}

function setTransferBackupUiBusy(active) {
    transferBackupRuntime.inProgress = !!active;
    setTransferBackupProgressIndicator(active);
    try {
        createMenu();
    } catch (_) { }
}

function showTransferBackupToast(level, title, message) {
    try {
        queueInjectorToast(level, title, message);
    } catch (_) { }
}

// Desktop notifications on Linux are delivered over D-Bus to whatever implements
// org.freedesktop.Notifications. When a session bus exists but nothing implements that
// service - a headless server, a bare window manager, some Wayland sessions - Electron's
// Notification.show() blocks the main process until D-Bus gives up. Measured on Electron 43
// with no notification daemon: the failed event arrived after 100 seconds and show() did not
// return for 120, with Notification.isSupported() reporting true the whole time. A frozen
// main process means no chat processing, no IPC and no control API for two minutes, and it is
// reachable without any user action, from automatic session-transfer backups and from the
// on-battery power event.
//
// So: check once whether anything is listening, stop trying after a failure, and never
// bother in headless control mode where there is no desktop to notify.
let desktopNotificationSupport = 'unknown'; // 'unknown' | 'available' | 'unavailable'

function probeDesktopNotificationSupport() {
    if (process.platform !== 'linux' || desktopNotificationSupport !== 'unknown') return;
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
        desktopNotificationSupport = 'unavailable';
        return;
    }

    const attempts = [
        ['gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus',
            '--object-path', '/org/freedesktop/DBus',
            '--method', 'org.freedesktop.DBus.GetNameOwner', 'org.freedesktop.Notifications']],
        ['dbus-send', ['--session', '--print-reply', '--reply-timeout=2000',
            '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus.GetNameOwner', 'string:org.freedesktop.Notifications']]
    ];

    const tryNext = (index) => {
        if (index >= attempts.length) {
            // Nothing could confirm a notification service. Treat that as unavailable rather
            // than finding out the expensive way: the cost of being wrong here is no desktop
            // notifications, while the cost of guessing wrong the other way is a two minute
            // freeze of the whole app. A machine with neither gdbus nor dbus-send almost
            // certainly has no notification daemon either.
            desktopNotificationSupport = 'unavailable';
            console.warn('[Notifications] Could not confirm a notification service; notifications disabled.');
            return;
        }
        const [command, args] = attempts[index];
        let child;
        try {
            child = require('child_process').spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (_) {
            tryNext(index + 1);
            return;
        }
        let stderr = '';
        try { child.stderr.on('data', (chunk) => { stderr += String(chunk); }); } catch (_) { }
        const timer = setTimeout(() => { try { child.kill(); } catch (_) { } }, 4000);
        child.on('error', () => { clearTimeout(timer); tryNext(index + 1); });
        child.on('exit', (code) => {
            clearTimeout(timer);
            if (code === 0 && !/NameHasNoOwner/i.test(stderr)) {
                desktopNotificationSupport = 'available';
            } else if (/NameHasNoOwner|no such name/i.test(stderr) || code === 1) {
                desktopNotificationSupport = 'unavailable';
                console.warn('[Notifications] No desktop notification service on this session; notifications disabled.');
            } else {
                tryNext(index + 1);
            }
        });
    };

    tryNext(0);
}

function showDesktopNotification(options) {
    try {
        if (headlessControlEnabled) return;
        if (desktopNotificationSupport === 'unavailable') return;
        if (electron.Notification && typeof electron.Notification.isSupported === 'function' && !electron.Notification.isSupported()) {
            return;
        }
        const notification = new electron.Notification(options);
        notification.on('failed', () => {
            if (desktopNotificationSupport !== 'unavailable') {
                desktopNotificationSupport = 'unavailable';
                console.warn('[Notifications] Desktop notification failed; not trying again this session.');
            }
        });
        notification.show();
    } catch (_) { }
}

probeDesktopNotificationSupport();

function showTransferBackupNotification(title, body) {
    showDesktopNotification({
        title: String(title || 'Full Session Transfer'),
        body: String(body || ''),
        icon: TRANSFER_BACKUP_NOTIFICATION_ICON
    });
}

function getTransferBackupConfig() {
    const raw = store.get(TRANSFER_BACKUP_STORE_KEY, {});
    const merged = {
        ...DEFAULT_TRANSFER_BACKUP_CONFIG,
        ...(raw && typeof raw === 'object' ? raw : {})
    };
    merged.password = {
        ...DEFAULT_TRANSFER_BACKUP_CONFIG.password,
        ...(merged.password && typeof merged.password === 'object' ? merged.password : {})
    };
    return merged;
}

function setTransferBackupConfig(patch) {
    const current = getTransferBackupConfig();
    const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
    if (patch && typeof patch.password === 'object') {
        next.password = { ...current.password, ...patch.password };
    }
    store.set(TRANSFER_BACKUP_STORE_KEY, next);
    return next;
}

function canStoreTransferBackupPassword() {
    try {
        return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
    } catch (_) {
        return false;
    }
}

function encryptTransferBackupPassword(password) {
    if (!canStoreTransferBackupPassword()) {
        return null;
    }
    const encrypted = safeStorage.encryptString(String(password));
    return encrypted.toString('base64');
}

function decryptTransferBackupPassword(config) {
    const passwordConfig = config && typeof config === 'object' ? config.password : null;
    if (!passwordConfig || passwordConfig.method !== 'safeStorage' || !passwordConfig.encrypted) {
        return null;
    }
    if (!canStoreTransferBackupPassword()) {
        return null;
    }
    try {
        return safeStorage.decryptString(Buffer.from(passwordConfig.encrypted, 'base64'));
    } catch (error) {
        console.warn('[TransferBackup] Failed to decrypt stored password:', error && error.message ? error.message : error);
        return null;
    }
}

function buildTransferBackupFilePath(config) {
    const folderPath = config && typeof config.folderPath === 'string' ? config.folderPath.trim() : '';
    if (!folderPath) return null;
    const fileName = (config && typeof config.fileName === 'string' && config.fileName.trim())
        ? config.fileName.trim()
        : DEFAULT_TRANSFER_BACKUP_CONFIG.fileName;
    return path.join(folderPath, fileName);
}

function getDefaultSettingsBackupFileName() {
    const date = new Date().toISOString().slice(0, 10);
    return `social-stream-settings-${date}.data`;
}

function getSettingsObjectKeyCount(settings) {
    return settings && typeof settings === 'object' && !Array.isArray(settings)
        ? Object.keys(settings).length
        : 0;
}

async function flushPendingStorageSaveForSettingsBackup() {
    try {
        if (typeof global.flushPendingStorageSave === 'function') {
            global.flushPendingStorageSave();
        }
    } catch (error) {
        console.warn('[SettingsBackup] Failed to flush pending settings save:', error?.message || error);
    }
}

async function collectMainWindowSettingsLocalStorage() {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
        return {};
    }

    const script = `(function(){\n` +
        `const keys = ${JSON.stringify(LOCAL_STORAGE_SETTING_KEYS)};\n` +
        `const out = {};\n` +
        `keys.forEach((key) => {\n` +
        `  try {\n` +
        `    const value = localStorage.getItem(key);\n` +
        `    if (value !== null) out[key] = value;\n` +
        `  } catch (e) {}\n` +
        `});\n` +
        `return out;\n` +
        `})();`;

    try {
        const result = await mainWindow.webContents.executeJavaScript(script, true);
        return result && typeof result === 'object' ? result : {};
    } catch (error) {
        console.warn('[SettingsBackup] Failed to read app localStorage settings:', error?.message || error);
        return {};
    }
}

async function applyImportedSettingsLocalStorage(localStorageData) {
    if (!localStorageData || typeof localStorageData !== 'object' || !Object.keys(localStorageData).length) {
        return 0;
    }
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
        return 0;
    }

    const entries = {};
    for (const key of LOCAL_STORAGE_SETTING_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(localStorageData, key)) continue;
        const value = localStorageData[key];
        if (value === null || value === undefined) continue;
        entries[key] = String(value);
    }

    const script = `(function(){\n` +
        `const entries = ${JSON.stringify(entries)};\n` +
        `let restored = 0;\n` +
        `Object.keys(entries).forEach((key) => {\n` +
        `  try {\n` +
        `    localStorage.setItem(key, String(entries[key]));\n` +
        `    restored++;\n` +
        `  } catch (e) {}\n` +
        `});\n` +
        `return restored;\n` +
        `})();`;

    try {
        const restored = await mainWindow.webContents.executeJavaScript(script, true);
        return Number.isFinite(restored) ? restored : 0;
    } catch (error) {
        console.warn('[SettingsBackup] Failed to restore app localStorage settings:', error?.message || error);
        return 0;
    }
}

function applyImportedCachedSettings(importedState) {
    if (!importedState || typeof importedState !== 'object') {
        return { saved: false, settingsCount: 0 };
    }

    const next = { ...(cachedState && typeof cachedState === 'object' ? cachedState : {}) };

    if (Object.prototype.hasOwnProperty.call(importedState, 'streamID')) {
        const normalizedStreamID = normalizeStreamIdValue(importedState.streamID);
        if (normalizedStreamID !== null) {
            next.streamID = normalizedStreamID;
        }
    }

    if (Object.prototype.hasOwnProperty.call(importedState, 'password')) {
        const normalizedPassword = normalizePasswordValue(importedState.password);
        if (normalizedPassword !== null) {
            next.password = normalizedPassword;
        } else {
            delete next.password;
        }
    }

    if (Object.prototype.hasOwnProperty.call(importedState, 'state')) {
        if (typeof importedState.state === 'boolean') {
            next.state = importedState.state;
        } else if (typeof importedState.state === 'string') {
            const normalizedState = importedState.state.trim().toLowerCase();
            if (normalizedState === 'true') next.state = true;
            if (normalizedState === 'false') next.state = false;
        }
    }

    if (importedState.settings && typeof importedState.settings === 'object' && !Array.isArray(importedState.settings)) {
        next.settings = importedState.settings;
    }

    cachedState = normalizeCachedStateSnapshot(next);

    const persistResult = persistCachedStateSafely(cachedState, {
        reason: 'settings-import',
        allowSettingsDowngrade: true
    });

    const payload = buildLocalStorageMirrorPayload(cachedState);
    updateLocalStorageBackup(payload, { allowSettingsDowngrade: true });

    return {
        saved: !!(persistResult && persistResult.saved),
        settingsCount: getSettingsObjectKeyCount(cachedState.settings)
    };
}

async function exportSettingsBackupWithDialog() {
    try {
        await flushPendingStorageSaveForSettingsBackup();
        await recoverCachedStateIfNeeded('settings-export');

        const localStorageData = await collectMainWindowSettingsLocalStorage();
        const defaultPath = path.join(app.getPath('documents'), getDefaultSettingsBackupFileName());
        const picked = await dialog.showSaveDialog({
            title: 'Export Settings',
            defaultPath,
            filters: [
                { name: 'Social Stream Settings', extensions: ['data', 'json'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        if (picked.canceled || !picked.filePath) return null;

        rememberDialogApprovedPath(picked.filePath);
        const payload = writeSettingsBackupFile(picked.filePath, cachedState, localStorageData);
        const settingsCount = getSettingsObjectKeyCount(payload.settings);
        const sourceListIncluded = !!(payload.localStorage && payload.localStorage.socialStreamState);

        showTransferBackupToast(
            'success',
            'Settings Exported',
            `${path.basename(picked.filePath)} (${settingsCount} settings${sourceListIncluded ? ', source list included' : ''})`
        );

        await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            title: 'Settings Exported',
            message: `Saved:\n${picked.filePath}`,
            detail: `${settingsCount} Social Stream setting key${settingsCount === 1 ? '' : 's'} exported.${sourceListIncluded ? '\nApp source list settings were included.' : ''}`
        });

        return { filePath: picked.filePath, settingsCount, sourceListIncluded };
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        showTransferBackupToast('error', 'Settings Export Failed', message);
        await dialog.showMessageBox({
            type: 'error',
            buttons: ['OK'],
            title: 'Settings Export Failed',
            message
        });
        return null;
    }
}

async function importSettingsBackupWithDialog() {
    try {
        const picked = await dialog.showOpenDialog({
            title: 'Import Settings',
            properties: ['openFile'],
            filters: [
                { name: 'Social Stream Settings', extensions: ['data', 'json'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) return null;

        const filePath = picked.filePaths[0];
        rememberDialogApprovedPath(filePath);

        const imported = readSettingsBackupFile(filePath);
        const incomingSettingsCount = getSettingsObjectKeyCount(imported.cachedState.settings);
        const incomingLocalStorageCount = Object.keys(imported.localStorage || {}).length;

        const confirmResult = await dialog.showMessageBox({
            type: 'question',
            buttons: ['Import and Reload', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
            title: 'Import Settings',
            message: `Import settings from:\n${filePath}`,
            detail: `${incomingSettingsCount} Social Stream setting key${incomingSettingsCount === 1 ? '' : 's'} found.${incomingLocalStorageCount ? `\n${incomingLocalStorageCount} app setting key${incomingLocalStorageCount === 1 ? '' : 's'} found.` : ''}\n\nThe main app window will reload after import.`
        });
        if (confirmResult.response !== 0) return null;

        const cachedStateResult = applyImportedCachedSettings(imported.cachedState);
        const restoredLocalStorageCount = await applyImportedSettingsLocalStorage(imported.localStorage);

        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                await mirrorCachedStateToLocalStorage(mainWindow);
            } catch (_) { }
            mainWindow.webContents.reload();
        }

        showTransferBackupToast(
            'success',
            'Settings Imported',
            `${cachedStateResult.settingsCount} settings restored${restoredLocalStorageCount ? `, ${restoredLocalStorageCount} app keys restored` : ''}.`
        );

        await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            title: 'Settings Imported',
            message: 'Settings were imported and the app window is reloading.',
            detail: `${cachedStateResult.settingsCount} Social Stream setting key${cachedStateResult.settingsCount === 1 ? '' : 's'} restored.${restoredLocalStorageCount ? `\n${restoredLocalStorageCount} app setting key${restoredLocalStorageCount === 1 ? '' : 's'} restored.` : ''}`
        });

        return {
            filePath,
            settingsCount: cachedStateResult.settingsCount,
            restoredLocalStorageCount
        };
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        showTransferBackupToast('error', 'Settings Import Failed', message);
        await dialog.showMessageBox({
            type: 'error',
            buttons: ['OK'],
            title: 'Settings Import Failed',
            message
        });
        return null;
    }
}

async function flushAllSessionStorageData() {
    const sessionsToFlush = new Set();
    try {
        sessionsToFlush.add(session.defaultSession);
    } catch (_) { }

    const knownPartitions = new Set([
        'persist:abc',
        'persist:youtube',
        'persist:youtubemusic',
        TIKTOK_AUTH_PARTITION
    ]);

    try {
        for (const partition of createdPartitions) {
            if (partition) knownPartitions.add(partition);
        }
    } catch (_) { }

    for (const partition of knownPartitions) {
        try {
            sessionsToFlush.add(session.fromPartition(partition));
        } catch (_) { }
    }

    try {
        for (const win of BrowserWindow.getAllWindows()) {
            if (win && win.webContents && win.webContents.session) {
                sessionsToFlush.add(win.webContents.session);
            }
        }
    } catch (_) { }

    await Promise.allSettled(
        Array.from(sessionsToFlush).map(async (ses) => {
            try {
                if (ses && typeof ses.flushStorageData === 'function') {
                    await ses.flushStorageData();
                }
            } catch (_) { }
        })
    );
}

function runTransferBackupSubprocess(payload, { onProgress = null } = {}) {
    return new Promise((resolve, reject) => {
        const runnerPath = path.join(__dirname, 'transfer-backup-runner.js');
        const child = spawn(process.execPath, [runnerPath], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let stdoutLineBuffer = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (typeof onProgress !== 'function') return;

            stdoutLineBuffer += chunk;
            while (true) {
                const newlineIndex = stdoutLineBuffer.indexOf('\n');
                if (newlineIndex === -1) break;
                const line = stdoutLineBuffer.slice(0, newlineIndex).trim();
                stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
                if (!line) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed && parsed.type === 'progress') {
                        onProgress(parsed);
                    }
                } catch (_) { }
            }
        });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);

        child.on('close', (code) => {
            if (typeof onProgress === 'function') {
                const tail = stdoutLineBuffer.trim();
                if (tail) {
                    try {
                        const parsed = JSON.parse(tail);
                        if (parsed && parsed.type === 'progress') {
                            onProgress(parsed);
                        }
                    } catch (_) { }
                }
            }
            const raw = stdout.trim().split('\n').filter(Boolean).pop() || '';
            try {
                const parsed = raw ? JSON.parse(raw) : null;
                if (parsed && parsed.success) {
                    resolve(parsed.result);
                    return;
                }
                const message = parsed && parsed.error ? parsed.error : (stderr || `Backup runner exited with code ${code}`);
                reject(new Error(message));
            } catch (error) {
                reject(new Error(stderr || `Backup runner failed (${code || 0})`));
            }
        });

        try {
            child.stdin.end(JSON.stringify(payload));
        } catch (error) {
            reject(error);
        }
    });
}

async function promptForPasswordPair({ title, label }) {
    const first = await prompt({
        title: title || 'Backup Password',
        label: label || 'Password:',
        value: '',
        inputAttrs: { type: 'password' },
        type: 'input'
    });
    if (!first) return null;
    const second = await prompt({
        title: title || 'Backup Password',
        label: 'Confirm password:',
        value: '',
        inputAttrs: { type: 'password' },
        type: 'input'
    });
    if (!second) return null;
    if (first !== second) {
        await dialog.showMessageBox({
            type: 'error',
            buttons: ['OK'],
            title: 'Password mismatch',
            message: 'Passwords did not match. Please try again.'
        });
        return null;
    }
    return first;
}

async function promptForPasswordOnce({ title, label }) {
    const password = await prompt({
        title: title || 'Backup Password',
        label: label || 'Password:',
        value: '',
        inputAttrs: { type: 'password' },
        type: 'input'
    });
    return password || null;
}

async function createTransferBackupWithDialog({ useAutoConfig = false, onStart = null } = {}) {
    const config = getTransferBackupConfig();
    const userDataDir = app.getPath('userData');

    let outputFilePath = null;
    let includeCaches = config.includeCaches;
    let password = null;
    const progressTitle = useAutoConfig ? 'Auto Full Session Transfer' : 'Full Session Transfer';

    if (useAutoConfig) {
        outputFilePath = buildTransferBackupFilePath(config);
        password = decryptTransferBackupPassword(config);
        includeCaches = !!config.includeCaches;
        if (!outputFilePath || !password) {
            throw new Error('Auto full session transfer is not configured');
        }
    } else {
        const defaultName = config.fileName || DEFAULT_TRANSFER_BACKUP_CONFIG.fileName;
        const picked = await dialog.showSaveDialog({
            title: 'Create Full Session Transfer Backup',
            defaultPath: path.join(app.getPath('documents'), defaultName),
            filters: [{ name: 'SSAPP Backup', extensions: ['ssappbk'] }]
        });
        if (picked.canceled || !picked.filePath) return null;
        outputFilePath = picked.filePath;

        const includeChoice = await dialog.showMessageBox({
            type: 'question',
            buttons: ['Exclude caches (recommended)', 'Include caches (bigger)'],
            defaultId: 0,
            title: 'Full Session Transfer Size',
            message: 'Include Chromium caches in the full session transfer backup?'
        });
        includeCaches = includeChoice.response === 1;

        password = await promptForPasswordPair({ title: 'Create Full Session Transfer Backup', label: 'Encryption password:' });
        if (!password) return null;
    }

    const progressId = crypto.randomBytes(8).toString('hex');
    transferBackupRuntime.currentProgressId = progressId;

    const emitProgress = (patch = {}) => {
        if (transferBackupRuntime.currentProgressId !== progressId) return;
        try {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            mainWindow.webContents.send('transfer-backup-progress', {
                id: progressId,
                title: progressTitle,
                outputFilePath,
                ...patch
            });
        } catch (_) { }
    };

    if (typeof onStart === 'function') {
        try {
            await onStart({
                userDataDir,
                outputFilePath,
                includeCaches,
                useAutoConfig
            });
        } catch (_) { }
    }

    emitProgress({
        active: true,
        indeterminate: true,
        percent: null,
        message: `Preparing… ${path.basename(outputFilePath)}`
    });

    try {
        await flushAllSessionStorageData();

        emitProgress({
            active: true,
            indeterminate: true,
            percent: null,
            message: `Creating backup… ${path.basename(outputFilePath)}`
        });

        const compressionLevel = useAutoConfig ? 0 : 6;
        const result = await runTransferBackupSubprocess({
            userDataDir,
            outputFilePath,
            password,
            includeCaches,
            compressionLevel,
            appName: app.name,
            appVersion: app.getVersion()
        }, {
            onProgress: (progressEvent) => {
                try {
                    if (transferBackupRuntime.currentProgressId !== progressId) return;
                    const bytesProcessed = Number(progressEvent?.bytesProcessed) || 0;
                    const bytesTotal = Number(progressEvent?.bytesTotal) || 0;
                    const entriesProcessed = Number(progressEvent?.entriesProcessed) || 0;
                    const entriesTotal = Number(progressEvent?.entriesTotal) || 0;

                    const percent = (bytesTotal > 0 && bytesProcessed >= 0)
                        ? Math.max(0, Math.min(1, bytesProcessed / bytesTotal))
                        : null;

                    const indeterminate = !(typeof percent === 'number' && Number.isFinite(percent));

                    const parts = [];
                    if (!indeterminate) parts.push(`${Math.round(percent * 100)}%`);
                    if (entriesTotal > 0) parts.push(`${entriesProcessed}/${entriesTotal} files`);
                    if (bytesTotal > 0) parts.push(`${formatBytes(bytesProcessed)} / ${formatBytes(bytesTotal)}`);

                    emitProgress({
                        active: true,
                        indeterminate,
                        percent,
                        entriesProcessed,
                        entriesTotal,
                        bytesProcessed,
                        bytesTotal,
                        message: parts.join(' • ') || `Creating backup… ${path.basename(outputFilePath)}`
                    });

                    setTransferBackupProgressIndicator(indeterminate ? true : percent);
                } catch (_) { }
            }
        });

        emitProgress({
            active: false,
            success: true,
            indeterminate: false,
            percent: 1,
            message: `Complete: ${path.basename(result.filePath)} (${formatBytes(result.bytes)})`
        });

        return result;
    } catch (error) {
        const msg = error && error.message ? error.message : String(error);
        emitProgress({
            active: false,
            success: false,
            indeterminate: false,
            percent: null,
            error: msg,
            message: msg
        });
        throw error;
    } finally {
        if (transferBackupRuntime.currentProgressId === progressId) {
            transferBackupRuntime.currentProgressId = null;
        }
        setTransferBackupProgressIndicator(false);
    }
}

function spawnTransferRestoreRunner({ backupFilePath, password }) {
    const runnerPath = path.join(__dirname, 'transfer-restore-runner.js');
    const logPath = path.join(path.dirname(backupFilePath), `transfer-restore-${Date.now()}.log`);

    const child = spawn(process.execPath, [runnerPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true
    });

    child.stdin.end(JSON.stringify({
        backupFilePath,
        password,
        userDataDir: app.getPath('userData'),
        parentPid: process.pid,
        execPath: process.execPath,
        appArgs: process.argv.slice(1),
        logPath
    }));

    child.unref();
    return logPath;
}

async function restoreTransferBackupWithDialog() {
    const picked = await dialog.showOpenDialog({
        title: 'Restore Full Session Transfer Backup',
        properties: ['openFile'],
        filters: [{ name: 'SSAPP Backup', extensions: ['ssappbk'] }]
    });
    if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) return null;

    const backupFilePath = picked.filePaths[0];
    const password = await promptForPasswordOnce({ title: 'Restore Full Session Transfer Backup', label: 'Encryption password:' });
    if (!password) return null;

    const confirmResult = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Restore and Restart', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Restore Full Session Transfer Backup',
        message: 'This will close the app, replace all local session data, and restart.\n\nA copy of your current data will be kept beside your userData folder as "pre-restore-*".',
        detail: 'For normal settings moves, use File -> Settings Backup instead. Full Session Transfer is intended for whole-profile migration only.'
    });

    if (confirmResult.response !== 0) return null;

    const logPath = spawnTransferRestoreRunner({ backupFilePath, password });

    await dialog.showMessageBox({
        type: 'info',
        buttons: ['OK'],
        title: 'Restoring Full Session…',
        message: `The app will now close and restore your full session backup.\n\nIf something goes wrong, check:\n${logPath}`
    });

    markStabilitySessionGraceful('transfer-restore');
    app.quit();
    return { started: true };
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function handleCreateTransferBackupMenu() {
    if (transferBackupRuntime.inProgress) {
        await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            title: 'Full Session Transfer',
            message: 'A full session transfer backup is already running.'
        });
        return;
    }

    let didStart = false;

    try {
        const result = await createTransferBackupWithDialog({
            useAutoConfig: false,
            onStart: ({ outputFilePath }) => {
                didStart = true;
                setTransferBackupUiBusy(true);
                showTransferBackupToast('info', 'Full Session Transfer', `Creating backup…\n${outputFilePath}`);
            }
        });
        if (!result) return;
        setTransferBackupConfig({ lastSuccessAt: Date.now(), lastError: null });

        showTransferBackupToast('success', 'Full Session Transfer Created', `${path.basename(result.filePath)} (${formatBytes(result.bytes)})`);
        showTransferBackupNotification('Full Session Transfer Created', `Saved:\n${result.filePath}\nSize: ${formatBytes(result.bytes)}`);

        if (didStart) {
            setTransferBackupUiBusy(false);
            didStart = false;
        }

        await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            title: 'Full Session Transfer Created',
            message: `Saved:\n${result.filePath}\n\nSize: ${formatBytes(result.bytes)}`
        });
    } catch (error) {
        const msg = error && error.message ? error.message : String(error);

        showTransferBackupToast('error', 'Full Session Transfer Failed', msg);
        showTransferBackupNotification('Full Session Transfer Failed', msg);

        if (didStart) {
            setTransferBackupUiBusy(false);
            didStart = false;
        }

        await dialog.showMessageBox({
            type: 'error',
            buttons: ['OK'],
            title: 'Full Session Transfer Failed',
            message: msg
        });
    } finally {
        if (didStart) {
            setTransferBackupUiBusy(false);
        }
    }
}

async function handleAutoTransferBackupNowMenu() {
    if (transferBackupRuntime.inProgress) {
        await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            title: 'Auto Full Session Transfer',
            message: 'A full session transfer backup is already running.'
        });
        return;
    }

    const config = getTransferBackupConfig();
    if (!config.enabled) {
        await dialog.showMessageBox({
            type: 'warning',
            buttons: ['OK'],
            title: 'Auto Full Session Transfer Disabled',
            message: 'Enable auto full session transfer first.'
        });
        return;
    }

    let didStart = false;

    if (transferBackupRuntime.sourcesActive) {
        const confirmResult = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Backup Anyway', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'Sources Active',
            message: 'Sources appear to be active. Backing up now may impact performance.\n\nContinue?'
        });
        if (confirmResult.response !== 0) return;
    }

    try {
        setTransferBackupConfig({ lastAttemptAt: Date.now(), lastError: null });
        const result = await createTransferBackupWithDialog({
            useAutoConfig: true,
            onStart: ({ outputFilePath }) => {
                didStart = true;
                setTransferBackupUiBusy(true);
                showTransferBackupToast('info', 'Auto Full Session Transfer', `Creating backup…\n${outputFilePath}`);
            }
        });
        setTransferBackupConfig({ lastSuccessAt: Date.now(), lastError: null });

        showTransferBackupToast('success', 'Auto Full Session Transfer Complete', `${path.basename(result.filePath)} (${formatBytes(result.bytes)})`);
        showTransferBackupNotification('Auto Full Session Transfer Complete', `Saved:\n${result.filePath}\nSize: ${formatBytes(result.bytes)}`);

        if (didStart) {
            setTransferBackupUiBusy(false);
            didStart = false;
        }

        await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            title: 'Auto Full Session Transfer Complete',
            message: `Saved:\n${result.filePath}\n\nSize: ${formatBytes(result.bytes)}`
        });
    } catch (error) {
        const msg = error && error.message ? error.message : String(error);
        setTransferBackupConfig({ lastError: msg });

        showTransferBackupToast('error', 'Auto Full Session Transfer Failed', msg);
        showTransferBackupNotification('Auto Full Session Transfer Failed', msg);

        if (didStart) {
            setTransferBackupUiBusy(false);
            didStart = false;
        }

        await dialog.showMessageBox({
            type: 'error',
            buttons: ['OK'],
            title: 'Auto Full Session Transfer Failed',
            message: msg
        });
    } finally {
        if (didStart) {
            setTransferBackupUiBusy(false);
        }
    }
}

async function configureAutoTransferBackup() {
    if (!canStoreTransferBackupPassword()) {
        await dialog.showMessageBox({
            type: 'error',
            buttons: ['OK'],
            title: 'Auto Full Session Transfer Unavailable',
            message: 'Your system does not support secure credential storage. Auto full session transfer backups require OS encryption.'
        });
        return null;
    }

    const folderPick = await dialog.showOpenDialog({
        title: 'Select Auto Full Session Transfer Folder',
        properties: ['openDirectory', 'createDirectory']
    });
    if (folderPick.canceled || !folderPick.filePaths || !folderPick.filePaths[0]) return null;

    const folderPath = folderPick.filePaths[0];
    const password = await promptForPasswordPair({ title: 'Enable Auto Full Session Transfer', label: 'Encryption password:' });
    if (!password) return null;

    const includeChoice = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Exclude caches (recommended)', 'Include caches (bigger)'],
        defaultId: 0,
        title: 'Full Session Transfer Size',
        message: 'Include Chromium caches in the auto full session transfer backup?'
    });
    const includeCaches = includeChoice.response === 1;

    const encrypted = encryptTransferBackupPassword(password);
    const next = setTransferBackupConfig({
        enabled: true,
        folderPath,
        includeCaches,
        password: {
            method: 'safeStorage',
            encrypted
        }
    });

    scheduleTransferBackupTimers();
    createMenu();
    return next;
}

function disableAutoTransferBackup() {
    setTransferBackupConfig({
        enabled: false,
        password: { method: null, encrypted: null }
    });
    scheduleTransferBackupTimers();
    createMenu();
}

function computeIsIdleForTransferBackup(config) {
    if (transferBackupRuntime.sourcesActive) return false;
    const idleGateMs = Number.isFinite(config.idleGateMs) ? config.idleGateMs : DEFAULT_TRANSFER_BACKUP_CONFIG.idleGateMs;
    const inactiveFor = Date.now() - (transferBackupRuntime.lastBecameInactiveAt || 0);
    return inactiveFor >= idleGateMs;
}

async function maybeRunAutoTransferBackup(trigger) {
    const config = getTransferBackupConfig();
    if (!config.enabled) return;

    const outputFilePath = buildTransferBackupFilePath(config);
    if (!outputFilePath) return;

    if (transferBackupRuntime.inProgress) return;
    if (!computeIsIdleForTransferBackup(config)) return;

    const minIntervalMs = Number.isFinite(config.minIntervalMs) ? config.minIntervalMs : DEFAULT_TRANSFER_BACKUP_CONFIG.minIntervalMs;
    if (Date.now() - (config.lastSuccessAt || 0) < minIntervalMs) return;

    const password = decryptTransferBackupPassword(config);
    if (!password) {
        console.warn('[TransferBackup] Auto full session transfer enabled but password unavailable; disabling.');
        disableAutoTransferBackup();
        return;
    }

    setTransferBackupUiBusy(true);
    setTransferBackupConfig({ lastAttemptAt: Date.now(), lastError: null });

    try {
        const result = await createTransferBackupWithDialog({
            useAutoConfig: true,
            onStart: ({ outputFilePath: startedPath }) => {
                showTransferBackupToast('info', 'Auto Full Session Transfer', `Creating backup… (${trigger || 'auto'})\n${startedPath}`);
                showTransferBackupNotification('Auto Full Session Transfer Started', `Saving:\n${startedPath}`);
            }
        });
        setTransferBackupConfig({ lastSuccessAt: Date.now(), lastError: null });

        console.log(`[TransferBackup] Auto full session transfer complete (${trigger || 'auto'})`);
        showTransferBackupToast('success', 'Auto Full Session Transfer', `Complete (${trigger || 'auto'}): ${path.basename(result.filePath)} (${formatBytes(result.bytes)})`);
        showTransferBackupNotification('Auto Full Session Transfer Complete', `Saved:\n${result.filePath}\nSize: ${formatBytes(result.bytes)}`);
    } catch (error) {
        const msg = error && error.message ? error.message : String(error);
        console.warn('[TransferBackup] Auto full session transfer failed:', msg);
        setTransferBackupConfig({ lastError: msg });
        showTransferBackupToast('error', 'Auto Full Session Transfer Failed', msg);
        showTransferBackupNotification('Auto Full Session Transfer Failed', msg);
    } finally {
        setTransferBackupUiBusy(false);
    }
}

function scheduleTransferBackupTimers() {
    if (transferBackupRuntime.idleGateTimer) {
        clearTimeout(transferBackupRuntime.idleGateTimer);
        transferBackupRuntime.idleGateTimer = null;
    }
    if (transferBackupRuntime.periodicTimer) {
        clearInterval(transferBackupRuntime.periodicTimer);
        transferBackupRuntime.periodicTimer = null;
    }

    const config = getTransferBackupConfig();
    if (!config.enabled) return;

    if (!transferBackupRuntime.sourcesActive) {
        transferBackupRuntime.lastBecameInactiveAt = Date.now();
        const idleGateMs = Number.isFinite(config.idleGateMs) ? config.idleGateMs : DEFAULT_TRANSFER_BACKUP_CONFIG.idleGateMs;
        transferBackupRuntime.idleGateTimer = setTimeout(() => {
            maybeRunAutoTransferBackup('idle-gate').catch(() => { });
        }, idleGateMs);
        transferBackupRuntime.idleGateTimer.unref?.();
    }

    const intervalMs = Number.isFinite(config.minIntervalMs) ? config.minIntervalMs : DEFAULT_TRANSFER_BACKUP_CONFIG.minIntervalMs;
    const periodic = setInterval(() => {
        maybeRunAutoTransferBackup('periodic').catch(() => { });
    }, intervalMs);
    periodic.unref?.();
    transferBackupRuntime.periodicTimer = periodic;
}

ipcMain.on('ssapp:sources-activity', (_event, payload = {}) => {
    const active = !!payload.active;
    const wasActive = transferBackupRuntime.sourcesActive;
    transferBackupRuntime.sourcesActive = active;
    if (active) {
        if (transferBackupRuntime.idleGateTimer) {
            clearTimeout(transferBackupRuntime.idleGateTimer);
            transferBackupRuntime.idleGateTimer = null;
        }
    } else if (wasActive !== active) {
        transferBackupRuntime.lastBecameInactiveAt = Date.now();
        const config = getTransferBackupConfig();
        const idleGateMs = Number.isFinite(config.idleGateMs) ? config.idleGateMs : DEFAULT_TRANSFER_BACKUP_CONFIG.idleGateMs;
        transferBackupRuntime.idleGateTimer = setTimeout(() => {
            maybeRunAutoTransferBackup('idle-gate').catch(() => { });
        }, idleGateMs);
        transferBackupRuntime.idleGateTimer.unref?.();
    }
});

const spotifyOAuthMode = (() => {
    if (process.argv.includes('--spotify-oauth-intercept')) {
        return 'intercept';
    }
    if (process.argv.includes('--spotify-oauth-loopback')) {
        return 'loopback';
    }
    const envMode = (process.env.SSAPP_SPOTIFY_OAUTH_MODE || '').trim().toLowerCase();
    if (envMode === 'intercept' || envMode === 'loopback') {
        return envMode;
    }
    return 'auto';
})();

const spotifyOAuthFallbackMode = (process.env.SSAPP_SPOTIFY_OAUTH_FALLBACK || '').trim().toLowerCase();
const spotifyOAuthAllowInterceptFallback = (() => {
    if (process.argv.includes('--spotify-oauth-disable-intercept-fallback')) {
        return false;
    }
    if (spotifyOAuthFallbackMode === 'none' || spotifyOAuthFallbackMode === 'off' || spotifyOAuthFallbackMode === 'disabled' || spotifyOAuthFallbackMode === 'loopback') {
        return false;
    }
    if (process.argv.includes('--spotify-oauth-allow-intercept-fallback') || spotifyOAuthFallbackMode === 'intercept') {
        return true;
    }
    return undefined;
})();

function configureSpotifyOAuthHandlers() {
    if (spotifyOAuthMode === 'intercept') {
        setupSpotifyOAuthWithIntercept();
        return;
    }

    try {
        const loopbackOptions = {};
        if (spotifyOAuthMode === 'loopback') {
            loopbackOptions.fallbackToIntercept = false;
        } else if (typeof spotifyOAuthAllowInterceptFallback === 'boolean') {
            loopbackOptions.fallbackToIntercept = spotifyOAuthAllowInterceptFallback;
        }
        setupSpotifyOAuthWithLocalServer(loopbackOptions);
    } catch (error) {
        console.error('[Spotify OAuth] Failed to initialize loopback handler:', error);
        if (spotifyOAuthMode !== 'loopback') {
            console.warn('[Spotify OAuth] Falling back to intercept handler.');
            setupSpotifyOAuthWithIntercept();
        } else {
            throw error;
        }
    }
}

configureSpotifyOAuthHandlers();
setupYouTubeOAuthHandler();
setupTwitchOAuthHandler();
setupFacebookOAuthHandler();
setupVeloraOAuthHandler();
setupKickOAuthHandler();
setupVpzoneOAuthHandler();
setupMediaUploadHandler();

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

let connectionStates = new Map();
let browserViews = {};

function normalizeSourceAccountRole(role) {
    const value = String(role || 'normal').trim().toLowerCase();
    return ['host', 'bot', 'relay'].includes(value) ? value : 'normal';
}

function getBrowserViewAccountMeta(tabID) {
    try {
        const view = getActiveBrowserView(tabID) || browserViews[tabID];
        const args = view && view.args ? view.args : {};
        const role = normalizeSourceAccountRole(args.accountRole);
        if (role === 'normal') return null;
        return {
            role,
            sourceId: args.sourceId || view.sourceId || null,
            session: args.customSession || null
        };
    } catch (_) {
        return null;
    }
}

function attachSourceAccountMetaToMessage(message, tabID) {
    if (!message || typeof message !== 'object') return message;
    const account = getBrowserViewAccountMeta(tabID);
    if (!account) return message;
    const next = { ...message };
    if (next.meta === undefined || next.meta === null) {
        next.meta = {};
    }
    if (typeof next.meta !== 'object' || Array.isArray(next.meta)) {
        return next;
    }
    next.meta = { ...next.meta, ssnAccountRole: account.role };
    if (account.sourceId) next.meta.ssnSourceId = account.sourceId;
    if (account.session && account.session !== 'AUTO') next.meta.ssnSession = account.session;
    return next;
}

function attachSourceAccountMetaToPayload(payload, tabID) {
    if (!payload || typeof payload !== 'object') return payload;
    if (payload.message && typeof payload.message === 'object') {
        return { ...payload, message: attachSourceAccountMetaToMessage(payload.message, tabID) };
    }
    if (Array.isArray(payload.messages)) {
        return { ...payload, messages: payload.messages.map(message => attachSourceAccountMetaToMessage(message, tabID)) };
    }
    if (payload.chatmessage !== undefined || payload.event !== undefined || payload.hasDonation !== undefined || payload.membership !== undefined) {
        return attachSourceAccountMetaToMessage(payload, tabID);
    }
    return payload;
}

const legacyRemoteControlEnabled = (
    process.argv.includes('--remote-control') ||
    (process.env.SSAPP_REMOTE_CONTROL || '').trim() === '1'
);
const headlessControlEnabled = process.argv.includes('--ssapp-headless-control')
    || (process.env.SSAPP_HEADLESS_CONTROL || '').trim() === '1';
const controlApiEnabled = process.argv.includes('--ssapp-control-api')
    || (process.env.SSAPP_CONTROL_API || '').trim() === '1'
    || store.get('controlApi.enabled', false) === true;
const remoteControlEnabled = legacyRemoteControlEnabled || controlApiEnabled;
const remoteControlPort = (() => {
    const inline = process.argv.find(value => typeof value === 'string' && value.startsWith('--ssapp-control-port='));
    const index = process.argv.indexOf('--ssapp-control-port');
    const raw = (inline ? inline.slice('--ssapp-control-port='.length) : (index >= 0 ? process.argv[index + 1] : ''))
        || (process.env.SSAPP_CONTROL_PORT || '').trim()
        || (process.env.SSAPP_REMOTE_CONTROL_PORT || '').trim();
    const parsed = parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : 17777;
})();
const legacyRemoteControlToken = (() => {
    if (!legacyRemoteControlEnabled) return '';
    return (process.env.SSAPP_REMOTE_CONTROL_TOKEN || '').trim()
        || crypto.randomBytes(32).toString('hex');
})();
const remoteControlFileSelections = [];
let llmControlCommandHandler = null;
let controlApiRouter = null;

function findSourceObservationView(sourceId, tabId) {
    if (Number.isFinite(Number(tabId))) {
        const byTab = getActiveBrowserView(Number(tabId)) || browserViews[Number(tabId)];
        if (byTab) return byTab;
    }
    for (const view of Object.values(browserViews)) {
        if (!view || isBrowserViewDestroyed(view)) continue;
        if (view.sourceId === sourceId || view.args?.sourceId === sourceId) return view;
    }
    return null;
}

function sourceIdForObservedMessage(tabId, sender) {
    try {
        const view = findSourceObservationView('', tabId);
        const sourceId = view?.args?.sourceId || view?.sourceId;
        if (sourceId) return sourceId;
    } catch (_) { }
    try {
        const sourceWindow = BrowserWindow.fromWebContents(sender);
        return sourceWindow?.args?.sourceId || sourceWindow?.sourceId || null;
    } catch (_) {
        return null;
    }
}

const sourceObservationService = controlApiEnabled ? new SourceObservationService({
    resolveView: findSourceObservationView,
    getAppMetrics: () => app.getAppMetrics(),
    publish: (type, data) => {
        if (controlApiRouter) controlApiRouter.publish(type, data);
    }
}) : null;

const appWindowControlService = controlApiEnabled ? new AppWindowControlService({
    getWindows: () => BrowserWindow.getAllWindows(),
    getMainWindow: () => mainWindow,
    isHeadless: () => headlessControlEnabled,
    getAppMetrics: () => app.getAppMetrics(),
    publish: (type, data) => {
        if (controlApiRouter) controlApiRouter.publish(type, data);
    }
}) : null;

const appDialogService = controlApiEnabled ? new AppDialogService({
    getMainWindow: () => mainWindow,
    rememberApprovedPath: filePath => rememberDialogApprovedPath(filePath),
    publish: (type, data) => {
        if (controlApiRouter) controlApiRouter.publish(type, data);
    }
}) : null;

if (appDialogService) {
    appDialogService.install(dialog);
    app.on('browser-window-created', (_event, window) => {
        void appDialogService.trackWindow(window);
    });
    ipcMain.on('ssapp-automation-dialog-response', (event, value) => {
        void appDialogService.handleRendererResponse(event, value);
    });
    ipcMain.on('ssapp-automation-javascript-dialog-sync', (event, value) => {
        appDialogService.handleSyncRendererJavaScriptDialog(event, value);
    });
}

function matchesLegacyRemoteControlToken(value) {
    const supplied = Buffer.from(String(value || ''), 'utf8');
    const expected = Buffer.from(legacyRemoteControlToken, 'utf8');
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

if (headlessControlEnabled) {
    app.on('browser-window-created', (_event, window) => {
        const keepHidden = () => {
            try {
                if (!window || window.isDestroyed()) return;
                if (window.__ssappHumanHandoff === true) return;
                if (window.__ssappInternalCapture === true) return;
                window.setSkipTaskbar(true);
                window.hide();
            } catch (_) { }
        };
        keepHidden();
        window.on('show', keepHidden);
        window.on('ready-to-show', keepHidden);
    });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    try {
        process.once(signal, () => {
            markStabilitySessionGraceful(`control-api-${signal.toLowerCase()}`);
            app.quit();
        });
    } catch (_) { }
}


function normalizeKickSlug(value) {
    if (!value) return '';
    return String(value).trim().replace(/^@+/, '').toLowerCase();
}

function buildKickSocketPacket(message, client) {
    const body = message && typeof message === 'object' ? { ...message } : {};
    if (client?.userId != null) {
        body.broadcaster_user_id = client.userId;
    }
    if (client?.channelId != null) {
        body.channel_id = client.channelId;
    }
    if (client?.chatroomId != null) {
        body.chatroom_id = client.chatroomId;
    }
    if (client?.slug) {
        body.channel_slug = client.slug;
    }
    const messageId = body.id ?? body.message_id ?? null;
    return {
        source: 'socket',
        type: 'chat.message.sent',
        body,
        messageId: messageId != null ? String(messageId) : null,
        timestamp: body.created_at || null,
        verified: true,
        version: 'socket',
        channel_slug: body.channel_slug || null
    };
}

function logKickWs(message, details) {
    try {
        if (details !== undefined) {
            console.log('[KickWs]', message, details);
        } else {
            console.log('[KickWs]', message);
        }
    } catch (_) {}
}

function sendKickWsStatus(sender, payload) {
    if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
        return;
    }
    try {
        sender.send('kick-ws-status', payload);
    } catch (_) {}
}

function sendKickWsEvent(sender, payload) {
    if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
        return;
    }
    try {
        sender.send('kick-ws-event', payload);
    } catch (_) {}
}

function stopKickWsEntry(entry, reason) {
    if (!entry) return;
    try {
        entry.client?.removeAllListeners?.();
        entry.client?.stop?.();
    } catch (err) {
        console.warn('[KickWs] Failed to stop client', err);
    }
    if (entry.sender) {
        sendKickWsStatus(entry.sender, {
            connectionId: entry.id,
            status: 'disconnected',
            reason: reason || 'stopped'
        });
    }
}

function findYouTubeOAuthView() {
    try {
        for (const view of Object.values(browserViews)) {
            if (isBrowserViewDestroyed(view)) {
                continue;
            }
            const wc = view.webContents;
            if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
                continue;
            }
            const url = wc.getURL && wc.getURL();
            if (url && matchesSocialStreamPagePath(url, 'sources/websocket/youtube')) {
                return view;
            }
        }
    } catch (error) {
        console.warn('[Remote Control] Failed to scan BrowserViews:', error);
    }
    return null;
}

async function triggerYouTubeExternalAuth() {
    const view = findYouTubeOAuthView();
    if (!view || !view.webContents) {
        return { ok: false, reason: 'youtube_view_not_found' };
    }
    try {
        await view.webContents.executeJavaScript(
            'window.__SSAPP_START_YT_AUTH__ && window.__SSAPP_START_YT_AUTH__()',
            true
        );
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            reason: 'execute_failed',
            error: error && error.message ? error.message : String(error)
        };
    }
}

function findTwitchOAuthView() {
    try {
        for (const view of Object.values(browserViews)) {
            if (isBrowserViewDestroyed(view)) {
                continue;
            }
            const wc = view.webContents;
            if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
                continue;
            }
            const url = wc.getURL && wc.getURL();
            if (url && url.includes('websocket/twitch')) {
                return view;
            }
        }
    } catch (error) {
        console.warn('[Remote Control] Failed to scan BrowserViews for Twitch:', error);
    }
    return null;
}

async function triggerTwitchExternalAuth() {
    const view = findTwitchOAuthView();
    if (!view || !view.webContents) {
        return { ok: false, reason: 'twitch_view_not_found' };
    }
    try {
        await view.webContents.executeJavaScript(
            'window.__SSAPP_START_TWITCH_AUTH__ && window.__SSAPP_START_TWITCH_AUTH__()',
            true
        );
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            reason: 'execute_failed',
            error: error && error.message ? error.message : String(error)
        };
    }
}

function findKickOAuthView() {
    try {
        for (const view of Object.values(browserViews)) {
            if (isBrowserViewDestroyed(view)) {
                continue;
            }
            const wc = view.webContents;
            if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
                continue;
            }
            const url = wc.getURL && wc.getURL();
            if (url && url.includes('websocket/kick')) {
                return view;
            }
        }
    } catch (error) {
        console.warn('[Remote Control] Failed to scan BrowserViews for Kick:', error);
    }
    return null;
}

async function triggerKickExternalAuth() {
    const view = findKickOAuthView();
    if (!view || !view.webContents) {
        return { ok: false, reason: 'kick_view_not_found' };
    }
    try {
        await view.webContents.executeJavaScript(
            'window.__SSAPP_START_KICK_AUTH__ && window.__SSAPP_START_KICK_AUTH__()',
            true
        );
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            reason: 'execute_failed',
            error: error && error.message ? error.message : String(error)
        };
    }
}

function readBodyLimited(req, maxBytes = 1048576) {
    return new Promise((resolve, reject) => {
        let body = '';
        let bytes = 0;
        req.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                req.destroy();
                reject(new Error('Request body too large'));
                return;
            }
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function setupRemoteControlServer() {
    if (!remoteControlEnabled) {
        return;
    }

    const executeControlCommand = async (command) => {
        const action = command && typeof command.action === 'string' ? command.action : '';
        const value = command && command.value && typeof command.value === 'object' ? command.value : {};
        if (appDialogService && appDialogService.handles(action)) {
            return appDialogService.execute(action, value);
        }
        if (appWindowControlService && appWindowControlService.handles(action)) {
            if (appDialogService && action === 'interactAppWindow') appDialogService.arm();
            return appWindowControlService.execute(action, value);
        }
        if (!llmControlCommandHandler) {
            return { ok: false, error: { code: 'SSAPP_UNAVAILABLE', message: 'SSApp controller is not ready.' } };
        }
        if (action === 'showSourceForHuman') {
            const result = await llmControlCommandHandler({
                action: 'setSourceVisibility',
                value: { sourceId: value.sourceId, isVisible: true, humanHandoff: true }
            });
            if (!result || !result.ok) return result;
            const shown = result.payload?.source?.isVisible === true;
            if (!shown) {
                return {
                    ok: false,
                    error: {
                        code: 'STATE_CONFLICT',
                        message: 'The source window cannot be shown while SSApp is running headless.'
                    }
                };
            }
            return {
                ...result,
                payload: {
                    ...(result.payload || {}),
                    sourceId: value.sourceId,
                    shown,
                    humanActionRequired: true
                }
            };
        }
        if (sourceObservationService && sourceObservationService.handles(action)) {
            let source = null;
            if (!['getRecentSourceEvents', 'waitForSourceEvents'].includes(action)) {
                const sourceResult = await llmControlCommandHandler({
                    action: 'getSource',
                    value: { sourceId: value.sourceId }
                });
                if (!sourceResult || !sourceResult.ok) return sourceResult;
                source = sourceResult.payload && sourceResult.payload.source;
            }
            return sourceObservationService.execute(action, value, source);
        }
        return llmControlCommandHandler(command);
    };
    controlApiRouter = createControlApiRouter({
        getSsappVersion: () => app.getVersion(),
        executeCommand: executeControlCommand,
        getStatus: async () => {
            const sources = await executeControlCommand({ action: 'getSources' });
            return {
                ok: !!(sources && sources.ok),
                app: {
                    version: app.getVersion(),
                    session: currentSessionName,
                    headless: headlessControlEnabled,
                    mainWindowReady: !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents),
                    mainWindowVisible: !!(mainWindow && !mainWindow.isDestroyed() && mainWindowVisible),
                    localMedia: localMediaService ? localMediaService.getStatus() : null,
                    pendingAppDialogs: appDialogService ? appDialogService.pendingResult().dialogs.length : 0
                },
                sources: sources && sources.ok ? sources.payload.sources : [],
                error: sources && !sources.ok ? sources.error : undefined
            };
        },
        reloadApp: () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
        },
        shutdownApp: () => {
            markStabilitySessionGraceful('control-api-shutdown');
            app.quit();
        }
    });

    const server = http.createServer(async (req, res) => {
        const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
        const parsed = {
            pathname: requestUrl.pathname,
            query: Object.fromEntries(requestUrl.searchParams)
        };
        const isControlApiRequest = parsed.pathname.startsWith('/api/v1/');
        const handleControlApiRequest = async () => {
            try {
                return await controlApiRouter.handle(req, res, parsed);
            } catch (error) {
                console.error('[Control API] Request failed:', error && error.stack ? error.stack : error);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
                } else {
                    res.destroy();
                }
                return true;
            }
        };

        // The product API is intentionally local and unauthenticated. The separate legacy
        // renderer-execution test harness keeps its existing token gate below.
        if (controlApiEnabled && isControlApiRequest) {
            await handleControlApiRequest();
            return;
        }

        const sendJson = (statusCode, payload) => {
            res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(payload));
        };

        if (!legacyRemoteControlEnabled) {
            sendJson(404, { ok: false, error: 'not_found' });
            return;
        }

        const token = (parsed.query && parsed.query.token) || req.headers['x-ssapp-token'];
        if (!matchesLegacyRemoteControlToken(token)) {
            sendJson(403, { ok: false, error: 'unauthorized' });
            return;
        }

        if (parsed.pathname === '/ping') {
            sendJson(200, {
                ok: true,
                version: app.getVersion(),
                windows: BrowserWindow.getAllWindows().length
            });
            return;
        }

        // A few Electron integration tests use the declarative API through the legacy
        // harness. Keep that compatibility without making --remote-control a product mode.
        if (isControlApiRequest) {
            await handleControlApiRequest();
            return;
        }

        if (parsed.pathname === '/queue-file-selection' && req.method === 'POST') {
            try {
                const body = JSON.parse(await readBodyLimited(req));
                const filePath = path.resolve(String(body.filePath || ''));
                const stat = await fsp.stat(filePath);
                if (!stat.isFile()) throw new Error('filePath must identify an existing file');
                remoteControlFileSelections.push(filePath);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, queued: remoteControlFileSelections.length }));
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }));
            }
            return;
        }

        if (parsed.pathname === '/youtube-auth') {
            const result = await triggerYouTubeExternalAuth();
            res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
        }

        // Create a YouTube source for testing (POST /create-youtube-source with videoId in body)
        if (parsed.pathname === '/create-youtube-source' && req.method === 'POST') {
            readBodyLimited(req).then(async (body) => {
                try {
                    const { videoId } = JSON.parse(body);
                    if (!videoId) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'videoId required' }));
                        return;
                    }

                    // Get runningLocally from command line args
                    const filesourceArg = process.argv.find(a => a.startsWith('--filesource'));
                    const localPath = filesourceArg ? filesourceArg.split('=')[1] || process.argv[process.argv.indexOf('--filesource') + 1] : '';
                    const basePath = localPath || path.join(__dirname, 'resources/social_stream_fallback/main/');

                    // Create the YouTube source window directly
                    const wssUrl = pathToFileURL(path.join(basePath, 'sources/websocket/youtube.html')).href + `?videoId=${encodeURIComponent(videoId)}&devmode=`;

                    const win = new BrowserWindow({
                        width: 400,
                        height: 600,
                        show: true,
                        webPreferences: {
                            nodeIntegration: false,
                            contextIsolation: true,
                            preload: path.join(__dirname, 'preload.js'),
                            sandbox: false
                        }
                    });

                    const tabID = generateUniqueWindowId();
                    win.tabID = tabID;
                    browserViews[tabID] = win;

                    await win.loadURL(wssUrl);

                    // Inject the youtube.js script
                    const jsSource = path.join(__dirname, 'resources/social_stream_fallback/main/sources/websocket/youtube.js');
                    try {
                        const text = fs.readFileSync(jsSource, 'utf8');
                        if (text) {
                            await win.webContents.executeJavaScript(text);
                        }
                    } catch (e) {
                        console.error('Failed to inject youtube.js:', e);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, tabId: tabID, url: wssUrl }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: err.message }));
                }
            }).catch(err => {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
            return;
        }

        if (parsed.pathname === '/twitch-auth') {
            const result = await triggerTwitchExternalAuth();
            res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
        }

        if (parsed.pathname === '/kick-auth') {
            const result = await triggerKickExternalAuth();
            res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
        }

        // Create a Kick source for testing (POST /create-kick-source with username in body)
        if (parsed.pathname === '/create-kick-source' && req.method === 'POST') {
            readBodyLimited(req).then(async (body) => {
                try {
                    const { username } = JSON.parse(body);

                    // Get basePath
                    const filesourceArg = process.argv.find(a => a.startsWith('--filesource'));
                    const localPath = filesourceArg ? filesourceArg.split('=')[1] || process.argv[process.argv.indexOf('--filesource') + 1] : '';
                    const basePath = localPath || path.join(__dirname, 'resources/social_stream_fallback/main/');

                    // Create the Kick source window
                    const wssUrl = pathToFileURL(path.join(basePath, 'sources/websocket/kick.html')).href + '?ssapp=1' + (username ? '&username=' + encodeURIComponent(username) : '');

                    const win = new BrowserWindow({
                        width: 500,
                        height: 700,
                        show: true,
                        webPreferences: {
                            nodeIntegration: false,
                            contextIsolation: true,
                            preload: path.join(__dirname, 'preload.js'),
                            sandbox: false
                        }
                    });

                    const tabID = generateUniqueWindowId();
                    win.tabID = tabID;
                    browserViews[tabID] = win;

                    await win.loadURL(wssUrl);

                    // Inject chrome mock and kick.js after page loads (matching the normal startRunning flow)
                    const jsSource = path.join(__dirname, 'resources/social_stream_fallback/main/sources/websocket/kick.js');
                    try {
                        const text = fs.readFileSync(jsSource, 'utf8');
                        if (text) {
                            // Inject chrome mock setup first, then the script
                            const code = `
                                window.__SSAPP_TAB_ID__ = ${tabID};
                                if (!window.chrome) window.chrome = {};
                                chrome.runtime = {};
                                chrome.runtime.id = 1;
                                chrome.runtime.getURL = function(path) {
                                    return 'electron-inject:' + path;
                                };
                                chrome.runtime.onMessage = {};
                                chrome.runtime.onMessage.addListener = function(callback) {
                                    function tryRegister() {
                                        if (window.ninjafy && window.ninjafy.exposeDoSomethingInWebApp) {
                                            window.ninjafy.exposeDoSomethingInWebApp(function(message, sender, sendResponse) {
                                                callback(message, sender, sendResponse);
                                            });
                                            return true;
                                        }
                                        return false;
                                    }
                                    if (!tryRegister()) {
                                        let retries = 0;
                                        const maxRetries = 10;
                                        const retryInterval = setInterval(() => {
                                            retries++;
                                            if (tryRegister() || retries >= maxRetries) {
                                                clearInterval(retryInterval);
                                            }
                                        }, 100);
                                    }
                                };
                                chrome.runtime.sendMessage = function(a=null,b=null,c=null){
                                    const messageData = b || a;
                                    if (window.ninjafy && window.ninjafy.sendMessage) {
                                        window.ninjafy.sendMessage(null, messageData, c, window.__SSAPP_TAB_ID__);
                                    } else {
                                        const outgoingMessage = { ...messageData };
                                        outgoingMessage.__tabID__ = window.__SSAPP_TAB_ID__;
                                        window.postMessage(outgoingMessage, '*');
                                        if (c) setTimeout(() => c(null), 0);
                                    }
                                };
                                console.log('[Kick] Chrome mock injected, tabID:', window.__SSAPP_TAB_ID__);

                                try {
                                    ${text}
                                } catch(err) {
                                    console.error('[Kick] Script error:', err);
                                }
                            `;
                            await win.webContents.executeJavaScript(code);
                            console.log('[Kick] Successfully injected kick.js');
                        }
                    } catch (e) {
                        console.error('Failed to inject kick.js:', e);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, tabId: tabID, url: wssUrl }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: err.message }));
                }
            }).catch(err => {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
            return;
        }

        if (parsed.pathname === '/views') {
            const views = [];
            for (const [key, view] of Object.entries(browserViews)) {
                if (isBrowserViewDestroyed(view)) continue;
                const wc = view.webContents;
                if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) continue;
                views.push({ key, url: wc.getURL ? wc.getURL() : 'unknown' });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, views }));
            return;
        }

        if (parsed.pathname === '/view-exec' && req.method === 'POST') {
            readBodyLimited(req).then(async (body) => {
                try {
                    const { key, code } = JSON.parse(body);
                    if (!key || !code || typeof code !== 'string') {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'key and code are required' }));
                        return;
                    }
                    const view = browserViews[key];
                    if (isBrowserViewDestroyed(view)) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'view_not_found' }));
                        return;
                    }
                    const wc = view.webContents;
                    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'webcontents_not_found' }));
                        return;
                    }
                    const result = await wc.executeJavaScript(code, true);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, result }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: err.message }));
                }
            }).catch(err => {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
            return;
        }

        if (parsed.pathname === '/windows') {
            const windows = BrowserWindow.getAllWindows().map((win, i) => ({
                id: win.id,
                title: win.getTitle(),
                url: win.webContents ? win.webContents.getURL() : 'unknown'
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, windows }));
            return;
        }

        if (parsed.pathname === '/exec' && req.method === 'POST') {
            readBodyLimited(req).then(async (body) => {
                try {
                    const { windowId, code } = JSON.parse(body);
                    const wins = BrowserWindow.getAllWindows();
                    const win = windowId ? wins.find(w => w.id === windowId) : wins[0];
                    if (!win || !win.webContents) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'window_not_found' }));
                        return;
                    }
                    const result = await win.webContents.executeJavaScript(code, true);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, result }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: err.message }));
                }
            }).catch(err => {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    });

    server.on('error', (error) => {
        console.error('[Remote Control] Server error:', error);
    });

    server.listen(remoteControlPort, '127.0.0.1', () => {
        console.log(`[Remote Control] Listening on http://127.0.0.1:${remoteControlPort}`);
    });
}

// Define isDevMode
const isDevMode = (
    process.env.NODE_ENV === 'development' ||
    process.argv.includes('--dev') ||
    process.argv.includes('--running-from-source') ||
    process.argv.includes('--inspect-brk') ||
    process.argv.includes('--inspect')
);

// Centralized logging toggle (disable console noise outside dev-style runs)
const explicitLogEnable = process.argv.includes('--enable-logs') || process.env.SSAPP_DEBUG_LOGS === '1';
const explicitLogDisable = process.argv.includes('--disable-logs') || process.env.SSAPP_DEBUG_LOGS === '0';
const isDebugLoggingEnabled = explicitLogDisable ? false : (explicitLogEnable || isDevMode);

if (!isDebugLoggingEnabled) {
    const noop = () => { };
    console.log = noop;
    console.info = noop;
    console.debug = noop;
    console.warn = noop;
    console.trace = noop;
}

const forceTikTokLogging = process.argv.includes('--enable-tiktok-logs') || process.env.SSAPP_TIKTOK_LOGS === '1';
const disableTikTokLogging = process.argv.includes('--disable-tiktok-logs') || process.env.SSAPP_TIKTOK_LOGS === '0';
const shouldEnableTikTokLogging = !disableTikTokLogging && (forceTikTokLogging); // !disableTikTokLogging && (forceTikTokLogging || isDevMode);
const DEFAULT_TIKTOK_SIGNING_URL = 'https://livecenter.tiktok.com/realtime';

let TikTokLiveConnectionClass = null;
let TikTokPollingFallbackClass = null;
let usingLegacyTikTokConnector = false;
let ConnectionManager = null;
let cleanupConnection = () => { };
let registerActiveTikTokSourceConnection = () => [];
let sendToBackground = () => { };
let sendBatchToBackground = () => { };
let logTikTokForwardedMessage = () => { };
let sendToTikTok = () => { };
let wssID = 0;
let tiktokSigningWindow = null;
let detachSigningWindowHook = null;
// Track websocket connections globally for cleanup
const websocketConnections = {};
const kickWsConnections = new Map();
let kickWsNextId = 1;

try {
    const tiktokConnector = require('tiktok-live-connector');
    installTikTokSignServerFallback(tiktokConnector);

	    const localSignerImplementation = {
	        sign: async (url, options) => {
	            if (!tikTokSignerHelper) {
	                throw new Error('TikTok signer helper not available');
	            }
	            console.log('[TikTok] localSigner.sign called. Options:', {
	                method: options?.method || null,
	                performFetch: !!options?.performFetch,
	                hasRoomId: !!options?.roomId,
	                hasUniqueId: !!options?.uniqueId,
	                hasSessionId: !!options?.sessionId,
	                hasTtTargetIdc: !!options?.ttTargetIdc,
	                hasActiveUrl: !!options?.activeUrl,
	                hasLandingUrl: !!options?.landingUrl,
	                hasFallbackUrl: !!options?.fallbackUrl
	            });
	            const primaryUrl = normalizeTikTokLandingUrl(options?.landingUrl || options?.activeUrl || DEFAULT_TIKTOK_SIGNING_URL);
	            const fallbackUrl = (typeof options?.fallbackUrl === 'string' && options.fallbackUrl.trim())
	                ? normalizeTikTokLandingUrl(options.fallbackUrl.trim())
	                : null;

            let activeUrlUsed = primaryUrl;
            let win = await ensureTikTokSigningWindow(primaryUrl, { allowNavigation: false, mode: 'background' });
            let parameters;

            try {
                parameters = await tikTokSignerHelper.generateSigningParameters(win, {
                    urlToSign: url,
                    ...options,
                    landingUrl: primaryUrl,
                    activeUrl: primaryUrl
                });
            } catch (primaryError) {
                if (fallbackUrl && fallbackUrl !== primaryUrl) {
                    console.warn('[TikTok] Local signer primary page failed; retrying fallback URL.', primaryError?.message || primaryError);
                    activeUrlUsed = fallbackUrl;
                    win = await ensureTikTokSigningWindow(fallbackUrl, { allowNavigation: true, mode: 'background' });
                    parameters = await tikTokSignerHelper.generateSigningParameters(win, {
                        urlToSign: url,
                        ...options,
                        landingUrl: fallbackUrl,
                        activeUrl: fallbackUrl
                    });
                } else {
                    throw primaryError;
                }
            }

            const enriched = { ...(parameters || {}) };
            if (activeUrlUsed && !enriched.referer) {
                enriched.referer = activeUrlUsed;
            }
            if (activeUrlUsed && !enriched.activeUrl) {
                enriched.activeUrl = activeUrlUsed;
            }
            try {
                if (!enriched.sessionid && typeof tikTokSignerHelper.readSessionIdFromSession === 'function') {
                    const sessionId = await tikTokSignerHelper.readSessionIdFromSession(win);
                    if (sessionId) {
                        enriched.sessionid = sessionId;
                    }
                }

                const cookies = await win.webContents.session.cookies.get({ url: 'https://www.tiktok.com/' });
                if (cookies && cookies.length) {
                    if (!enriched.tt_target_idc) {
                        const ttCookie = cookies.find(c => c.name === 'tt_target_idc' || c.name === 'tt-target-idc');
                        if (ttCookie?.value) {
                            enriched.tt_target_idc = ttCookie.value;
                        }
                    }
                    enriched.allCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                }
            } catch (cookieError) {
                console.warn('[TikTok] Failed to collect cookies for local signer payload:', cookieError);
            }

            return enriched;
        }
    };

    const tikTokEnv = createTikTokEnvironment({
        connector: tiktokConnector,
        shouldEnableTikTokLogging,
        signerHelper: tikTokSignerHelper,
        localSigner: localSignerImplementation,
        isDevMode: () => isDevMode,
        resolveLogDirectory: () => app.getPath('userData'),
        getMainWindow: () => mainWindow,
        browserViews,
        websocketConnections,
        log,
        getCachedSettings,
        isCaptureEventsEnabled,
        isCaptureJoinedEventEnabled,
        isViewerUpdateAllowed,
        isTextOnlyModeEnabled,
        connectionStates
    });

    ConnectionManager = tikTokEnv.ConnectionManager;
    cleanupConnection = tikTokEnv.cleanupConnection;
    registerActiveTikTokSourceConnection = tikTokEnv.registerActiveTikTokSourceConnection;
    sendToBackground = tikTokEnv.sendToBackground;
    sendBatchToBackground = tikTokEnv.sendBatchToBackground;
    logTikTokForwardedMessage = tikTokEnv.logTikTokForwardedMessage;
    sendToTikTok = tikTokEnv.sendToTikTok;
    connectionStates = tikTokEnv.connectionStates;
    usingLegacyTikTokConnector = tikTokEnv.usingLegacyConnector;
    TikTokLiveConnectionClass = tikTokEnv.TikTokLiveConnectionClass;
    TikTokPollingFallbackClass = tikTokEnv.TikTokPollingFallbackClass;

    if (!usingLegacyTikTokConnector) {
        console.info('[TikTok] TikTokLiveConnection available (tiktok-live-connector v2.x)');
    }
} catch (e) {
    console.warn('[TikTok] tiktok-live-connector not available:', e && e.message ? e.message : e);
    TikTokLiveConnectionClass = null; // Allow app to boot; TikTok features disabled until module present
    ConnectionManager = null;
    registerActiveTikTokSourceConnection = () => [];
}

// --- AUTOMATED TEST HARNESS ---
// Watch for a trigger file to send test messages. This allows external agents/scripts to trigger a chat send.
if (isDevMode) {
const TEST_TRIGGER_FILE = path.join(app.getPath('userData'), '.test-trigger');
try {
    console.log('[Test Harness] Watching for test trigger at:', TEST_TRIGGER_FILE);
    fs.watchFile(TEST_TRIGGER_FILE, { interval: 1000 }, async (curr, prev) => {
        if (curr.mtime > prev.mtime) {
            console.log('[Test Harness] Trigger file modified, attempting to send test message...');
            try {
                const content = await fsp.readFile(TEST_TRIGGER_FILE, 'utf8');
                if (!content.trim()) return;

                const payload = JSON.parse(content);
                const targetWssID = payload.wssID || Object.keys(connectionStates)[0]; // Default to first active connection

                if (!targetWssID) {
                    console.warn('[Test Harness] No active connection found to send message.');
                    return;
                }

                console.log(`[Test Harness] Sending message to WSS ID ${targetWssID}:`, payload.message);

                // Find the connection instance - ConnectionManager is a static class/singleton wrapper in this context?
                // Actually ConnectionManager is the class. We need the instance.
                // The 'connectionStates' map holds state, but 'websocketConnections' holds the actual instances?
                // Let's look at how sendToTikTok works.

                // Based on line 265: sendToTikTok = tikTokEnv.sendToTikTok;
                // And sendToTikTok usually handles routing.
                // But we want to call sendChatMessage specifically.

                // We need to find the ConnectionManager instance for this WSS ID.
                // In this codebase, it seems 'tikTokEnv' manages instances but doesn't expose them easily?
                // Wait, 'websocketConnections' (line 162) might hold them?
                // Let's try to find the connection in websocketConnections.

                const connection = websocketConnections[targetWssID];
                if (connection && typeof connection.sendChatMessage === 'function') {
                    const result = await connection.sendChatMessage(payload.message || 'Test message');
                    console.log('[Test Harness] Result:', result);
                } else {
                    console.warn('[Test Harness] Connection instance not found or invalid for WSS ID:', targetWssID);
                    console.log('Available WSS IDs:', Object.keys(websocketConnections));
                }

            } catch (err) {
                console.error('[Test Harness] Failed to execute test trigger:', err);
            }
        }
    });
} catch (err) {
    console.warn('[Test Harness] Failed to setup file watcher:', err);
}
} // end isDevMode gate
// ------------------------------

// Generate a random flag for this session to authenticate injected scripts
const INJECTED_SCRIPT_FLAG = '_ssapp_' + Math.random().toString(36).substring(2) + Date.now().toString(36);

// App-level helper: whether to forward non-gift events to overlays
function isCaptureEventsEnabled() {
    const settings = cachedState && cachedState.settings;
    // Opt-out model: events are enabled unless an explicit block key is present.
    if (!settings || typeof settings !== 'object') return true;
    if (Object.prototype.hasOwnProperty.call(settings, 'hideevents')) return false;
    if (Object.prototype.hasOwnProperty.call(settings, 'disableevents')) return false;
    if (Object.prototype.hasOwnProperty.call(settings, 'disablecaptureevents')) return false;
    return true;
}

function isCaptureJoinedEventEnabled() {
    const settings = cachedState && cachedState.settings;
    if (!settings || typeof settings !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(settings, 'capturejoinedevent');
}

function isViewerUpdateAllowed() {
    try {
        const s = (typeof cachedState === 'object' && cachedState) ? cachedState.settings : undefined;
        if (!s || typeof s !== 'object') return false;
        // Enabled if any of these keys exist (value ignored)
        return (s.showviewercount !== undefined) || (s.hypemode !== undefined) || (s.hypemeter !== undefined);
    } catch (_) { return false; }
}

function getCachedSettings() {
    try {
        if (cachedState && typeof cachedState === 'object') {
            return cachedState.settings && typeof cachedState.settings === 'object'
                ? cachedState.settings
                : {};
        }
    } catch (_) { }
    return {};
}

function isTextOnlyModeEnabled() {
    try {
        const settings = getCachedSettings();
        return !!(settings.textonlymode || settings.textonly);
    } catch (_) {
        return false;
    }
}

function normalizeLocaleCandidate(candidate) {
    if (!candidate || typeof candidate !== 'string') {
        return null;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
        return null;
    }
    // Normalize separators to BCP-47 style without forcing case
    let normalized = trimmed.replace('_', '-');
    const dotIndex = normalized.indexOf('.');
    if (dotIndex !== -1) {
        normalized = normalized.slice(0, dotIndex);
    }
    return normalized;
}

function resolveLocaleOverride() {
    const envOverride =
        process.env.SSAPP_LOCALE ||
        process.env.SSAPP_LANGUAGE ||
        process.env.SSAPP_LANG;
    if (envOverride) {
        return {
            value: normalizeLocaleCandidate(envOverride),
            source: 'environment'
        };
    }

    let cliValue = null;
    const localeFlag = process.argv.find((arg) => arg.startsWith('--locale='));
    if (localeFlag) {
        cliValue = localeFlag.split('=')[1];
    } else {
        const idx = process.argv.indexOf('--locale');
        if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
            cliValue = process.argv[idx + 1];
        }
    }
    if (cliValue) {
        return {
            value: normalizeLocaleCandidate(cliValue),
            source: 'command line'
        };
    }

    try {
        const stored = normalizeLocaleCandidate(store.get('startupFlags.locale'));
        if (stored) {
            return {
                value: stored,
                source: 'preferences'
            };
        }
    } catch (_) { }

    return null;
}

function buildAcceptLanguageHeader(locale) {
    const normalized = normalizeLocaleCandidate(locale) || 'en-US';
    if (normalized === 'en-US') {
        return 'en-US,en;q=0.9';
    }

    const parts = [];
    const seen = new Set();
    const push = (segment) => {
        if (!segment) return;
        const key = segment.split(';')[0];
        if (seen.has(key)) return;
        seen.add(key);
        parts.push(segment);
    };

    push(normalized);
    const base = (normalized.split('-')[0] || '').toLowerCase() || 'en';
    push(`${base};q=0.9`);
    if (base !== 'en') {
        push('en;q=0.8');
    }

    return parts.join(',');
}

// Store the system locale - get it from environment or OS
let SYSTEM_LOCALE = 'en-US'; // Default fallback

// Try to get system locale from environment variables or OS
let localeOverrideSource = null;
try {
    const override = resolveLocaleOverride();
    if (override && override.value) {
        SYSTEM_LOCALE = override.value;
        localeOverrideSource = override.source;
        console.log(`Locale override detected (${override.source}): ${SYSTEM_LOCALE}`);
    } else if (process.platform === 'win32') {
        try {
            const { execSync } = require('child_process');
            const locale = execSync('powershell -command "Get-Culture | Select-Object -ExpandProperty Name"', { encoding: 'utf8' }).trim();
            if (locale) {
                SYSTEM_LOCALE = normalizeLocaleCandidate(locale);
            }
        } catch (e) {
            SYSTEM_LOCALE = normalizeLocaleCandidate(process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES) || 'en-US';
        }
    } else {
        SYSTEM_LOCALE = normalizeLocaleCandidate(process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES) || 'en-US';
        SYSTEM_LOCALE = SYSTEM_LOCALE.split('.')[0];
    }
    console.log('System locale detected:', SYSTEM_LOCALE);
} catch (e) {
    console.log('Could not detect system locale, using default:', SYSTEM_LOCALE);
}

// Force locale to English before app initialization (matches Chrome)
/* app.locale = 'en';
process.env.LANG = 'en_US.UTF-8';
process.env.LC_ALL = 'en_US.UTF-8';
process.env.LC_MESSAGES = 'en_US.UTF-8'; */


// Helper function to get/create installation ID
function getOrCreateInstallationId() {
    let installId = store.get('kasadaInstallId');
    if (!installId) {
        installId = Math.random().toString(36).substring(2, 10);
        store.set('kasadaInstallId', installId);
        console.log('[Main] Generated new installation ID:', installId);
    }
    return installId;
}

// Note: kasadaProxy cleanup is handled per-window in the closed event
// since each window has its own proxy instance (view.tlsProxy)

// CRITICAL: Set Chrome-like process model BEFORE app ready (from working code)
app.commandLine.appendSwitch('--site-per-process'); // Chrome's process model
app.commandLine.appendSwitch('--process-per-site');
app.commandLine.appendSwitch('--process-per-tab');
// Chrome security settings from working code
app.commandLine.appendSwitch('--disable-web-security', 'false'); // Chrome default
app.commandLine.appendSwitch('--allow-running-insecure-content', 'false');

// Essential anti-detection flags (safe for IPC) - MATCH WORKING CODE FORMAT
app.commandLine.appendSwitch('--disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('--exclude-switches', 'enable-automation');
app.commandLine.appendSwitch('--disable-automation');
app.commandLine.appendSwitch('--disable-dev-shm-usage');
app.commandLine.appendSwitch('--disable-permissions-api', 'false');

// Set language to the detected system locale
// Note: Electron has a bug where en-CA becomes en-GB, but we'll accept this for now
app.commandLine.appendSwitch('--lang', SYSTEM_LOCALE);

// Build proper Accept-Language header based on system locale
const acceptLangValue = buildAcceptLanguageHeader(SYSTEM_LOCALE);
app.commandLine.appendSwitch('--accept-lang', acceptLangValue);

console.log(`Setting app language to system locale: ${SYSTEM_LOCALE} (Note: Electron bug may change en-CA to en-GB)`);
process.env.SSAPP_LOCALE_EFFECTIVE = SYSTEM_LOCALE;
process.env.SSAPP_ACCEPT_LANGUAGE = acceptLangValue;
process.env.SSAPP_LOCALE_SOURCE = localeOverrideSource || 'system';

// enable-features / disable-features are single comma-separated switches, and
// appendSwitch overwrites any previous value for the same switch instead of merging.
// Calling appendSwitch('disable-features', ...) twice therefore silently threw away the
// first list, so every feature set here has to go through these helpers.
const chromiumFeatureSwitches = {
    'enable-features': new Set(),
    'disable-features': new Set()
};

function applyChromiumFeatureSwitch(switchName) {
    const features = chromiumFeatureSwitches[switchName];
    if (!features || !features.size) return;
    app.commandLine.appendSwitch(switchName, [...features].join(','));
}

function addChromiumFeatures(switchName, features) {
    const target = chromiumFeatureSwitches[switchName];
    if (!target) return;
    const opposite = switchName === 'enable-features'
        ? chromiumFeatureSwitches['disable-features']
        : chromiumFeatureSwitches['enable-features'];
    let oppositeChanged = false;

    const list = Array.isArray(features) ? features : String(features || '').split(',');
    for (const feature of list) {
        const name = String(feature || '').trim();
        if (!name) continue;
        // A feature listed on both switches is ambiguous to Chromium. Disabling wins,
        // which is what the previous overwrite-the-switch behaviour ended up doing.
        if (switchName === 'enable-features' && opposite.has(name)) continue;
        if (switchName === 'disable-features' && opposite.delete(name)) oppositeChanged = true;
        target.add(name);
    }

    // Re-apply the merged lists immediately so ordering of callers does not matter.
    applyChromiumFeatureSwitch(switchName);
    if (oppositeChanged) {
        app.commandLine.appendSwitch(
            switchName === 'disable-features' ? 'enable-features' : 'disable-features',
            [...opposite].join(',')
        );
    }
}

function enableChromiumFeatures(features) {
    addChromiumFeatures('enable-features', features);
}

function disableChromiumFeatures(features) {
    addChromiumFeatures('disable-features', features);
}

// Chrome-specific feature flags from working code
enableChromiumFeatures('NetworkService,NetworkServiceInProcess,VaapiVideoDecoder');
disableChromiumFeatures('TranslateUI,BlinkGenPropertyTrees,ImprovedCookieControls,LazyFrameLoading');
// Chromium 115+ keeps draws throttled once a surface has been evicted, which is one of
// the ways a background capture window stops getting frames (and therefore stops running
// requestAnimationFrame work such as YouTube live chat appending messages).
disableChromiumFeatures('EvictionThrottlesDraw');
app.commandLine.appendSwitch('--use-angle', 'default'); // Chrome's graphics backend

// Performance and stability flags
app.commandLine.appendSwitch('disable-dev-shm-usage');
if (!IS_MAC_BALANCED_MODE) {
    app.commandLine.appendSwitch('disable-background-timer-throttling');
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    if (!stabilityGpuProfile.disableGpuRasterization) {
        app.commandLine.appendSwitch('enable-gpu-rasterization');
    } else {
        app.commandLine.appendSwitch('disable-gpu-rasterization');
        console.warn('[Stability] Disabled GPU rasterization due to fallback level', stabilityGpuProfile.level);
    }
    if (!stabilityGpuProfile.disableIgnoreGpuBlocklist) {
        app.commandLine.appendSwitch('ignore-gpu-blocklist');
    } else {
        console.warn('[Stability] Respecting GPU blocklist due to fallback level', stabilityGpuProfile.level);
    }
    if (stabilityGpuProfile.disableGpuSandbox) {
        app.commandLine.appendSwitch('disable-gpu-sandbox');
        console.warn('[Stability] Disabled GPU sandbox due to repeated GPU child process crashes.');
    }
}

// User data directory for persistent profile
// app.commandLine.appendSwitch('user-data-dir', path.join(app.getPath('userData'), 'ChromeProfile'));
// User agent override at app level - this will be overridden by config if available
// Set platform-specific user agent with simplified Chrome version
const CHROME_UA_VERSION = '148.0.0.0';  // Chrome shows simplified version in UA string
if (isMac) {
    app.userAgentFallback = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_VERSION} Safari/537.36`;
} else if (process.platform === 'linux') {
    app.userAgentFallback = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_VERSION} Safari/537.36`;
} else {
    app.userAgentFallback = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_VERSION} Safari/537.36`;
}

// Session management initialization
let currentSessionName = store.get('currentSession');
let sessions = store.get('sessions');

// First-time initialization - preserve existing user data
if (!sessions || !currentSessionName) {
    console.log('Initializing session management for the first time');

    // Set up default session with existing data
    sessions = {
        default: {
            name: 'Default Session (Original)',
            created: Date.now(),
            description: 'Your original settings and sources'
        }
    };

    currentSessionName = 'default';

    // Save the session configuration
    store.set('sessions', sessions);
    store.set('currentSession', currentSessionName);
    store.set('sessionSystemInitialized', true);
}

// Ensure current session exists
if (!sessions[currentSessionName]) {
    currentSessionName = 'default';
    store.set('currentSession', 'default');
}

const USER_SESSION_PERSISTED_STORE_KEYS = [
    'cachedStateBackup',
    'cachedStateBackupTime',
    'localStorageBackup',
    'localStorageBackupTime',
    'pendingImport'
];
const PENDING_USER_SESSION_PARTITION_CLEANUP_KEY = 'pendingUserSessionPartitionCleanup';

let suppressedUserSessionPersistence = null;

function getUserSessionPartitionName(sessionName) {
    const normalized = String(sessionName || 'default');
    return normalized === 'default' ? 'persist:abc' : `persist:session-${normalized}`;
}

// Default keeps the legacy names so existing installs retain their data.
// Additional User Sessions use hashed namespaces to prevent settings/source crossover.
function getUserSessionPersistenceScope(sessionName = currentSessionName) {
    const normalized = String(sessionName || 'default');
    if (normalized === 'default') return 'default';
    const digest = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
    return `session-${digest}`;
}

function getUserSessionStoreKey(key, sessionName = currentSessionName) {
    const scope = getUserSessionPersistenceScope(sessionName);
    if (scope === 'default') return key;
    return `userSessionData.${scope}.${key}`;
}

function getUserSessionStoreValue(key, defaultValue, sessionName = currentSessionName) {
    return store.get(getUserSessionStoreKey(key, sessionName), defaultValue);
}

function setUserSessionStoreValue(key, value, sessionName = currentSessionName) {
    store.set(getUserSessionStoreKey(key, sessionName), value);
}

function deleteUserSessionStoreValue(key, sessionName = currentSessionName) {
    store.delete(getUserSessionStoreKey(key, sessionName));
}

function clearUserSessionPersistence(sessionName) {
    USER_SESSION_PERSISTED_STORE_KEYS.forEach((key) => {
        try {
            deleteUserSessionStoreValue(key, sessionName);
        } catch (_) { }
    });

    const paths = getSavedSyncPaths(sessionName);
    [paths.mainPath, paths.tmpPath, paths.bakPath].forEach((filePath) => {
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (error) {
            console.warn(`[User Sessions] Failed to remove ${path.basename(filePath)}:`, error?.message || error);
        }
    });
}

function shouldSuppressCurrentUserSessionPersistence() {
    return suppressedUserSessionPersistence !== null
        && suppressedUserSessionPersistence === currentSessionName;
}

function getPendingUserSessionPartitionCleanup() {
    const pending = store.get(PENDING_USER_SESSION_PARTITION_CLEANUP_KEY, []);
    if (!Array.isArray(pending)) return [];
    return Array.from(new Set(
        pending
            .filter((sessionId) => typeof sessionId === 'string')
            .map((sessionId) => sessionId.trim())
            .filter((sessionId) => sessionId && sessionId !== 'default')
    ));
}

function setPendingUserSessionPartitionCleanup(sessionIds) {
    const pending = Array.from(new Set(sessionIds));
    if (pending.length > 0) {
        store.set(PENDING_USER_SESSION_PARTITION_CLEANUP_KEY, pending);
    } else {
        store.delete(PENDING_USER_SESSION_PARTITION_CLEANUP_KEY);
    }
}

function queueUserSessionPartitionCleanup(sessionId) {
    const pending = getPendingUserSessionPartitionCleanup();
    if (!pending.includes(sessionId)) pending.push(sessionId);
    setPendingUserSessionPartitionCleanup(pending);
}

function isElectronSessionInUse(targetSession) {
    try {
        return electron.webContents.getAllWebContents().some((contents) => {
            return contents && !contents.isDestroyed() && contents.session === targetSession;
        });
    } catch (_) {
        return true;
    }
}

async function processPendingUserSessionPartitionCleanup(onlySessionId = null) {
    const pending = getPendingUserSessionPartitionCleanup();
    if (!pending.length) return { cleared: [], pending: [] };

    const remaining = [];
    const cleared = [];

    for (const sessionId of pending) {
        if (onlySessionId && sessionId !== onlySessionId) {
            remaining.push(sessionId);
            continue;
        }

        // A recreated session owns this partition now. Favor preserving data over cleanup.
        const knownSessions = store.get('sessions', {});
        if (Object.prototype.hasOwnProperty.call(knownSessions, sessionId)) {
            console.warn(`[User Sessions] Skipped partition cleanup because session ${sessionId} exists again.`);
            continue;
        }
        if (sessionId === currentSessionName) {
            console.warn(`[User Sessions] Deferred cleanup for active session ${sessionId}.`);
            remaining.push(sessionId);
            continue;
        }

        const partitionName = getUserSessionPartitionName(sessionId);
        const targetSession = session.fromPartition(partitionName);
        if (isElectronSessionInUse(targetSession)) {
            console.warn(`[User Sessions] Deferred cleanup for in-use partition ${partitionName}.`);
            remaining.push(sessionId);
            continue;
        }

        const didClear = await clearSessionData(targetSession);
        if (!didClear) {
            remaining.push(sessionId);
            continue;
        }

        clearUserSessionPersistence(sessionId);
        cleared.push(sessionId);
        console.log(`[User Sessions] Cleared deleted session partition ${partitionName}.`);
    }

    const latestPending = getPendingUserSessionPartitionCleanup();
    const queuedWhileClearing = latestPending.filter((sessionId) => !pending.includes(sessionId));
    const nextPending = [...remaining, ...queuedWhileClearing];
    setPendingUserSessionPartitionCleanup(nextPending);
    return { cleared, pending: nextPending };
}

process.on("uncaughtException", function (error) {
    console.error("Uncaught Exception:", error);
    reporter.report('uncaught_exception', error);
    if (!isDevMode) {
        dialog.showErrorBox('Application Error',
            `An error occurred: ${error.message}\nPlease report this to support.`);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    reporter.report('unhandled_rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

function safeUnregisterGlobalShortcuts(context = 'shutdown') {
    try {
        if (!app || typeof app.isReady !== 'function' || !app.isReady()) return;
        if (!globalShortcut || typeof globalShortcut.unregisterAll !== 'function') return;
        globalShortcut.unregisterAll();
    } catch (error) {
        console.warn(`[Shortcuts] Failed to unregister global shortcuts during ${context}:`, error?.message || error);
    }
}

function reportExecuteJavaScriptFailure(label, error, webContents = null) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    let url = null;
    try {
        url = webContents && typeof webContents.getURL === 'function' ? webContents.getURL() : null;
    } catch (_) { }
    console.warn(`[ExecuteJS] ${label} failed:`, normalizedError.message || normalizedError);
    reporter.report('execute_javascript_failed', normalizedError, { label, url });
}

function executeJavaScriptWithReport(webContents, script, label, userGesture) {
    if (!webContents || typeof webContents.executeJavaScript !== 'function') {
        return Promise.resolve(null);
    }
    try {
        return webContents.executeJavaScript(script, userGesture).catch((error) => {
            reportExecuteJavaScriptFailure(label, error, webContents);
            throw error;
        });
    } catch (error) {
        reportExecuteJavaScriptFailure(label, error, webContents);
        return Promise.reject(error);
    }
}

function executeJavaScriptQuietly(webContents, script, label, userGesture) {
    executeJavaScriptWithReport(webContents, script, label, userGesture).catch(() => null);
}

app.on('render-process-gone', (_event, webContents, details) => {
    const reason = details && details.reason ? String(details.reason) : 'unknown';
    if (!isStabilityCrashReason(reason)) return;
    let crashedUrl = null;
    try {
        crashedUrl = webContents && typeof webContents.getURL === 'function' ? webContents.getURL() : null;
    } catch (_) { }
    recordStabilityCrashSignal(`render-process-gone:${reason}`, {
        reason,
        exitCode: details && Number.isFinite(details.exitCode) ? details.exitCode : null,
        url: crashedUrl
    });
});

app.on('child-process-gone', (_event, details) => {
    const reason = details && details.reason ? String(details.reason) : 'unknown';
    if (!isStabilityCrashReason(reason)) return;
    recordStabilityCrashSignal(`child-process-gone:${details && details.type ? details.type : 'unknown'}:${reason}`, {
        reason,
        type: details && details.type ? details.type : null,
        serviceName: details && details.serviceName ? details.serviceName : null,
        name: details && details.name ? details.name : null,
        exitCode: details && Number.isFinite(details.exitCode) ? details.exitCode : null
    });
});

app.isQuitting = false;
process.on("exit", () => {
    quitApp();
});

// Track all created partitions for proper cleanup
const createdPartitions = new Set();

// Helper function to get and track partition name
function getTrackedPartition(sessionName) {
    const partition = getUserSessionPartitionName(sessionName);
    createdPartitions.add(partition); // Track this partition
    return partition;
}

//app.setAppUserModelId("app."+Date.now());
//  PORTABLE!!
let runningFromSource = process.argv.includes("--running-from-source");

// const settingsPath = path.join(path.dirname(app.getPath('exe')), `${app.name}_settings`);
// if (!fs.existsSync(settingsPath)) {
// fs.mkdirSync(settingsPath, { recursive: true });
// }
// log("settingsPath: " +settingsPath);

function getStackTrace() {
    const obj = {};
    Error.captureStackTrace(obj, getStackTrace);
    return obj.stack;
}

function getLineNumber() {
    const e = new Error();
    const frame = e.stack.split("\n")[3]; // Change the index if needed
    const lineNumber = frame.split(":").reverse()[1];
    return lineNumber;
}

function log(msg, a, b) {
    if (runningFromSource) {
        // if not source, hide console
        const lineNumber = getLineNumber();
        console.log(`${lineNumber}: `, msg);
    }
}

/* 
let lastLogTime = performance.now(); // Initialize with the current time
function getTimeStamp() {
  const now = performance.now();
  const timeSinceLastLog = now - lastLogTime;
  lastLogTime = now; // Update lastLogTime to the current time
  return timeSinceLastLog.toFixed(0); // Return time with three decimals for milliseconds
}

function log(msg) {
  const timeStamp = getTimeStamp();
  const lineNumber = getLineNumber();
  log(`${timeStamp}ms [Line ${lineNumber}]:`, msg);
}
function warnlog(msg) {
  const timeStamp = getTimeStamp();
  const lineNumber = getLineNumber();
  console.warn(`${timeStamp}ms [Line ${lineNumber}]:`, msg);
}
function errorlog(msg) {
  const timeStamp = getTimeStamp();
  const lineNumber = getLineNumber();
  console.error(`${timeStamp}ms [Line ${lineNumber}]:`, msg);
}
 */

const TIKTOK_LOG_SUBDIR = 'tiktok-logs';
let cachedTikTokLogDir = null;

function sanitizeForFilename(input) {
    if (input === null || input === undefined) return 'tiktok';
    return String(input)
        .replace(/[^a-z0-9-_]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || 'tiktok';
}

function ensureTikTokLogDir() {
    if (cachedTikTokLogDir) {
        return cachedTikTokLogDir;
    }
    try {
        const userDataPath = app.getPath('userData');
        const logDir = path.join(userDataPath, TIKTOK_LOG_SUBDIR);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        cachedTikTokLogDir = logDir;
    } catch (error) {
        console.error('Failed to prepare TikTok log directory:', error);
        cachedTikTokLogDir = null;
    }
    return cachedTikTokLogDir;
}

function normalizeForLogging(value, seen = new WeakMap()) {
    if (value === null || value === undefined) {
        return value;
    }

    const valueType = typeof value;
    if (valueType === 'bigint') {
        return value.toString();
    }
    if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
        return value;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Buffer.isBuffer(value)) {
        return {
            type: 'Buffer',
            data: value.toString('base64')
        };
    }
    if (ArrayBuffer.isView(value)) {
        const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        return {
            type: value.constructor && value.constructor.name ? value.constructor.name : 'TypedArray',
            data: buffer.toString('base64')
        };
    }
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack
        };
    }
    if (valueType === 'function') {
        return `[Function ${value.name || 'anonymous'}]`;
    }
    if (valueType === 'symbol') {
        return value.toString();
    }

    if (valueType === 'object') {
        if (seen.has(value)) {
            return '[Circular]';
        }

        if (Array.isArray(value)) {
            const arr = [];
            seen.set(value, arr);
            for (const item of value) {
                arr.push(normalizeForLogging(item, seen));
            }
            return arr;
        }

        if (value instanceof Map) {
            const obj = {};
            seen.set(value, obj);
            for (const [key, val] of value.entries()) {
                const mapKey = typeof key === 'string' ? key : String(key);
                obj[mapKey] = normalizeForLogging(val, seen);
            }
            return obj;
        }

        if (value instanceof Set) {
            const arr = [];
            seen.set(value, arr);
            for (const item of value.values()) {
                arr.push(normalizeForLogging(item, seen));
            }
            return arr;
        }

        const output = {};
        seen.set(value, output);
        for (const key of Object.keys(value)) {
            try {
                output[key] = normalizeForLogging(value[key], seen);
            } catch (error) {
                output[key] = `[Unserializable: ${error && error.message ? error.message : 'error'}]`;
            }
        }
        return output;
    }

    return value;
}

const SOCIAL_STREAM_CACHE_DIR = 'social_stream_cache';
const SOCIAL_STREAM_FALLBACK_DIR = 'social_stream_fallback';
const SOCIAL_STREAM_REMOTE_TIMEOUT_MS = 5000;
const SOCIAL_STREAM_ALLOWED_BRANCHES = new Set(['main', 'beta']);
const socialStreamLoadPromises = new Map();
const pendingInjectorToasts = [];
const seenInjectorToastKeys = new Set();
let mainWindowReadyForInjectorToasts = false;

function normalizeSocialStreamBranch(input) {
    const normalized = typeof input === 'string' ? input.trim().toLowerCase() : '';
    return SOCIAL_STREAM_ALLOWED_BRANCHES.has(normalized) ? normalized : 'main';
}

function normalizeSocialStreamRelativePath(input) {
    if (!input || typeof input !== 'string') return null;
    const normalized = [];
    const parts = input.replace(/\\/g, '/').split('/');
    for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (normalized.length) normalized.pop();
            continue;
        }
        normalized.push(part);
    }
    if (!normalized.length) return null;
    return normalized.join(path.sep);
}

function extractSocialStreamRelativePath(input) {
    if (!input || typeof input !== 'string') return null;
    let rawPath = input;
    try {
        rawPath = new URL(input).pathname || '';
    } catch (_) { }
    rawPath = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const marker = 'sources/';
    const markerIndex = rawPath.indexOf(marker);
    if (markerIndex !== -1) {
        rawPath = rawPath.slice(markerIndex);
    }
    return normalizeSocialStreamRelativePath(rawPath);
}

async function ensureDirectoryFor(filePath) {
    try {
        const dir = path.dirname(filePath);
        await fsp.mkdir(dir, { recursive: true });
    } catch (error) {
        if (error && error.code !== 'EEXIST') {
            console.warn('Failed to prepare directory for cache file:', error);
        }
    }
}

async function readTextIfExists(filePath) {
    try {
        return await fsp.readFile(filePath, 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function isPathInsideDirectory(rootDir, targetPath) {
    const root = path.resolve(rootDir);
    const target = path.resolve(targetPath);
    const relative = path.relative(root, target);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolvePathInsideRoot(rootDir, relativePath) {
    const normalizedPath = normalizeSocialStreamRelativePath(relativePath);
    if (!normalizedPath) return null;

    const targetPath = path.resolve(rootDir, normalizedPath);
    if (!isPathInsideDirectory(rootDir, targetPath)) {
        return null;
    }
    return targetPath;
}

function getSocialStreamCachePath(branch, relativePath) {
    const sanitizedBranch = normalizeSocialStreamBranch(branch);
    const userDataPath = app.getPath('userData');
    const cacheRoot = path.join(userDataPath, SOCIAL_STREAM_CACHE_DIR, sanitizedBranch);
    return resolvePathInsideRoot(cacheRoot, relativePath);
}

function getCandidateBundledPaths(branch, relativePath) {
    const sanitizedBranch = normalizeSocialStreamBranch(branch);
    const candidates = [];
    const roots = [];
    if (process.resourcesPath) {
        roots.push(path.join(process.resourcesPath, SOCIAL_STREAM_FALLBACK_DIR, sanitizedBranch));
        roots.push(path.join(process.resourcesPath, 'app.asar.unpacked', SOCIAL_STREAM_FALLBACK_DIR, sanitizedBranch));
        roots.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', SOCIAL_STREAM_FALLBACK_DIR, sanitizedBranch));
    }
    roots.push(path.join(__dirname, 'resources', SOCIAL_STREAM_FALLBACK_DIR, sanitizedBranch));
    roots.push(path.join(__dirname, SOCIAL_STREAM_FALLBACK_DIR, sanitizedBranch));

    for (const root of roots) {
        const candidate = resolvePathInsideRoot(root, relativePath);
        if (candidate) {
            candidates.push(candidate);
        }
    }
    return candidates;
}

async function loadBundledSocialStream(branch, relativePath) {
    const attempts = getCandidateBundledPaths(branch, relativePath);
    for (const candidate of attempts) {
        try {
            const text = await readTextIfExists(candidate);
            if (typeof text === 'string') {
                return { text, path: candidate };
            }
        } catch (error) {
            console.warn('Failed to read bundled Social Stream script:', error);
        }
    }
    return null;
}

async function fetchWithTimeout(url, timeoutMs = SOCIAL_STREAM_REMOTE_TIMEOUT_MS) {
    const fetchPromise = fetch(url, { cache: 'no-store' });
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
        const response = await Promise.race([fetchPromise, timeoutPromise]);
        clearTimeout(timeoutId);
        if (!response) {
            throw new Error('No response received');
        }
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const text = await response.text();
        return { text };
    } catch (error) {
        fetchPromise.catch(() => { }); // Prevent unhandled rejection if timeout wins
        clearTimeout(timeoutId);
        throw error;
    }
}

function isLikelyHtmlText(text) {
    const preview = String(text || '').trimStart().slice(0, 256).toLowerCase();
    return preview.startsWith('<!doctype html')
        || preview.startsWith('<html')
        || preview.startsWith('<head')
        || preview.startsWith('<body');
}

function validateSocialStreamSourceText(text, relativePath = '', remoteUrl = '') {
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`Empty Social Stream source response for ${relativePath || remoteUrl || 'remote asset'}`);
    }
    if (isLikelyHtmlText(text)) {
        throw new Error(`Invalid Social Stream source for ${relativePath || remoteUrl || 'remote asset'}: received HTML instead of JavaScript`);
    }
    return text;
}

async function loadSocialStreamSource(remoteUrl, options = {}) {
    const branch = normalizeSocialStreamBranch(options.branch || 'main');
    const relativePath = normalizeSocialStreamRelativePath(options.relativePath || '');
    const cacheKey = `${branch}::${remoteUrl || 'none'}::${relativePath || 'inline'}`;

    if (socialStreamLoadPromises.has(cacheKey)) {
        return socialStreamLoadPromises.get(cacheKey);
    }

    const promise = (async () => {
        let remoteError = null;
        let cachePath = null;

        if (remoteUrl) {
            try {
                const { text } = await fetchWithTimeout(remoteUrl, options.timeoutMs || SOCIAL_STREAM_REMOTE_TIMEOUT_MS);
                validateSocialStreamSourceText(text, relativePath, remoteUrl);
                if (relativePath) {
                    try {
                        cachePath = getSocialStreamCachePath(branch, relativePath);
                        if (cachePath) {
                            await ensureDirectoryFor(cachePath);
                            await fsp.writeFile(cachePath, text, 'utf8');
                        }
                    } catch (cacheWriteError) {
                        console.warn('Failed to update Social Stream cache:', cacheWriteError);
                    }
                }
                return {
                    text,
                    origin: 'remote',
                    meta: { url: remoteUrl }
                };
            } catch (error) {
                remoteError = error;
                reporter.report('remote_load_error', error, { url: remoteUrl, branch, relativePath });
            }
        }

        if (relativePath) {
            try {
                cachePath = cachePath || getSocialStreamCachePath(branch, relativePath);
                if (cachePath) {
                    const cachedText = await readTextIfExists(cachePath);
                    if (typeof cachedText === 'string') {
                        return {
                            text: cachedText,
                            origin: 'cache',
                            meta: {
                                path: cachePath,
                                reason: remoteError ? remoteError.message : 'remote unavailable'
                            }
                        };
                    }
                }
            } catch (cacheReadError) {
                console.warn('Failed to read Social Stream cache:', cacheReadError);
            }

            let fallbackBranchUsed = null;
            let bundled = await loadBundledSocialStream(branch, relativePath);
            if ((!bundled || typeof bundled.text !== 'string') && branch !== 'main') {
                bundled = await loadBundledSocialStream('main', relativePath);
                if (bundled && typeof bundled.text === 'string') {
                    fallbackBranchUsed = 'main';
                }
            }
            if (bundled && typeof bundled.text === 'string') {
                const remoteReason = remoteError ? (remoteError.message || String(remoteError)) : null;
                const meta = {
                    path: bundled.path,
                    reason: remoteReason || `Bundled ${branch} asset unavailable`
                };
                const toBranch = fallbackBranchUsed || branch;
                const fromBranch = fallbackBranchUsed ? branch : (remoteError ? 'remote' : branch);
                meta.fallbackBranch = toBranch;
                notifySocialStreamFallback(relativePath, fromBranch, toBranch);
                return {
                    text: bundled.text,
                    origin: 'fallback',
                    meta
                };
            }
        }

        const reasons = [];
        if (remoteError) {
            reasons.push(remoteError && remoteError.message ? remoteError.message : String(remoteError));
        }
        if (!relativePath) {
            reasons.push('No relative path available for cache or fallback.');
        } else {
            reasons.push('No cached or bundled Social Stream script available.');
        }
        reporter.report('remote_load_failed', reasons.join(' | '), { url: remoteUrl, branch, relativePath });
        throw new Error(reasons.join(' | '));
    })()
        .finally(() => {
            socialStreamLoadPromises.delete(cacheKey);
        });

    socialStreamLoadPromises.set(cacheKey, promise);
    return promise;
}

const bundledSocialStreamCache = new Map();
const socialStreamFallbackNotified = new Set();

function notifySocialStreamFallback(relativePath, fromBranch, toBranch) {
    const key = `${fromBranch}->${toBranch}::${relativePath}`;
    if (socialStreamFallbackNotified.has(key)) {
        return;
    }
    socialStreamFallbackNotified.add(key);

    const readablePath = relativePath.replace(/\\/g, '/');
    const sourceBranch = fromBranch || 'remote';
    const bundledBranch = toBranch || 'main';
    const message = sourceBranch === bundledBranch
        ? `Using packaged ${bundledBranch} assets for ${readablePath}.`
        : `Using packaged ${bundledBranch} assets for ${readablePath} after ${sourceBranch} assets were unavailable.`;
    try {
        queueInjectorToast('warning', 'Fallback Assets Active', message);
    } catch (error) {
        console.warn('Failed to queue injector toast for fallback:', error);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            mainWindow.webContents.send('ssapp:fallback-asset', {
                relativePath,
                fromBranch,
                toBranch
            });
        } catch (error) {
            console.warn('Failed to notify renderer of fallback asset usage:', error);
        }
    }
}

async function locateBundledSocialStreamFile(branch, relativePath, options = {}) {
    const sanitizedBranch = normalizeSocialStreamBranch(branch);
    const normalizedPath = normalizeSocialStreamRelativePath(relativePath);
    if (!normalizedPath) {
        return null;
    }

    const cacheKey = `${sanitizedBranch}::${normalizedPath}`;
    if (!options.bypassCache && bundledSocialStreamCache.has(cacheKey)) {
        return bundledSocialStreamCache.get(cacheKey);
    }

    const candidates = getCandidateBundledPaths(sanitizedBranch, normalizedPath);
    for (const candidate of candidates) {
        try {
            await fsp.access(candidate, fs.constants.R_OK);
            const descriptor = { path: candidate, branch: sanitizedBranch };
            bundledSocialStreamCache.set(cacheKey, descriptor);
            return descriptor;
        } catch (error) {
            if (error && error.code !== 'ENOENT') {
                console.warn(`Failed to access bundled Social Stream file (${candidate}):`, error.message || error);
            }
        }
    }

    bundledSocialStreamCache.set(cacheKey, null);

    if (options.fallbackToMain !== false && sanitizedBranch !== 'main') {
        const fallback = await locateBundledSocialStreamFile('main', normalizedPath, { fallbackToMain: false });
        if (fallback) {
            bundledSocialStreamCache.set(cacheKey, fallback);
            return fallback;
        }
    }

    return null;
}

async function resolveBundledSocialStreamRoot(branch = 'main') {
    try {
        const descriptor = await locateBundledSocialStreamFile(branch, 'manifest.json', {
            bypassCache: true,
            fallbackToMain: branch !== 'main'
        });
        if (descriptor && descriptor.path) {
            return path.dirname(descriptor.path);
        }
    } catch (error) {
        console.warn('Failed to resolve bundled Social Stream root:', error && error.message ? error.message : error);
    }
    return null;
}

ipcMain.handle('socialstream:resolve-file-url', async (_event, relativePath, options = {}) => {
    try {
        const descriptor = await locateBundledSocialStreamFile(options.branch || 'main', relativePath);
        if (!descriptor || !descriptor.path) {
            return { success: false, error: 'NOT_FOUND' };
        }
        const fileUrl = pathToFileURL(descriptor.path).toString();
        const baseUrl = pathToFileUrl(path.dirname(descriptor.path));
        return {
            success: true,
            url: fileUrl,
            path: descriptor.path,
            branch: descriptor.branch,
            baseUrl
        };
    } catch (error) {
        console.error('Failed to resolve Social Stream file URL:', error);
        return { success: false, error: error && error.message ? error.message : 'UNKNOWN' };
    }
});

ipcMain.handle('socialstream:read-file', async (_event, relativePath, options = {}) => {
    const encoding = options.encoding || 'utf8';
    try {
        const descriptor = await locateBundledSocialStreamFile(options.branch || 'main', relativePath);
        if (!descriptor || !descriptor.path) {
            return { success: false, error: 'NOT_FOUND' };
        }
        const data = await fsp.readFile(descriptor.path, encoding);
        return {
            success: true,
            data,
            path: descriptor.path,
            branch: descriptor.branch
        };
    } catch (error) {
        console.error('Failed to read bundled Social Stream file:', error);
        return { success: false, error: error && error.message ? error.message : 'UNKNOWN' };
    }
});

ipcMain.handle('socialstream:resolve-cache-url', async (_event, relativePath, options = {}) => {
    try {
        const normalized = normalizeSocialStreamRelativePath(relativePath);
        if (!normalized) {
            return { success: false, error: 'INVALID_PATH' };
        }
        const branch = normalizeSocialStreamBranch(options.branch || 'main');
        const cachePath = getSocialStreamCachePath(branch, normalized);
        if (!cachePath) {
            return { success: false, error: 'INVALID_PATH' };
        }
        try {
            await fsp.access(cachePath, fs.constants.R_OK);
            return {
                success: true,
                url: pathToFileURL(cachePath).toString(),
                path: cachePath,
                branch
            };
        } catch (error) {
            if (error && error.code === 'ENOENT') {
                return { success: false, error: 'NOT_FOUND' };
            }
            console.warn('Failed to access cached Social Stream file:', error && error.message ? error.message : error);
            return { success: false, error: error && error.message ? error.message : 'UNKNOWN' };
        }
    } catch (error) {
        console.error('Failed to resolve Social Stream cache file:', error);
        return { success: false, error: error && error.message ? error.message : 'UNKNOWN' };
    }
});

ipcMain.handle('ssapp:get-environment', async () => {
    let hasFallback = false;
    try {
        const descriptor = await locateBundledSocialStreamFile('main', 'popup.html', { bypassCache: true });
        hasFallback = !!(descriptor && descriptor.path);
    } catch (error) {
        console.warn('Failed to verify Social Stream fallback availability:', error && error.message ? error.message : error);
    }
    return {
        isPackaged: app.isPackaged,
        preferLocalAssets: !!(preferLocalAssetsFlag && hasFallback),
        hasFallbackBundle: hasFallback,
        localWebSocketEnabled: !!wsServer.server,
        localWebSocketPort: wsServer.port,
        localWebSocketHost: wsServer.host,
        localWebSocketLanAccess: !isLoopbackHost(wsServer.host)
    };
});

function normalizeUiLanguagePreference(lang) {
    if (!lang || typeof lang !== 'string') return '';
    const trimmed = lang.trim();
    if (!trimmed) return '';
    const lower = trimmed.toLowerCase();
    if (lower === 'test') return 'test';
    if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-hans') return 'zh-CN';
    if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant') return 'zh-TW';
    if (lower === 'en-gb' || lower === 'en-uk') return 'en-uk';
    if (lower === 'en' || lower.startsWith('en-')) return 'en-us';
    if (lower === 'pt-br' || lower.startsWith('pt')) return 'pt-br';
    if (lower.startsWith('ar')) return 'ar';
    if (lower.startsWith('es')) return 'es';
    if (lower.startsWith('fr')) return 'fr';
    if (lower.startsWith('de')) return 'de';
    if (lower.startsWith('cs')) return 'cs';
    if (lower.startsWith('th')) return 'th';
    if (lower.startsWith('tr')) return 'tr';
    if (lower.startsWith('uk')) return 'uk';
    return 'en-us';
}

ipcMain.handle('ssapp:set-language', async (_event, payload) => {
    const language = payload && typeof payload === 'object' ? payload.language : payload;
    const source = payload && typeof payload === 'object' && typeof payload.source === 'string' ? payload.source : 'user';
    const normalized = normalizeUiLanguagePreference(language) || 'en-us';
    if (source === 'startup') {
        const currentRaw = store.get('language');
        const currentNormalized = normalizeUiLanguagePreference(currentRaw);
        if (currentRaw && currentNormalized && currentNormalized !== normalized) {
            store.set('language', currentNormalized);
            return { ok: true, language: currentNormalized, preserved: true };
        }
    }
    store.set('language', normalized);
    return { ok: true, language: normalized };
});

ipcMain.handle('ssapp:get-source-window-config', async (event) => {
    try {
        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        const args = sourceWindow && sourceWindow.args ? sourceWindow.args : {};
        return {
            ok: true,
            platform: typeof args.domain === 'string' ? args.domain : '',
            config: args.config && typeof args.config === 'object' ? args.config : {},
            rumbleApiTracker: !!args.rumbleApiTracker,
            rumbleApiUrl: typeof args.rumbleApiUrl === 'string' ? args.rumbleApiUrl : '',
            rumbleFollowerCountMode: typeof args.rumbleFollowerCountMode === 'string' ? args.rumbleFollowerCountMode : ''
        };
    } catch (error) {
        return {
            ok: false,
            error: error?.message || 'Unable to read source window config.'
        };
    }
});

function queueInjectorToast(level, title, message) {
    if (!level || !title || !message) return;
    const key = `${level}|${title}|${message}`;
    if (seenInjectorToastKeys.has(key)) return;
    seenInjectorToastKeys.add(key);
    pendingInjectorToasts.push({ level, title, message });
    flushInjectorToastQueue();
}

function flushInjectorToastQueue() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }
    const wc = mainWindow.webContents;
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
        return;
    }
    if (!mainWindowReadyForInjectorToasts) {
        try {
            const currentUrl = typeof wc.getURL === 'function' ? wc.getURL() : '';
            const hasLoadedPage = !!currentUrl && currentUrl !== 'about:blank';
            const mainFrameIdle = typeof wc.isLoadingMainFrame === 'function' ? !wc.isLoadingMainFrame() : true;
            if (hasLoadedPage && mainFrameIdle) {
                mainWindowReadyForInjectorToasts = true;
            }
        } catch (_) { }
    }
    if (!mainWindowReadyForInjectorToasts) {
        return;
    }
    while (pendingInjectorToasts.length) {
        const toast = pendingInjectorToasts.shift();
        try {
            wc.send('socialstream-injector-status', toast);
        } catch (error) {
            console.warn('Failed to send injector toast:', error);
            pendingInjectorToasts.unshift(toast);
            break;
        }
    }
}

function createTikTokLogWriter(username, wssID) {
    if (!shouldEnableTikTokLogging) {
        return null;
    }
    const logDir = ensureTikTokLogDir();
    if (!logDir) {
        return null;
    }

    const safeUser = sanitizeForFilename(username || 'tiktok');
    const safeId = sanitizeForFilename(wssID || 'connection');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${safeUser}-${safeId}-${timestamp}.log`;
    const filePath = path.join(logDir, fileName);

    let stream;
    try {
        stream = fs.createWriteStream(filePath, { flags: 'a' });
    } catch (error) {
        console.error('Failed to create TikTok log file:', error);
        return null;
    }

    console.info('[TikTok] Debug logging enabled:', filePath);

    return {
        filePath,
        append(entry) {
            if (!stream || stream.destroyed || stream.closed) {
                return;
            }
            try {
                const normalized = normalizeForLogging(entry);
                stream.write(JSON.stringify(normalized) + os.EOL);
            } catch (error) {
                console.error('Failed to write TikTok log entry:', error);
            }
        },
        close() {
            if (stream && !stream.destroyed && !stream.closed) {
                try {
                    stream.end();
                } catch (error) {
                    console.error('Failed to close TikTok log stream:', error);
                }
            }
        }
    };
}

function getWindowStateKey(window) {
    // Generate a unique key based on the window's URL
    // This prevents different types of windows from overwriting each other's saved dimensions
    const url = window.webContents.getURL();
    if (matchesSocialStreamPagePath(url, "index")) return "windowState_main";
    if (matchesSocialStreamPagePath(url, "dock")) return "windowState_dock";
    if (matchesSocialStreamPagePath(url, "input")) return "windowState_input";
    if (matchesSocialStreamPagePath(url, "popup")) return "windowState_popup";
    if (matchesSocialStreamPagePath(url, "chathistory")) return "windowState_history";
    if (matchesSocialStreamPagePath(url, "sampleoverlay")) return "windowState_overlay";
    // For other windows, use a hash of the base URL
    const baseUrl = url.split('?')[0].split('#')[0];
    return "windowState_" + baseUrl.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
}

function saveWindowState(window) {
    // Use getBounds() instead of getNormalBounds() to get actual current size
    // getNormalBounds() returns the bounds when not maximized, which can be incorrect
    const bounds = window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const stateKey = getWindowStateKey(window);

    const stateToSave = {
        width: Math.max(parseInt(bounds.width), 100),
        height: Math.max(parseInt(bounds.height), 100),
        x: bounds.x,
        y: bounds.y,
        displayId: display.id,
        scaleFactor: display.scaleFactor || 1
    };
    store.set(stateKey, stateToSave);
}

function loadWindowState(url) {
    // Generate the same key based on URL that saveWindowState will use
    if (!url) {
        return store.get("windowState"); // Fallback for main window
    }

    let stateKey;
    if (matchesSocialStreamPagePath(url, "index")) stateKey = "windowState_main";
    else if (matchesSocialStreamPagePath(url, "dock")) stateKey = "windowState_dock";
    else if (matchesSocialStreamPagePath(url, "input")) stateKey = "windowState_input";
    else if (matchesSocialStreamPagePath(url, "popup")) stateKey = "windowState_popup";
    else if (matchesSocialStreamPagePath(url, "chathistory")) stateKey = "windowState_history";
    else if (matchesSocialStreamPagePath(url, "sampleoverlay")) stateKey = "windowState_overlay";
    else {
        const baseUrl = url.split('?')[0].split('#')[0];
        stateKey = "windowState_" + baseUrl.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
    }

    const savedState = store.get(stateKey);
    if (savedState) {
        return savedState;
    }

    // Return appropriate defaults based on window type
    const defaultState = {
        width: url.includes("input.html") ? 600 : 800,
        height: url.includes("input.html") ? 60 : 600,
        x: null,
        y: null,
        displayId: null
    };

    return defaultState;
}

/**
 * Validate that saved window bounds are still visible on a connected display.
 * @param {object} savedState - The saved window state with x, y, width, height
 * @returns {object|null} - Validated bounds object, or null if position is off-screen
 */
function validateSavedBounds(savedState) {
    if (!savedState || savedState.x === null || savedState.y === null) {
        return null;
    }

    const displays = screen.getAllDisplays();
    const preferredDisplayId = savedState.displayId !== null && savedState.displayId !== undefined
        ? String(savedState.displayId)
        : null;
    const orderedDisplays = preferredDisplayId
        ? [
            ...displays.filter((display) => String(display.id) === preferredDisplayId),
            ...displays.filter((display) => String(display.id) !== preferredDisplayId)
        ]
        : displays;
    const bounds = {
        x: savedState.x,
        y: savedState.y,
        width: Math.max(1, savedState.width || 800),
        height: Math.max(1, savedState.height || 600)
    };

    // Check if at least part of the window would be visible on any display
    // We require at least 100px of the window to be on-screen
    const minVisiblePx = 100;

    for (const display of orderedDisplays) {
        const db = display.bounds;
        const overlapX = Math.max(0, Math.min(bounds.x + bounds.width, db.x + db.width) - Math.max(bounds.x, db.x));
        const overlapY = Math.max(0, Math.min(bounds.y + bounds.height, db.y + db.height) - Math.max(bounds.y, db.y));

        if (overlapX >= minVisiblePx && overlapY >= minVisiblePx) {
            // Electron bounds are already DPI-independent; avoid scaleFactor math.

            // Clamp saved bounds into the display work area so reopened windows stay fully reachable.
            const workArea = getDisplayWorkAreaBounds(display);
            bounds.width = Math.min(Math.max(bounds.width, 100), workArea.width);
            bounds.height = Math.min(Math.max(bounds.height, 100), workArea.height);
            const maxX = workArea.x + Math.max(workArea.width - bounds.width, 0);
            const maxY = workArea.y + Math.max(workArea.height - bounds.height, 0);
            bounds.x = Math.max(workArea.x, Math.min(bounds.x, maxX));
            bounds.y = Math.max(workArea.y, Math.min(bounds.y, maxY));

            return bounds;
        }
    }

    // Position is off-screen (monitor likely disconnected)
    return null;
}

function getWindowStateDefaults(url) {
    return {
        width: url && url.includes("input.html") ? 600 : 800,
        height: url && url.includes("input.html") ? 60 : 600,
        x: null,
        y: null,
        displayId: null
    };
}

function getDisplayWorkAreaBounds(display) {
    const source = display && typeof display === "object" ? display : {};
    const fallbackBounds = source.bounds || {};
    const workArea = source.workArea || fallbackBounds;
    return {
        x: Number.isFinite(workArea.x) ? workArea.x : (Number.isFinite(fallbackBounds.x) ? fallbackBounds.x : 0),
        y: Number.isFinite(workArea.y) ? workArea.y : (Number.isFinite(fallbackBounds.y) ? fallbackBounds.y : 0),
        width: Math.max(100, Math.round(Number.isFinite(workArea.width) ? workArea.width : fallbackBounds.width || 800)),
        height: Math.max(100, Math.round(Number.isFinite(workArea.height) ? workArea.height : fallbackBounds.height || 600))
    };
}

function getPreferredDisplayForSavedState(savedState) {
    const displays = screen.getAllDisplays();

    if (savedState && savedState.displayId !== null && savedState.displayId !== undefined) {
        const matchedDisplay = displays.find((display) => String(display.id) === String(savedState.displayId));
        if (matchedDisplay) {
            return matchedDisplay;
        }
    }

    if (savedState && Number.isFinite(savedState.x) && Number.isFinite(savedState.y)) {
        try {
            return screen.getDisplayNearestPoint({
                x: Math.round(savedState.x),
                y: Math.round(savedState.y)
            });
        } catch (_) { }
    }

    return screen.getPrimaryDisplay();
}

function resolveWindowBoundsForUrl(url) {
    const savedState = loadWindowState(url);
    const defaults = getWindowStateDefaults(url);
    const width = Math.max(100, Math.round(savedState && savedState.width ? savedState.width : defaults.width));
    const height = Math.max(100, Math.round(savedState && savedState.height ? savedState.height : defaults.height));

    if (!savedState) {
        return {
            width,
            height
        };
    }

    const validatedBounds = validateSavedBounds(savedState);
    if (validatedBounds) {
        return validatedBounds;
    }

    if (savedState.x === null || savedState.x === undefined || savedState.y === null || savedState.y === undefined) {
        return {
            width,
            height
        };
    }

    const targetDisplay = getPreferredDisplayForSavedState(savedState);
    const workArea = getDisplayWorkAreaBounds(targetDisplay);
    const clampedWidth = Math.min(width, workArea.width);
    const clampedHeight = Math.min(height, workArea.height);

    return {
        x: Math.round(workArea.x + Math.max(workArea.width - clampedWidth, 0) / 2),
        y: Math.round(workArea.y + Math.max(workArea.height - clampedHeight, 0) / 2),
        width: clampedWidth,
        height: clampedHeight
    };
}

function normalizeBrowserWindowBounds(window, desiredBounds) {
    const currentBounds = window && !window.isDestroyed() ? window.getBounds() : { x: 0, y: 0, width: 800, height: 600 };
    return {
        x: desiredBounds && desiredBounds.x !== null && desiredBounds.x !== undefined ? Math.round(desiredBounds.x) : currentBounds.x,
        y: desiredBounds && desiredBounds.y !== null && desiredBounds.y !== undefined ? Math.round(desiredBounds.y) : currentBounds.y,
        width: Math.max(100, Math.round(desiredBounds && desiredBounds.width ? desiredBounds.width : currentBounds.width)),
        height: Math.max(100, Math.round(desiredBounds && desiredBounds.height ? desiredBounds.height : currentBounds.height))
    };
}

function applyBrowserWindowBounds(window, desiredBounds, options = {}) {
    if (!window || window.isDestroyed()) {
        return;
    }

    const finalBounds = normalizeBrowserWindowBounds(window, desiredBounds);

    if (process.platform === "win32") {
        try {
            const currentBounds = window.getBounds();
            const currentDisplay = screen.getDisplayMatching(currentBounds);
            const targetDisplay = screen.getDisplayMatching(finalBounds);
            const crossesDisplay = currentDisplay && targetDisplay && currentDisplay.id !== targetDisplay.id;

            if (crossesDisplay) {
                window.setBounds({
                    x: finalBounds.x,
                    y: finalBounds.y,
                    width: currentBounds.width,
                    height: currentBounds.height
                }, false);

                setTimeout(() => {
                    try {
                        if (!window || window.isDestroyed()) return;
                        window.setBounds(finalBounds, false);
                    } catch (_) { }
                }, options.followUpDelayMs || 75);
                return;
            }
        } catch (_) { }
    }

    try {
        window.setBounds(finalBounds, false);
    } catch (_) { }
}

async function waitForCondition(predicate, timeoutMs = 10000, intervalMs = 100) {
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
        try {
            const result = await predicate();
            if (result) {
                return result;
            }
        } catch (_) { }
        await sleep(intervalMs);
    }
    throw new Error(`Timed out after ${timeoutMs}ms`);
}

function getWindowStateDiagnosticFixturePath() {
    return path.join(__dirname, 'tests', 'electron', 'fixtures', 'dock.html');
}

function buildWindowStateDiagnosticUrl(caseId) {
    const fixturePath = getWindowStateDiagnosticFixturePath();
    const baseUrl = pathToFileURL(fixturePath).href;
    const suffix = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${suffix}windowStateDiagnostic=${encodeURIComponent(caseId)}`;
}

function getWindowStateDiagnosticTargetBounds(display, caseIndex) {
    const workArea = getDisplayWorkAreaBounds(display);
    const width = Math.max(420, Math.min(1200, workArea.width - 140));
    const height = Math.max(320, Math.min(860, workArea.height - 140));
    const offsetX = 30 + (caseIndex * 18);
    const offsetY = 40 + (caseIndex * 18);
    const maxX = workArea.x + Math.max(workArea.width - width - 30, 0);
    const maxY = workArea.y + Math.max(workArea.height - height - 30, 0);

    return {
        x: Math.min(workArea.x + offsetX, maxX),
        y: Math.min(workArea.y + offsetY, maxY),
        width,
        height
    };
}

function getClampedVisibleBoundsForDisplay(display, desiredBounds) {
    const workArea = getDisplayWorkAreaBounds(display);
    const width = Math.min(Math.max(Math.round(desiredBounds.width || workArea.width), 100), workArea.width);
    const height = Math.min(Math.max(Math.round(desiredBounds.height || workArea.height), 100), workArea.height);
    const maxX = workArea.x + Math.max(workArea.width - width, 0);
    const maxY = workArea.y + Math.max(workArea.height - height, 0);

    return {
        x: Math.max(workArea.x, Math.min(Math.round(desiredBounds.x || workArea.x), maxX)),
        y: Math.max(workArea.y, Math.min(Math.round(desiredBounds.y || workArea.y), maxY)),
        width,
        height
    };
}

function getWindowStateDiagnosticsTolerance(win = null) {
    const base = { x: 8, y: 8, width: 12, height: 12 };
    if (process.platform !== 'linux') return base;

    // Linux window managers reserve room for their own decorations, and screen.workArea does
    // not account for it: asking for a window as tall as the work area comes back shifted
    // down and shortened by the titlebar. Measured with xfwm4 at 1920x1080, a request for
    // 1920x1080 at 0,0 is placed at 0,24 sized 1920x1056. That is legal placement by the
    // window manager, not window state being lost, so allow for the frame it actually drew
    // rather than failing the case. Horizontal tolerance stays tight; decorations there are
    // a pixel or two.
    let frameAllowance = 40;
    try {
        if (win && !win.isDestroyed()) {
            const bounds = win.getBounds();
            const content = win.getContentBounds();
            const measured = Math.abs(bounds.height - content.height);
            if (measured > 0) frameAllowance = measured + 8;
        }
    } catch (_) { }

    return {
        x: base.x,
        y: Math.max(base.y, frameAllowance),
        width: base.width,
        height: Math.max(base.height, frameAllowance)
    };
}

// The property that actually matters for restored window state: the window has to land on
// screen. A looser tolerance for decorations must not let a window drift off the work area.
function isWindowWithinWorkArea(bounds, workArea, slack = 8) {
    if (!bounds || !workArea) return true;
    return (
        bounds.x >= workArea.x - slack &&
        bounds.y >= workArea.y - slack &&
        (bounds.x + bounds.width) <= (workArea.x + workArea.width + slack) &&
        (bounds.y + bounds.height) <= (workArea.y + workArea.height + slack)
    );
}

function compareWindowBounds(expectedBounds, actualBounds) {
    return {
        x: Math.round((actualBounds?.x || 0) - (expectedBounds?.x || 0)),
        y: Math.round((actualBounds?.y || 0) - (expectedBounds?.y || 0)),
        width: Math.round((actualBounds?.width || 0) - (expectedBounds?.width || 0)),
        height: Math.round((actualBounds?.height || 0) - (expectedBounds?.height || 0))
    };
}

function isWindowBoundsWithinTolerance(diff, tolerance = getWindowStateDiagnosticsTolerance()) {
    return (
        Math.abs(diff.x) <= tolerance.x &&
        Math.abs(diff.y) <= tolerance.y &&
        Math.abs(diff.width) <= tolerance.width &&
        Math.abs(diff.height) <= tolerance.height
    );
}

async function openWindowStateDiagnosticChildWindow(diagnosticUrl) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error('Main window unavailable for diagnostics');
    }

    const existingIds = new Set(BrowserWindow.getAllWindows().map((win) => win.id));
    await mainWindow.webContents.executeJavaScript(`window.open(${JSON.stringify(diagnosticUrl)}, "_blank");`, true);

    return waitForCondition(() => {
        const windows = BrowserWindow.getAllWindows();
        return windows.find((win) => {
            if (!win || win.isDestroyed() || existingIds.has(win.id) || win === mainWindow) return false;
            try {
                const currentUrl = win.webContents && typeof win.webContents.getURL === 'function' ? win.webContents.getURL() : '';
                return currentUrl.includes('windowStateDiagnostic=');
            } catch (_) {
                return false;
            }
        });
    }, 15000, 100);
}

async function closeWindowStateDiagnosticChildWindow(win) {
    if (!win || win.isDestroyed()) {
        return;
    }

    try {
        win.close();
    } catch (_) { }

    await waitForCondition(() => !win || win.isDestroyed(), 15000, 100);
}

async function waitForWindowStateDiagnosticReady(win) {
    if (!win || win.isDestroyed()) {
        throw new Error('Diagnostic window destroyed before ready');
    }

    if (win.webContents && !win.webContents.isLoading()) {
        await sleep(1000);
        return;
    }

    await new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        const fail = () => {
            if (settled) return;
            settled = true;
            reject(new Error('Diagnostic window was destroyed while loading'));
        };

        try {
            win.once('closed', fail);
            win.webContents.once('did-finish-load', finish);
            setTimeout(finish, 5000);
        } catch (error) {
            reject(error);
        }
    });

    await sleep(1000);
}

// Counts effective requestAnimationFrame delivery, timer delivery and chat row growth
// inside a source window. Installed in the page's own world so it sees exactly what a
// capture script would see.
// What counts as "a chat message arrived" per platform. The YouTube and Twitch selectors are
// confirmed against live chat; the Kick ones are best-effort, because Kick will not stream
// chat to an unauthenticated window and could not be exercised.
const HIDDEN_CAPTURE_ROW_SELECTOR = [
    '.ssn-chat-row',                                                        // local fixture
    'yt-live-chat-text-message-renderer', 'yt-live-chat-paid-message-renderer', // YouTube
    '.chat-line__message', '[data-a-target="chat-line-message"]',           // Twitch
    '.chat-entry', '[data-chat-entry]', '[id^="chatroom-message"]',         // Kick (unverified)
    '[data-e2e="chat-message"]',                                            // TikTok
    'div[role="article"]'                                                   // Facebook Live comments
].join(', ');

// Runs only during hidden-capture diagnostics and soak tests. It records messages at two real
// background.js boundaries: when processing starts and when a message reaches the
// destination fan-out. This proves the source injector delivered chat through SSApp,
// rather than merely proving that a third-party page continued changing its DOM.
const HIDDEN_CAPTURE_BACKGROUND_PROBE_INSTALL = `(function () {
	try {
		if (window.__ssnHiddenCaptureBackgroundProbe) {
			return { status: "already-installed" };
		}
		if (typeof processIncomingMessage !== "function" || typeof sendToDestinations !== "function") {
			return {
				status: "waiting",
				processIncomingMessage: typeof processIncomingMessage,
				sendToDestinations: typeof sendToDestinations
			};
		}

		var probe = {
			processed: 0,
			destinations: 0,
			processedByType: {},
			destinationsByType: {},
			processedByTid: {},
			destinationsByTid: {},
			lastProcessed: null,
			lastDestination: null
		};
		var countType = function (counts, value) {
			var type = String((value && value.type) || "unknown");
			counts[type] = (counts[type] || 0) + 1;
		};
		var countTid = function (counts, value) {
			var tid = String((value && value.tid) == null ? "unknown" : value.tid);
			counts[tid] = (counts[tid] || 0) + 1;
		};
		var snapshot = function (value) {
			try { return JSON.parse(JSON.stringify(value)); } catch (error) {
				return {
					type: value && value.type,
					chatname: value && value.chatname,
					chatmessage: value && value.chatmessage
				};
			}
		};
		var originalProcessIncomingMessage = processIncomingMessage;
		var originalSendToDestinations = sendToDestinations;

		processIncomingMessage = async function () {
			probe.processed++;
			countType(probe.processedByType, arguments[0]);
			var result = await originalProcessIncomingMessage.apply(this, arguments);
			countTid(probe.processedByTid, arguments[0]);
			probe.lastProcessed = snapshot(arguments[0]);
			return result;
		};
		sendToDestinations = async function () {
			probe.destinations++;
			countType(probe.destinationsByType, arguments[0]);
			countTid(probe.destinationsByTid, arguments[0]);
			probe.lastDestination = snapshot(arguments[0]);
			return await originalSendToDestinations.apply(this, arguments);
		};
		try { window.sendToDestinations = sendToDestinations; } catch (error) { }

		window.__ssnHiddenCaptureBackgroundProbe = probe;
		return { status: "installed" };
	} catch (error) {
		return { status: "error", message: (error && error.message) ? error.message : String(error) };
	}
})();`;

const HIDDEN_CAPTURE_BACKGROUND_PROBE_READ = `(function () {
	var probe = window.__ssnHiddenCaptureBackgroundProbe;
	if (!probe) { return null; }
	return {
		processed: probe.processed || 0,
		destinations: probe.destinations || 0,
		processedByType: Object.assign({}, probe.processedByType || {}),
		destinationsByType: Object.assign({}, probe.destinationsByType || {}),
		processedByTid: Object.assign({}, probe.processedByTid || {}),
		destinationsByTid: Object.assign({}, probe.destinationsByTid || {}),
		lastProcessed: probe.lastProcessed || null,
		lastDestination: probe.lastDestination || null
	};
})();`;

const HIDDEN_CAPTURE_PROBE_INSTALL = `(function () {
	try {
		if (window.__ssnCaptureProbe) { return "already"; }
		var probe = { raf: 0, timer: 0, rows: 0 };
		window.__ssnCaptureProbe = probe;
		(function loop() { probe.raf++; requestAnimationFrame(loop); })();
		setInterval(function () { probe.timer++; }, 16);

		// Count appended chat rows the way a capture script does, rather than counting
		// what is currently in the DOM: chat pages prune old messages, so a live count
		// saturates and stops reflecting whether new messages are still arriving.
		var ROW_SELECTOR = ${JSON.stringify(HIDDEN_CAPTURE_ROW_SELECTOR)};
		var observer = new MutationObserver(function (records) {
			for (var i = 0; i < records.length; i++) {
				var added = records[i].addedNodes;
				for (var j = 0; j < added.length; j++) {
					var node = added[j];
					if (!node || node.nodeType !== 1) { continue; }
					try {
						// Count the node itself and anything matching inside it: YouTube appends
						// message elements directly, while Twitch and Kick append a wrapper with
						// the message nested in it.
						if (node.matches(ROW_SELECTOR)) { probe.rows++; }
						probe.rows += node.querySelectorAll(ROW_SELECTOR).length;
					} catch (error) { }
				}
			}
		});
		observer.observe(document.documentElement, { childList: true, subtree: true });
		return "installed";
	} catch (error) {
		return "error: " + ((error && error.message) ? error.message : String(error));
	}
})();`;

const HIDDEN_CAPTURE_PROBE_READ = `(function () {
	var probe = window.__ssnCaptureProbe || { raf: 0, timer: 0, rows: 0 };
	return {
		raf: probe.raf,
		timer: probe.timer,
		rows: probe.rows,
		visibility: document.visibilityState,
		pump: window.__ssnFramePump ? window.__ssnFramePump.stats() : null
	};
})();`;

function getHiddenCaptureDiagnosticUrl() {
    const arg = process.argv.find((value) => typeof value === 'string' && value.startsWith('--hidden-capture-url='));
    if (arg) {
        const value = arg.slice('--hidden-capture-url='.length).trim();
        if (value) return value;
    }
    return pathToFileURL(path.join(__dirname, 'tests', 'electron', 'fixtures', 'hidden-capture.html')).href;
}

function getHiddenCaptureDiagnosticSourceFiles(targetUrl) {
    const explicit = process.argv
        .filter((value) => typeof value === 'string' && value.startsWith('--hidden-capture-source='))
        .map((value) => value.slice('--hidden-capture-source='.length).trim())
        .filter(Boolean);
    if (explicit.length) return [...new Set(explicit)];

    try {
        const parsed = new URL(targetUrl);
        const hostname = String(parsed.hostname || '').toLowerCase();
        if (
            parsed.protocol === 'file:' &&
            path.basename(fileURLToPath(parsed)) === 'hidden-capture.html'
        ) {
            const fixturePlatform = String(parsed.searchParams.get('platform') || 'youtube').toLowerCase();
			if (['youtube', 'twitch', 'kick', 'tiktok'].includes(fixturePlatform)) {
                return [`sources/${fixturePlatform}.js`];
            }
            return [];
        }
        if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) return ['sources/youtube.js'];
        if (hostname === 'twitch.tv' || hostname.endsWith('.twitch.tv')) return ['sources/twitch.js'];
        if (hostname === 'kick.com' || hostname.endsWith('.kick.com')) return ['sources/kick.js'];
        if (hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com')) return ['sources/tiktok.js'];
        if (
            hostname === 'facebook.com' || hostname.endsWith('.facebook.com') ||
            hostname === 'workplace.com' || hostname.endsWith('.workplace.com')
        ) return ['sources/facebook.js'];
    } catch (_) { }
    return [];
}

function getHiddenCaptureDiagnosticSourceRoot() {
    const arg = process.argv.find((value) => typeof value === 'string' && value.startsWith('--hidden-capture-filesource='));
    return arg ? arg.slice('--hidden-capture-filesource='.length).trim() : '';
}

function getHiddenCaptureBackgroundFrame() {
    try {
        if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) return null;
        const rootFrame = mainWindow.webContents.mainFrame;
        const frames = rootFrame && Array.isArray(rootFrame.framesInSubtree)
            ? rootFrame.framesInSubtree
            : (rootFrame && Array.isArray(rootFrame.frames) ? rootFrame.frames : []);
        return frames.find((frame) => frame && matchesSocialStreamPagePath(frame.url || '', 'background')) || null;
    } catch (_) {
        return null;
    }
}

async function installHiddenCaptureBackgroundProbe() {
    return await waitForCondition(async () => {
        const frame = getHiddenCaptureBackgroundFrame();
        if (!frame) return null;
        try {
            const result = await frame.executeJavaScript(HIDDEN_CAPTURE_BACKGROUND_PROBE_INSTALL, true);
            if (result && (result.status === 'installed' || result.status === 'already-installed')) {
                return { frame, result };
            }
        } catch (_) { }
        return null;
    }, 20000, 250);
}

async function readHiddenCaptureBackgroundProbe(frame) {
    try {
        if (!frame || (typeof frame.isDestroyed === 'function' && frame.isDestroyed())) return null;
        return await frame.executeJavaScript(HIDDEN_CAPTURE_BACKGROUND_PROBE_READ, true);
    } catch (_) {
        return null;
    }
}

function getHiddenCaptureOverlapRatio(sourceBounds, coverBounds) {
    if (!sourceBounds || !coverBounds || sourceBounds.width <= 0 || sourceBounds.height <= 0) return 0;
    const left = Math.max(sourceBounds.x, coverBounds.x);
    const top = Math.max(sourceBounds.y, coverBounds.y);
    const right = Math.min(sourceBounds.x + sourceBounds.width, coverBounds.x + coverBounds.width);
    const bottom = Math.min(sourceBounds.y + sourceBounds.height, coverBounds.y + coverBounds.height);
    const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
    return overlap / (sourceBounds.width * sourceBounds.height);
}

async function createHiddenCaptureOccluder(view) {
    const requestedBounds = view.getBounds();
    const cover = new BrowserWindow({
        x: requestedBounds.x,
        y: requestedBounds.y,
        width: requestedBounds.width,
        height: requestedBounds.height,
        show: false,
        frame: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        backgroundColor: '#050505',
        webPreferences: {
            backgroundThrottling: false
        }
    });
    await cover.loadURL('data:text/html;charset=utf-8,<title>Hidden capture occluder</title><body style="margin:0;background:%23050505"></body>');
    try { cover.setBounds(requestedBounds); } catch (_) { }
    cover.show();
    try { cover.setAlwaysOnTop(true); } catch (_) { }
    try { cover.focus(); } catch (_) { }
    await sleep(800);

    const sourceBounds = view.getBounds();
    const coverBounds = cover.getBounds();
    return {
        cover,
        sourceBounds,
        coverBounds,
        overlapRatio: getHiddenCaptureOverlapRatio(sourceBounds, coverBounds)
    };
}

// Verifies the two things this issue is about: hiding a source window really hides it on
// Linux, and capture keeps running while it is hidden.
async function runHiddenCaptureDiagnostics() {
    const targetUrl = getHiddenCaptureDiagnosticUrl();
    const sourceFiles = getHiddenCaptureDiagnosticSourceFiles(targetUrl);
    const sourceRoot = getHiddenCaptureDiagnosticSourceRoot();
    const report = {
        startedAt: new Date().toISOString(),
        platform: process.platform,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        sessionType: process.env.XDG_SESSION_TYPE || null,
        waylandDisplay: process.env.WAYLAND_DISPLAY || null,
        isWaylandSession: isWaylandSession(),
        ozonePlatform: app.commandLine.getSwitchValue('ozone-platform') || null,
        headlessControl: headlessControlEnabled,
        framePumpDisabled: isFramePumpDisabled(),
        featureSwitches: {
            enable: app.commandLine.getSwitchValue('enable-features'),
            disable: app.commandLine.getSwitchValue('disable-features')
        },
        url: targetUrl,
        sourceFiles,
        sourceRoot: sourceRoot || null,
        phases: [],
        checks: [],
        summary: { passed: 0, failed: 0 }
    };

    const headless = headlessControlEnabled;

    const check = (id, passed, detail) => {
        report.checks.push({ id, passed: !!passed, detail: detail || null });
        if (passed) {
            report.summary.passed += 1;
        } else {
            report.summary.failed += 1;
        }
    };

    await waitForCondition(() => mainWindow && !mainWindow.isDestroyed(), 15000, 100);
    await sleep(500);

    const backgroundProbe = await installHiddenCaptureBackgroundProbe();
    report.backgroundProbeInstall = backgroundProbe.result;
    check(
        'pipeline.background_probe_installed',
        !!backgroundProbe.frame,
        `status=${backgroundProbe.result && backgroundProbe.result.status}`
    );

    // Create the source window through the real IPC handler so the diagnostic exercises
    // the same preload, session, hide/show and injection code paths users get.
    if (typeof sourceWindowCreateHandler !== 'function') {
        throw new Error('Source window IPC handler is not registered yet');
    }
    // --hidden-capture-start-hidden covers the case a user hits by adding a source with its
    // window switched off: the window is hidden before it has ever been shown, which is a
    // different Chromium state from hiding a window that was on screen a moment ago.
    const startHidden = process.argv.includes('--hidden-capture-start-hidden');
    report.startedHidden = startHidden;

    const created = {};
    const sourceWindowArgs = {
        url: targetUrl,
        visible: !startHidden,
        sourceFiles
    };
    if (sourceRoot) sourceWindowArgs.filesource = sourceRoot;
    sourceWindowCreateHandler(created, sourceWindowArgs);
    const tabID = created.returnValue;
    if (!tabID) {
        throw new Error('Source window creation returned no tab id');
    }
    const view = browserViews[tabID];
    if (!view) {
        throw new Error(`Source window ${tabID} missing from registry`);
    }
    report.tabID = tabID;

    const readHiddenWindowPlacement = () => {
        let nativeVisible = null;
        let bounds = null;
        let intersectsScreen = null;
        try { nativeVisible = view.isVisible(); } catch (_) { }
        try {
            bounds = view.getBounds();
            intersectsScreen = sourceWindowIntersectsVirtualScreen(bounds);
        } catch (_) { }

        // Linux and headless-control mode deliberately unmap the window. Windows and macOS
        // deliberately keep it mapped and park it beyond the virtual desktop so compositor
        // frames continue. Both satisfy the user-facing requirement that it is not on screen.
        const expectsNativeHide = headless || process.platform === 'linux';
        const notOnScreen = expectsNativeHide
            ? nativeVisible === false
            : nativeVisible === false || intersectsScreen === false;
        return {
            notOnScreen,
            detail: `isVisible()=${nativeVisible}, intersectsScreen=${intersectsScreen}, bounds=${JSON.stringify(bounds)}`
        };
    };

    try {
        await waitForCondition(() => {
            try { return !view.webContents.isLoading(); } catch (_) { return false; }
        }, 45000, 250);
		await sleep(6000); // let a real chat page connect and start streaming

		report.pageState = await view.webContents.executeJavaScript(`(() => ({
			href: location.href,
			pathname: location.pathname,
			readyState: document.readyState,
			fixturePlatform: window.__fixturePlatform || null,
			fixtureLocationError: window.__fixtureLocationError || null,
			chatMessageRows: document.querySelectorAll('[data-e2e="chat-message"]').length,
			hasChatRoom: !!document.querySelector('[data-e2e="chat-room"]')
		}))()`, true);

		report.probeInstall = await view.webContents.executeJavaScript(HIDDEN_CAPTURE_PROBE_INSTALL, true);
        await sleep(500);

        // Live chat arrives at whatever rate the stream happens to be busy at, so sample
        // real pages for longer than the fixture, which appends at a fixed 20 rows/second.
        const sampleMs = targetUrl.startsWith('file:') ? 6000 : 10000;

        let zeroFramePhase = null;
        let occludedPhase = null;

        const sample = async (label, ms = sampleMs) => {
            const before = await view.webContents.executeJavaScript(HIDDEN_CAPTURE_PROBE_READ, true);
            const backgroundBefore = await readHiddenCaptureBackgroundProbe(backgroundProbe.frame);
            await sleep(ms);
            const after = await view.webContents.executeJavaScript(HIDDEN_CAPTURE_PROBE_READ, true);
            const backgroundAfter = await readHiddenCaptureBackgroundProbe(backgroundProbe.frame);
            const phase = {
                label,
                windowMs: ms,
                rafPerSecond: Math.round(((after.raf - before.raf) / ms) * 1000),
                timerPerSecond: Math.round(((after.timer - before.timer) / ms) * 1000),
                rowsAdded: after.rows - before.rows,
                visibilityState: after.visibility,
                nativeVisible: (() => { try { return view.isVisible(); } catch (_) { return null; } })(),
                minimized: (() => { try { return view.isMinimized(); } catch (_) { return null; } })(),
                logicalVisible: view.__ss_visible !== false,
                messagesProcessed: (backgroundBefore && backgroundAfter)
                    ? backgroundAfter.processed - backgroundBefore.processed
                    : null,
                messagesSentToDestinations: (backgroundBefore && backgroundAfter)
                    ? backgroundAfter.destinations - backgroundBefore.destinations
                    : null,
                pump: after.pump,
                pumpedBatchesAdded: (after.pump && before.pump)
                    ? after.pump.pumpedBatches - before.pump.pumpedBatches
                    : null,
                nativeBatchesAdded: (after.pump && before.pump)
                    ? after.pump.nativeBatches - before.pump.nativeBatches
                    : null
            };
            report.phases.push(phase);
            return phase;
        };

        // Under --ssapp-headless-control every window is forced hidden and stays that way,
        // so this first phase is already a hidden window there. That is the interesting case
        // for a cloud or server install: it is exactly the state capture has to survive.
        const startupLabel = (headless || startHidden) ? 'startup (created hidden)' : 'visible';
        const visible = await sample(startupLabel);
        check('startup.frames_running', visible.rafPerSecond > 5, `rAF/s=${visible.rafPerSecond}`);
        check('pump.installed', !!visible.pump, `pump=${JSON.stringify(visible.pump)}`);
        if (headless || startHidden) {
            const startupPlacement = readHiddenWindowPlacement();
            check(
                'startup.window_not_shown',
                startupPlacement.notOnScreen,
                startupPlacement.detail
            );
        }

        // A visible but fully covered Wayland surface is #875's exact failure mode. Put an
        // opaque always-on-top window over the source and verify both compositor-driven work
        // and the real Social Stream message pipeline continue. Hidden/headless runs skip
        // this because those windows are never mapped in the first place.
        if (process.platform === 'linux' && !headless && !startHidden) {
            let occluder = null;
            try {
                occluder = await createHiddenCaptureOccluder(view);
                report.occlusion = {
                    sourceBounds: occluder.sourceBounds,
                    coverBounds: occluder.coverBounds,
                    overlapRatio: occluder.overlapRatio
                };
                check(
                    'occluded.window_fully_covered',
                    occluder.overlapRatio >= 0.98,
                    `overlap=${Math.round(occluder.overlapRatio * 100)}%`
                );
                occludedPhase = await sample('fully occluded');
                check('occluded.frames_running', occludedPhase.rafPerSecond > 5, `rAF/s=${occludedPhase.rafPerSecond}`);
            } finally {
                try {
                    if (occluder && occluder.cover && !occluder.cover.isDestroyed()) {
                        occluder.cover.destroy();
                    }
                } catch (_) { }
            }
            await sleep(500);
        }

        // Hide through the same code path the UI's hide button uses.
        applySourceWindowVisibility(view, { state: true });
        await sleep(1200);

        const hiddenPlacement = readHiddenWindowPlacement();
        check(
            'hide.window_not_on_screen',
            hiddenPlacement.notOnScreen,
            hiddenPlacement.detail
        );
        check('hide.logical_state', view.__ss_visible === false, `__ss_visible=${view.__ss_visible}`);

        const hidden = await sample('hidden');
        check('hidden.frames_running', hidden.rafPerSecond > 5, `rAF/s=${hidden.rafPerSecond}`);
        check('hidden.timers_running', hidden.timerPerSecond > 20, `timer/s=${hidden.timerPerSecond}`);
        if (headless || startHidden) {
            // A window hidden before it was ever shown keeps reporting "hidden" to the page,
            // on every platform, so this is recorded rather than asserted. What matters is
            // that timers and capture keep running, which is checked above.
            report.hiddenFromBirthVisibilityState = hidden.visibilityState;
        } else {
            check(
                'hidden.visibility_state_visible',
                hidden.visibilityState === 'visible',
                `visibilityState=${hidden.visibilityState}`
            );
        }

        // Eviction and draw throttling only kick in after a surface has been invisible for
        // a while, so sample again later rather than declaring victory immediately.
        await sleep(20000);
        const settled = await sample('hidden after 20s');
        check('hidden_settled.frames_running', settled.rafPerSecond > 5, `rAF/s=${settled.rafPerSecond}`);

        // Within-run A/B of the two mitigations on this machine. Put the window back under
        // Chromium's normal throttling, measure, then re-arm. Capture has to survive the
        // throttled window too, because that is the state the pump exists for: it is what an
        // on-screen window looks like when the compositor has quietly stopped redrawing it.
        let throttled = null;
        try {
            view.webContents.setBackgroundThrottling(true);
            await sleep(1500);
            throttled = await sample('hidden, throttling restored');
            check('throttled.capture_survives', throttled.rafPerSecond > 5, `rAF/s=${throttled.rafPerSecond}`);
        } catch (error) {
            report.throttleAbNote = `could not toggle throttling: ${error && error.message}`;
        } finally {
            // Put back the constructor setting either way.
            try { view.webContents.setBackgroundThrottling(false); } catch (_) { }
            await sleep(1500);
        }

        const rearmed = await sample("hidden, throttling restored to default");
        check('rearmed.frames_running', rearmed.rafPerSecond > 5, `rAF/s=${rearmed.rafPerSecond}`);
        report.backgroundThrottlingEffect = throttled ? {
            nativeFramesReArmed: settled.nativeBatchesAdded,
            nativeFramesThrottled: throttled.nativeBatchesAdded,
            pumpedFramesReArmed: settled.pumpedBatchesAdded,
            pumpedFramesThrottled: throttled.pumpedBatchesAdded,
            helped: (typeof settled.nativeBatchesAdded === 'number' && typeof throttled.nativeBatchesAdded === 'number')
                ? settled.nativeBatchesAdded > throttled.nativeBatchesAdded * 2
                : null
        } : null;

        applySourceWindowVisibility(view, { state: false, userInitiated: true });
        await sleep(1500);

        let nativeVisibleAfterReveal = null;
        try { nativeVisibleAfterReveal = view.isVisible(); } catch (_) { }
        if (headless) {
            // Headless control refuses to show windows at all, which is the point of it.
            check(
                'headless.reveal_stays_hidden',
                nativeVisibleAfterReveal === false,
                `isVisible()=${nativeVisibleAfterReveal}`
            );
        } else {
            check('reveal.window_visible', nativeVisibleAfterReveal === true, `isVisible()=${nativeVisibleAfterReveal}`);
            check('reveal.logical_state', view.__ss_visible === true, `__ss_visible=${view.__ss_visible}`);
        }

        const revealed = await sample(headless ? 'after reveal request (still hidden)' : 'revealed');
        check('revealed.frames_running', revealed.rafPerSecond > 5, `rAF/s=${revealed.rafPerSecond}`);

        report.framePumpStats = await readFramePumpStats(view.webContents);

        // Last phase, because it permanently breaks this page's real frame callbacks:
        // stub requestAnimationFrame so it never calls back, reinstall the pump on top of
        // that, and confirm callbacks still run. This is the condition a window hits when a
        // compositor stops sending frame callbacks altogether, which is what kills capture
        // for backgrounded windows on some Wayland setups.
        if (!isFramePumpDisabled()) {
            report.zeroFrameSetup = await view.webContents.executeJavaScript(`(function () {
	try {
		if (window.__ssnFramePump) { window.__ssnFramePump.dispose(); }
		window.requestAnimationFrame = function () { return 0; };
		window.cancelAnimationFrame = function () { };
		return "stubbed";
	} catch (error) {
		return "error: " + ((error && error.message) ? error.message : String(error));
	}
})();`, true);

            installFramePump(view.webContents);
            await sleep(600);
            // The probe's own frame loop died with the old pump; restart it so it is driven
            // by the freshly installed pump and nothing else.
            await view.webContents.executeJavaScript(`(function () {
	var probe = window.__ssnCaptureProbe;
	if (!probe) { return "no-probe"; }
	(function loop() { probe.raf++; requestAnimationFrame(loop); })();
	return "restarted";
})();`, true);

            const zeroFrame = await sample('zero native frames');
            zeroFramePhase = zeroFrame;
            check(
                'zero_frames.callbacks_still_run',
                zeroFrame.rafPerSecond > 5,
                `rAF/s=${zeroFrame.rafPerSecond}`
            );
            check(
                'zero_frames.pump_is_the_driver',
                zeroFrame.pumpedBatchesAdded > 0 && zeroFrame.nativeBatchesAdded === 0,
                `pumped=${zeroFrame.pumpedBatchesAdded} native=${zeroFrame.nativeBatchesAdded}`
            );
        }

        // Chat row growth is asserted in aggregate rather than per phase. A live stream
        // delivers messages at whatever rate it happens to be busy at, so a single quiet
        // sample window means nothing, whereas "rows arrived on screen but never once while
        // hidden" is exactly the reported bug.
		const onScreenRows = visible.rowsAdded + revealed.rowsAdded;
		const hiddenRows = hidden.rowsAdded + settled.rowsAdded + rearmed.rowsAdded
			+ (throttled ? throttled.rowsAdded : 0);
		const occludedRows = occludedPhase ? occludedPhase.rowsAdded : null;
		const zeroFrameRows = zeroFramePhase ? zeroFramePhase.rowsAdded : null;
		report.rowGrowth = { onScreenRows, hiddenRows, occludedRows, zeroFrameRows };
		const pipelineOnlySource = sourceFiles.some((sourceFile) =>
			String(sourceFile || '').replace(/\\/g, '/').includes('sources/websocket/')
		);
		report.pipelineOnlySource = pipelineOnlySource;

		if (pipelineOnlySource) {
			// WebSocket source pages do not need to render chat rows. Their real success
			// criterion is the background destination pipeline checked immediately below.
			check('rows.not_required_for_transport_source', true, 'WebSocket source uses pipeline delivery.');
		} else if (onScreenRows + hiddenRows === 0) {
            // Nothing to measure: the page never produced a chat row in any state, so this
            // says the target was unusable, not that capture is broken.
            check(
                'rows.target_produces_chat',
                false,
                `no chat rows in any phase - is ${targetUrl} actually live with chat enabled?`
            );
        } else {
            check(
                'rows.growing_while_hidden',
                hiddenRows > 0,
                `hidden=${hiddenRows} rows vs on-screen=${onScreenRows} rows`
            );
            if (zeroFrameRows !== null) {
                check(
                    'rows.growing_with_zero_frames',
                    zeroFrameRows > 0,
                    `rows added=${zeroFrameRows} with no compositor frames`
                );
            }
        }

        const allPhases = report.phases || [];
        const destinationMessages = allPhases.reduce(
            (total, phase) => total + (Number.isFinite(phase.messagesSentToDestinations) ? phase.messagesSentToDestinations : 0),
            0
        );
        const hiddenDestinationMessages = [hidden, settled, rearmed, throttled]
            .filter(Boolean)
            .reduce(
                (total, phase) => total + (Number.isFinite(phase.messagesSentToDestinations) ? phase.messagesSentToDestinations : 0),
                0
            );
        report.pipeline = {
            destinationMessages,
            hiddenDestinationMessages,
            occludedDestinationMessages: occludedPhase ? occludedPhase.messagesSentToDestinations : null,
            zeroFrameDestinationMessages: zeroFramePhase ? zeroFramePhase.messagesSentToDestinations : null,
            finalProbe: await readHiddenCaptureBackgroundProbe(backgroundProbe.frame)
        };

        if (sourceFiles.length) {
            check(
                'pipeline.messages_reach_destinations',
                destinationMessages > 0,
                `messages=${destinationMessages}`
            );
            check(
                'pipeline.hidden_messages_reach_destinations',
                hiddenDestinationMessages > 0,
                `messages=${hiddenDestinationMessages}`
            );
            if (occludedPhase) {
                check(
                    'pipeline.occluded_messages_reach_destinations',
                    occludedPhase.messagesSentToDestinations > 0,
                    `messages=${occludedPhase.messagesSentToDestinations}`
                );
            }
            if (zeroFramePhase) {
                check(
                    'pipeline.zero_frame_messages_reach_destinations',
                    zeroFramePhase.messagesSentToDestinations > 0,
                    `messages=${zeroFramePhase.messagesSentToDestinations}`
                );
            }
        }
    } finally {
        try {
            app.isQuitting = true;
            if (!isBrowserViewDestroyed(view)) view.destroy();
        } catch (_) { }
    }

    report.finishedAt = new Date().toISOString();
    report.success = report.summary.failed === 0;

    if (HIDDEN_CAPTURE_DIAGNOSTICS_REPORT_PATH) {
        try {
            await fsp.writeFile(
                HIDDEN_CAPTURE_DIAGNOSTICS_REPORT_PATH,
                JSON.stringify(report, null, 2),
                'utf8'
            );
        } catch (error) {
            console.error('[HiddenCaptureDiagnostics] Failed to write report:', error && error.message);
        }
    }

    return report;
}

// Long-running version of the same idea, for the question the short diagnostic cannot
// answer: does capture in a hidden window keep working for hours, or does it quietly stop
// after a while? Frame eviction, memory pressure and idle socket timeouts all take minutes
// to show up, and each platform reacts differently.
async function runHiddenCaptureSoak() {
    const urls = process.argv
        .filter((value) => typeof value === 'string' && value.startsWith('--hidden-capture-soak-url='))
        .map((value) => value.slice('--hidden-capture-soak-url='.length).trim())
        .filter(Boolean);
    if (!urls.length) {
        urls.push(getHiddenCaptureDiagnosticUrl());
    }

    const minutesArg = process.argv.find((value) => typeof value === 'string' && value.startsWith('--hidden-capture-soak-minutes='));
    const minutes = Math.max(1, parseInt(minutesArg ? minutesArg.slice('--hidden-capture-soak-minutes='.length) : '30', 10) || 30);
    const reportArg = process.argv.find((value) => typeof value === 'string' && value.startsWith('--hidden-capture-soak-report='));
    const reportPath = reportArg ? reportArg.slice('--hidden-capture-soak-report='.length) : null;
    // Windows created hidden never get compositor frames at all, so capture there runs
    // entirely on the frame pump. That is the harsher case and the one worth soaking.
    const startHidden = process.argv.includes('--hidden-capture-soak-start-hidden');
    const sourceRoot = getHiddenCaptureDiagnosticSourceRoot();

    const appendLine = async (entry) => {
        if (!reportPath) return;
        try {
            await fsp.appendFile(reportPath, JSON.stringify(entry) + '\n', 'utf8');
        } catch (_) { }
    };

    console.log(`[HiddenCaptureSoak] ${urls.length} window(s), ${minutes} minute(s)`);
    await appendLine({
        type: 'start',
        at: new Date().toISOString(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        platform: process.platform,
        headlessControl: headlessControlEnabled,
        wayland: isWaylandSession(),
        minutes,
        startHidden,
        urls
    });

    await waitForCondition(() => mainWindow && !mainWindow.isDestroyed(), 15000, 100);
    await sleep(500);
    const backgroundProbe = await installHiddenCaptureBackgroundProbe();
    if (typeof sourceWindowCreateHandler !== 'function') {
        throw new Error('Source window IPC handler is not registered yet');
    }

    // Build every window through the real source path, let it settle, then hide it the way
    // the hide button does.
    const windows = [];
    for (const url of urls) {
        const sourceFiles = getHiddenCaptureDiagnosticSourceFiles(url);
        const sourceWindowArgs = { url, visible: !startHidden, sourceFiles };
        if (sourceRoot) sourceWindowArgs.filesource = sourceRoot;
        const created = {};
        sourceWindowCreateHandler(created, sourceWindowArgs);
        const tabID = created.returnValue;
        const view = tabID ? browserViews[tabID] : null;
        if (!view) {
            console.error(`[HiddenCaptureSoak] could not create a window for ${url}`);
            await appendLine({ type: 'error', at: new Date().toISOString(), url, error: 'window-not-created' });
            continue;
        }
        const expectedType = sourceFiles.length ? path.basename(sourceFiles[0], '.js') : null;
        windows.push({ url, tabID, view, sourceFiles, expectedType, samples: [], loadError: null });
    }
    if (!windows.length) {
        throw new Error('No source windows could be created');
    }

    for (const entry of windows) {
        try {
            await waitForCondition(() => {
                try { return !entry.view.webContents.isLoading(); } catch (_) { return false; }
            }, 60000, 250);
        } catch (_) {
            entry.loadError = 'timed-out-loading';
        }
    }
    await sleep(8000); // let chat clients connect and backfill

    for (const entry of windows) {
        try {
            entry.probeInstall = await entry.view.webContents.executeJavaScript(HIDDEN_CAPTURE_PROBE_INSTALL, true);
        } catch (error) {
            entry.probeInstall = `error: ${error && error.message}`;
        }
        // Snapshot what the page actually is. A window that never reports a chat row is
        // usually a page that never loaded a chat - a login wall, a bot check, a dead
        // channel - rather than capture breaking, and that difference matters.
        try {
            entry.snapshot = await entry.view.webContents.executeJavaScript(`(function () {
	var counts = {};
	${JSON.stringify(HIDDEN_CAPTURE_ROW_SELECTOR.split(', '))}.forEach(function (selector) {
		try {
			var n = document.querySelectorAll(selector).length;
			if (n > 0) { counts[selector] = n; }
		} catch (error) { }
	});
	var facebookVideoLinks = [];
	try {
		if (/(^|\.)facebook\.com$/i.test(location.hostname)) {
			var links = document.querySelectorAll('a[href*="/videos/"], a[href*="/watch/?v="], a[href*="/watch/live/"]');
			var seen = {};
			for (var i = 0; i < links.length && facebookVideoLinks.length < 30; i += 1) {
				var href = links[i].href || links[i].getAttribute("href") || "";
				if (!href || seen[href]) { continue; }
				seen[href] = true;
				var contextNode = links[i];
				for (var depth = 0; contextNode && depth < 4; depth += 1) {
					if ((contextNode.innerText || "").trim().length > 40) { break; }
					contextNode = contextNode.parentElement;
				}
				facebookVideoLinks.push({
					href: href,
					text: ((contextNode && contextNode.innerText) || links[i].innerText || "").replace(/\\s+/g, " ").trim().slice(0, 320)
				});
			}
		}
	} catch (error) { }
	return {
		url: location.href,
		title: document.title,
		text: (document.body ? document.body.innerText : "").slice(0, 200).replace(/\\s+/g, " "),
		matchedSelectors: counts,
		facebookLiveDiscovery: window.__ssnFacebookLiveDiscovery || null,
		facebookRecovery: window.__ssnFacebookRecovery || null,
		facebookVideoLinks: facebookVideoLinks
	};
})();`, true);
        } catch (error) {
            entry.snapshot = { error: (error && error.message) || String(error) };
        }
        await appendLine({ type: 'snapshot', at: new Date().toISOString(), url: entry.url, snapshot: entry.snapshot });
        console.log(`[HiddenCaptureSoak] page ${entry.url.slice(0, 46)} -> ${JSON.stringify(entry.snapshot).slice(0, 260)}`);

        if (!startHidden) {
            applySourceWindowVisibility(entry.view, { state: true });
        }
    }
    await sleep(2000);

	const backgroundAtSamplingStart = await readHiddenCaptureBackgroundProbe(backgroundProbe.frame);
	for (const entry of windows) {
		entry.startupDestinationMessages = entry.expectedType && backgroundAtSamplingStart
			? Number(backgroundAtSamplingStart.destinationsByTid && backgroundAtSamplingStart.destinationsByTid[String(entry.tabID)]) || 0
			: 0;
		await appendLine({
			type: 'sampling-start',
			at: new Date().toISOString(),
			url: entry.url,
			tabID: entry.tabID,
			startupDestinationMessages: entry.startupDestinationMessages
		});
	}

    const readSample = async (entry) => {
		const installProbe = () => entry.view.webContents.executeJavaScript(HIDDEN_CAPTURE_PROBE_INSTALL, true);
        const read = () => entry.view.webContents.executeJavaScript(HIDDEN_CAPTURE_PROBE_READ, true);
		await installProbe();
        const before = await read();
		const beforeUrl = await entry.view.webContents.executeJavaScript('location.href', true);
        const backgroundBefore = await readHiddenCaptureBackgroundProbe(backgroundProbe.frame);
        await sleep(5000);
		let after = await read();
		let afterUrl = await entry.view.webContents.executeJavaScript('location.href', true);
		let sampleSeconds = 5;
		let reloaded = beforeUrl !== afterUrl || after.raf < before.raf || after.timer < before.timer;
		let rateBefore = before;
		if (reloaded) {
			await installProbe();
			rateBefore = await read();
			await sleep(1000);
			after = await read();
			afterUrl = await entry.view.webContents.executeJavaScript('location.href', true);
			sampleSeconds = 1;
		}
		let rafPerSecond = Math.round((after.raf - rateBefore.raf) / sampleSeconds);
		let timerPerSecond = Math.round((after.timer - rateBefore.timer) / sampleSeconds);
		let rateRetried = false;
		if (rafPerSecond < 10 || timerPerSecond < 10) {
			const retryBefore = after;
			await sleep(3000);
			const retryAfter = await read();
			afterUrl = await entry.view.webContents.executeJavaScript('location.href', true);
			rafPerSecond = Math.round((retryAfter.raf - retryBefore.raf) / 3);
			timerPerSecond = Math.round((retryAfter.timer - retryBefore.timer) / 3);
			after = retryAfter;
			rateRetried = true;
		}
        const backgroundAfter = await readHiddenCaptureBackgroundProbe(backgroundProbe.frame);
        const beforeTypeCount = entry.expectedType && backgroundBefore
            ? Number(backgroundBefore.destinationsByTid && backgroundBefore.destinationsByTid[String(entry.tabID)]) || 0
            : null;
        const afterTypeCount = entry.expectedType && backgroundAfter
            ? Number(backgroundAfter.destinationsByTid && backgroundAfter.destinationsByTid[String(entry.tabID)]) || 0
            : null;
        return {
			rafPerSecond,
			timerPerSecond,
			rowsAdded: reloaded ? after.rows : after.rows - before.rows,
            rowsTotal: after.rows,
			pageUrl: afterUrl,
			reloaded,
			rateRetried,
            visibilityState: after.visibility,
            nativeVisible: (() => { try { return entry.view.isVisible(); } catch (_) { return null; } })(),
			logicalVisible: typeof entry.view.__ss_visible === 'boolean' ? entry.view.__ss_visible : null,
            messagesSentToDestinations: beforeTypeCount === null || afterTypeCount === null
                ? null
                : afterTypeCount - beforeTypeCount,
            pumped: after.pump ? after.pump.pumpedBatches : null,
            native: after.pump ? after.pump.nativeBatches : null
        };
    };

    const startedAt = Date.now();
    for (let minute = 0; minute < minutes; minute += 1) {
        for (const entry of windows) {
            let sample;
            try {
                if (isBrowserViewDestroyed(entry.view)) throw new Error('window destroyed');
                sample = await readSample(entry);
            } catch (error) {
                sample = { error: (error && error.message) || String(error) };
            }
            sample.minute = minute;
            sample.elapsedMs = Date.now() - startedAt;
            entry.samples.push(sample);
            await appendLine({ type: 'sample', at: new Date().toISOString(), url: entry.url, ...sample });
            console.log(
                `[HiddenCaptureSoak] m${String(minute).padStart(3)} ${entry.url.slice(0, 52).padEnd(52)} ` +
                (sample.error
                    ? `ERROR ${sample.error}`
                    : `rAF/s=${String(sample.rafPerSecond).padStart(3)} timer/s=${String(sample.timerPerSecond).padStart(3)} ` +
                      `rows+=${String(sample.rowsAdded).padStart(4)} total=${String(sample.rowsTotal).padStart(5)} ` +
                      `destinations+=${String(sample.messagesSentToDestinations ?? 0).padStart(4)} ` +
                      `visible=${sample.nativeVisible} frames(native/pumped)=${sample.native}/${sample.pumped}`)
            );
        }
        const spent = Date.now() - startedAt - minute * 60000;
        await sleep(Math.max(1000, 60000 - spent));
    }

    // A window "paused" if capture was working and then stopped: rows arrived at some point
    // while hidden, and then never again before the end of the run.
    const results = windows.map((entry) => {
        const ok = entry.samples.filter((s) => !s.error);
        const rowsWhileHidden = ok.reduce((sum, s) => sum + (s.rowsAdded || 0), 0);
		const activitySamples = entry.expectedType === 'facebook'
			? ok.filter((s) => (s.messagesSentToDestinations || 0) > 0)
			: ok.filter((s) => s.rowsAdded > 0);
		const lastMinuteWithRows = activitySamples.reduce((last, s) => Math.max(last, s.minute), -1);
		const minutesWithRows = activitySamples.length;
        const minRaf = ok.length ? Math.min(...ok.map((s) => s.rafPerSecond)) : null;
        const minTimer = ok.length ? Math.min(...ok.map((s) => s.timerPerSecond)) : null;
        const destinationMessagesWhileHidden = ok.reduce(
            (sum, sample) => sum + (Number.isFinite(sample.messagesSentToDestinations) ? sample.messagesSentToDestinations : 0),
            0
        );
		const everProducedRows = activitySamples.length > 0;
        const quietTailMinutes = everProducedRows ? (minutes - 1 - lastMinuteWithRows) : null;
        return {
            url: entry.url,
            loadError: entry.loadError,
            probeInstall: entry.probeInstall,
            snapshot: entry.snapshot,
            samples: entry.samples.length,
            errors: entry.samples.length - ok.length,
            rowsWhileHidden,
            minutesWithRows,
            lastMinuteWithRows,
            quietTailMinutes,
            minRafPerSecond: minRaf,
            minTimerPerSecond: minTimer,
            destinationMessagesWhileHidden,
			startupDestinationMessages: entry.startupDestinationMessages || 0,
            // Capture is considered stalled if frames stopped entirely, or if a chat that was
            // producing rows went quiet for the last third of the run.
            stalled: ok.length > 0 && (minRaf <= 0 || (everProducedRows && quietTailMinutes > Math.max(3, minutes / 3))),
            // No rows at all proves nothing about whether hiding breaks capture, so it must
            // not read as a pass. Usually it means the page is not showing a live chat.
			inconclusive: (entry.sourceFiles.length > 0 && destinationMessagesWhileHidden <= 0) ||
				(!everProducedRows && entry.expectedType !== 'facebook')
        };
    });

    const summary = {
        type: 'summary',
        at: new Date().toISOString(),
        minutes,
        windows: results,
        success: results.every((r) => !r.stalled && !r.inconclusive && r.errors === 0
            && r.minRafPerSecond > 0 && r.minTimerPerSecond > 10)
    };
    await appendLine(summary);

    console.log('[HiddenCaptureSoak] summary:');
    for (const r of results) {
        console.log(
            `[HiddenCaptureSoak]   ${r.url.slice(0, 60).padEnd(60)} rows=${String(r.rowsWhileHidden).padStart(5)} ` +
			`minutesWithRows=${r.minutesWithRows}/${r.samples} minRaf=${r.minRafPerSecond} ` +
			`minTimer=${r.minTimerPerSecond} ` +
			`startup=${r.startupDestinationMessages} destinations=${r.destinationMessagesWhileHidden} ` +
			`quietTail=${r.quietTailMinutes} errors=${r.errors} stalled=${r.stalled}` +
            `${r.inconclusive ? ' INCONCLUSIVE(no chat rows seen)' : ''}`
        );
    }

    return summary;
}

async function runWindowStateDiagnostics() {
    const report = {
        startedAt: new Date().toISOString(),
        platform: process.platform,
        displays: screen.getAllDisplays().map((display) => ({
            id: display.id,
            label: display.label || null,
            scaleFactor: display.scaleFactor || 1,
            bounds: display.bounds,
            workArea: display.workArea
        })),
        cases: [],
        summary: {
            passed: 0,
            failed: 0
        }
    };

    const fixturePath = getWindowStateDiagnosticFixturePath();
    const originalDockState = store.get('windowState_dock');

    if (!fs.existsSync(fixturePath)) {
        throw new Error(`Diagnostic fixture missing: ${fixturePath}`);
    }

    try {
        await waitForCondition(() => mainWindow && !mainWindow.isDestroyed(), 15000, 100);
        await waitForCondition(() => mainWindow.webContents && !mainWindow.webContents.isLoading(), 30000, 100);
        await sleep(1000);

        const displays = screen.getAllDisplays();
        const cases = [];
        for (let index = 0; index < displays.length; index += 1) {
            const display = displays[index];
            const exactBounds = getWindowStateDiagnosticTargetBounds(display, index);
            cases.push({
                id: `display-${display.id}-${index}-exact`,
                display,
                seededState: {
                    x: exactBounds.x,
                    y: exactBounds.y,
                    width: exactBounds.width,
                    height: exactBounds.height,
                    displayId: display.id,
                    scaleFactor: display.scaleFactor || 1
                },
                targetBounds: exactBounds
            });

            const workArea = getDisplayWorkAreaBounds(display);
            const oversizedSeed = {
                x: workArea.x + 80,
                y: workArea.y + 70,
                width: workArea.width + 420,
                height: workArea.height + 310,
                displayId: display.id,
                scaleFactor: display.scaleFactor || 1
            };
            cases.push({
                id: `display-${display.id}-${index}-oversized`,
                display,
                seededState: oversizedSeed,
                targetBounds: getClampedVisibleBoundsForDisplay(display, oversizedSeed)
            });

            const offscreenSeed = {
                x: workArea.x + workArea.width + 1600,
                y: workArea.y + workArea.height + 1200,
                width: Math.min(900, Math.max(420, workArea.width - 220)),
                height: Math.min(700, Math.max(320, workArea.height - 220)),
                displayId: display.id,
                scaleFactor: display.scaleFactor || 1
            };
            cases.push({
                id: `display-${display.id}-${index}-offscreen`,
                display,
                seededState: offscreenSeed,
                targetBounds: getClampedVisibleBoundsForDisplay(display, {
                    x: Math.round(workArea.x + Math.max(workArea.width - offscreenSeed.width, 0) / 2),
                    y: Math.round(workArea.y + Math.max(workArea.height - offscreenSeed.height, 0) / 2),
                    width: offscreenSeed.width,
                    height: offscreenSeed.height
                })
            });
        }

        for (const testCase of cases) {
            const {
                id,
                display,
                seededState,
                targetBounds
            } = testCase;
            const diagnosticUrl = buildWindowStateDiagnosticUrl(id);

            try {
                store.set('windowState_dock', seededState);

                const firstWindow = await openWindowStateDiagnosticChildWindow(diagnosticUrl);
                await waitForWindowStateDiagnosticReady(firstWindow);
                await sleep(400);

                const restoredBounds = firstWindow.getBounds();
                const restoredDiff = compareWindowBounds(targetBounds, restoredBounds);
                const restoredPassed = isWindowBoundsWithinTolerance(
                    restoredDiff,
                    getWindowStateDiagnosticsTolerance(firstWindow)
                ) && isWindowWithinWorkArea(restoredBounds, display.workArea);
                await closeWindowStateDiagnosticChildWindow(firstWindow);
                await sleep(300);

                const savedState = store.get('windowState_dock');
                const reopenedWindow = await openWindowStateDiagnosticChildWindow(diagnosticUrl);
                await waitForWindowStateDiagnosticReady(reopenedWindow);
                const reopenedBounds = reopenedWindow.getBounds();
                const reopenedDiff = compareWindowBounds(targetBounds, reopenedBounds);
                const reopenedPassed = isWindowBoundsWithinTolerance(
                    reopenedDiff,
                    getWindowStateDiagnosticsTolerance(reopenedWindow)
                ) && isWindowWithinWorkArea(reopenedBounds, display.workArea);
                const passed = restoredPassed && reopenedPassed;

                report.cases.push({
                    id,
                    displayId: display.id,
                    scaleFactor: display.scaleFactor || 1,
                    workArea: display.workArea,
                    seededState,
                    targetBounds,
                    restoredBounds,
                    restoredDiff,
                    restoredPassed,
                    savedState,
                    reopenedBounds,
                    reopenedDiff,
                    reopenedPassed,
                    passed
                });

                if (passed) {
                    report.summary.passed += 1;
                } else {
                    report.summary.failed += 1;
                }

                await closeWindowStateDiagnosticChildWindow(reopenedWindow);
            } catch (error) {
                report.cases.push({
                    id,
                    displayId: display.id,
                    scaleFactor: display.scaleFactor || 1,
                    workArea: display.workArea,
                    seededState,
                    targetBounds,
                    error: error && error.message ? error.message : String(error),
                    passed: false
                });
                report.summary.failed += 1;
            }
        }
    } finally {
        if (typeof originalDockState === 'undefined') {
            store.delete('windowState_dock');
        } else {
            store.set('windowState_dock', originalDockState);
        }
    }

    report.finishedAt = new Date().toISOString();
    report.success = report.summary.failed === 0;

    if (WINDOW_STATE_DIAGNOSTICS_REPORT_PATH) {
        await fsp.writeFile(WINDOW_STATE_DIAGNOSTICS_REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
    }

    return report;
}

function getTtsDiagnosticBuffer(value) {
    if (!value) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value instanceof ArrayBuffer) {
        return Buffer.from(value);
    }
    if (Array.isArray(value)) {
        return Buffer.from(value);
    }
    if (value.type === 'Buffer' && Array.isArray(value.data)) {
        return Buffer.from(value.data);
    }
    if (value.buffer instanceof ArrayBuffer) {
        return Buffer.from(value.buffer, value.byteOffset || 0, value.byteLength || value.length || 0);
    }
    return null;
}

function validateTtsDiagnosticResponse(response) {
    const errors = [];
    if (!response || typeof response !== 'object') {
        errors.push('No response object returned.');
    } else {
        if (!Number.isFinite(response.byteLength) || response.byteLength <= 44) {
            errors.push(`WAV response is too small: ${response.byteLength}`);
        }
        if (response.riffSignature !== 'RIFF') {
            errors.push(`Missing RIFF signature: ${response.riffSignature}`);
        }
        if (response.waveSignature !== 'WAVE') {
            errors.push(`Missing WAVE signature: ${response.waveSignature}`);
        }
    }
    return errors;
}

async function runTtsDiagnosticRequest(text, settings) {
    const startedAt = Date.now();
    const wavBuffer = await enqueueTtsRequest({ text, settings });
    const bytes = getTtsDiagnosticBuffer(wavBuffer);
    const response = bytes
        ? {
            byteLength: bytes.byteLength,
            riffSignature: bytes.toString('ascii', 0, 4),
            waveSignature: bytes.toString('ascii', 8, 12),
            elapsedMs: Date.now() - startedAt
        }
        : {
            byteLength: 0,
            riffSignature: '',
            waveSignature: '',
            elapsedMs: Date.now() - startedAt
        };
    const errors = validateTtsDiagnosticResponse(response);
    return {
        text,
        settings,
        ...response,
        passed: errors.length === 0,
        errors
    };
}

async function runTtsDiagnostics() {
    const report = {
        startedAt: new Date().toISOString(),
        platform: process.platform,
        requests: [],
        snapshots: {},
        summary: {
            passed: 0,
            failed: 0,
            workerCreateDelta: 0,
            completedRequestDelta: 0,
            workerModelLoadCount: 0
        }
    };

    report.snapshots.before = getTtsDiagnosticsSnapshot();

    const cases = [
        {
            text: 'Social Stream local TTS diagnostic one.',
            settings: { voice: 'af_aoede', speed: 1 }
        },
        {
            text: 'Social Stream local TTS diagnostic two.',
            settings: { voice: 'af_aoede', speed: 1 }
        }
    ];

    for (const testCase of cases) {
        let result;
        try {
            result = await runTtsDiagnosticRequest(testCase.text, testCase.settings);
        } catch (error) {
            result = {
                text: testCase.text,
                settings: testCase.settings,
                byteLength: 0,
                riffSignature: '',
                waveSignature: '',
                elapsedMs: 0,
                passed: false,
                errors: [error && error.message ? error.message : String(error)]
            };
        }
        report.requests.push(result);
        if (result.passed) {
            report.summary.passed += 1;
        } else {
            report.summary.failed += 1;
        }
    }

    report.snapshots.after = getTtsDiagnosticsSnapshot();
    report.summary.workerCreateDelta =
        report.snapshots.after.workerCreateCount - report.snapshots.before.workerCreateCount;
    report.summary.completedRequestDelta =
        report.snapshots.after.completedRequestCount - report.snapshots.before.completedRequestCount;
    report.summary.workerModelLoadCount = report.snapshots.after.workerModelLoadCount;

    if (report.summary.workerCreateDelta !== 1) {
        report.summary.failed += 1;
        report.requests.push({
            passed: false,
            errors: [`Expected one TTS worker for two requests; created ${report.summary.workerCreateDelta}.`]
        });
    }
    if (report.summary.completedRequestDelta !== cases.length) {
        report.summary.failed += 1;
        report.requests.push({
            passed: false,
            errors: [`Expected ${cases.length} completed TTS requests; completed ${report.summary.completedRequestDelta}.`]
        });
    }
    if (report.summary.workerModelLoadCount !== 1) {
        report.summary.failed += 1;
        report.requests.push({
            passed: false,
            errors: [`Expected one Kokoro model load in the worker; observed ${report.summary.workerModelLoadCount}.`]
        });
    }

    report.finishedAt = new Date().toISOString();
    report.success = report.summary.failed === 0;

    if (TTS_DIAGNOSTICS_REPORT_PATH) {
        await fsp.writeFile(TTS_DIAGNOSTICS_REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
    }

    return report;
}

const DEFAULT_SOURCE_WINDOW_X = 635;
const DEFAULT_SOURCE_WINDOW_Y = 100;
const DEFAULT_SOURCE_WINDOW_WIDTH = 1366;
const DEFAULT_SOURCE_WINDOW_HEIGHT = 768;

function normalizeRememberedSourceWindowMode(mode) {
    if (mode === "signin" || mode === "wss") {
        return mode;
    }
    return "classic";
}

function getRememberedSourceWindowPlatform(args) {
    if (args && args.platform) {
        return String(args.platform).trim().toLowerCase();
    }

    try {
        const domain = getPrimaryDomain(args && args.url ? args.url : "");
        const platform = resolveSessionPlatform(args, domain);
        if (platform) {
            return String(platform).trim().toLowerCase();
        }
    } catch (_) { }

    return "default";
}

function getRememberedSourceWindowKey(args, mode) {
    const platform = getRememberedSourceWindowPlatform(args).replace(/[^a-z0-9_-]/g, "_") || "default";
    const normalizedMode = normalizeRememberedSourceWindowMode(mode);
    return `sourceWindowState_${platform}_${normalizedMode}`;
}

function getConfiguredSourceWindowSize(args, mode) {
    const normalizedMode = normalizeRememberedSourceWindowMode(mode);
    let size = null;

    if (args && args.size) {
        size = { ...args.size };
    } else if (args && args.configs) {
        const platform = getRememberedSourceWindowPlatform(args);
        const platformConfig = args.configs[platform];

        if (args.configs.global && args.configs.global.size) {
            size = { ...args.configs.global.size };
        }
        if (platformConfig && platformConfig.size) {
            size = { ...(size || {}), ...platformConfig.size };
        }
        if (normalizedMode === "signin" && platformConfig && platformConfig.signin && platformConfig.signin.size) {
            size = { ...(size || {}), ...platformConfig.signin.size };
        } else if (normalizedMode === "wss" && platformConfig && platformConfig.wss && platformConfig.wss.size) {
            size = { ...(size || {}), ...platformConfig.wss.size };
        }
    } else if (args && args.config && args.config.size) {
        size = { ...args.config.size };
    }

    const width = Math.max(parseInt(size && size.width, 10) || 0, 100) || DEFAULT_SOURCE_WINDOW_WIDTH;
    const height = Math.max(parseInt(size && size.height, 10) || 0, 100) || DEFAULT_SOURCE_WINDOW_HEIGHT;

    return { width, height };
}

function loadRememberedSourceWindowBounds(args, mode) {
    const savedState = validateSavedBounds(store.get(getRememberedSourceWindowKey(args, mode)));
    if (savedState) {
        return savedState;
    }

    const size = getConfiguredSourceWindowSize(args, mode);
    return {
        x: DEFAULT_SOURCE_WINDOW_X,
        y: DEFAULT_SOURCE_WINDOW_Y,
        width: size.width,
        height: size.height
    };
}

function saveRememberedSourceWindowBounds(window, mode) {
    try {
        if (!window || (typeof window.isDestroyed === "function" && window.isDestroyed())) {
            return;
        }
        if (window.__ss_visible === false) {
            return;
        }

        const bounds = window.getBounds();
        const display = screen.getDisplayMatching(bounds);
        const stateKey = getRememberedSourceWindowKey(window.args || {}, mode);

        store.set(stateKey, {
            width: Math.max(parseInt(bounds.width, 10) || 0, 100),
            height: Math.max(parseInt(bounds.height, 10) || 0, 100),
            x: bounds.x,
            y: bounds.y,
            displayId: display.id,
            scaleFactor: display.scaleFactor || 1
        });
    } catch (_) { }
}

function installRememberedSourceWindowBoundsTracking(window, mode) {
    if (!window) return;

    let readyToSave = false;
    let saveTimeout = null;

    setTimeout(() => {
        readyToSave = true;
    }, 500);

    const scheduleSave = () => {
        if (!readyToSave) return;
        if (window.__ss_visible === false) return;

        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            saveRememberedSourceWindowBounds(window, mode);
        }, 100);
    };

    window.on("resize", scheduleSave);
    window.on("move", scheduleSave);
    window.once("closed", () => {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
        }
    });
}

function setPopupUnclickableForWindow(win, enabled) {
    try {
        if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
        if (win === mainWindow) return;
        win.mouseEvent = !!enabled;
        win.setIgnoreMouseEvents(!!enabled);
    } catch (_) { }
}

function applyPopupUnclickableStateToWindows(enabled) {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
        setPopupUnclickableForWindow(win, enabled);
    }
}

function setPopupUnclickableEnabled(enabled) {
    popupUnclickableEnabled = !!enabled;
    try {
        store.set(POPUP_UNCLICKABLE_ALL_KEY, popupUnclickableEnabled);
    } catch (_) { }
    applyPopupUnclickableStateToWindows(popupUnclickableEnabled);
    try {
        createMenu();
    } catch (_) { }
}

var ver = app.getVersion();

const argDescriptions = {};

let windowIdCounter = new Map();
// Guard to prevent multiple main-process YouTube ad-skipper intervals
let YT_AD_SKIPPER_INTERVAL = null;

function getActiveBrowserView(id) {
    const view = browserViews[id];
    if (!view) return null;
    try {
        if (isBrowserViewDestroyed(view)) {
            delete browserViews[id];
            releaseWindowId(id);
            return null;
        }
    } catch (error) {
        console.warn('Error validating browser view state:', error);
        return null;
    }
    return view;
}

function isBrowserViewDestroyed(view) {
    if (!view) return true;
    try {
        if (typeof view.isDestroyed === 'function') {
            return !!view.isDestroyed();
        }
        const wc = view.webContents;
        if (wc && typeof wc.isDestroyed === 'function') {
            return !!wc.isDestroyed();
        }
    } catch (error) {
        console.warn('Error checking browser view state:', error);
        return true;
    }
    return false;
}

function generateUniqueWindowId() {
    let id = 1;
    while (browserViews[id] || windowIdCounter.has(id)) {
        id++;
    }
    windowIdCounter.set(id, true);
    return id;
}

function releaseWindowId(id) {
    windowIdCounter.delete(id);
}

function getCliArgs() {
    return process.argv.slice(app.isPackaged ? 1 : 2);
}

const CLI_ARGS = getCliArgs();

function createYargs() {
    var argv = Yargs(CLI_ARGS).scriptName("socialstream").usage("Usage: $0 [options]")
        .example(
            "$0 -w 1280 -h 720 -u https://vdo.ninja/?view=xxxx",
            "Loads the stream with ID xxxx into a window sized 1280x720"
        )
        .help("help")
        .describe("help", "Show this help message.");

    function addOption(key, config) {
        argv = argv.option(key, config);
        argDescriptions[key] = config.describe;
    }


    addOption("w", {
        alias: "width",
        describe: "The width of the window in pixel.",
        type: "number",
        nargs: 1,
        default: 1280,
    });
    addOption("h", {
        alias: "height",
        describe: "The height of the window in pixels.",
        type: "number",
        nargs: 1,
        default: 800,
    });
    addOption("u", {
        alias: "url",
        describe: "The URL of the window to load.",
        default: pathToFileURL(path.join(__dirname, "index.html")).href,
        type: "string",
    });
    addOption("fs", {
        alias: "filesource",
        describe: "The location of the local source files. Default is current directory.",
        default: "",
        type: "string",
    });
    addOption("t", {
        alias: "title",
        describe: "The default Title for the app Window",
        type: "string",
        default: null,
    });
    addOption("p", {
        alias: "pin",
        describe: "Toggle always on top",
        type: "boolean",
        default: process.platform == "darwin",
    });
    addOption("a", {
        alias: "hwa",
        describe: "Enable Hardware Acceleration",
        type: "boolean",
        default: true,
    });
    addOption("x", {
        describe: "Window X position",
        type: "number",
        default: -1,
    });
    addOption("y", {
        describe: "Window Y position",
        type: "number",
        default: -1,
    });
    addOption("node", {
        alias: "n",
        describe: "Enables node-integration, allowing for screen capture, global hotkeys, prompts, and more.",
        type: "boolean",
        default: true,
    });
    addOption("minimized", {
        alias: "min",
        describe: "Starts the window minimized",
        type: "boolean",
        default: false,
    });
    addOption("fullscreen", {
        alias: "f",
        describe: "Enables full-screen mode for the first window on its load.",
        type: "boolean",
        default: false,
    });
    addOption("unclickable", {
        alias: "uc",
        describe: "The page will pass thru any mouse clicks or other mouse events",
        type: "boolean",
        default: false,
    });
    addOption("savefolder", {
        alias: "sf",
        describe: "Where to save a file on disk",
        type: "string",
        default: null,
    });
    addOption("mediafoundation", {
        alias: "mf",
        describe: "Enable media foundation video capture",
        type: "string",
        default: null,
    });
    addOption("disablemediafoundation", {
        alias: "dmf",
        describe: "Disable media foundation video capture; helps capture some webcams",
        type: "string",
        default: null,
    });
    addOption("locale", {
        alias: "loc",
        describe: "Force Chromium locale (e.g. pt-BR) for testing regional behaviour.",
        type: "string",
        default: null,
    });
    addOption("css", {
        describe: "Have local CSS script be auto-loaded into every page",
        type: "string",
        default: null,
    });
    addOption("chroma", {
        alias: "color",
        describe: "Set background CSS to target hex color; FFF or 0000 are examples.",
        type: "string",
        default: null,
    });

    addOption("filesource", {
        describe: "Specify where the social stream ninja extension code is located",
        type: "string",
        default: null,
    });
    addOption("preferlocalassets", {
        describe: "Force bundled Social Stream assets to load before remote copies",
        type: "boolean",
        default: false,
    });
    addOption("tiktokclassic", {
        alias: "tc",
        describe: "Force TikTok sources to use classic (HTTP) mode instead of WebSockets.",
        type: "boolean",
        default: false
    });
    addOption("multiinstance", {
        alias: ["standalone"],
        describe: "Opt-out of the single-instance lock so this launch runs as its own process.",
        type: "boolean",
        default: false
    });
    addOption("closetotray", {
        alias: ["tray"],
        describe: "Minimize to system tray instead of quitting when closing the window.",
        type: "boolean",
        default: false
    });


    const options = argv.getOptions();
    Object.keys(options.key).forEach((key) => {
        try {
            if (options.describe && options.describe[key]) {
                argDescriptions[key] = options.describe[key];
            }
        } catch (e) {
            console.error(`Error processing option ${key}:`, e);
        }
    });

    return argv;
}

var Args = createYargs();
if (CLI_ARGS.includes('--help')) {
    Args.showHelp((helpText) => {
        try {
            fs.writeSync(1, `${helpText}\n`);
        } catch (_) {
            console.log(helpText);
        }
    });
    markStabilitySessionGraceful('cli-help', { force: true });
    process.exit(0);
}
var Argv = Args.argv;
const storedStartupFlags = (() => {
    try {
        const raw = store.get('startupFlags');
        if (raw && typeof raw === 'object') {
            return raw;
        }
    } catch (_) { }
    return {};
})();

const cliPreferLocalAssetsProvided = process.argv.includes('--preferlocalassets');
const cliPreferLocalAssets = cliPreferLocalAssetsProvided || Argv.preferlocalassets === true;
const storedPreferLocalAssets = storedStartupFlags.preferLocalAssets === true;
const envPreferLocalAssetsRaw = process.env.SSAPP_PREFER_LOCAL_ASSETS;
const hasEnvPreferLocalAssets = envPreferLocalAssetsRaw !== undefined;

if (cliPreferLocalAssets) {
    process.env.SSAPP_PREFER_LOCAL_ASSETS = '1';
} else if (!hasEnvPreferLocalAssets) {
    process.env.SSAPP_PREFER_LOCAL_ASSETS = storedPreferLocalAssets ? '1' : '0';
}

const preferLocalAssetsFlag = process.env.SSAPP_PREFER_LOCAL_ASSETS === '1';

const cliAllowMultipleInstancesProvided = (
    process.argv.includes('--multiinstance') ||
    process.argv.includes('--standalone')
);
const cliAllowMultipleInstances = cliAllowMultipleInstancesProvided || Argv.multiinstance === true || Argv.standalone === true;
const storedAllowMultipleInstances = storedStartupFlags.allowMultipleInstances === true;
const allowMultipleInstances = cliAllowMultipleInstances || storedAllowMultipleInstances;

// Close-to-tray: minimize to system tray instead of quitting when closing the window
const cliCloseToTrayProvided = (
    process.argv.includes('--closetotray') ||
    process.argv.includes('--tray')
);
const cliCloseToTray = cliCloseToTrayProvided || Argv.closetotray === true || Argv.tray === true;
const storedCloseToTray = storedStartupFlags.closeToTray === true;
let closeToTrayEnabled = cliCloseToTray || storedCloseToTray;

const cliForceTikTokClassicProvided = (
    process.argv.includes('--tiktokclassic') ||
    process.argv.includes('--tc')
);
const CLI_FORCE_TIKTOK_CLASSIC = cliForceTikTokClassicProvided || Argv.tiktokclassic === true;
const storedForceTikTokClassic = storedStartupFlags.forceTikTokClassic === true;
const envForceTikTokClassicRaw = process.env.SSAPP_FORCE_TIKTOK_CLASSIC;
const hasEnvForceTikTokClassic = envForceTikTokClassicRaw !== undefined;
if (CLI_FORCE_TIKTOK_CLASSIC) {
    process.env.SSAPP_FORCE_TIKTOK_CLASSIC = '1';
} else if (!hasEnvForceTikTokClassic) {
    process.env.SSAPP_FORCE_TIKTOK_CLASSIC = storedForceTikTokClassic ? '1' : '0';
}
let runtimeForceTikTokClassic = CLI_FORCE_TIKTOK_CLASSIC || process.env.SSAPP_FORCE_TIKTOK_CLASSIC === '1';

function showCommandLineArguments() {

    const argInfo = Args.getOptions();
    const argWindow = new BrowserWindow({
        width: 1280,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            additionalPermissions: ['clipboard-write']
        }
    });

    argWindow.loadURL(`data:text/html,${encodeURIComponent(generateArgHTML(argInfo))}`);
}

function generateArgHTML(argInfo) {
    let html = `
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
        </style>
      </head>
      <body>
        <h1>Command Line Arguments</h1>
        <table>
          <tr>
            <th>Option</th>
            <th>Alias</th>
            <th>Description</th>
            <th>Type</th>
            <th>Default</th>
          </tr>
  `;

    for (const [key, option] of Object.entries(argInfo.key)) {
        const alias = argInfo.alias[key] ? argInfo.alias[key].join(', ') : '';
        const type = argInfo.boolean.includes(key) ? 'boolean' :
            argInfo.string.includes(key) ? 'string' :
                argInfo.number.includes(key) ? 'number' : '';
        const defaultValue = argInfo.default[key] !== undefined ? argInfo.default[key] : '';

        html += `
      <tr>
        <td>${key}</td>
        <td>${alias}</td>
        <td>${argDescriptions[key] || ''}</td>
        <td>${type}</td>
        <td>${defaultValue}</td>
      </tr>
    `;
    }

    html += `
      </table>
    </body>
    </html>
  `;

    return html;
}

if (!allowMultipleInstances) {
    if (!app.requestSingleInstanceLock(Argv)) {
        log("requestSingleInstanceLock");
        quitApp();
    }
} else {
    log("Multi-instance mode enabled; skipping single-instance lock.");
}

function getDirectories(path) {
    return fs.readdirSync(path).filter(function (file) {
        return fs.statSync(path + "/" + file).isDirectory();
    });
}

if (!Argv.hwa) {
    app.disableHardwareAcceleration();
    log("HWA DISABLED");
}

// Media foundation switches
if (!Argv.mf) {
    enableChromiumFeatures("MediaFoundationVideoCapture");
}
if (!Argv.dmf) {
    disableChromiumFeatures("MediaFoundationVideoCapture");
}

// WebRTC and media performance flags
app.commandLine.appendSwitch("webrtc-max-cpu-consumption-percentage", "100");
if (!IS_MAC_BALANCED_MODE) {
    app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
}
app.commandLine.appendSwitch("max-web-media-player-count", "5000");

// Network and security flags
app.commandLine.appendSwitch("ignore-certificate-errors");
// disable-http-cache removed: was preventing Facebook/Twitch SharedWorker MQTT real-time delivery;
// SSN GitHub source fetches use { cache: 'no-store' } in fetchWithTimeout instead
app.commandLine.appendSwitch('dns-server', '1.1.1.1,8.8.8.8');

// Enable experimental features for better compatibility
app.commandLine.appendSwitch("enable-experimental-web-platform-features");
if (!IS_MAC_BALANCED_MODE && !stabilityGpuProfile.disableUnsafeWebGpu) {
    app.commandLine.appendSwitch('enable-unsafe-webgpu');
} else if (stabilityGpuProfile.disableUnsafeWebGpu) {
    console.warn('[Stability] WebGPU flag disabled due to fallback level', stabilityGpuProfile.level);
}
enableChromiumFeatures('WebAssemblySimd');

// Memory allocation for JavaScript
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

var counter = 0;
var forcingAspectRatio = false;

var cachedState = {};
var cachedStateReady = false;

// Settings validation thresholds
const SETTINGS_VALIDATION = {
    // Minimum keys before we consider settings "established" and worth protecting
    MIN_EXISTING_KEYS: 5,
    // If incoming has less than this ratio of existing keys, likely incomplete load
    PARTIAL_THRESHOLD_RATIO: 0.5,
};
const CACHED_STATE_SOURCE_PRIORITY = {
    runtime: 100,
    "savedSync.json": 80,
    "savedSync.json.bak": 70,
    "electron-store backup": 60,
    "localStorage backup": 40,
    "localStorage mirror": 30
};
let cachedStatePersistenceBaseline = null;
let cachedStateRecoveryQueued = false;

// cachedState.state = false;

// Debounce state for storageSave to batch rapid sequential saves
let storageSaveDebounceTimer = null;
let storageSavePending = false;
let storageSavePendingAllowSettingsDowngrade = false;

var mainWindow = null;
let mainWindowVisible = false;
let ttt = {
    width: 1280,
    height: 800
};

var extensions = [];
try {
    var dir = false;
    if (process.platform == "win32") {
        dir = process.env.APPDATA.replace("Roaming", "") + "\\Local\\Google\\Chrome\\User Data\\Default\\Extensions";
        if (dir) {
            //dir = dir.replace("Roaming","");
            var getDir = getDirectories(dir);
            getDir.forEach((d) => {
                try {
                    var ddd = getDirectories(dir + "\\" + d);
                    var fd = fs.readFileSync(dir + "\\" + d + "\\" + ddd[0] + "\\manifest.json", "utf8");
                    var json = JSON.parse(fd);

                    if (json.name.startsWith("_")) {
                        return;
                    }

                    extensions.push({
                        name: json.name,
                        location: dir + "\\" + d + "\\" + ddd[0],
                    });
                } catch (e) { }
            });
        }
    } else if (process.platform == "darwin") {
        dir = process.env.HOME + "/Library/Application Support/Google/Chrome/Default/Extensions";
        log(dir);
        if (dir) {
            //dir = dir.replace("Roaming","");
            var getDir = getDirectories(dir);
            getDir.forEach((d) => {
                try {
                    var ddd = getDirectories(dir + "/" + d);
                    if (!ddd.length) {
                        return;
                    }
                    var fd = fs.readFileSync(dir + "/" + d + "/" + ddd[0] + "/manifest.json", "utf8");
                    var json = JSON.parse(fd);

                    if (json.name.startsWith("_")) {
                        return;
                    }

                    extensions.push({
                        name: json.name,
                        location: dir + "/" + d + "/" + ddd[0],
                    });
                } catch (e) {
                    console.error(e);
                }
            });
        }
    }
} catch (e) {
    console.error(e);
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function formatURL(inputURL, browserWindow) {
    inputURL = inputURL.trim();

    if (inputURL.match(/^[a-zA-Z]+:\/\//)) {
        return inputURL;
    }

    if (inputURL.startsWith('/') || inputURL.match(/^[a-zA-Z]:\\/)) {
        return pathToFileURL(inputURL).href;
    }

    if (inputURL.startsWith('www.')) {
        return `https://${inputURL}`;
    }

    if (inputURL.match(/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/)) {
        return `https://${inputURL}`;
    }

    // If it doesn't look like a URL, ask the user what to do
    const {
        response
    } = await dialog.showMessageBox(browserWindow, {
        type: 'question',
        buttons: ['Search', 'Treat as URL', 'Cancel'],
        defaultId: 2,
        title: 'Confirm Action',
        message: `"${inputURL}" doesn't look like a URL. What would you like to do?`,
    });

    if (response === 0) { // Search
        const searchEngines = {
            'Google': 'https://www.google.com/search?q=',
            'DuckDuckGo': 'https://duckduckgo.com/?q=',
            'Bing': 'https://www.bing.com/search?q=',
        };

        const {
            response: engineChoice
        } = await dialog.showMessageBox(browserWindow, {
            type: 'question',
            buttons: Object.keys(searchEngines),
            defaultId: 0,
            title: 'Choose Search Engine',
            message: 'Select your preferred search engine:',
        });

        const chosenEngine = Object.values(searchEngines)[engineChoice];
        return `${chosenEngine}${encodeURIComponent(inputURL)}`;
    } else if (response === 1) { // Treat as URL
        return `https://${inputURL}`;
    } else { // Cancel
        return null;
    }
}

class WebSocketServer {
    constructor(port = DEFAULT_LOCAL_WEBSOCKET_PORT, host = DEFAULT_LOCAL_WEBSOCKET_HOST) {
        this.server = null;
        this.port = normalizeLocalWebSocketPort(port) || DEFAULT_LOCAL_WEBSOCKET_PORT;
        this.host = normalizeLocalWebSocketHost(host) || DEFAULT_LOCAL_WEBSOCKET_HOST;
        this.connections = new Set();
        this.started = false;
        this.callback = {};
    }

    handleConnection(webSocketClient, request) {
        var out = false;
        const pathComponents = request.url.split('/');

        // Handle path-based connection parameters
        if (pathComponents.length >= 3 && pathComponents[1] === 'join') {
            if (pathComponents[2]) {
                webSocketClient.room = pathComponents[2];
            }
            if (pathComponents.length >= 4) {
                const inChannel = parseInt(pathComponents[3], 10);
                if (!isNaN(inChannel)) {
                    webSocketClient.inn = inChannel;
                }
            }
            if (pathComponents.length >= 5) {
                const outChannel = parseInt(pathComponents[4], 10);
                if (!isNaN(outChannel)) {
                    webSocketClient.out = outChannel;
                    out = outChannel;
                }
            }
        }

        webSocketClient.on('message', (message) => {
            try {
                // Handle room joining via message if not already in a room
                if (!webSocketClient.room) {
                    try {
                        var msg = JSON.parse(message);
                        if ("join" in msg) {
                            webSocketClient.room = msg.join + "";
                            if ("out" in msg) {
                                webSocketClient.out = msg.out;
                                out = msg.out;
                            } else {
                                webSocketClient.out = false;
                            }
                            if ("in" in msg) {
                                webSocketClient.inn = msg.in;
                            } else {
                                webSocketClient.inn = false;
                            }
                        }
                        return;
                    } catch (e) {
                        return;
                    }
                }

                var msg = JSON.parse(message);

                if (msg.callback && ("get" in msg.callback)) {
                    if (this.callback[msg.callback.get]) {
                        if ("result" in msg.callback) {
                            if (typeof msg.callback.result == 'object') {
                                this.callback[msg.callback.get].resolve(JSON.stringify(msg.callback.result));
                            } else {
                                this.callback[msg.callback.get].resolve(msg.callback.result);
                            }
                        } else {
                            this.callback[msg.callback.get].resolve("null");
                        }
                    }
                    return;
                }

                const outChannel = msg.out || out;

                this.server.clients.forEach(client => {
                    if (webSocketClient != client) {
                        // Rooms are the local relay's session boundary. Without this
                        // check, clients using the same port but different Social
                        // Stream sessions can receive each other's traffic whenever
                        // their channel numbers happen to match.
                        if (!webSocketClient.room || client.room !== webSocketClient.room) {
                            return;
                        }
                        if (client.inn && outChannel) {
                            if (client.inn == outChannel) {
                                try {
                                    client.send(message.toString());
                                } catch (e) { }
                            }
                        } else if (client.inn || outChannel) {
                            // skip
                        } else {
                            try {
                                client.send(message.toString());
                            } catch (e) { }
                        }
                    }
                });
            } catch (e) {
                //
            }
        });

        webSocketClient.on('close', () => {
            this.connections.delete(webSocketClient);
        });

        this.connections.add(webSocketClient);
    }

    start(update = false) {

        if (this.server) {
            return {
                success: false,
                message: 'Server already running'
            };
        }

        try {
            const server = new WebSocket.Server({
                port: this.port,
                host: this.host
            });
            this.server = server;
            this.server.on('connection', (ws, req) => this.handleConnection(ws, req));
            this.server.on('error', (error) => {
                console.error(`[Local WebSocket] Server error on ${this.host}:${this.port}:`, error && error.message ? error.message : error);
                if (this.server === server) this.server = null;
                this.started = false;
                try {
                    cachedState.wsServer = false;
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send("fromMainToIndex", "serverStopped", { port: this.port });
                    }
                    createMenu();
                } catch (notifyError) {
                    log(notifyError);
                }
            });
            this.started = true;

            try {
                cachedState.wsServer = true;
                if (update) {
                    mainWindow.webContents.send("fromMainToIndex", "serverStarted", { port: this.port });
                }
            } catch (error) {
                log(error);
            }

            return {
                success: true,
                message: `Server started on ${this.host}:${this.port}`
            };
        } catch (error) {

            try {
                cachedState.wsServer = false;
                if (update) {
                    mainWindow.webContents.send("fromMainToIndex", "serverStopped");
                }
            } catch (error) {
                log(error);
            }

            return {
                success: false,
                message: error.message
            };
        }
    }

    stop(update = false) {
        if (!this.server) {
            return {
                success: false,
                message: 'Server not running'
            };
        }
        try {
            cachedState.wsServer = false;
            if (update) {
                mainWindow.webContents.send("fromMainToIndex", "serverStopped", { port: this.port });
            }
        } catch (error) {
            log(error);
        }
        try {
            for (const client of this.connections) {
                client.terminate();
            }
            this.connections.clear();
        } catch (error) {
            log(error);
        }

        try {
            this.server.close();
            this.server = null;


            this.started = false;
            return {
                success: true,
                message: 'Server stopped'
            };
        } catch (error) {
            return {
                success: false,
                message: error.message
            };
        }
    }

    async stopAndWait(update = false) {
        const server = this.server;
        if (!server) return this.stop(update);
        const closed = new Promise(resolve => server.once('close', resolve));
        const result = this.stop(update);
        if (!result.success) return result;
        await closed;
        return result;
    }
}

const wsServer = new WebSocketServer(localWebSocketConfig.port, localWebSocketConfig.host);

// The default local-server port moved from 3000 to 3003 so new installs do not
// collide with other tools on 3000. Anyone who already had the local server
// enabled keeps 3000: their existing overlay links and OBS browser sources have
// no localserverport parameter and would otherwise silently stop connecting.
// Runs once, before the server ever binds, and pins the legacy value so the
// choice survives later upgrades.
function migrateLegacyLocalServerPort() {
    // An explicit CLI flag, environment variable, or stored setting always wins.
    if (localWebSocketConfig.portSource !== 'default') return false;
    if (store.get('localWebSocket.port') !== undefined) return false;

    store.set('localWebSocket.port', LEGACY_LOCAL_WEBSOCKET_PORT);
    wsServer.port = LEGACY_LOCAL_WEBSOCKET_PORT;
    log(`[Local WebSocket] Existing install detected — keeping legacy port ${LEGACY_LOCAL_WEBSOCKET_PORT}. New installs default to ${DEFAULT_LOCAL_WEBSOCKET_PORT}.`);
    return true;
}

async function configureLocalWebSocketPort() {
    const rawPort = await prompt({
        title: 'Local WebSocket Server Port',
        label: 'Port (1024–65535):',
        value: String(wsServer.port),
        inputAttrs: {
            type: 'number',
            min: String(1024),
            max: String(65535),
            step: '1'
        },
        buttonLabels: {
            ok: 'Save',
            cancel: 'Cancel'
        },
        type: 'input'
    }, mainWindow);

    if (rawPort === null) return;
    const port = normalizeLocalWebSocketPort(rawPort);
    if (port === null) {
        await dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Invalid Local Server Port',
            message: 'Enter a whole-number port between 1024 and 65535.'
        });
        return;
    }
    if (port === wsServer.port) return;

    const wasRunning = !!wsServer.server;
    if (wasRunning) await wsServer.stopAndWait(false);
    wsServer.port = port;
    store.set('localWebSocket.port', port);

    if (wasRunning) {
        wsServer.start(true);
    } else if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("fromMainToIndex", "serverPortChanged", { port });
    }
    createMenu();
}

async function configureLocalWebSocketLanAccess(enabled) {
    const host = enabled ? LAN_LOCAL_WEBSOCKET_HOST : DEFAULT_LOCAL_WEBSOCKET_HOST;
    if (host === wsServer.host) return;

    if (enabled) {
        const response = await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'Allow Local Server on Your Network?',
            message: 'Other devices on this network will be able to connect to the Social Stream relay.',
            detail: 'The local relay does not provide authentication or encryption. Prefer P2P mode for communication between computers, and enable this only on a trusted network.',
            buttons: ['Cancel', 'Allow LAN Connections'],
            defaultId: 0,
            cancelId: 0,
            noLink: true
        });
        if (response.response !== 1) {
            createMenu();
            return;
        }
    }

    const wasRunning = !!wsServer.server;
    if (wasRunning) await wsServer.stopAndWait(false);
    wsServer.host = host;
    store.set('localWebSocket.host', host);

    if (wasRunning) {
        wsServer.start(true);
    }
    createMenu();
}

// Track sessions we've already configured to avoid stacking listeners
const cspConfiguredSessions = new WeakSet();
const clientHintsConfiguredSessions = new WeakMap();
const cookiesListenerConfiguredSessions = new WeakSet();
const activatedWindowSessionHooks = new WeakMap();

function getOrCreateActivatedWindowSessionHooks(ses) {
    if (!ses) return null;
    const existing = activatedWindowSessionHooks.get(ses);
    if (existing) {
        return existing;
    }

    const hooks = {
        passkeyBlockWebContentsIds: new Set(),
        headerOverrideByWebContentsId: new Map()
    };

    try {
        ses.webRequest.onBeforeRequest({ urls: ['https://www.linkedin.com/checkpoint/pk/*'] }, (details, callback) => {
            try {
                const webContentsId = typeof details?.webContentsId === 'number' ? details.webContentsId : null;
                if (
                    webContentsId !== null &&
                    hooks.passkeyBlockWebContentsIds.has(webContentsId) &&
                    typeof details?.url === 'string' &&
                    details.url.includes('/checkpoint/pk/initiateLogin')
                ) {
                    console.log('[LinkedIn] Blocking passkey initiation:', details.url);
                    return callback({ cancel: true });
                }
            } catch (_) { }
            return callback({});
        });
    } catch (error) {
        console.warn('Failed to configure LinkedIn passkey blocker for activated windows:', error);
    }

    try {
        ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
            const requestHeaders = details && details.requestHeaders ? details.requestHeaders : {};
            let shouldStripElectron = false;
            try {
                const webContentsId = typeof details?.webContentsId === 'number' ? details.webContentsId : null;
                if (webContentsId !== null) {
                    const override = hooks.headerOverrideByWebContentsId.get(webContentsId);
                    if (override) {
                        if (override.origin) {
                            requestHeaders.Origin = override.origin;
                        }
                        if (override.referer) {
                            requestHeaders.Referer = override.referer;
                        }
                        if (override.stripElectron) {
                            shouldStripElectron = true;
                        }
                    }
                }
            } catch (_) { }
            if (shouldStripElectron) {
                delete requestHeaders.Electron;
            }
            callback({ requestHeaders });
        });
    } catch (error) {
        console.warn('Failed to configure header overrides for activated windows:', error);
    }

    activatedWindowSessionHooks.set(ses, hooks);
    return hooks;
}

function registerClientHintFiltering(ses, webContentsId, shouldFilter = () => true) {
    if (!ses || typeof webContentsId !== 'number') {
        return () => { };
    }

    let hooks = clientHintsConfiguredSessions.get(ses);
    if (!hooks) {
        hooks = {
            filtersByWebContentsId: new Map()
        };

        try {
            ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
                const responseHeaders = details && details.responseHeaders
                    ? details.responseHeaders
                    : {};

                const filter = hooks.filtersByWebContentsId.get(details?.webContentsId);
                if (!filter || !filter(details)) {
                    callback({ responseHeaders });
                    return;
                }

                const filteredHeaders = { ...responseHeaders };
                delete filteredHeaders['Accept-CH'];
                delete filteredHeaders['accept-ch'];
                callback({ responseHeaders: filteredHeaders });
            });
            clientHintsConfiguredSessions.set(ses, hooks);
        } catch (error) {
            console.warn('Failed to configure client hint filtering for sign-in windows:', error);
            return () => { };
        }
    }

    hooks.filtersByWebContentsId.set(webContentsId, shouldFilter);

    let released = false;
    return () => {
        if (released) return;
        released = true;
        hooks.filtersByWebContentsId.delete(webContentsId);
    };
}

function deriveOriginFromReferer(referer) {
    if (typeof referer !== 'string' || !referer.trim()) {
        return null;
    }
    try {
        return new URL(referer.trim()).origin;
    } catch (_) {
        return null;
    }
}

function deriveHeaderDefaultsFromUrl(urlValue) {
    if (typeof urlValue !== 'string' || !urlValue.trim()) {
        return {
            origin: null,
            referer: null
        };
    }

    const raw = urlValue.trim();
    const candidates = [raw];
    if (!/^https?:\/\//i.test(raw)) {
        candidates.push(`https://${raw}`);
    }

    for (const candidate of candidates) {
        try {
            const parsed = new URL(candidate);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                continue;
            }
            return {
                origin: parsed.origin,
                referer: `${parsed.origin}/`
            };
        } catch (_) { }
    }

    return {
        origin: null,
        referer: null
    };
}

function resolveHeaderOverridesFromConfig(config, baseUrl) {
    const configuredOrigin =
        (config && typeof config.Origin === 'string' && config.Origin.trim()) ? config.Origin.trim()
            : (config && typeof config.origin === 'string' && config.origin.trim()) ? config.origin.trim()
                : null;
    const configuredReferer =
        (config && typeof config.Referer === 'string' && config.Referer.trim()) ? config.Referer.trim()
            : (config && typeof config.referer === 'string' && config.referer.trim()) ? config.referer.trim()
                : (config && typeof config.referrer === 'string' && config.referrer.trim()) ? config.referrer.trim()
                    : null;

    const configuredOriginResolved = configuredOrigin || deriveOriginFromReferer(configuredReferer);

    const referrerModeRaw =
        (config && typeof config.referrerMode === 'string' && config.referrerMode.trim()) ? config.referrerMode.trim().toLowerCase()
            : (config && typeof config.refererMode === 'string' && config.refererMode.trim()) ? config.refererMode.trim().toLowerCase()
                : (config && typeof config.refMode === 'string' && config.refMode.trim()) ? config.refMode.trim().toLowerCase()
                    : null;

    const derived = deriveHeaderDefaultsFromUrl(baseUrl);

    if (referrerModeRaw === 'off' || referrerModeRaw === 'none' || referrerModeRaw === 'disabled') {
        return {
            mode: 'off',
            origin: null,
            referer: null
        };
    }

    if (referrerModeRaw === 'on' || referrerModeRaw === 'force') {
        return {
            mode: 'on',
            origin: derived.origin || configuredOriginResolved || null,
            referer: derived.referer || configuredReferer || null
        };
    }

    if (referrerModeRaw === 'auto') {
        return {
            mode: 'auto',
            origin: configuredOriginResolved || derived.origin || null,
            referer: configuredReferer || derived.referer || null
        };
    }

    // Backward-compatible mode: only use explicit config header overrides.
    return {
        mode: 'configured',
        origin: configuredOriginResolved || null,
        referer: configuredReferer || null
    };
}

function registerActivatedWindowSessionHooks(view, args = {}) {
    if (isBrowserViewDestroyed(view)) {
        return () => { };
    }
    if (!view.webContents || !view.webContents.session) {
        return () => { };
    }

    const ses = view.webContents.session;
    const hooks = getOrCreateActivatedWindowSessionHooks(ses);
    if (!hooks) {
        return () => { };
    }

    const webContentsId = view.webContents.id;
    hooks.passkeyBlockWebContentsIds.add(webContentsId);

    const config = args && typeof args.config === 'object' ? args.config : null;
    const headerOverrides = resolveHeaderOverridesFromConfig(config, args && typeof args.url === 'string' ? args.url : null);
    const needsOriginReferer = !!(headerOverrides.origin || headerOverrides.referer);
    const needsUserAgentHeaders = !!(config && config.userAgent && config.mockUserAgentData);
    if (needsOriginReferer || needsUserAgentHeaders) {
        hooks.headerOverrideByWebContentsId.set(webContentsId, {
            origin: needsOriginReferer ? headerOverrides.origin : null,
            referer: needsOriginReferer ? headerOverrides.referer : null,
            stripElectron: needsUserAgentHeaders
        });
    }

    let released = false;
    return () => {
        if (released) return;
        released = true;
        hooks.passkeyBlockWebContentsIds.delete(webContentsId);
        hooks.headerOverrideByWebContentsId.delete(webContentsId);
    };
}

function getOrCreatePersistentSession(domain) {
    const sessionName = `persist:${domain}`;
    createdPartitions.add(sessionName); // Track this partition
    return session.fromPartition(sessionName);
}

async function clearAllData() {
    try {
        const {
            response
        } = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Continue', 'Cancel'],
            defaultId: 1,
            title: "Clear All Data",
            message: "This will delete all data, including settings, cache, and cookies for all sites.\n\nThis action cannot be undone.\n\nAre you sure you want to continue❓",
            cancelId: 1,
        });

        if (response === 1) { // User clicked Cancel
            log("Operation cancelled by user");
            return false;
        }

        // Preserve minimal cached state
        const preservedStreamID = (cachedState && typeof cachedState === 'object' && 'streamID' in cachedState)
            ? cachedState.streamID
            : null;
	        const preservedPassword = (cachedState && typeof cachedState === 'object' && 'password' in cachedState)
	            ? normalizePasswordValue(cachedState.password)
	            : null;

        // Reset cached state while preserving stream credentials
        cachedState = {};
	        if (preservedStreamID) {
	            cachedState.streamID = preservedStreamID;
	        }
		        if (preservedPassword !== null && preservedPassword !== undefined) {
		            cachedState.password = preservedPassword;
		        } else {
		            delete cachedState.password;
		        }
	        cachedState.state = false;
	        // Explicit reset: replace any old quality baseline to prevent stale recovery.
	        cachedStatePersistenceBaseline = null;
	        const resetBaselineCandidate = createCachedStateCandidate(cachedState, "runtime-reset", Date.now());
	        if (resetBaselineCandidate) {
	            setCachedStatePersistenceBaseline(resetBaselineCandidate);
	        }

        const userSessionsToClear = new Set(Object.keys(sessions || {}));
        userSessionsToClear.add('default');
        userSessionsToClear.add(currentSessionName);
        userSessionsToClear.forEach((sessionName) => clearUserSessionPersistence(sessionName));
        currentSessionName = 'default';

	        const { mainPath: savedSyncPath, bakPath: savedSyncBackupPath } = getSavedSyncPaths();
        try {
            fs.writeFileSync(savedSyncPath, JSON.stringify(cachedState, null, 2));
        } catch (writeError) {
            console.error('Failed to rewrite cached state during reset:', writeError);
        }
        try {
            if (fs.existsSync(savedSyncBackupPath)) {
                fs.unlinkSync(savedSyncBackupPath);
            }
        } catch (backupError) {
            console.warn('Failed to remove cachedState backup during reset:', backupError?.message || backupError);
        }

        // Clear persisted application settings
        try {
            store.clear();
        } catch (storeError) {
            console.error('Failed to clear settings store during reset:', storeError);
        }

        try {
            clearYouTubeOwnerAuthStore();
        } catch (ownerAuthStoreError) {
            console.error('Failed to clear YouTube owner auth store during reset:', ownerAuthStoreError);
        }

        try {
            if (mainWindow && mainWindow.webContents) {
                const clearScript = `
                    (function(){
                        const keys = ['settings','streamID','password','state','ssninja_stream_id','ssninja_state'];
                        keys.forEach((key) => {
                            try { localStorage.removeItem(key); } catch (e) {}
                        });
                    })();
                `;
                mainWindow.webContents.executeJavaScript(clearScript).catch(() => null);
            }
        } catch (e) {
            console.warn('Failed to clear localStorage mirror during reset:', e?.message || e);
        }

        sessions = {
            default: {
                name: 'Default Session (Original)',
                created: Date.now(),
                description: 'Your original settings and sources'
            }
        };
        currentSessionName = 'default';
        store.set('sessions', sessions);
        store.set('currentSession', currentSessionName);
        store.set('sessionSystemInitialized', true);

        // Snapshot tracked partitions before clearing so they are still included in cleanup.
        const trackedPartitions = new Set(createdPartitions);
        createdPartitions.clear();

        // Clear data from default session
        const defaultSession = session.defaultSession;
        await clearSessionData(defaultSession);

        // Clear data from known partition patterns
        const knownPartitions = [
            'persist:youtubemusic',
            'persist:youtube',
            'persist:abc' // Default session partition
        ];

        // Collect all unique sessions from all windows first
        const sessionsToClean = new Set();

        // Add known partitions
        for (const partition of knownPartitions) {
            sessionsToClean.add(partition);
        }

        // Add all dynamically created partitions
        for (const partition of trackedPartitions) {
            sessionsToClean.add(partition);
        }

        // Get all windows and collect their session partitions
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            const contents = win.webContents;
            const sessionPartition = contents.session.getStoragePath();

            // Extract partition name from storage path if available
            if (sessionPartition && sessionPartition.includes('Partitions')) {
                const match = sessionPartition.match(/Partitions[\\\/](.+?)$/);
                if (match && match[1]) {
                    sessionsToClean.add(match[1]);
                }
            }
        }

        // Clear data from all collected partition sessions
        for (const partition of sessionsToClean) {
            try {
                const ses = session.fromPartition(partition);
                await clearSessionData(ses);
                log(`Cleared session data for partition: ${partition}`);
            } catch (error) {
                console.error(`Error clearing partition ${partition}:`, error);
            }
        }

        // Clear data from all window sessions (in case we missed any)
        for (const win of windows) {
            try {
                const contents = win.webContents;
                await clearSessionData(contents.session);
                await contents.clearHistory();
                log(`Cleared session for window: ${win.id}`);
            } catch (error) {
                console.error(`Error clearing window ${win.id} session:`, error);
            }
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.webContents.send('app:clear-all-sources');
            } catch (error) {
                console.error('Failed to dispatch source clear during reset:', error);
            }
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.reload();
            log('Main window refreshed');
        } else {
            log('Main window is not available for refresh');
        }

        log("All data cleared successfully");
        return true;
    } catch (error) {
        console.error("Error clearing all data:", error);
        return false;
    }
}

async function promptClearAllSources() {
    try {
        if (!mainWindow || mainWindow.isDestroyed()) {
            log('Clear all sources requested but main window is unavailable');
            return;
        }

        const { response } = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Clear Sources', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'Clear All Sources',
            message: 'Remove every configured source and group from the Embedded Core?',
            detail: 'This stops active source windows and connections but keeps app sessions, cookies, and other settings intact.'
        });

        if (response !== 0) {
            log('Clear all sources cancelled by user');
            return;
        }

        mainWindow.webContents.send('app:clear-all-sources');
    } catch (error) {
        console.error('Error sending clear-all-sources command:', error);
    }
}

async function clearSessionData(ses) {
    try {
        await ses.clearStorageData({
            storages: [
                'appcache',
                'cookies',
                'filesystem',
                'indexdb',
                'localstorage',
                'shadercache',
                'websql',
                'serviceworkers',
                'cachestorage',
            ],
            quotas: [
                'temporary',
                'persistent',
                'syncable',
            ],
        });
        await ses.clearCache();
        await ses.clearHostResolverCache();
        await ses.clearAuthCache();
        await ses.clearCodeCaches({});
        if (typeof ses.clearHttpCache === 'function') {
            await ses.clearHttpCache();
        }
        return true;
    } catch (error) {
        console.error(`Error clearing session data: ${error}`);
        return false;
    }
}

// Export all session data (cookies, localStorage, IndexedDB, etc.) from all windows/partitions
async function exportAllSessionData() {
    try {
        const sessionData = {
            version: '2.0',
            exportedAt: new Date().toISOString(),
            sessions: {}
        };

        // Helper to get all storage data from a session
        async function getSessionStorageData(ses, partitionName) {
            const data = {
                cookies: [],
                localStorage: {},
                sessionStorage: {},
                indexedDB: {}
            };

            try {
                // Get cookies
                data.cookies = await ses.cookies.get({});
                log(`Exported ${data.cookies.length} cookies from ${partitionName}`);
            } catch (error) {
                console.error(`Error exporting cookies from ${partitionName}:`, error);
            }

            // Note: localStorage, sessionStorage, and IndexedDB need to be extracted from renderer process
            // We'll handle this through IPC communication with windows

            return data;
        }

        // Export from default session
        const defaultSession = session.defaultSession;
        sessionData.sessions['default'] = await getSessionStorageData(defaultSession, 'default');

        // Export from known partitions
        const knownPartitions = [
            'persist:youtubemusic',
            'persist:youtube',
            'persist:abc'
        ];

        // Add all dynamically created partitions
        const allPartitions = new Set([...knownPartitions, ...createdPartitions]);

        // Export from all partitions
        for (const partition of allPartitions) {
            try {
                const ses = session.fromPartition(partition);
                sessionData.sessions[partition] = await getSessionStorageData(ses, partition);
            } catch (error) {
                console.error(`Error exporting data from partition ${partition}:`, error);
            }
        }

        // Get data from all open windows
        const windows = BrowserWindow.getAllWindows();
        const windowDataPromises = [];

        for (const win of windows) {
            try {
                const contents = win.webContents;
                const winSession = contents.session;

                // Try to identify the partition name
                let partitionKey = `window-${win.id}`;
                const storagePath = winSession.getStoragePath();
                if (storagePath && storagePath.includes('Partitions')) {
                    const match = storagePath.match(/Partitions[\\\/](.+?)$/);
                    if (match && match[1]) {
                        partitionKey = match[1];
                    }
                }

                // Skip if we already have this partition
                if (sessionData.sessions[partitionKey]) continue;

                // Get cookies from window session
                const cookies = await winSession.cookies.get({});

                // Execute script in window to get localStorage and sessionStorage
                const windowData = await contents.executeJavaScript(`
          (function() {
            const data = {
              localStorage: {},
              sessionStorage: {},
              url: window.location.href,
              origin: window.location.origin
            };
            
            // Export localStorage
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              data.localStorage[key] = localStorage.getItem(key);
            }
            
            // Export sessionStorage
            for (let i = 0; i < sessionStorage.length; i++) {
              const key = sessionStorage.key(i);
              data.sessionStorage[key] = sessionStorage.getItem(key);
            }
            
            return data;
          })();
        `).catch(err => {
                    console.error(`Error getting storage from window ${win.id}:`, err);
                    return {
                        localStorage: {},
                        sessionStorage: {}
                    };
                });

                sessionData.sessions[partitionKey] = {
                    cookies: cookies || [],
                    localStorage: windowData.localStorage || {},
                    sessionStorage: windowData.sessionStorage || {},
                    url: windowData.url,
                    origin: windowData.origin
                };

                log(`Exported data from window ${win.id} (${partitionKey})`);
            } catch (error) {
                console.error(`Error exporting data from window ${win.id}:`, error);
            }
        }

        log(`Total sessions exported: ${Object.keys(sessionData.sessions).length}`);
        return sessionData;
    } catch (error) {
        console.error("Error exporting all session data:", error);
        return null;
    }
}

// Import all session data to restore complete state
async function importAllSessionData(sessionData) {
    try {
        if (!sessionData || !sessionData.sessions) {
            throw new Error('Invalid session data format');
        }

        let results = {
            totalCookies: 0,
            totalSessions: 0,
            errors: []
        };

        // Helper to import cookies to a session
        async function importCookiesToSession(ses, cookies, partitionName) {
            let imported = 0;
            for (const cookie of cookies) {
                try {
                    // Build URL for cookie
                    const protocol = cookie.secure ? 'https' : 'http';
                    const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
                    const url = `${protocol}://${domain}${cookie.path || '/'}`;

                    await ses.cookies.set({
                        url: url,
                        name: cookie.name,
                        value: cookie.value,
                        domain: cookie.domain,
                        path: cookie.path || '/',
                        secure: cookie.secure || false,
                        httpOnly: cookie.httpOnly || false,
                        expirationDate: cookie.expirationDate,
                        sameSite: cookie.sameSite || 'no_restriction'
                    });
                    imported++;
                } catch (error) {
                    console.error(`Error importing cookie ${cookie.name} to ${partitionName}:`, error);
                    results.errors.push(`Cookie ${cookie.name} to ${partitionName}: ${error.message}`);
                }
            }
            return imported;
        }

        // Import to each partition
        for (const [partitionName, data] of Object.entries(sessionData.sessions)) {
            try {
                let ses;
                if (partitionName === 'default') {
                    ses = session.defaultSession;
                } else {
                    ses = session.fromPartition(partitionName);
                    // Track this partition for future cleanup
                    if (partitionName.startsWith('persist:')) {
                        createdPartitions.add(partitionName);
                    }
                }

                // Import cookies
                if (data.cookies && data.cookies.length > 0) {
                    const imported = await importCookiesToSession(ses, data.cookies, partitionName);
                    results.totalCookies += imported;
                    log(`Imported ${imported} cookies to ${partitionName}`);
                }

                results.totalSessions++;

                // Note: localStorage and sessionStorage will be imported on the renderer side
                // when windows are created or reloaded

            } catch (error) {
                console.error(`Error importing to partition ${partitionName}:`, error);
                results.errors.push(`Partition ${partitionName}: ${error.message}`);
            }
        }

        log(`Import complete: ${results.totalSessions} sessions, ${results.totalCookies} cookies`);
        return results;
    } catch (error) {
        console.error("Error importing session data:", error);
        return {
            error: error.message
        };
    }
}


function createCustomDialog(htmlFile, width, height, options = {}) {
    try {
        const parentWindow = options.parent && !options.parent.isDestroyed() ? options.parent : null;
        let win = new BrowserWindow({
            width: width,
            height: height,
            frame: false,
            transparent: false,
            backgroundColor: "#11161c",
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            alwaysOnTop: !!options.alwaysOnTop,
            modal: !!parentWindow,
            parent: parentWindow || undefined,
            show: false,
            skipTaskbar: !!parentWindow,
            autoHideMenuBar: true,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                additionalPermissions: ['clipboard-write']
            }
        });
        try { win.removeMenu(); } catch (_) { }
        // Workaround for Electron 36 frameless window titlebar issue
        if (APPLY_WIN_FRAMELESS_WORKAROUND) {
            // Apply initial fix after window is created
            setTimeout(() => {
                if (win && !win.isDestroyed()) {
                    // Force a resize to trigger proper rendering
                    const bounds = win.getBounds();
                    win.setBounds({
                        x: bounds.x,
                        y: bounds.y,
                        width: bounds.width + 1,
                        height: bounds.height
                    });
                    win.setBounds(bounds);
                }
            }, 100);

            // Handle blur events to prevent titlebar from appearing
            let blurTimeout;
            win.on('blur', () => {
                // Clear any existing timeout
                if (blurTimeout) {
                    clearTimeout(blurTimeout);
                    blurTimeout = null;
                }

                blurTimeout = setTimeout(() => {
                    if (win && !win.isDestroyed()) {
                        // Store current bounds
                        const currentBounds = win.getBounds();

                        // Toggle a minimal size change to force re-render
                        win.setBounds({
                            x: currentBounds.x,
                            y: currentBounds.y,
                            width: currentBounds.width + 1,
                            height: currentBounds.height
                        });

                        // Immediately restore original size
                        win.setBounds(currentBounds);
                    }
                }, 10);
            });

            // Clean up timeout on window close
            win.on('closed', () => {
                if (blurTimeout) clearTimeout(blurTimeout);
            });
        }

        win.loadFile(path.join(__dirname, htmlFile));

        // Add error handling for window creation
        win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            console.error('Failed to load custom dialog:', errorDescription);
            win.close();
        });

        return win;
    } catch (e) {
        console.error('Error creating custom dialog:', e);
        return null;
    }
}

function handleZoom(window) {
    window.webContents.on('zoom-changed', (event, zoomDirection) => {
        const currentZoom = window.webContents.getZoomFactor();
        if (zoomDirection === 'in') {
            window.webContents.setZoomFactor(currentZoom + 0.1);
        } else if (zoomDirection === 'out') {
            window.webContents.setZoomFactor(Math.max(currentZoom - 0.1, 0.1));
        }
    });

    window.webContents.on('before-input-event', (event, input) => {
        if (input.control && input.type === 'keyDown') {
            if (input.key === '=') {
                window.webContents.emit('zoom-changed', event, 'in');
            } else if (input.key === '-') {
                window.webContents.emit('zoom-changed', event, 'out');
            }
        }
    });
}

// Handler to get the injected script flag
ipcMain.handle('get-injected-script-flag', () => {
    return INJECTED_SCRIPT_FLAG;
});

ipcMain.handle('ssapp:choose-ticker-file', async (_event, options = {}) => {
    try {
        const dialogOpts = {
            title: options.title || 'Select ticker source file',
            properties: ['openFile'],
            filters: Array.isArray(options.filters) && options.filters.length
                ? options.filters
                : [
                    { name: 'Text Files', extensions: ['txt', 'csv', 'md'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
        };
        const result = await dialog.showOpenDialog(dialogOpts);
        if (result.canceled || !result.filePaths || !result.filePaths.length) {
            return { canceled: true };
        }
        rememberDialogApprovedPath(result.filePaths[0]);
        return {
            canceled: false,
            filePath: result.filePaths[0]
        };
    } catch (error) {
        console.error('[SSAPP] Failed to open ticker file dialog:', error);
        return {
            canceled: true,
            error: error?.message || 'Unable to open file picker'
        };
    }
});

const DIALOG_APPROVED_PATHS_KEY = "dialogApprovedPaths";
const MAX_DIALOG_APPROVED_PATHS = 256;
const LEGACY_APPROVED_PATH_LOCAL_STORAGE_KEYS = ["savedFilePath", "savedNamesFilePath", "tickerFilePath"];

function normalizeApprovedPath(filePath) {
    if (!filePath || typeof filePath !== "string") return "";
    try {
        const resolved = path.resolve(filePath);
        if (!resolved) return "";
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    } catch (_) {
        return "";
    }
}

function isSafeAbsolutePathCandidate(filePath) {
    if (!filePath || typeof filePath !== "string") return false;
    if (filePath.length > 4096) return false;
    if (/[\r\n]/.test(filePath)) return false;
    return path.isAbsolute(filePath);
}

function loadDialogApprovedPaths() {
    const allowed = new Set();
    try {
        const stored = store.get(DIALOG_APPROVED_PATHS_KEY, []);
        if (Array.isArray(stored)) {
            for (const item of stored) {
                const normalized = normalizeApprovedPath(item);
                if (normalized) allowed.add(normalized);
            }
        }
    } catch (_) { }
    return allowed;
}

function persistDialogApprovedPaths() {
    try {
        store.set(DIALOG_APPROVED_PATHS_KEY, Array.from(dialogApprovedPaths));
    } catch (error) {
        console.warn("Failed to persist approved file paths:", error?.message || error);
    }
}

function rememberDialogApprovedPath(filePath) {
    const normalized = normalizeApprovedPath(filePath);
    if (!normalized) return;
    if (dialogApprovedPaths.has(normalized)) return;
    dialogApprovedPaths.add(normalized);
    while (dialogApprovedPaths.size > MAX_DIALOG_APPROVED_PATHS) {
        const oldest = dialogApprovedPaths.values().next().value;
        if (!oldest) break;
        dialogApprovedPaths.delete(oldest);
    }
    persistDialogApprovedPaths();
}

// Track paths that the user approved via a native save/open dialog
const dialogApprovedPaths = loadDialogApprovedPaths();

function migrateLegacyApprovedPaths() {
    let migrated = 0;
    try {
        const localStorageBackup = getUserSessionStoreValue("localStorageBackup", {});
        if (!localStorageBackup || typeof localStorageBackup !== "object") return;
        for (const key of LEGACY_APPROVED_PATH_LOCAL_STORAGE_KEYS) {
            const candidate = localStorageBackup[key];
            if (!isSafeAbsolutePathCandidate(candidate)) continue;
            const sizeBefore = dialogApprovedPaths.size;
            rememberDialogApprovedPath(candidate);
            if (dialogApprovedPaths.size > sizeBefore) migrated += 1;
        }
    } catch (_) { }
    if (migrated > 0) {
        console.log(`[PathSandbox] Migrated ${migrated} persisted path approval(s) from localStorage backup`);
    }
}

migrateLegacyApprovedPaths();

function isPathAllowed(filePath) {
    const normalized = normalizeApprovedPath(filePath);
    if (!normalized) return false;
    // Always allow files inside the app's userData directory
    try {
        const userData = normalizeApprovedPath(app.getPath("userData"));
        if (userData && (normalized.startsWith(userData + path.sep) || normalized === userData)) return true;
    } catch (_) { }
    // Allow paths the user explicitly approved via a native dialog
    if (dialogApprovedPaths.has(normalized)) return true;
    return false;
}

ipcMain.handle("show-save-dialog", async (event, opts) => {
    const dialogOpts = {
        title: "Save File",
        buttonLabel: "Save",
        ...opts, // Override defaults with opts provided from renderer
    };
    try {
        const {
            filePath
        } = await dialog.showSaveDialog(dialogOpts);
        if (filePath) rememberDialogApprovedPath(filePath);
        return filePath;
    } catch (error) {
        log(error);
    }
});

ipcMain.handle('read-from-file', async (event, filePath) => {
    if (!isPathAllowed(filePath)) {
        console.warn('read-from-file blocked: path not allowed:', filePath);
        return null;
    }
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        console.error('Error reading file:', error);
        return null;
    }
});

function getStoredCustomJsFilePath() {
    try {
        const raw = store.get(CUSTOM_JS_FILE_STORE_KEY, {});
        if (raw && typeof raw === "object" && typeof raw.filePath === "string") {
            return raw.filePath;
        }
    } catch (_) { }
    return "";
}

function getCustomJsFileState() {
    const filePath = getStoredCustomJsFilePath();
    const enabled = !!filePath;
    const state = {
        enabled,
        filePath,
        fileName: filePath ? path.basename(filePath) : "",
        exists: false,
        size: 0,
        mtimeMs: 0,
        maxBytes: CUSTOM_JS_MAX_BYTES,
        error: ""
    };

    if (!filePath) {
        return state;
    }

    if (!isPathAllowed(filePath)) {
        state.error = "The selected custom.js file needs to be selected again.";
        return state;
    }

    try {
        const stat = fs.statSync(filePath);
        state.exists = stat.isFile();
        state.size = stat.size;
        state.mtimeMs = Number(stat.mtimeMs) || 0;
        if (!state.exists) {
            state.error = "The selected custom.js path is not a file.";
        } else if (state.size > CUSTOM_JS_MAX_BYTES) {
            state.error = "The selected custom.js file is larger than 1 MB.";
        }
    } catch (error) {
        state.error = error?.message || "Unable to access the selected custom.js file.";
    }

    return state;
}

function setCustomJsFilePath(filePath) {
    const normalizedPath = typeof filePath === "string" ? filePath : "";
    store.set(CUSTOM_JS_FILE_STORE_KEY, {
        filePath: normalizedPath,
        updatedAt: Date.now()
    });
    return getCustomJsFileState();
}

function broadcastCustomJsFileState(state = getCustomJsFileState()) {
    try {
        BrowserWindow.getAllWindows().forEach((window) => {
            try {
                if (window && !window.isDestroyed()) {
                    window.webContents.send("ssapp:custom-js-updated", state);
                }
            } catch (_) { }
        });
    } catch (_) { }
}

async function selectCustomJsFileWithDialog() {
    try {
        const result = await dialog.showOpenDialog({
            title: "Load a custom.js file",
            properties: ["openFile"],
            filters: [
                { name: "JavaScript Files", extensions: ["js"] },
                { name: "All Files", extensions: ["*"] }
            ]
        });
        if (result.canceled || !result.filePaths || !result.filePaths.length) {
            return {
                canceled: true,
                state: getCustomJsFileState()
            };
        }

        const filePath = result.filePaths[0];
        rememberDialogApprovedPath(filePath);
        const state = setCustomJsFilePath(filePath);
        broadcastCustomJsFileState(state);
        createMenu();
        return {
            canceled: false,
            state
        };
    } catch (error) {
        console.error("[SSAPP] Failed to load custom.js file:", error);
        return {
            canceled: true,
            error: error?.message || "Unable to load custom.js file.",
            state: getCustomJsFileState()
        };
    }
}

async function showCustomJsMenuMessage(options) {
    const parent = BrowserWindow.getFocusedWindow() || mainWindow;
    if (parent && !parent.isDestroyed()) {
        return dialog.showMessageBox(parent, options);
    }
    return dialog.showMessageBox(options);
}

async function handleLoadCustomJsFileMenu() {
    const result = await selectCustomJsFileWithDialog();
    if (!result || result.canceled) {
        return result;
    }

    const state = result.state || getCustomJsFileState();
    if (state.error) {
        await showCustomJsMenuMessage({
            type: "warning",
            title: "Custom JS",
            message: "The selected custom.js file could not be loaded.",
            detail: state.error,
            buttons: ["OK"]
        });
        return result;
    }

    await showCustomJsMenuMessage({
        type: "info",
        title: "Custom JS",
        message: "custom.js file loaded.",
        detail: state.filePath || state.fileName || "Selected file",
        buttons: ["OK"]
    });
    return result;
}

async function handleClearCustomJsFileMenu() {
    const previousState = getCustomJsFileState();
    const state = setCustomJsFilePath("");
    broadcastCustomJsFileState(state);
    createMenu();
    await showCustomJsMenuMessage({
        type: "info",
        title: "Custom JS",
        message: "custom.js file cleared.",
        detail: previousState.filePath ? "Reload any open dock, featured, or bot windows to fully clear already-run custom code." : undefined,
        buttons: ["OK"]
    });
    return state;
}

ipcMain.handle("ssapp:get-custom-js-file-state", async () => {
    return getCustomJsFileState();
});

ipcMain.handle("ssapp:select-custom-js-file", async () => {
    return selectCustomJsFileWithDialog();
});

ipcMain.handle("ssapp:clear-custom-js-file", async () => {
    const state = setCustomJsFilePath("");
    broadcastCustomJsFileState(state);
    createMenu();
    return {
        success: true,
        state
    };
});

ipcMain.handle("ssapp:read-custom-js-file", async (event) => {
    let senderUrl = "";
    try {
        senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
    } catch (_) { }
    if (!getTrustedStandaloneCustomJsPageType(senderUrl)) {
        return {
            success: false,
            error: "custom.js is only available to trusted Social Stream dock, featured, and bot pages.",
            code: "UNTRUSTED_PAGE"
        };
    }

    const state = getCustomJsFileState();
    if (!state.enabled) {
        return {
            success: false,
            disabled: true,
            state
        };
    }
    if (state.error || !state.exists) {
        return {
            success: false,
            error: state.error || "The selected custom.js file is unavailable.",
            state
        };
    }

    try {
        const code = await fsp.readFile(state.filePath, "utf8");
        return {
            success: true,
            code,
            state
        };
    } catch (error) {
        return {
            success: false,
            error: error?.message || "Unable to read custom.js file.",
            state
        };
    }
});

// Utility: compute virtual desktop bounds across all displays
function getVirtualScreenBounds() {
    try {
        const displays = screen.getAllDisplays();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const d of displays) {
            const { x, y, width, height } = d.bounds;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + width);
            maxY = Math.max(maxY, y + height);
        }
        if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
            const pb = screen.getPrimaryDisplay().bounds;
            return { x: pb.x, y: pb.y, width: pb.width, height: pb.height };
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    } catch (_) {
        const pb = screen.getPrimaryDisplay().bounds;
        return { x: pb.x, y: pb.y, width: pb.width, height: pb.height };
    }
}

function sourceWindowIntersectsVirtualScreen(bounds) {
    try {
        if (!bounds || typeof bounds !== 'object') return true;
        const vb = getVirtualScreenBounds();
        const overlapX = Math.max(0, Math.min(bounds.x + bounds.width, vb.x + vb.width) - Math.max(bounds.x, vb.x));
        const overlapY = Math.max(0, Math.min(bounds.y + bounds.height, vb.y + vb.height) - Math.max(bounds.y, vb.y));
        return overlapX > 0 && overlapY > 0;
    } catch (_) {
        return true;
    }
}

function getSourceWindowOffscreenCandidates(view) {
    let currentBounds = null;
    try {
        currentBounds = view && view.__prevBounds ? view.__prevBounds : view.getBounds();
    } catch (_) {
        currentBounds = null;
    }

    const width = Math.max(parseInt(currentBounds && currentBounds.width, 10) || 800, 100);
    const height = Math.max(parseInt(currentBounds && currentBounds.height, 10) || 600, 100);
    const vb = getVirtualScreenBounds();
    const margin = Math.max(10000, width + height + 1000);

    return [
        { x: Math.floor(vb.x - width - margin), y: Math.floor(vb.y - height - margin), width, height },
        { x: Math.floor(vb.x + vb.width + margin), y: Math.floor(vb.y + vb.height + margin), width, height },
        { x: Math.floor(vb.x - width - margin), y: Math.floor(vb.y + vb.height + margin), width, height },
        { x: Math.floor(vb.x + vb.width + margin), y: Math.floor(vb.y - height - margin), width, height }
    ];
}

function parkSourceWindowOffscreen(view) {
    if (isBrowserViewDestroyed(view)) return false;

    let lastBounds = null;
    const candidates = getSourceWindowOffscreenCandidates(view);
    for (const candidate of candidates) {
        try {
            view.setBounds(candidate);
            lastBounds = view.getBounds();
            if (!sourceWindowIntersectsVirtualScreen(lastBounds)) {
                return true;
            }
        } catch (_) { }
    }

    try {
        console.warn('[SourceWindow] Failed to park source window fully off-screen:', lastBounds);
    } catch (_) { }
    return false;
}

function notifySourceWindowVisibilityChange(view, visible) {
    try {
        if (!mainWindow || mainWindow.isDestroyed() || isBrowserViewDestroyed(view)) return;
        mainWindow.webContents.send(visible ? 'window-shown' : 'window-hidden', {
            tabID: view.tabID,
            url: view.args && view.args.url
        });
    } catch (_) { }
}

function installWindowsSourceWindowMinimizeGuard(view) {
    if (process.platform !== 'win32' || !view || view.__ss_windowsMinimizeGuardInstalled) return;
    view.__ss_windowsMinimizeGuardInstalled = true;
    view.on('minimize', (event) => {
        if (app.isQuitting) {
            return;
        }
        try {
            if (event && typeof event.preventDefault === 'function') {
                event.preventDefault();
            }
        } catch (_) { }
        setTimeout(() => {
            try {
                if (isBrowserViewDestroyed(view)) return;
                try {
                    if (typeof view.isMinimized === 'function' && view.isMinimized()) {
                        view.restore();
                    }
                } catch (_) { }
                stealthHideView(view);
                notifySourceWindowVisibilityChange(view, false);
            } catch (_) { }
        }, 0);
    });
}

// Stealth-hide: keep capture windows renderable without leaving them accessible on-screen.
function stealthHideView(view) {
    try {
        if (isBrowserViewDestroyed(view)) return false;
        const wasVisible = view.__ss_visible !== false;
        // Remember current bounds before parking, but do not overwrite with parked bounds.
        if (wasVisible || !view.__prevBounds) {
            try { view.__prevBounds = view.getBounds(); } catch (_) { view.__prevBounds = null; }
        }

        // Avoid taskbar clutter while hidden
        try { view.setSkipTaskbar(true); } catch (_) { }

        // Linux gets a real hide() rather than the off-screen parking used elsewhere.
        // Window managers clamp far-off-screen coordinates back towards the desktop
        // (leaving a visible sliver), and Wayland forbids programmatic positioning
        // outright, so parking cannot work here. Minimizing was the previous fallback but
        // it leaves the window in the taskbar and pager where users expect it gone, and
        // reveal is unreliable because Wayland does not support a minimized state.
        //
        // hide() is safe for capture because the source window disables
        // backgroundThrottling: document.visibilityState stays "visible" and DOM timers
        // keep running. The frame pump injected into the page covers the remaining risk,
        // which is compositors that stop feeding a window compositor frames and therefore
        // stop running its requestAnimationFrame work.
        //
        // Measured on Electron 38 and 43 (X11 + Wayland): a hidden source window keeps
        // visibilityState "visible", keeps timers at full rate, and keeps rendering.
        if (process.platform === 'linux') {
            try { installFramePump(view.webContents); } catch (_) { }

            let hidden = false;
            try {
                if (typeof view.hide === 'function') view.hide();
                hidden = typeof view.isVisible === 'function' ? !view.isVisible() : true;
            } catch (_) { }

            if (!hidden) {
                // Last resort for compositors that refuse to unmap the window.
                try {
                    if (typeof view.minimize === 'function') view.minimize();
                    hidden = typeof view.isMinimized === 'function' && view.isMinimized();
                } catch (_) { }
            }

            view.__ss_visible = !hidden;
            if (!hidden) {
                try { view.setSkipTaskbar(false); } catch (_) { }
            }
            return hidden;
        }

        // Windows and macOS keep the window mapped and park it outside the virtual desktop,
        // rather than using the real hide() that Linux now uses. Deliberate: parking works
        // on these platforms (they allow arbitrary window coordinates, unlike Linux window
        // managers, which clamp them back towards the desktop) and a parked window keeps
        // getting compositor frames, so the page renders normally. There are also reports of
        // hide() defeating backgroundThrottling on Windows specifically
        // (electron/electron#31016), which would leave the frame pump carrying capture on
        // its own. If this is ever revisited, measure it on a real Windows machine first.
        const parked = parkSourceWindowOffscreen(view);
        view.__ss_visible = !parked;
        if (!parked) {
            try { view.setSkipTaskbar(false); } catch (_) { }
        }
        return parked;
    } catch (_) {
        return false;
    }
}

// Restore from stealth-hide
function stealthShowView(view, options = {}) {
    try {
        if (isBrowserViewDestroyed(view)) return true;
        const bringToFront = !!(options && options.bringToFront);
        const previousBounds = view.__prevBounds && typeof view.__prevBounds.x === 'number'
            ? view.__prevBounds
            : null;
        if (process.platform === 'linux') {
            const wayland = isWaylandSession();

            // Wayland prohibits programmatic positioning, so replaying stored bounds there
            // does nothing useful and can confuse the compositor's own placement.
            if (previousBounds && !wayland) {
                try { view.setBounds(previousBounds); } catch (_) { }
            }
            try { view.setSkipTaskbar(false); } catch (_) { }
            try {
                if (typeof view.isMinimized === 'function' && view.isMinimized()) {
                    view.restore();
                }
            } catch (_) { }
            try {
                // showInactive() is not supported on Wayland; there it must be show().
                if (bringToFront || wayland || typeof view.showInactive !== 'function') {
                    view.show();
                } else {
                    view.showInactive();
                }
            } catch (_) { }
            if (previousBounds && !wayland) {
                try { view.setBounds(previousBounds); } catch (_) { }
            }

            let shown = true;
            try {
                const nativeVisible = typeof view.isVisible !== 'function' || view.isVisible();
                const minimized = typeof view.isMinimized === 'function' && view.isMinimized();
                shown = nativeVisible && !minimized;
                // getBounds() reports every Wayland window at 0,0, so an on-screen check
                // there would be meaningless rather than merely unhelpful.
                if (shown && !wayland) {
                    const currentBounds = typeof view.getBounds === 'function' ? view.getBounds() : previousBounds;
                    shown = sourceWindowIntersectsVirtualScreen(currentBounds);
                }
            } catch (_) {
                shown = false;
            }
            view.__ss_visible = shown;
            if (!shown) {
                try { view.setSkipTaskbar(true); } catch (_) { }
            }
            return shown;
        }
        // Restore size/position
        if (previousBounds) {
            view.setBounds(previousBounds);
        }
        try { view.setSkipTaskbar(false); } catch (_) { }
        try {
            if (bringToFront) {
                view.show();
            } else {
                view.showInactive();
            }
        } catch (_) { }
        view.__ss_visible = true;
        return true;
    } catch (_) {
        return false;
    }
}

// Shared by the showWindow IPC handler and the hidden-capture diagnostics so both drive
// the same hide/reveal path.
// args.state semantics (legacy): true => hide, false => show, null/undefined => toggle
function applySourceWindowVisibility(view, args = {}) {
    if (!view) return { newState: false };
    const humanHandoff = args.humanHandoff === true;
    if (headlessControlEnabled && !humanHandoff) {
        view.__ssappHumanHandoff = false;
        stealthHideView(view);
        return { newState: false };
    }

    const hasExplicitUserInitiated = !!(args && Object.prototype.hasOwnProperty.call(args, 'userInitiated'));
    const userInitiatedReveal = hasExplicitUserInitiated ? !!args.userInitiated : false;

    // Initialize logical visibility if missing
    if (typeof view.__ss_visible !== 'boolean') {
        view.__ss_visible = true;
    }

    let hide;
    if (args.state === null || typeof args.state === 'undefined') {
        hide = !!view.__ss_visible;
    } else {
        hide = !!args.state;
    }

    if (hide) {
        view.__ssappHumanHandoff = false;
        stealthHideView(view);
    } else {
        if (humanHandoff) view.__ssappHumanHandoff = true;
        stealthShowView(view, { bringToFront: userInitiatedReveal });
    }

    return { newState: !!view.__ss_visible };
}

ipcMain.handle('showWindow', (event, args) => {
    const view = browserViews[args.vid];
    if (!view) return false;
    return applySourceWindowVisibility(view, args);
});

ipcMain.handle('checkWindowExists', (event, args) => {
    const view = browserViews[args.vid];
    if (!view) return false;
    try {
        if (isBrowserViewDestroyed(view)) {
            // Clean up stale reference
            delete browserViews[args.vid];
            releaseWindowId(args.vid);
            return false;
        }
    } catch (_) { }
    return true;
});

// Explicit window close handler for classic/browser windows
ipcMain.handle('closeWindow', async (event, args) => {
    const vid = args && args.vid;
    if (!vid) return false;
    const view = browserViews[vid];
    if (!view) return false;

    try {
        // Attempt a clean destroy regardless of custom close handlers
        if (typeof view.destroy === 'function' && !isBrowserViewDestroyed(view)) {
            view.destroy();
        } else if (typeof view.close === 'function') {
            view.close();
        }
    } catch (e) {
        console.error('Error destroying window:', e);
    }

    try {
        delete browserViews[vid];
        releaseWindowId(vid);
    } catch (_) { }

    return true;
});


// Session management IPC handlers
ipcMain.handle('getSessions', () => {
    const sessions = store.get('sessions', {});

    // Ensure default session always exists
    if (!sessions.default) {
        sessions.default = {
            name: 'Default Session',
            description: 'Main session',
            created: Date.now()
        };
        store.set('sessions', sessions);
    }

    return {
        sessions: sessions,
        currentSession: currentSessionName
    };
});

ipcMain.handle('createSession', (event, sessionData) => {
    const sessions = store.get('sessions', {});
    const sessionId = sessionData.id || `session-${Date.now()}`;
    sessions[sessionId] = {
        name: sessionData.name,
        description: sessionData.description || '',
        created: Date.now()
    };
    store.set('sessions', sessions);
    return {
        success: true,
        sessionId
    };
});

ipcMain.handle('stageUserSessionImport', (event, sessionId, localStorageData) => {
    const knownSessions = store.get('sessions', {});
    if (!sessionId || !Object.prototype.hasOwnProperty.call(knownSessions, sessionId)) {
        return {
            success: false,
            message: 'Target session not found'
        };
    }
    if (!localStorageData || typeof localStorageData !== 'object' || Array.isArray(localStorageData)) {
        return {
            success: false,
            message: 'Invalid session import data'
        };
    }

    const normalizedLocalStorage = Object.fromEntries(
        Object.entries(localStorageData)
            .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
            .map(([key, value]) => [String(key), value === null ? null : String(value)])
    );
    for (const key of ['settings', 'socialStreamState']) {
        const value = normalizedLocalStorage[key];
        if (value === null || value === undefined) continue;
        try {
            const parsed = JSON.parse(value);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('Expected an object');
            }
        } catch (_) {
            return {
                success: false,
                message: `Invalid ${key} data in session import`
            };
        }
    }
    const pendingImport = {
        id: crypto.randomBytes(16).toString('hex'),
        stagedAt: Date.now(),
        localStorage: normalizedLocalStorage
    };
    setUserSessionStoreValue('pendingImport', pendingImport, sessionId);
    return {
        success: true,
        importId: pendingImport.id
    };
});

ipcMain.handle('getPendingUserSessionImport', () => {
    const pendingImport = getUserSessionStoreValue('pendingImport', null);
    return {
        success: true,
        pendingImport: pendingImport && typeof pendingImport === 'object' ? pendingImport : null
    };
});

ipcMain.handle('completeUserSessionImport', (event, importId) => {
    const pendingImport = getUserSessionStoreValue('pendingImport', null);
    if (!pendingImport || pendingImport.id !== importId) {
        return {
            success: false,
            message: 'Pending session import not found'
        };
    }
    deleteUserSessionStoreValue('pendingImport');
    return {
        success: true
    };
});

ipcMain.handle('switchSession', async (event, sessionId) => {
    if (sessionId === currentSessionName) {
        return {
            success: false,
            message: 'Already on this session'
        };
    }

    // Save current session
    store.set('currentSession', sessionId);

    // Restart the app to apply new session
    markStabilitySessionGraceful('session-switch-restart');
    app.relaunch();
    app.exit();

    return {
        success: true
    };
});

ipcMain.handle('deleteSession', async (event, sessionId) => {
    if (sessionId === 'default') {
        return {
            success: false,
            message: 'Cannot delete default session'
        };
    }

    const sessions = store.get('sessions', {});
    if (!sessionId || !Object.prototype.hasOwnProperty.call(sessions, sessionId)) {
        return {
            success: false,
            message: 'Session not found'
        };
    }

    queueUserSessionPartitionCleanup(sessionId);
    const deletingActiveSession = sessionId === currentSessionName;
    if (deletingActiveSession) {
        suppressedUserSessionPersistence = sessionId;
    }

    delete sessions[sessionId];
    store.set('sessions', sessions);
    clearUserSessionPersistence(sessionId);

    // If deleting current session, switch to default
    if (deletingActiveSession) {
        store.set('currentSession', 'default');
        markStabilitySessionGraceful('session-delete-restart');
        app.relaunch();
        app.exit();
    } else {
        await processPendingUserSessionPartitionCleanup(sessionId);
    }

    return {
        success: true,
        partitionCleanupPending: getPendingUserSessionPartitionCleanup().includes(sessionId)
    };
});

ipcMain.handle('renameSession', (event, sessionId, newName) => {
    const sessions = store.get('sessions', {});
    if (sessions[sessionId]) {
        sessions[sessionId].name = newName;
        store.set('sessions', sessions);
        return {
            success: true
        };
    }
    return {
        success: false,
        message: 'Session not found'
    };
});

// Export all session data including cookies, localStorage, etc from all windows
ipcMain.handle('exportAllSessionData', async () => {
    try {
        const sessionData = await exportAllSessionData();
        return {
            success: true,
            data: sessionData
        };
    } catch (error) {
        console.error('Error in exportAllSessionData handler:', error);
        return {
            success: false,
            error: error.message
        };
    }
});

// Import all session data including cookies, localStorage, etc
ipcMain.handle('importAllSessionData', async (event, sessionData) => {
    try {
        const results = await importAllSessionData(sessionData);
        return {
            success: true,
            results
        };
    } catch (error) {
        console.error('Error in importAllSessionData handler:', error);
        return {
            success: false,
            error: error.message
        };
    }
});

// Get localStorage data from a specific window/partition for import
ipcMain.handle('getStorageDataForImport', async (event, partitionName) => {
    try {
        const sessionData = store.get('pendingSessionImport', {});
        if (sessionData && sessionData.sessions && sessionData.sessions[partitionName]) {
            return {
                success: true,
                localStorage: sessionData.sessions[partitionName].localStorage || {},
                sessionStorage: sessionData.sessions[partitionName].sessionStorage || {}
            };
        }
        return {
            success: false,
            message: 'No pending import data found'
        };
    } catch (error) {
        console.error('Error getting storage data for import:', error);
        return {
            success: false,
            error: error.message
        };
    }
});

// Generic store setter
ipcMain.handle('store-set', async (event, key, value) => {
    try {
        store.set(key, value);
        return {
            success: true
        };
    } catch (error) {
        console.error('Error setting store value:', error);
        return {
            success: false,
            error: error.message
        };
    }
});

// Generic store getter
ipcMain.handle('store-get', async (event, key) => {
    try {
        const value = store.get(key);
        return {
            success: true,
            value
        };
    } catch (error) {
        console.error('Error getting store value:', error);
        return {
            success: false,
            error: error.message
        };
    }
});

let tray = null;

function isTikTokWindowArgs(args = {}) {
    if (!args || typeof args !== 'object') return false;
    const platform = String(args.platform || args.target || '').trim().toLowerCase();
    if (platform === 'tiktok') return true;

    const sourcePath = String(args.source || '').trim().replace(/\\/g, '/').toLowerCase();
    if (sourcePath.endsWith('/tiktok.js') || sourcePath === 'sources/tiktok.js' || sourcePath === 'tiktok.js') {
        return true;
    }

    const domain = String(args.domain || '').trim().toLowerCase().replace(/^www\./, '');
    if (domain === 'tiktok.com' || domain.endsWith('.tiktok.com')) {
        return true;
    }

    try {
        const parsed = new URL(args.url);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        return host === 'tiktok.com' || host.endsWith('.tiktok.com');
    } catch (_) {
        return false;
    }
}

function shouldPreserveManualTikTokStandardNavigation(args = {}) {
    if (!args || typeof args !== 'object') return false;
    if (args.manualActivation !== true) return false;
    if (args.wss) return false;
    const mode = String(args.connectionMode || args.activeConnectionMode || 'classic').trim().toLowerCase();
    const isStandardMode = !mode || mode === 'classic' || mode === 'standard';
    return isStandardMode && isTikTokWindowArgs(args);
}

function sendWindowNavigationWarning(view, args = {}, navUrl = '', reason = 'navigate', mode = 'prefix') {
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('window-navigation-warning', {
                tabID: view && view.tabID,
                sourceId: (view && view.args && view.args.sourceId) || args.sourceId,
                reason,
                mode,
                initialUrl: args.url,
                newUrl: navUrl,
                platform: args.platform || args.target || args.domain || null
            });
        }
    } catch (_) { }
}

function normalizeCloseOnNavigatePlatform(args = {}) {
    const explicit = String(args.platform || args.target || '').trim().toLowerCase();
    if (explicit) return explicit;

    const sourcePath = String(args.source || '').trim().replace(/\\/g, '/').toLowerCase();
    if (sourcePath.endsWith('/twitch.js') || sourcePath === 'sources/twitch.js' || sourcePath === 'twitch.js') {
        return 'twitch';
    }
    if (sourcePath.endsWith('/vpzone.js') || sourcePath === 'sources/vpzone.js' || sourcePath === 'vpzone.js') {
        return 'vpzone';
    }
    return '';
}

function normalizeNavigationChannel(value) {
    let channel = String(value || '').trim().replace(/^@+/, '');
    try {
        channel = decodeURIComponent(channel);
    } catch (_) { }
    return channel.trim().toLowerCase();
}

function getNavigationChannel(platform, value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch (_) {
        return '';
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    let channel = parsed.searchParams.get('channel') || '';
    if (!channel && platform === 'vpzone') {
        channel = parsed.searchParams.get('username')
            || parsed.searchParams.get('streamUsername')
            || '';
    }

    if (!channel && platform === 'twitch') {
        if (parts[0] === 'popout' && parts[1]) {
            // Moderator/dashboard popout variants keep the channel one segment deeper
            // (/popout/moderator/<channel>/chat, /popout/u/<channel>/...).
            channel = ((parts[1] === 'moderator' || parts[1] === 'u') && parts[2]) ? parts[2] : parts[1];
        } else if ((parts[0] === 'moderator' || parts[0] === 'u') && parts[1]) {
            channel = parts[1];
        } else if (parts[0]) {
            const reserved = new Set([
                'directory', 'downloads', 'inventory', 'jobs', 'login', 'p',
                'search', 'settings', 'signup', 'subscriptions', 'turbo', 'wallet'
            ]);
            if (!reserved.has(parts[0].toLowerCase())) {
                channel = parts[0];
            }
        }
    } else if (!channel && platform === 'vpzone') {
        if (['watch', 'stream', 'u'].includes(String(parts[0] || '').toLowerCase()) && parts[1]) {
            channel = parts[1];
        }
    }

    return normalizeNavigationChannel(channel);
}

function isNavigationHostAllowed(platform, initialUrl, nextUrl) {
    if (!initialUrl || !nextUrl) return false;
    const initialHost = String(initialUrl.hostname || '').toLowerCase();
    const nextHost = String(nextUrl.hostname || '').toLowerCase();
    const isHostFamily = (host, base) => host === base || host.endsWith('.' + base);

    if (platform === 'twitch' && isHostFamily(initialHost, 'twitch.tv')) {
        return isHostFamily(nextHost, 'twitch.tv');
    }
    if (platform === 'vpzone' && isHostFamily(initialHost, 'vpzone.tv')) {
        return isHostFamily(nextHost, 'vpzone.tv');
    }
    return nextUrl.origin === initialUrl.origin;
}

// Redirect chains and auth bounces are judged only where navigation settles; a
// disallowed committed URL gets this long to return to an allowed one before the
// capture window is closed.
const CLOSE_ON_NAVIGATE_SETTLE_MS = 2500;

function createCloseOnNavigateAllowance(args = {}, mode = 'prefix') {
    let initialHref = '';
    let initialOrigin = '';
    let initialNoHash = '';
    let parsedInitialUrl = null;
    try {
        parsedInitialUrl = new URL(args.url);
        initialHref = parsedInitialUrl.href.replace(/\/+$/, '/');
        initialOrigin = parsedInitialUrl.origin;
        initialNoHash = parsedInitialUrl.origin + parsedInitialUrl.pathname + (parsedInitialUrl.search || '');
    } catch (_) {
        initialHref = String(args.url || '').trim();
        initialNoHash = initialHref.replace(/#.*$/, '');
    }

    const platform = normalizeCloseOnNavigatePlatform(args);
    const initialChannel = mode === 'channel' ? getNavigationChannel(platform, args.url) : '';

    return (url) => {
        try {
            const nextUrl = new URL(url);
            const href = nextUrl.href.replace(/\/+$/, '/');
            const noHash = nextUrl.origin + nextUrl.pathname + (nextUrl.search || '');
            if (mode === 'origin') {
                return initialOrigin && nextUrl.origin === initialOrigin;
            }
            if (mode === 'exact') {
                // Treat hash-only changes as allowed; compare without hash fragment.
                return noHash === initialNoHash;
            }
            if (mode === 'channel' && initialChannel) {
                if (!isNavigationHostAllowed(platform, parsedInitialUrl, nextUrl)) {
                    return false;
                }
                const nextChannel = getNavigationChannel(platform, nextUrl.href);
                if (nextChannel) {
                    return nextChannel === initialChannel;
                }
                // Ignore transient internal navigations, but stop once an HTTP(S) page
                // no longer represents the configured capture channel.
                return nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:';
            }
            return href.startsWith(initialHref);
        } catch (_) {
            return true;
        }
    };
}

function getCloseOnNavigateEventUrl(event, legacyUrl) {
    if (event && typeof event.url === 'string' && event.url) return event.url;
    return legacyUrl;
}

function isCloseOnNavigateMainFrameEvent(event, legacyIsMainFrame) {
    const isMainFrame = event && typeof event.isMainFrame === 'boolean'
        ? event.isMainFrame
        : legacyIsMainFrame;
    return isMainFrame !== false;
}

async function createWindow(args, reuse = false, mainApp = false) {
    try {
        var webSecurity = true;
        var URI = args.url,
            NODE = args.node,
            WIDTH = args.width,
            HEIGHT = args.height,
            TITLE = args.title,
            PIN = args.pin,
            X = args.x,
            Y = args.y,
            FULLSCREEN = args.fullscreen,
            UNCLICKABLE = args.uc,
            MINIMIZED = args.min,
            CSS = args.css,
            BGCOLOR = args.chroma,
            runningLocally = args.filesource;
    } catch (e) {
        console.error(e);
    }
    try {
        if (runningFromSource) {
            if (isMac && !runningLocally) {
                runningLocally = "/Users/steveseguin/Code/social_stream/";
                runningFromSource = false;
            }
        }
        if (runningLocally && !runningLocally.endsWith("/")) {
            runningLocally += "/";
        }

        log("runningLocally :" + runningLocally);

        var CSSCONTENT = "";

        if (BGCOLOR) {
            CSSCONTENT = "body {background-color:#" + BGCOLOR + "!important;}";
        }

        if (CSS) {
            var p = path.join(__dirname, ".", CSS);

            var res, rej;
            var promise = new Promise((resolve, reject) => {
                res = resolve;
                rej = reject;
            });
            promise.resolve = res;
            promise.reject = rej;

            fs.readFile(p, "utf8", function (err, data) {
                if (err) {
                    fs.readFile(CSS, "utf8", function (err, data) {
                        if (err) {
                            log("Couldn't read specified CSS file");
                        } else {
                            CSSCONTENT += data;
                        }
                        promise.resolve();
                    });
                } else {
                    CSSCONTENT += data;
                    promise.resolve();
                }
            });
            try {
                await promise;
            } catch (error) {
                log(error);
            }
            if (CSSCONTENT) {
                log("Loaded specified file.");
            }
        }
    } catch (e) {
        console.error(e);
    }
    try {
        if (URI.startsWith("file:")) {
            webSecurity = false; // not ideal, but to open local files, this is needed.
            // warn the user in some way that this window is tained.  perhaps detect if they navigate to a different website or load an iframe that it will be a security concern?
            // maybe filter all requests to file:// and ensure they are made from a file:// resource already.
        } else if (!URI.startsWith("http")) {
            URI = "https://" + URI.toString();
            webSecurity = true; // just in case its a remote URI being loaded.
        }
    } catch (e) {
        URI = pathToFileURL(path.join(__dirname, "index.html")).href; // zero idea.
        webSecurity = false; // should be local, so we're good.
    }

    if (runningFromSource) {
        if (URI.includes("?")) {
            URI += "&devmode";
        } else {
            URI += "?devmode";
        }
    }
    if (runningLocally) {
        if (URI.includes("?")) {
            URI += "&sourcemode=" + encodeURIComponent(runningLocally);
        } else {
            URI += "?sourcemode=" + encodeURIComponent(runningLocally);
        }
        if (mainApp && preferLocalAssetsFlag) {
            URI += "&hostedlinks=1";
        }
    }

    let currentTitle = "Social Stream Ninja";
    try {
        if (reuse) {
            currentTitle = reuse;
        } else if (TITLE === null) {
            counter += 1;
            if (counter === 1) {
                currentTitle = "Social Stream Ninja - Desktop App v" + app.getVersion();
            } else {
                currentTitle = "Social Stream Ninja (" + counter.toString() + ")";
            }
        } else if (counter == 0) {
            counter += 1;
            currentTitle = TITLE.toString();
        } else {
            counter += 1;
            currentTitle = TITLE.toString() + " (" + counter.toString() + ")";
        }
    } catch (e) {
        console.error(e);
    }

    ipcMain.on("prompt", (event, arg) => {
        try {
            let promptWindow = createCustomDialog('prompt.html', 1000, 600, {
                parent: mainWindow
            });

            if (!promptWindow) {
                console.error('Failed to create prompt window');
                event.returnValue = null;
                return;
            }

            // Center the prompt window on the same display as the main window
            if (mainWindow && !mainWindow.isDestroyed()) {
                const mainBounds = mainWindow.getBounds();
                const promptBounds = promptWindow.getBounds();

                // Get the display that contains the main window
                const display = screen.getDisplayMatching(mainBounds);

                // Calculate center position within the display
                const x = display.bounds.x + (display.bounds.width - promptBounds.width) / 2;
                const y = display.bounds.y + (display.bounds.height - promptBounds.height) / 2;

                promptWindow.setPosition(Math.round(x), Math.round(y));
            } else {
                // Fallback to centering on primary display
                promptWindow.center();
            }

            let settled = false;
            let promptTimeout = null;
            const cleanupPrompt = () => {
                if (promptTimeout) {
                    clearTimeout(promptTimeout);
                    promptTimeout = null;
                }
                try {
                    ipcMain.removeListener('prompt-response', onPromptResponse);
                } catch (_) { }
            };
            const settlePrompt = (response, shouldCloseWindow = true) => {
                if (settled) return;
                settled = true;
                cleanupPrompt();
                event.returnValue = response;
                if (shouldCloseWindow && promptWindow && !promptWindow.isDestroyed()) {
                    promptWindow.close();
                }
            };
            const onPromptResponse = (responseEvent, response) => {
                if (!promptWindow || promptWindow.isDestroyed()) return;
                if (responseEvent.sender !== promptWindow.webContents) return;
                settlePrompt(response);
            };

            promptWindow.once('ready-to-show', () => {
                if (!promptWindow || promptWindow.isDestroyed()) return;
                promptWindow.show();
                promptWindow.focus();
            });

            promptWindow.webContents.once('did-finish-load', () => {
                if (!promptWindow || promptWindow.isDestroyed()) return;
                promptWindow.webContents.send('prompt-data', arg || {});
                if (!promptWindow.isVisible()) {
                    promptWindow.show();
                }
                promptWindow.focus();
            });

            ipcMain.on('prompt-response', onPromptResponse);

            promptWindow.on('closed', () => {
                settlePrompt(null, false);
            });

            const parsedTimeoutMs = Number(arg && arg.timeoutMs);
            const timeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0 ? parsedTimeoutMs : 0;
            if (timeoutMs > 0) {
                promptTimeout = setTimeout(() => {
                    log('Prompt timed out');
                    settlePrompt(null, true);
                }, timeoutMs);
            }

        } catch (e) {
            console.error('Error handling prompt:', e);
            event.returnValue = null;
        }
    });
    ipcMain.on("confirm", function (eventRet, arg) {
        // This enables a CONFIRM pop up, which is used to BLOCK the main thread until the user provides input.
        log("confirm");
        try {
            dialog.showMessageBox({
                type: 'question',
                buttons: ['Continue', 'Cancel'],
                defaultId: 1,
                title: arg.title.split("\n")[0],
                message: arg.title.replace("\n", "\n\n").replaceAll("\n", "\n"),
                detail: arg.val || "",
                cancelId: 1,
            }).then(result => {
                if (result.response === 0) {
                    log("user chose Continue");
                    eventRet.returnValue = true;
                } else {
                    log("user chose Cancel");
                    eventRet.returnValue = false;
                }
            }).catch((e) => {
                console.error(e);
                eventRet.returnValue = null;
            });
        } catch (e) {
            console.error(e);
        }
    });

    ipcMain.on("showOpenDialog", async function (eventRet, arg) {
        // this enables a PROMPT pop up , which is used to BLOCK the main thread until the user provides input. VDO.Ninja uses prompt for passwords, etc.
        log("----------------------------- showOpenDialog");
        //eventRet.returnValue = null;;
        try {
            //const { dialog } = require('electron').remote;
            let dialogOptions = {
                title: "Choisir un dossier:",
                properties: ["openFile"],
            };
            await dialog
                .showOpenDialog(dialogOptions)
                .then(async (fileNames) => {
                    log(fileNames);
                    if (fileNames !== undefined) {
                        const filePath = fileNames.filePaths[0]; // Assuming you want to read the first selected file.
                        rememberDialogApprovedPath(filePath);
                        await fs.readFile(filePath, "utf8", async (err, data) => {
                            if (err) {
                                console.error(err);
                                eventRet.returnValue = 1;
                            } else {
                                // The contents of the file are now in the 'data' variable.
                                log("loaded file...");
                                log(data);
                                eventRet.returnValue = data;
                            }
                        });
                    } else {
                        console.error("fileNames is undefined");
                        eventRet.returnValue = 2;
                    }
                })
                .catch((err) => {
                    console.error(err);
                    eventRet.returnValue = 3;
                });
        } catch (e) {
            console.error(e);
        }
    });

    ipcMain.on("alert", function (eventRet, arg) {
        // this enables a PROMPT pop up , which is used to BLOCK the main thread until the user provides input. VDO.Ninja uses prompt for passwords, etc.
        log("PROMPT");
        try {
            arg.val = arg.val || "";
            arg.title = arg.title.replace("\n", "<br /><br />");

            let options = {
                title: arg.title,
                buttons: ["OK"],
                message: arg.val,
            };
            if (appDialogService?.isArmed()) void dialog.showMessageBox(options);
            else dialog.showMessageBoxSync(options);
        } catch (e) {
            console.error(e);
        }
    });


    let factor = 1;


    if (app.isReady()) {
        try {
            const primaryDisplay = screen.getPrimaryDisplay();
            ttt = primaryDisplay.workAreaSize;
            // Don't use scaleFactor for window sizing - Electron handles DPI scaling internally
            // factor = primaryDisplay.scaleFactor || 1;
        } catch (e) {
            console.error('Failed to get screen info:', e);
        }
    }

    var targetWidth = WIDTH;  // Use WIDTH directly without dividing by factor
    var targetHeight = HEIGHT;  // Use HEIGHT directly without dividing by factor

    var tainted = false;
    if (targetWidth > ttt.width) {
        targetHeight = Math.max(parseInt((targetHeight * ttt.width) / targetWidth), 0);
        targetWidth = ttt.width;
        tainted = true;
    }
    if (targetHeight > ttt.height) {
        targetWidth = Math.max(0, parseInt((targetWidth * ttt.height) / targetHeight));
        targetHeight = ttt.height;
        tainted = true;
    }

    // Restore saved window position/size for main window (remembers which monitor it was on)
    // On Windows with mixed-DPI monitors, constructor bounds can be applied at the wrong scale.
    // Workaround: apply saved bounds again after the window is ready.
    let savedWindowX = undefined;
    let savedWindowY = undefined;
    let desiredMainBounds = null;
    if (mainApp && X === -1 && Y === -1) {
        // Only restore saved position if no command-line position args were provided (default is -1)
        const savedState = loadWindowState("index.html");
        const validatedBounds = validateSavedBounds(savedState);
        if (validatedBounds) {
            desiredMainBounds = validatedBounds;
            savedWindowX = validatedBounds.x;
            savedWindowY = validatedBounds.y;

            // Restore saved size (clamped to the matched display work area)
            if (validatedBounds.width && validatedBounds.height) {
                const matchedDisplay = screen.getDisplayMatching(validatedBounds);
                const maxWidth = matchedDisplay?.workAreaSize?.width || ttt.width;
                const maxHeight = matchedDisplay?.workAreaSize?.height || ttt.height;
                targetWidth = Math.min(Math.max(Math.round(validatedBounds.width), 100), maxWidth);
                targetHeight = Math.min(Math.max(Math.round(validatedBounds.height), 100), maxHeight);
                desiredMainBounds = {
                    x: savedWindowX,
                    y: savedWindowY,
                    width: targetWidth,
                    height: targetHeight
                };
            }
        } else if (savedState && savedState.x !== null) {
            // Saved position is off-screen (monitor disconnected) - center on primary display
            const primary = screen.getPrimaryDisplay();
            savedWindowX = Math.round(primary.bounds.x + (primary.bounds.width - targetWidth) / 2);
            savedWindowY = Math.round(primary.bounds.y + (primary.bounds.height - targetHeight) / 2);
        }
    }

    // Create the browser window. 
    mainWindow = new BrowserWindow({
        transparent: false,
        //focusable: false,
        width: targetWidth,
        height: targetHeight,
        x: savedWindowX,
        y: savedWindowY,
        frame: true,
        backgroundColor: "#FFF",
        fullscreenable: true,
        //titleBarStyle: 'customButtonsOnHover',
        roundedCorners: false,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'), // Regular preload without anti-detection
            pageVisibility: true,
            partition: getUserSessionPartitionName(currentSessionName),
            contextIsolation: false,
            backgroundThrottling: !shouldDisableBackgroundThrottlingForGeneralWindows(),
            webSecurity: webSecurity, // this is a locally hosted file, so it should be fine.
            nodeIntegrationInSubFrames: !webSecurity, // if security is on, then node support is off.
            nodeIntegration: !webSecurity // this could be a security hazard, but useful for enabling screen sharing and global hotkeys
        },
        title: currentTitle,
    });

    // BrowserWindow.isVisible() can stay true after hide() on Linux. Track the
    // actual show/hide events so remote status reflects whether the window is up.
    mainWindowVisible = false;
    mainWindow.on("show", () => {
        mainWindowVisible = true;
    });
    mainWindow.on("hide", () => {
        mainWindowVisible = false;
    });


    mainWindowReadyForInjectorToasts = false;
    if (mainWindow && mainWindow.webContents) {
        const wc = mainWindow.webContents;

        if (mainApp && desiredMainBounds && process.platform === "win32") {
            const applyDesiredBounds = () => {
                try {
                    if (!mainWindow || mainWindow.isDestroyed()) return;
                    applyBrowserWindowBounds(mainWindow, desiredMainBounds);
                } catch (_) { }
            };

            // Apply twice to handle Windows per-monitor DPI timing quirks.
            mainWindow.once("ready-to-show", () => {
                applyDesiredBounds();
                setTimeout(applyDesiredBounds, 100);
            });
        }

        wc.on('did-finish-load', () => {
            mainWindowReadyForInjectorToasts = true;
            flushInjectorToastQueue();
        });
        wc.on('will-navigate', () => {
            mainWindowReadyForInjectorToasts = false;
        });
        wc.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
            if (isMainFrame === false) return;
            mainWindowReadyForInjectorToasts = false;
        });
        wc.on('destroyed', () => {
            mainWindowReadyForInjectorToasts = false;
        });
        // Note: Permission handler is set later on mainWindow.webContents.session (see below)
    }

    const consoleFilterPatterns = [
        /Potential permissions policy violation/i,
        /Unrecognized feature/i,
        /Electron Security Warning/i
    ];

    mainWindow.webContents.on('console-message', (event) => {
        const message = typeof event?.message === 'string' ? event.message : '';
        if (consoleFilterPatterns.some((pattern) => pattern.test(message))) {
            if (typeof event?.preventDefault === 'function') {
                event.preventDefault();
            }
            return;
        }
    });

    mainWindow.args = args; // storing settings
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
            if (details.responseHeaders["X-Frame-Options"]) {
                delete details.responseHeaders["X-Frame-Options"];
            } else if (details.responseHeaders["x-frame-options"]) {
                delete details.responseHeaders["x-frame-options"];
            }
            callback({
                cancel: false,
                responseHeaders: details.responseHeaders
            });
        });

        mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
            try {
                const allowedPermissions = [
                    "media",
                    "audioCapture",
                    "desktopCapture",
                    "pageCapture",
                    "tabCapture",
                    "experimental",
                    "screenCapture",
                    "display-capture",
                    "midiSysex",
                    "midi",
                    "shared-array-buffer",
                    "clipboard-sanitized-write",
                    "screen-wake-lock",
                    "notifications",
                    "fullscreen",
                    "clipboard-read",
                    "clipboard-write"
                ];

                if (allowedPermissions.includes(permission)) {
                    callback(true); // Approve permission request
                } else {
                    console.warn(
                        `[Permission] '${permission}' was not whitelisted and has been blocked.`
                    );
                    callback(false); // Deny
                }
            } catch (e) {
                console.error(e);
            }
        });


        /* 	mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
            const currentZoom = mainWindow.webContents.getZoomFactor();
            if (zoomDirection === 'in') {
              mainWindow.webContents.setZoomFactor(currentZoom + 0.1);
            } else if (zoomDirection === 'out') {
              mainWindow.webContents.setZoomFactor(currentZoom - 0.1);
            }
        });
        	

          // Handle Ctrl+mousewheel zoom
        mainWindow.webContents.on('before-input-event', (event, input) => {
            if (input.control && input.type === 'mouseWheel') {
              const zoomDirection = input.deltaY < 0 ? 'in' : 'out';
              mainWindow.webContents.emit('zoom-changed', event, zoomDirection);
            }
        }); */

        handleZoom(mainWindow);

        // Add window state saving for main window
        // Skip saving during initial window setup to prevent DPI-related resize from corrupting saved size
        let mainWindowReadyToSaveState = false;
        mainWindow.webContents.once("did-finish-load", () => {
            // Delay enabling state saving to allow any initial resize/positioning to settle
            setTimeout(() => {
                mainWindowReadyToSaveState = true;
            }, 500);
        });

        let saveTimeout;
        mainWindow.on("resize", () => {
            if (!mainWindowReadyToSaveState) return;
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => {
                saveWindowState(mainWindow);
            }, 100);
        });

        mainWindow.on("move", () => {
            if (!mainWindowReadyToSaveState) return;
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => {
                saveWindowState(mainWindow);
            }, 100);
        });

        mainWindow.webContents.setWindowOpenHandler(({
            url,
            features
        }) => {

            var frame = !shouldUseFramelessForUrl(url);
            log(url);
            if ((isSocialStreamRemoteUrl(url) && matchesSocialStreamPagePath(url, "chathistory")) || (url == "./chathistory.html")) {
                url = path.join(__dirname, "chathistory.html");
            }

            var backgroundColor = "#DDD";
            var useTransparency = shouldUseTransparentWindowForUrl(url);
            if (!frame) {
                backgroundColor = "#0000";
            }
            const forceWin10Compatibility = shouldUseWin10TransparencyCompat(frame, useTransparency);

            if ((isSocialStreamRemoteUrl(url) && matchesSocialStreamPagePath(url, "cohost")) || (url.startsWith("file://") && url.includes("/cohost"))) {
                var config = {
                    webPreferences: {
                        preload: path.join(__dirname, "preload.js"),
                        pageVisibility: true,
                        partition: getTrackedPartition(currentSessionName),
                        contextIsolation: false,
                        backgroundThrottling: !shouldDisableBackgroundThrottlingForGeneralWindows(),
                        webSecurity: true,
                        nodeIntegrationInSubFrames: true,
                        nodeIntegration: true, // required for screen sharing, hotkeys, and code injection in cohost
                        additionalPermissions: ['clipboard-write']
                    },
                    show: true,
                    backgroundColor: backgroundColor,
                    transparent: useTransparency,
                    resizable: !forceWin10Compatibility,
                    frame: frame,
                    autoHideMenuBar: false,
                    title: url.replace("https://", "").slice(0, 50),
                };
            } else {
                var config = {
                    webPreferences: {
                        preload: path.join(__dirname, "preload.js"),
                        pageVisibility: true,
                        partition: getUserSessionPartitionName(currentSessionName),
                        contextIsolation: true,
                        backgroundThrottling: !shouldDisableBackgroundThrottlingForGeneralWindows(),
                        webSecurity: true, // this is probably a remote file, so we will ensure its off
                        nodeIntegrationInSubFrames: false, // also security concern
                        nodeIntegration: false, // this could be a security hazard, but useful for enabling screen sharing and global hotkeys
                        additionalPermissions: ['clipboard-write']
                    },
                    show: true,
                    backgroundColor: backgroundColor,
                    transparent: useTransparency,
                    resizable: !forceWin10Compatibility,
                    frame: frame,
                    autoHideMenuBar: false,
                    title: url.replace("https://", "").slice(0, 50),
                };
            }
            applyPlatformWindowCompatibility(config);

            const restoredWindowBounds = resolveWindowBoundsForUrl(url);
            if (restoredWindowBounds) {
                if (restoredWindowBounds.x !== null && restoredWindowBounds.x !== undefined) {
                    config.x = restoredWindowBounds.x;
                }
                if (restoredWindowBounds.y !== null && restoredWindowBounds.y !== undefined) {
                    config.y = restoredWindowBounds.y;
                }
                if (restoredWindowBounds.width) {
                    config.width = Math.round(restoredWindowBounds.width);
                }
                if (restoredWindowBounds.height) {
                    config.height = Math.round(restoredWindowBounds.height);
                }
            }

            const view = new BrowserWindow(config);

            if (process.platform === "win32" && restoredWindowBounds) {
                const applyDesiredBounds = () => {
                    try {
                        if (isBrowserViewDestroyed(view)) return;
                        applyBrowserWindowBounds(view, restoredWindowBounds);
                    } catch (_) { }
                };

                view.once("ready-to-show", () => {
                    applyDesiredBounds();
                    setTimeout(applyDesiredBounds, 100);
                });
            }

            // Workaround for Electron 36 frameless window titlebar issue
            if (!frame && APPLY_WIN_FRAMELESS_WORKAROUND) {
                // Show the window immediately but apply fixes
                view.show();

                // Apply initial fix after a short delay
                setTimeout(() => {
                    if (!isBrowserViewDestroyed(view)) {
                        // Force a resize to trigger proper rendering
                        const bounds = view.getBounds();
                        view.setBounds({
                            x: bounds.x,
                            y: bounds.y,
                            width: bounds.width + 1,
                            height: bounds.height
                        });
                        view.setBounds(bounds);
                    }
                }, 100);

                // Handle blur events to prevent titlebar from appearing
                let blurTimeout;
                view.on('blur', () => {
                    // Clear any existing timeout
                    if (blurTimeout) clearTimeout(blurTimeout);

                    blurTimeout = setTimeout(() => {
                        if (!isBrowserViewDestroyed(view)) {
                            // Store current bounds
                            const currentBounds = view.getBounds();

                            // Toggle a minimal size change to force re-render
                            view.setBounds({
                                x: currentBounds.x,
                                y: currentBounds.y,
                                width: currentBounds.width + 1,
                                height: currentBounds.height
                            });

                            // Immediately restore original size
                            view.setBounds(currentBounds);
                        }
                    }, 10);
                });

                // Clean up timeout on window close
                view.on('closed', () => {
                    if (blurTimeout) clearTimeout(blurTimeout);
                });
            }

            // Skip saving during initial window setup to prevent DPI-related resize from corrupting saved size
            let viewReadyToSaveState = false;
            view.webContents.once("did-finish-load", () => {
                setTimeout(() => {
                    viewReadyToSaveState = true;
                }, 500);
            });

            let saveTimeout;
            view.on("resize", () => {
                if (!viewReadyToSaveState) return;
                clearTimeout(saveTimeout);
                saveTimeout = setTimeout(() => {
                    saveWindowState(view);
                }, 100);
            });

            view.on("move", () => {
                if (!viewReadyToSaveState) return;
                clearTimeout(saveTimeout);
                saveTimeout = setTimeout(() => {
                    saveWindowState(view);
                }, 100);
            });

            let isClosing = false;
            view.on("close", async (event) => {
                log("close");
                if (isClosing) return;
                event.preventDefault();
                isClosing = true;

                view.hide(); // Hide immediately for better UX
                saveWindowState(view);
                view.webContents.closeDevTools();

                view.webContents.send('close-file-stream');

                await new Promise(resolve => setTimeout(resolve, 1000));
                view.destroy();
            });

            if (view.webContents) {
                // Auto-close on top-level navigation for activated (classic) windows if configured
                try {
                    const enforceCloseOnNavigate = (!args.wss && args.config && args.config.closeOnNavigate === true);
                    if (enforceCloseOnNavigate) {
                        const mode = (args.config && args.config.closeOnNavigateMode) || 'prefix'; // 'origin' | 'prefix' | 'exact' | 'channel'
                        const preserveManualTikTokStandard = shouldPreserveManualTikTokStandardNavigation(args);
                        let navigationWarningSent = false;
                        let navigationCloseStarted = false;
                        const isAllowed = createCloseOnNavigateAllowance(args, mode);

                        const maybeClose = (navUrl, reason) => {
                            if (!isAllowed(navUrl)) {
                                if (preserveManualTikTokStandard) {
                                    try { log(`Keeping manual TikTok Standard window open after navigation (${reason}): ${navUrl}`); } catch (_) { }
                                    if (!navigationWarningSent) {
                                        navigationWarningSent = true;
                                        sendWindowNavigationWarning(view, args, navUrl, reason, mode);
                                    }
                                    return;
                                }
                                if (navigationCloseStarted) return;
                                navigationCloseStarted = true;
                                try { log(`Auto-closing activated window due to navigation (${reason}): ${navUrl}`); } catch (_) { }
                                try {
                                    // Inform renderer (best-effort)
                                    if (mainWindow && !mainWindow.isDestroyed()) {
                                        mainWindow.webContents.send(`window-closed-${view.tabID}`);
                                    }
                                } catch (_) { }
                                try { if (!isBrowserViewDestroyed(view)) view.destroy(); } catch (_) { }
                                try { delete browserViews[view.tabID]; releaseWindowId(view.tabID); } catch (_) { }
                            }
                        };

                        view.webContents.on('will-navigate', (event, url) => { maybeClose(url, 'will-navigate'); });
                        view.webContents.on('did-navigate', (event, url) => { maybeClose(url, 'did-navigate'); });
                        view.webContents.on('did-navigate-in-page', (event, url, isMainFrame) => {
                            if (!isCloseOnNavigateMainFrameEvent(event, isMainFrame)) return;
                            maybeClose(getCloseOnNavigateEventUrl(event, url), 'did-navigate-in-page');
                        });
                        view.webContents.on('did-redirect-navigation', (event, url, _isInPlace, isMainFrame) => {
                            if (!isCloseOnNavigateMainFrameEvent(event, isMainFrame)) return;
                            maybeClose(getCloseOnNavigateEventUrl(event, url), 'redirect');
                        });
                    }
                } catch (e) {
                    try { console.warn('Error attaching closeOnNavigate handlers:', e); } catch (_) { }
                }
                // Log the URL being loaded
                console.log("Loading URL in new window:", url);

                view.webContents.loadURL(url).catch(err => {
                    console.error("Failed to load URL:", url, err);
                });

                view.webContents.on("zoom-changed", (event, zoomDirection) => {
                    const currentZoom = view.webContents.getZoomFactor();
                    if (zoomDirection === "in") {
                        view.webContents.setZoomFactor(currentZoom + 0.1);
                    } else if (zoomDirection === "out") {
                        view.webContents.setZoomFactor(currentZoom - 0.1);
                    }
                });

                view.webContents.on("did-fail-load", function (e) {
                    console.error("failed to load");
                    console.error(e);
                    //quitApp();
                });

                // Handle Ctrl+mousewheel zoom
                view.webContents.on("before-input-event", (event, input) => {
                    if (input.control && input.type === "mouseWheel") {
                        const zoomDirection = input.deltaY < 0 ? "in" : "out";
                        view.webContents.emit("zoom-changed", event, zoomDirection);
                    }
                });
            }

            createMenu();

            return {
                action: "deny"
            }; // This denies the default window creation since we already created our custom window
        });
    }
    //var appData = process.env.APPDATA+"\\..\\Local" || (process.platform == 'darwin' ? process.env.HOME + '/Library/Preferences' : process.env.HOME + "/.local/share")

    createMenu();

    /* 	let options  = {
         title : "",
         buttons: ["OK"],
         message:folder
    };
    let response = dialog.showMessageBoxSync(options);
     */
    if (UNCLICKABLE) {
        mainWindow.mouseEvent = true;
        mainWindow.setIgnoreMouseEvents(mainWindow.mouseEvent);
    }

    ipcMain.on("backgroundLoaded", function (eventRet, value) {
        // this doens't run tho, does it?
        log("BACKGROUND LOADED");
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send(
                "fromMainToIndex",
                (cachedState.wsServer || wsServer.server) ? "serverStarted" : "loadPopup",
                { port: wsServer.port }
            );
        }
    });

    ipcMain.on("write-to-file", (event, {
        filePath,
        data
    }) => {
        if (!isPathAllowed(filePath)) {
            console.warn("write-to-file blocked: path not allowed:", filePath);
            event.reply("write-failure", "Path not allowed");
            return;
        }
        log("WRITING FILE: " + filePath);

        fs.writeFile(filePath, data, (err) => {
            if (err) {
                console.error("Failed to write the file:", err);
                event.reply("write-failure", err.message);
            } else {
                log("File has been written successfully.");
                event.reply("write-success", filePath);
            }
        });
    });

    ipcMain.on("append-to-file", (event, { filePath, data }) => {
        if (!isPathAllowed(filePath)) {
            console.warn("append-to-file blocked: path not allowed:", filePath);
            event.reply("append-failure", "Path not allowed");
            return;
        }
        fs.appendFile(filePath, data, (err) => {
            if (err) {
                console.error("Failed to append to file:", err);
                event.reply("append-failure", err.message);
            } else {
                event.reply("append-success", filePath);
            }
        });
    });

	    ipcMain.on("fromBackground", function (eventRet, value) {
        log("\nfromBackground ??????????????????");
        log("Received settings from background:", JSON.stringify(value).substring(0, 200));

        // Merge instead of replace to avoid losing keys not sent by the renderer.
        // Protect established settings from being overwritten with empty/partial data.
	        if (value && typeof value === "object") {
	            const normalizedValue = { ...value };
	            let shouldClearPassword = false;
	            if ("streamID" in normalizedValue) {
	                const normalizedStreamID = normalizeStreamIdValue(normalizedValue.streamID);
	                if (normalizedStreamID === null) {
	                    delete normalizedValue.streamID;
	                } else {
	                    normalizedValue.streamID = normalizedStreamID;
	                }
	            }
	            if ("password" in normalizedValue) {
	                const normalizedPassword = normalizePasswordValue(normalizedValue.password);
	                if (normalizedPassword === null) {
	                    shouldClearPassword = true;
	                    delete normalizedValue.password;
	                } else {
	                    normalizedValue.password = normalizedPassword;
	                }
	            }

	            if ("settings" in normalizedValue && normalizedValue.settings && typeof normalizedValue.settings === "object") {
	                const existingSettings = cachedState?.settings || {};
	                const existingCount = Object.keys(existingSettings).length;
	                const incomingCount = Object.keys(normalizedValue.settings).length;
	                const hasEstablished = existingCount > SETTINGS_VALIDATION.MIN_EXISTING_KEYS;
	                const isPartial = incomingCount < existingCount * SETTINGS_VALIDATION.PARTIAL_THRESHOLD_RATIO;

	                if (hasEstablished && isPartial) {
	                    log(`[fromBackground] Blocking settings downgrade (incoming: ${incomingCount}, existing: ${existingCount})`);
	                    delete normalizedValue.settings; // keep existing settings
	                } else if (incomingCount === 0 && existingCount > 0) {
	                    log(`[fromBackground] Blocking empty settings overwrite (existing: ${existingCount})`);
	                    delete normalizedValue.settings;
	                }
	            }
	            cachedState = { ...cachedState, ...normalizedValue };
	            if (shouldClearPassword) {
	                delete cachedState.password;
	            }
	        }

        //log(cachedState);
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.mainFrame.frames.forEach((frame) => {
                if (matchesSocialStreamPagePath(frame.url, "popup")) {
                    frame.postMessage("fromMain", cachedState);
                    log("SENT TO POP UP SCUCESSFULLY");
                }
            });

            mainWindow.webContents.send(
                "fromMainToIndex",
                (cachedState.wsServer || wsServer.server) ? "serverStarted" : "loadPopup",
                { port: wsServer.port }
            ); // let the index.html page know the pop out should be loaded
        }
        eventRet.returnValue = cachedState;
    });

    /**
     * Flush any pending debounced storageSave operations immediately.
     * Called on app quit to ensure no data loss and prevent post-quit timer firing.
     */
    function flushPendingStorageSave() {
        if (!storageSavePending) return;

        clearTimeout(storageSaveDebounceTimer);
        storageSaveDebounceTimer = null;
        storageSavePending = false;
        const allowSettingsDowngrade = storageSavePendingAllowSettingsDowngrade;
        storageSavePendingAllowSettingsDowngrade = false;

        log("[storageSave] Flushing pending save");
        try {
            persistCachedStateSafely(cachedState, {
                reason: "flush-pending-storageSave",
                allowSettingsDowngrade
            });
        } catch (e) {
            console.error(e);
        }
        try {
            const payload = buildLocalStorageMirrorPayload(cachedState);
            updateLocalStorageBackup(payload, { allowSettingsDowngrade });
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
                mirrorCachedStateToLocalStorage(mainWindow);
            }
        } catch (e) {
            console.warn("Failed to mirror cachedState to localStorage on flush:", e?.message || e);
        }
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
                mainWindow.webContents.mainFrame.frames.forEach((frame) => {
                    if (matchesSocialStreamPagePath(frame.url, "popup")) {
                        frame.postMessage("fromMain", cachedState);
                    }
                });
            }
        } catch (e) {
            console.warn("Failed to update popup.html on flush:", e?.message || e);
        }
    }

    // Expose flushPendingStorageSave globally so quitApp can call it
    global.flushPendingStorageSave = flushPendingStorageSave;

    ipcMain.on("storageSave", function (eventRet, value) {
        // from background

        // Sanitize and merge incoming state immediately (caller expects updated state back)
	        const incoming = (value && typeof value === "object") ? value : {};
        const allowEmptySettings = incoming.allowEmptySettings === true;
        if ("allowEmptySettings" in incoming) {
            delete incoming.allowEmptySettings;
        }
	        const sanitized = {};
	        let shouldClearPassword = false;
	        let didAnyStateFieldChange = false;
	        Object.entries(incoming).forEach(([key, val]) => {
	            if (key === "password") {
	                const normalizedPassword = normalizePasswordValue(val);
	                const existingPassword = normalizePasswordValue(cachedState.password);
	                if (normalizedPassword !== null) {
	                    sanitized[key] = normalizedPassword;
	                    if (existingPassword !== normalizedPassword) {
	                        didAnyStateFieldChange = true;
	                    }
	                } else {
	                    shouldClearPassword = true;
	                    if (Object.prototype.hasOwnProperty.call(cachedState, "password")) {
	                        didAnyStateFieldChange = true;
	                    }
	                }
	                return;
	            }
	            if (key === "streamID") {
	                const normalizedStreamID = normalizeStreamIdValue(val);
	                const existingStreamID = normalizeStreamIdValue(cachedState.streamID);
	                if (normalizedStreamID !== null) {
	                    sanitized[key] = normalizedStreamID;
	                    if (existingStreamID !== normalizedStreamID) {
	                        didAnyStateFieldChange = true;
	                    }
	                }
	                return;
	            }
	            if (val === undefined || val === null) {
	                return;
	            }
	            if (key === "settings" && val && typeof val === "object") {
	                const existingSettings = cachedState?.settings || {};
                const existingCount = Object.keys(existingSettings).length;
                const incomingCount = Object.keys(val).length;

                const hasEstablishedSettings = existingCount > SETTINGS_VALIDATION.MIN_EXISTING_KEYS;
                const isPartialLoad = incomingCount < existingCount * SETTINGS_VALIDATION.PARTIAL_THRESHOLD_RATIO;

                // Block if incoming has significantly fewer keys (likely incomplete load)
                if (hasEstablishedSettings && isPartialLoad && !allowEmptySettings) {
                    log(`[storageSave] Blocking partial settings overwrite (incoming: ${incomingCount}, existing: ${existingCount})`);
                    return;
                }
                // Block completely empty settings
                if (incomingCount === 0 && existingCount > 0 && !allowEmptySettings) {
                    log(`[storageSave] Blocking empty settings overwrite`);
                    return;
                }
	                if (!areSettingsSnapshotsEqual(cachedState.settings, val)) {
	                    didAnyStateFieldChange = true;
	                }
	            } else if (!areStorageValuesEqual(cachedState[key], val)) {
	                didAnyStateFieldChange = true;
	            }
	            sanitized[key] = val;
	        });
	        cachedState = { ...cachedState, ...sanitized };
	        if (shouldClearPassword) {
	            delete cachedState.password;
	        }

        // Return merged state immediately (required for sendSync callers)
        eventRet.returnValue = cachedState;

        if (!didAnyStateFieldChange) return;

        // Debounce the expensive I/O operations to batch rapid sequential saves
        storageSavePending = true;
        storageSavePendingAllowSettingsDowngrade = storageSavePendingAllowSettingsDowngrade || allowEmptySettings;
        clearTimeout(storageSaveDebounceTimer);
        storageSaveDebounceTimer = setTimeout(() => {
            storageSavePending = false;
            storageSaveDebounceTimer = null;
            const allowSettingsDowngrade = storageSavePendingAllowSettingsDowngrade;
            storageSavePendingAllowSettingsDowngrade = false;

            log("[storageSave] Persisting batched changes");
            try {
                persistCachedStateSafely(cachedState, {
                    reason: "storageSave-batch",
                    allowSettingsDowngrade
                });
            } catch (e) {
                console.error(e);
            }
            try {
                const payload = buildLocalStorageMirrorPayload(cachedState);
                updateLocalStorageBackup(payload, { allowSettingsDowngrade });
                if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
                    mirrorCachedStateToLocalStorage(mainWindow);
                }
            } catch (e) {
                console.warn("Failed to mirror cachedState to localStorage on save:", e?.message || e);
            }

            // Update popup.html with latest state
            try {
                if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
                    mainWindow.webContents.mainFrame.frames.forEach((frame) => {
                        if (matchesSocialStreamPagePath(frame.url, "popup")) {
                            frame.postMessage("fromMain", cachedState);
                        }
                    });
                }
            } catch (e) {
                console.warn("Failed to update popup.html:", e?.message || e);
            }
        }, 150);
    });

    ipcMain.on("storageGet", function (eventRet, value) {
        // from background , ["streamID", "password", "state", "settings"];

        if (!cachedStateReady) {
            // This should not happen - state loads before createWindow registers these handlers
            console.warn("[storageGet] Called before cachedState ready - returning current state");
        }

        var response = {};

        log("\n >>>>>      getting from storage");
        ////log("!!!!!!!!!!!!!cachedState");
        //log(cachedState);

        if (shouldRecoverCachedStateFromBackups(cachedState)) {
            const diskResult = loadCachedStateWithBackupSource({ logSelection: true, updateBaseline: false });
            if (diskResult && diskResult.state) {
                applyRecoveredCachedState(diskResult, "storageGet");
            }
        }
        if (shouldRecoverCachedStateFromBackups(cachedState)) {
            try {
                hydrateCachedStateFromStoreBackup();
            } catch (_) { }
        }
        queueCachedStateRecovery("storageGet");

        value.forEach((key) => {
            //log(key);
            if (cachedState && key in cachedState) {
                response[key] = cachedState[key];
            }
        });
        //log("storageGet running still");

        log(response);
        eventRet.returnValue = response;
    });

    ipcMain.handle("storageGetAsync", async (eventRet, value) => {
        const response = {};
        await recoverCachedStateIfNeeded("storageGetAsync");
        if (Array.isArray(value)) {
            value.forEach((key) => {
                if (cachedState && key in cachedState) {
                    response[key] = cachedState[key];
                }
            });
        }
        return response;
    });

    ipcMain.on("fromBackgroundPopupResponse", function (eventRet, value) {
        // // state, password, streamID, settings
        if (!value) {
            return;
        }
        const hasPersistedPayload = hasPersistedFieldPayload(value);
        const didPersistedStateChange = hasPersistedPayload
            ? applyPersistedStateFieldsFromResponse(value, "fromBackgroundPopupResponse")
            : false;

        if (didPersistedStateChange) {
            try {
                const payload = buildLocalStorageMirrorPayload(cachedState);
                updateLocalStorageBackup(payload);
                if (mainWindow && mainWindow.webContents) {
                    mirrorCachedStateToLocalStorage(mainWindow);
                }
            } catch (e) {
                console.warn("Failed to mirror cachedState after popup response:", e?.message || e);
            }
        }

        // Forward response to popup frame
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.mainFrame.frames.forEach((frame) => {
                if (matchesSocialStreamPagePath(frame.url, "popup")) {
                    frame.postMessage("fromMain", value);
                }
            });
        }

        eventRet.returnValue = value;
    });

    ipcMain.on("fromBackgroundResponse", function (eventRet, value) {
        // log("\nBackgroundResponsed");
        //log(value)

        // // state, password, streamID, settings
        if (!value) {
            return;
        }
        if (!hasPersistedFieldPayload(value)) {
            eventRet.returnValue = value;
            return;
        }
        const didPersistedStateChange = applyPersistedStateFieldsFromResponse(value, "fromBackgroundResponse");

        if (didPersistedStateChange) {
            try {
                const payload = buildLocalStorageMirrorPayload(cachedState);
                updateLocalStorageBackup(payload);
                if (mainWindow && mainWindow.webContents) {
                    mirrorCachedStateToLocalStorage(mainWindow);
                }
            } catch (e) {
                console.warn("Failed to mirror cachedState after background response:", e?.message || e);
            }
        }
        eventRet.returnValue = value;
    });

    ipcMain.on("fromPopup", function (eventRet, value) {
        // Check if this is an async message with callbackId
        const hasCallbackId = value && value.callbackId;

        if (!hasCallbackId && value.cmd) {
            // Sync message - return immediately
            if (value.cmd == "getSettings") {
                eventRet.returnValue = cachedState;
            } else if (value.cmd == "getOnOffState") {
                eventRet.returnValue = {
                    state: cachedState.state || false
                };
            } else if (value.cmd == "setOnOffState") {
                if (value.data) {
                    cachedState.state = value.data.value || false;
                }
                eventRet.returnValue = {
                    state: cachedState.state || false
                };
            } else {
                eventRet.returnValue = cachedState;
            }
        } else if (!hasCallbackId) {
            // Sync message without cmd
            eventRet.returnValue = {
                state: cachedState.state || false
            };
        }

        try {
            if (mainWindow && mainWindow.webContents) {
                mainWindow.webContents.mainFrame.frames.forEach((frame) => {
                    if (matchesSocialStreamPagePath(frame.url, "background")) {
                        frame.postMessage("fromPopup", value); // pass it along to the actual background
                    }
                });
            }
        } catch (e) {
            console.error(e);
        }
    });

    ipcMain.on("fromPopupResponse", function (eventRet, value) {
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.mainFrame.frames.forEach((frame) => {
                if (matchesSocialStreamPagePath(frame.url, "background")) {
                    frame.postMessage("fromMain", value);
                }
            });
        }
    });

    ipcMain.on("PPTHotkey", function (eventRet, value) {
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send("postMessage", {
                PPT: true,
                node: mainWindow.node
            }); // sends to INDEX
        }
    });

    try {
        mainWindow.node = NODE;

        if (X != -1 || Y != -1) {
            if (X == -1) {
                X = 0;
            }
            if (Y == -1) {
                Y = 0;
            }
            mainWindow.setPosition(Math.floor(X / factor), Math.floor(Y / factor));
        }
    } catch (e) {
        console.error(e);
    }

    mainWindow.on("close", async function (e) {
        log("mainWindow close");
        saveWindowState(mainWindow);
        if (!app.isQuitting) {
            e.preventDefault();
            if (closeToTrayEnabled) {
                minimizeToTray();
            } else {
                quitApp();
            }
        } else {
            try {
                ipcMain.removeAllListeners("prompt");
                ipcMain.removeAllListeners("showOpenDialog");
                ipcMain.removeAllListeners("alert");
                ipcMain.removeAllListeners("backgroundLoaded");
                ipcMain.removeAllListeners("fromBackground");
                ipcMain.removeAllListeners("storageSave");
                ipcMain.removeAllListeners("storageGet");
                ipcMain.removeAllListeners("fromBackgroundPopupResponse");
                ipcMain.removeAllListeners("fromBackgroundResponse");
                ipcMain.removeAllListeners("fromPopup");
                ipcMain.removeAllListeners("fromPopupResponse");
                ipcMain.removeAllListeners("PPTHotkey");
                ipcMain.removeAllListeners("postMessage");
                ipcMain.removeAllListeners("getAppVersion");
                ipcMain.removeAllListeners("createWindow");
                ipcMain.removeAllListeners("disconnectTikTokConnection");
                ipcMain.removeAllListeners("getVersion");
                ipcMain.removeAllListeners("createTikTokConnection");
                ipcMain.removeHandler("createTikTokConnection");
                ipcMain.removeAllListeners("reloadWindow");
                ipcMain.removeAllListeners("closeWindow");
                ipcMain.removeAllListeners("clearWindowCache");
                ipcMain.removeAllListeners("clearAllCache");
                ipcMain.removeAllListeners("showWindow");
                ipcMain.removeAllListeners("muteWindow");
                ipcMain.removeAllListeners("sendToTab");
                ipcMain.removeAllListeners("getTabs");
                ipcMain.removeAllListeners("sendInputToTab");
                ipcMain.removeAllListeners("getSources");
            } catch (e) { }


            // Destroy browser views
            if (browserViews) {
                for (var winID in browserViews) {
                    try {
                        if (browserViews[winID]) {
                            try {
                                browserViews[winID].close();

                                // Immediate cleanup with safety check
                                if (!browserViews[winID].isDestroyed()) {
                                    browserViews[winID].destroy();
                                }
                            } catch (e) {
                                console.error(`Error closing/destroying view ${winID}:`, e);
                            } finally {
                                // Always remove reference to prevent memory leak
                                delete browserViews[winID];
                                // Also release window ID
                                releaseWindowId(winID);
                            }
                        }
                    } catch (e) {
                        console.error("Error destroying browser view:", e);
                    }
                }
            }
            browserViews = {};

            // Clean up global intervals
            if (global.intervals) {
                global.intervals.forEach(interval => {
                    try {
                        clearInterval(interval);
                    } catch (e) {
                        console.error("Error clearing interval:", e);
                    }
                });
                global.intervals = [];
            }

            try {
                // Close all child windows
                BrowserWindow.getAllWindows().forEach((window) => {
                    if (window !== mainWindow) {
                        window.close();
                    }
                });
            } catch (e) { }
            try {
                // Unregister all shortcuts
                globalShortcut.unregisterAll();

                if (mainWindow) {
                    mainWindow.removeAllListeners();
                }
            } catch (e) { }

            try {
                if (dialog) {
                    dialog.closeAll();
                }
            } catch (e) { }

            try {
                if (tray) {
                    tray.destroy();
                    tray = null;
                }
            } catch (e) { }

            try {

                if (mainWindow && !mainWindow.isDestroyed()) {

                    mainWindow.close();

                    setTimeout(() => {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.destroy();
                        }
                    }, 2000);
                }
            } catch (e) {
                console.error("Error during window close:", e);
            }
        }
    });

    mainWindow.on("closed", async function (e) {
        log("mainWindow closed");
        mainWindowVisible = false;

        // Clear any intervals attached to mainWindow
        if (mainWindow && mainWindow.intervals) {
            mainWindow.intervals.forEach(interval => clearInterval(interval));
            mainWindow.intervals = [];
        }

        setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.destroy();
                mainWindow = null;
            }
        }, 2000);
    });

    mainWindow.on("page-title-updated", function (event) {
        event.preventDefault();
    });

    mainWindow.webContents.on("did-fail-load", function (e) {
        console.error("failed to load");
        console.error(e);
        //quitApp();
    });


    mainWindow.webContents.on(
        "new-window",
        (event, url, frameName, disposition, options, additionalFeatures, referrer, postBody) => {
            if (mainWindow && mainWindow.webContents) {
                mainWindow.webContents.mainFrame.frames.forEach((frame) => {
                    if (frame.url === referrer.url) {
                        event.preventDefault();
                        frame.executeJavaScript(
                            '(function () {\
						window.location = "' +
                            url +
                            '";\
					})();'
                        );
                    } else if (frame.frames) {
                        frame.frames.forEach((subframe) => {
                            if (subframe.url === referrer.url) {
                                event.preventDefault();
                                subframe.executeJavaScript(
                                    '(function () {\
								window.location = "' +
                                    url +
                                    '";\
							})();'
                                );
                            }
                        });
                    }
                });
            }
        }
    );

    mainWindow.webContents.session.on("will-download", (event, item, webContents) => {
        if (mainWindow && mainWindow.webContents) {
            var currentURL = mainWindow.webContents.getURL();
        } else if (webContents.getURL) {
            var currentURL = webContents.getURL();
        }
        if (currentURL.includes("autorecord") || args.savefolder !== null) {
            var dir = args.savefolder;
            if (!dir && process.platform == "darwin") {
                //process.env.USERPROFILE
                dir = process.env.HOME + "/Downloads/";
            } else if (!dir && process.platform == "win32") {
                //process.env.USERPROFILE
                dir = process.env.USERPROFILE + "\\Downloads\\";
            } else if (!dir && process.env.HOME) {
                //process.env.USERPROFILE
                dir = process.env.HOME + "/";
            } else if (!dir && process.env.USERPROFILE) {
                //process.env.USERPROFILE
                dir = process.env.USERPROFILE + "/";
            }

            if (dir !== null) {
                log("Auto saving too " + dir + item.getFilename());
                item.setSavePath(dir + item.getFilename());
            }
        }
    });

    function handleNavigation(event, url) {
        const urlObj = new URL(url);
        if (!["https:", "http:", "file:"].includes(urlObj.protocol)) {
            // Prevent default if the protocol is not in the allowed list
            event.preventDefault();
            log(`Blocked navigation to: ${url}`);
            // Optionally, add your custom handling logic here
        }
    }

    mainWindow.webContents.on("did-finish-load", function (e) {
        if (tainted) {
            mainWindow.setSize(parseInt(WIDTH), parseInt(HEIGHT)); // allows for larger than display resolution.
            tainted = false;
        }

        // Only inject language preference if this is the main app window
        // Check if this is a local file:// URL pointing to our app
        const currentURL = mainWindow.webContents.getURL();
        const isMainAppWindow = currentURL && currentURL.startsWith('file://') &&
            (currentURL.includes(path.join(__dirname, 'index.html').replace(/\\/g, '/')) ||
                currentURL === URI); // URI is the URL we loaded

        if (isMainAppWindow) {
            // This is the main app window, inject language preference
            try {
                const savedLanguageRaw = store.get('language');
                const savedLanguage = normalizeUiLanguagePreference(savedLanguageRaw);
                if (savedLanguage) {
                    if (savedLanguageRaw && savedLanguage !== savedLanguageRaw) {
                        store.set('language', savedLanguage);
                    }
                    executeJavaScriptQuietly(mainWindow.webContents, `
                        // Set the language preference in localStorage for the UI to use
                        localStorage.setItem('language', ${JSON.stringify(savedLanguage)});
                        // Also trigger language change if the page is already loaded
                        if (typeof changeLanguage === 'function') {
                            changeLanguage(${JSON.stringify(savedLanguage)});
                        }
                    `, 'main_window.saved_language');
                } else if (SYSTEM_LOCALE && SYSTEM_LOCALE !== 'en-US') {
                    // If no saved preference, use system locale
                    // Map common system locales to our supported languages
                    let uiLanguage = SYSTEM_LOCALE;
                    const languageMap = {
                        'tr-TR': 'tr',
                        'pt-BR': 'pt-br',
                        'ar-SA': 'ar',
                        'ar-EG': 'ar',
                        'ar-AE': 'ar',
                        'es-ES': 'es',
                        'es-MX': 'es',
                        'de-DE': 'de',
                        'de-AT': 'de',
                        'de-CH': 'de',
                        'cs-CZ': 'cs',
                        'th-TH': 'th',
                        'zh-CN': 'zh-CN',
                        'zh-TW': 'zh-TW',
                        'zh-HK': 'zh-TW',
                        'zh-Hans': 'zh-CN',
                        'zh-Hant': 'zh-TW',
                        'en-GB': 'en-uk',
                        'en-US': 'en-us'
                    };

                    // Use mapped language or extract the base language code
                    if (languageMap[SYSTEM_LOCALE]) {
                        uiLanguage = languageMap[SYSTEM_LOCALE];
                    } else if (SYSTEM_LOCALE.includes('-')) {
                        uiLanguage = SYSTEM_LOCALE.split('-')[0];
                    }
                    uiLanguage = normalizeUiLanguagePreference(uiLanguage);

                    executeJavaScriptQuietly(mainWindow.webContents, `
                        localStorage.setItem('language', ${JSON.stringify(uiLanguage)});
                        if (typeof changeLanguage === 'function') {
                            changeLanguage(${JSON.stringify(uiLanguage)});
                        }
                    `, 'main_window.system_language');
                }
            } catch (e) {
                console.log('Could not inject language preference:', e);
            }

            // Check if localStorage seems empty/reset and restore from backup if available
            try {
                const localStorageBackup = getUserSessionStoreValue('localStorageBackup');
                if (localStorageBackup && Object.keys(localStorageBackup).length > 0) {
                    // Check if localStorage appears empty or missing key settings
                    executeJavaScriptWithReport(mainWindow.webContents, `
                        (function() {
                            // Check for key indicators that settings exist
                            const hasSettings = localStorage.length > 2 ||
                                localStorage.getItem('settings') ||
                                localStorage.getItem('sources') ||
                                localStorage.getItem('socialStreamState');
                            return { isEmpty: !hasSettings, count: localStorage.length };
                        })();
                    `, 'main_window.localstorage_restore_check').then((result) => {
                        if (result && result.isEmpty) {
                            const backupTime = getUserSessionStoreValue('localStorageBackupTime');
                            log(`localStorage appears empty (${result.count} keys), restoring from backup` +
                                (backupTime ? ` (saved: ${new Date(backupTime).toISOString()})` : ""));

                            // Restore localStorage from backup using serialized payload
                            // to avoid escaping bugs with quotes, backslashes, and newlines.
                            const backupBase64 = Buffer.from(JSON.stringify(localStorageBackup), 'utf8').toString('base64');
                            const restoreScript = `
                                (function() {
                                    try {
                                        const binary = atob(${JSON.stringify(backupBase64)});
                                        let raw = binary;
                                        try {
                                            raw = decodeURIComponent(escape(binary));
                                        } catch (_) {}
                                        const backup = JSON.parse(raw);
                                        if (!backup || typeof backup !== 'object') return 0;
                                        let restored = 0;
                                        Object.entries(backup).forEach(([key, value]) => {
                                            try {
                                                if (value === null || value === undefined) return;
                                                localStorage.setItem(String(key), String(value));
                                                restored++;
                                            } catch (_) {}
                                        });
                                        return restored;
                                    } catch (_) {
                                        return 0;
                                    }
                                })();
                            `;

                            executeJavaScriptWithReport(mainWindow.webContents, restoreScript, 'main_window.localstorage_restore')
                                .then((restoredCount) => {
                                    const restored = Number.isFinite(restoredCount) ? restoredCount : 0;
                                    log(`Restored ${restored} localStorage keys from backup`);
                                    if (restored > 0) {
                                        // Reload the page to apply restored settings
                                        executeJavaScriptQuietly(mainWindow.webContents, `
                                            if (typeof location !== 'undefined' && location.reload) {
                                                location.reload();
                                            }
                                        `, 'main_window.localstorage_restore_reload');
                                    }
                                })
                                .catch(err => console.error('Failed to restore localStorage:', err));
                        } else {
                            log(`localStorage has ${result.count} keys, no restore needed`);
                        }
                    }).catch(err => console.error('Failed to check localStorage:', err));
                }
            } catch (e) {
                console.error('localStorage restore check failed:', e);
            }

            // Ensure cachedState and localStorage stay in sync. A staged User Session import
            // owns these values during startup; mirroring the old cached state here can race
            // the renderer import and overwrite the newly imported settings.
            try {
                const pendingUserSessionImport = getUserSessionStoreValue('pendingImport', null);
                if (pendingUserSessionImport && typeof pendingUserSessionImport === 'object') {
                    log('[User Sessions] Skipping startup cachedState mirror while an import is pending');
                } else {
                    if (shouldRecoverCachedStateFromBackups(cachedState)) {
                        const diskResult = loadCachedStateWithBackupSource({ logSelection: true, updateBaseline: false });
                        if (diskResult && diskResult.state && typeof diskResult.state === "object") {
                            applyRecoveredCachedState(diskResult, "did-finish-load");
                        }
                    }
                    syncCachedStateWithLocalStorage(mainWindow, "did-finish-load");
                }
            } catch (e) {
                console.warn("Failed to sync cachedState/localStorage:", e?.message || e);
            }
        }

        if (mainWindow && mainWindow.webContents && mainWindow.webContents.getURL().includes("youtube.com")) {
            log("Youtube ad skipper inserted");
            if (!YT_AD_SKIPPER_INTERVAL) {
                const adSkipperInterval = YT_AD_SKIPPER_INTERVAL = setInterval(
                    function (mw) {
                        try {
                            if (!mw || mw.isDestroyed()) {
                                clearInterval(adSkipperInterval);
                                YT_AD_SKIPPER_INTERVAL = null;
                                return;
                            }
                            mw.webContents.executeJavaScript(
                                '\
						if (!xxxxxx){\
							var xxxxxx = setInterval(function(){\
							if (document.querySelector(".ytp-ad-skip-button")){\
								document.querySelector(".ytp-ad-skip-button").click();\
							}\
							},500);\
						}\
					'
                            );
                        } catch (e) {
                            clearInterval(adSkipperInterval);
                            YT_AD_SKIPPER_INTERVAL = null;
                            return;
                        }
                    },
                    5000,
                    mainWindow
                );

                // Store interval for cleanup
                if (!mainWindow.intervals) mainWindow.intervals = [];
                mainWindow.intervals.push(adSkipperInterval);

                // Attach a one-time navigation handler to clear page-level timer when leaving YouTube
                if (!mainWindow.__ytSkipperNavHandlerAttached) {
                    const clearYtPageTimer = () => {
                        try {
                            executeJavaScriptQuietly(mainWindow.webContents, 'try{ if (window.xxxxxx){ clearInterval(window.xxxxxx); window.xxxxxx=null; } }catch(e){}', 'youtube.clear_page_timer');
                        } catch (_) { }
                    };
                    try {
                        mainWindow.webContents.on('did-navigate', (event, url) => {
                            if (url && !url.includes('youtube.com')) clearYtPageTimer();
                        });
                        mainWindow.webContents.on('did-navigate-in-page', () => {
                            try {
                                const cu = mainWindow.webContents.getURL() || '';
                                if (!cu.includes('youtube.com')) clearYtPageTimer();
                            } catch (_) { }
                        });
                        mainWindow.__ytSkipperNavHandlerAttached = true;
                    } catch (_) { }
                }
            }
        }

        executeJavaScriptQuietly(mainWindow.webContents, `
			document.addEventListener('wheel', (event) => {
			  if (event.ctrlKey) {
				event.preventDefault();
				const direction = event.deltaY < 0 ? 'in' : 'out';
				require('electron').ipcRenderer.send('zoom', direction);
			  }
			}, { passive: false });
		  `, 'main_window.zoom_wheel_listener');

        if (CSSCONTENT && mainWindow && mainWindow.webContents) {
            try {
                mainWindow.webContents.insertCSS(CSSCONTENT, {
                    cssOrigin: "user"
                });
                log("Inserting specified CSS contained in the file");
            } catch (e) {
                log(e);
            }
        }

        //
    });

    ipcMain.on("postMessage", function (eventRet, ...args) {
        var tabID = -1;
        var options = {};

        const handleDockChatSend = (overlay = {}) => {
            try {
                const text = typeof overlay.response === 'string' ? overlay.response.trim() : '';
                if (!text) return false;

                const rawTargets = [];
                if (Array.isArray(overlay.tid)) {
                    rawTargets.push(...overlay.tid);
                } else if (overlay.tid !== undefined && overlay.tid !== null) {
                    rawTargets.push(overlay.tid);
                }

                const parsedTargets = rawTargets
                    .map((t) => {
                        if (typeof t === 'number' && Number.isFinite(t)) return t;
                        const num = Number(t);
                        return Number.isFinite(num) && num !== 0 ? num : null;
                    })
                    .filter((t) => t !== null);

                const availableWssIds = Object.keys(websocketConnections).map((key) => Number(key)).filter((n) => Number.isFinite(n));
                const availableWssIdSet = new Set(availableWssIds);

                const targetWssIds = parsedTargets.length
                    // Only TikTok virtual tabs use the synthetic 900000+ IDs.
                    ? parsedTargets
                        .filter((t) => t >= 900000)
                        .map((t) => t - 900000)
                        .filter((t) => availableWssIdSet.has(t))
                    : availableWssIds;

                if (!targetWssIds.length) {
                    return false;
                }

                for (const wssId of targetWssIds) {
                    if (!Number.isFinite(wssId)) continue;
                    sendToTikTok({ wssID: wssId, message: text }).catch(() => {});
                }
                return true;
            } catch (_) {
                return false;
            }
        };

        const normalizeDockResponseForBackground = (overlay = {}) => {
            try {
                if (!overlay || typeof overlay !== 'object') {
                    return null;
                }

                if (overlay.tid === undefined || overlay.tid === null || overlay.tid === false) {
                    return overlay;
                }

                const rawTargets = Array.isArray(overlay.tid) ? overlay.tid : [overlay.tid];
                const browserTargets = rawTargets.filter((target) => {
                    const numericTarget = typeof target === 'number' ? target : Number(target);
                    return !Number.isFinite(numericTarget) || numericTarget < 900000;
                });

                if (!browserTargets.length) {
                    return null;
                }

                return {
                    ...overlay,
                    tid: Array.isArray(overlay.tid) ? browserTargets : browserTargets[0]
                };
            } catch (_) {
                return overlay;
            }
        };

        if (args.length >= 2) {
            if (args[1] && args[1].tabID) {
                tabID = args[1].tabID;
                options = args[1];
            }
        }

        // Also check for tabID in the message data itself
        if (args[0] && args[0].__tabID__ !== undefined) {
            tabID = args[0].__tabID__;
            // Don't delete it here as it might be needed by background.html
        }

        let senderUrl = '';
        let dockChatHandled = false;
        let dockResponsePayload = undefined;
        try {
            senderUrl = eventRet.sender.getURL().toLowerCase();
            if (((isSocialStreamRemoteUrl(senderUrl) || senderUrl.startsWith("file://")) && matchesSocialStreamPagePath(senderUrl, "featured") && senderUrl.includes("?"))) {
                return;
            }

            if (matchesSocialStreamPagePath(senderUrl, "dock") || matchesSocialStreamPagePath(senderUrl, "background")) {
                const payload = args && args[0] ? args[0] : null;
                if (payload && payload.overlayNinja && payload.overlayNinja.response !== undefined) {
                    dockResponsePayload = normalizeDockResponseForBackground(payload.overlayNinja);
                    dockChatHandled = handleDockChatSend(payload.overlayNinja);
                }
            }
        } catch (e) { }

        // Handle generic WebSocket status signals (from WSS pages)
        try {
            if (args[0] && args[0].wssStatus) {
                const statusPayload = args[0].wssStatus || {};
                let sourceId = statusPayload.sourceId || null;
                if (!sourceId && Number.isFinite(tabID)) {
                    try {
                        const sourceView = getActiveBrowserView(tabID) || browserViews[tabID];
                        sourceId = sourceView?.args?.sourceId || null;
                    } catch (_) { }
                }
                if (!sourceId) {
                    try {
                        const sourceWindow = BrowserWindow.fromWebContents(eventRet.sender);
                        sourceId = sourceWindow?.args?.sourceId || null;
                    } catch (_) { }
                }
                const payload = {
                    tabID,
                    ...statusPayload,
                    sourceId
                };
                if (sourceObservationService) {
                    sourceObservationService.recordStatus(payload, { sourceId, tabId: tabID });
                }
                if (mainWindow && mainWindow.webContents) {
                    mainWindow.webContents.send('wssStatus', payload);
                }
                // respond quickly for sendMessage callbacks
                eventRet.returnValue = { ok: true };
                return;
            }
        } catch (_) { }

        try {
            if (args[0] && args[0].tiktokStatus) {
                const statusPayload = args[0].tiktokStatus || {};
                let sourceId = statusPayload.sourceId || null;
                if (!sourceId && Number.isFinite(tabID)) {
                    try {
                        const sourceView = getActiveBrowserView(tabID) || browserViews[tabID];
                        sourceId = sourceView?.args?.sourceId || null;
                    } catch (_) { }
                }
                if (mainWindow && mainWindow.webContents) {
                    mainWindow.webContents.send('tiktokConnectionStatus', {
                        tabID,
                        sourceId,
                        ...statusPayload
                    });
                }
                if (sourceObservationService) {
                    sourceObservationService.recordStatus(statusPayload, { sourceId, tabId: tabID });
                }
                eventRet.returnValue = { ok: true };
                return;
            }
        } catch (_) { }

        if (args[0] && args[0].getSettings) {
            if (!cachedStateReady) {
                // This should not happen - state loads before createWindow registers these handlers
                console.warn("[getSettings] Called before cachedState ready - returning current state");
            }
            if (shouldRecoverCachedStateFromBackups(cachedState)) {
                const diskResult = loadCachedStateWithBackupSource({ logSelection: true, updateBaseline: false });
                if (diskResult && diskResult.state) {
                    applyRecoveredCachedState(diskResult, "getSettings");
                }
            }
            if (shouldRecoverCachedStateFromBackups(cachedState)) {
                try {
                    hydrateCachedStateFromStoreBackup();
                } catch (_) { }
            }

            let tab = options.tabID || tabID;

            // Create settings response matching background.js format
	            let settingsResponse = {
	                settings: cachedState.settings || {},
	                state: cachedState.state !== undefined ? cachedState.state : true,
	                streamID: normalizeStreamIdValue(cachedState.streamID),
	                password: normalizePasswordValue(cachedState.password)
	            };

            log("getSettings request - returning cachedState:", JSON.stringify(settingsResponse).substring(0, 200));

            const settingsView = getActiveBrowserView(tab);
            if (settingsView && settingsView.webContents) {
                try {
                    log("-----------------------------------------");
                    log(settingsView);
                    if ("muted" in settingsView.args) {
                        if (settingsView.args.muted) {
                            settingsView.webContents.setAudioMuted(true);
                            settingsView.webContents.send("sendToTab", {
                                muteWindow: true
                            });
                        }
                    } else {
                        log("SENDING MUTE");
                        settingsView.webContents.setAudioMuted(true);
                        settingsView.webContents.send("sendToTab", {
                            muteWindow: true
                        });
                    }
                } catch (error) {
                    console.error('Failed to enforce mute state on settings response:', error);
                }
            }

            eventRet.returnValue = settingsResponse;
            return;
        }

        if (mainWindow && mainWindow.webContents) {
            // log("on postMessage:"); // Commented out to reduce spam
            var sender = {};
            sender.tab = {};
            sender.tab.id = tabID;
            if (eventRet.sender && eventRet.sender.getURL) {
                sender.tab.url = eventRet.sender.getURL();
            }

            let backgroundPayload = dockResponsePayload !== undefined ? dockResponsePayload : args[0];
            backgroundPayload = attachSourceAccountMetaToPayload(backgroundPayload, tabID);
            if (backgroundPayload !== null) {
                if (sourceObservationService) {
                    const sourceId = sourceIdForObservedMessage(tabID, eventRet.sender);
                    const observedView = findSourceObservationView(sourceId, tabID);
                    if (observedView) sourceObservationService.trackView(observedView);
                    sourceObservationService.recordCapture(backgroundPayload, { sourceId, tabId: tabID });
                }
                mainWindow.webContents.mainFrame.frames.forEach((frame) => {
                    if (matchesSocialStreamPagePath(frame.url, "background")) {
                        frame.postMessage("fromMainSender", [backgroundPayload, {
                            ...sender
                        }]);
                    }
                });
            }

            // Return response with message ID for callbacks
            if (args[0] && args[0].message) {
                const response = {
                    state: cachedState.state !== undefined ? cachedState.state : true
                };
                if (args[0].message.id !== undefined) {
                    response.id = args[0].message.id;
                }
                eventRet.returnValue = response;
                return;
            }

            if (dockChatHandled) {
                eventRet.returnValue = { ok: true };
                return;
            }
        }
        eventRet.returnValue = cachedState || {
            settings: {}
        };
    });

    ipcMain.on("getAppVersion", function (eventRet) {
        try {
            if (mainWindow && mainWindow.webContents) {
                mainWindow.webContents.send("appVersion", app.getVersion());
            }
        } catch (e) {
            console.error(e);
        }
    });

    ipcMain.on('zoom', (event, direction) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.webContents.emit('zoom-changed', event, direction);
        }
    });

    function normalizeNodeFetchError(error) {
        return {
            status: 500,
            error: error?.message || String(error || "Unknown fetch error"),
            code: error?.code || null,
            errno: error?.errno || null,
            type: error?.type || null,
            name: error?.name || null
        };
    }

    function getJsonErrorMessage(json, fallback) {
        if (json && json.error_description) return String(json.error_description);
        if (json && typeof json.error === "string") return json.error;
        if (json && json.error && json.error.message) return String(json.error.message);
        if (json && json.message) return String(json.message);
        return fallback;
    }

    function normalizeVpzoneApiUrlValue(value) {
        let parsed;
        try {
            parsed = new URL(String(value || ""));
        } catch (_) {
            return null;
        }
        if (parsed.protocol !== "https:" || !["vpzone.tv", "www.vpzone.tv"].includes(parsed.hostname) || !parsed.pathname.startsWith("/api/")) {
            return null;
        }
        parsed.hash = "";
        return parsed;
    }

    async function fetchVpzoneJsonResponse(request = {}) {
        const parsedUrl = normalizeVpzoneApiUrlValue(request.url);
        if (!parsedUrl) {
            throw new Error("VPZone fetch URL not allowed");
        }

        const method = String(request.method || "GET").toUpperCase();
        const isOAuthTokenPost = method === "POST" && parsedUrl.pathname === "/api/oauth/token";
        const isChatMessagePost = method === "POST" && /^\/api\/v1\/channels\/[^\/]+\/chat$/.test(parsedUrl.pathname);
        if (method !== "GET" && !isOAuthTokenPost && !isChatMessagePost) {
            throw new Error("VPZone fetch method not allowed");
        }

        const headers = {
            Accept: "application/json"
        };
        if (isOAuthTokenPost) {
            headers["Content-Type"] = "application/x-www-form-urlencoded";
        } else if (isChatMessagePost) {
            headers["Content-Type"] = "application/json";
            if (request.authToken && typeof request.authToken === "string") {
                headers.Authorization = "Bearer " + request.authToken.replace(/[\r\n]/g, "");
            }
        }

        const response = await fetch(parsedUrl.toString(), {
            method,
            cache: "no-store",
            headers,
            body: method === "POST" ? String(request.body || "") : undefined
        });
        const responseText = await response.text();
        let responseJson = {};
        try {
            responseJson = responseText ? JSON.parse(responseText) : {};
        } catch (_) {
            responseJson = null;
        }
        if (!response.ok) {
            const error = new Error(getJsonErrorMessage(responseJson, "HTTP " + response.status));
            error.status = response.status;
            throw error;
        }
        if (responseJson == null) {
            const error = new Error("Invalid JSON response");
            error.status = response.status;
            throw error;
        }
        return {
            status: response.status,
            data: responseJson
        };
    }

    async function handleVpzoneFetchJsonCommand(request) {
        try {
            const vpzoneResponse = await fetchVpzoneJsonResponse(request);
            return { ok: true, status: vpzoneResponse.status, data: vpzoneResponse.data };
        } catch (error) {
            return {
                ok: false,
                status: error && typeof error.status !== "undefined" ? error.status : undefined,
                error: error?.message || "VPZone fetch failed"
            };
        }
    }

    function normalizeJoystickApiUrlValue(value) {
        let parsed;
        try {
            parsed = new URL(String(value || ""));
        } catch (_) {
            return null;
        }
        if (parsed.protocol !== "https:" || parsed.hostname !== "api.joystick.tv") {
            return null;
        }
        parsed.hash = "";
        return parsed;
    }

    async function fetchJoystickJsonResponse(request = {}) {
        const parsedUrl = normalizeJoystickApiUrlValue(request.url);
        if (!parsedUrl) {
            throw new Error("Joystick API URL not allowed");
        }

        const method = String(request.method || "GET").toUpperCase();
        const isOAuthTokenPost = method === "POST" && parsedUrl.pathname === "/api/oauth/token";
        const isStreamSettingsGet = method === "GET" && parsedUrl.pathname === "/api/users/stream-settings";
        if (!isOAuthTokenPost && !isStreamSettingsGet) {
            throw new Error("Joystick API request not allowed");
        }

        const headers = {
            Accept: "application/json"
        };
        const authHeader = typeof request.auth === "string" ? request.auth.replace(/[\r\n]/g, "") : "";
        if (isOAuthTokenPost) {
            headers["Content-Type"] = "application/x-www-form-urlencoded";
            if (request.authType === "basic" && authHeader.startsWith("Basic ")) {
                headers.Authorization = authHeader;
            }
        } else if (isStreamSettingsGet) {
            headers["Content-Type"] = "application/json";
            if (request.authType === "bearer" && authHeader.startsWith("Bearer ")) {
                headers.Authorization = authHeader;
            }
        }

        const response = await fetch(parsedUrl.toString(), {
            method,
            cache: "no-store",
            headers,
            body: isOAuthTokenPost ? String(request.body || "") : undefined
        });
        const responseText = await response.text();
        let responseJson = {};
        try {
            responseJson = responseText ? JSON.parse(responseText) : {};
        } catch (_) {
            responseJson = null;
        }
        if (!response.ok) {
            const error = new Error(getJsonErrorMessage(responseJson, "HTTP " + response.status));
            error.status = response.status;
            throw error;
        }
        if (responseJson == null) {
            const error = new Error("Invalid JSON response");
            error.status = response.status;
            throw error;
        }
        return {
            status: response.status,
            data: responseJson
        };
    }

    async function handleJoystickFetchJsonCommand(request) {
        try {
            const joystickResponse = await fetchJoystickJsonResponse(request);
            return { ok: true, status: joystickResponse.status, data: joystickResponse.data };
        } catch (error) {
            return {
                ok: false,
                status: error && typeof error.status !== "undefined" ? error.status : undefined,
                error: error?.message || "Joystick API fetch failed"
            };
        }
    }

    function normalizeRumbleApiUrlValue(value) {
        let raw = typeof value === "string" ? value.trim() : "";
        let parsed;
        if (!raw) return "";
        if (!/^[a-z]+:\/\//i.test(raw) && raw.indexOf("rumble.com") >= 0) {
            raw = "https://" + raw.replace(/^\/+/, "");
        }
        try {
            parsed = new URL(raw);
        } catch (_) {
            return "";
        }
        parsed.hash = "";
        return parsed.toString();
    }

    async function fetchRumbleJsonResponse(url) {
        const normalizedUrl = normalizeRumbleApiUrlValue(url);
        const parsedUrl = normalizedUrl ? new URL(normalizedUrl) : null;
        if (!parsedUrl || parsedUrl.protocol !== "https:" || !["rumble.com", "www.rumble.com"].includes(parsedUrl.hostname)) {
            throw new Error("Rumble fetch URL not allowed");
        }

        const response = await fetch(parsedUrl.toString(), {
            method: "GET",
            cache: "no-store",
            headers: {
                Accept: "application/json,text/plain;q=0.9,*/*;q=0.8"
            }
        });
        const text = await response.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : {};
        } catch (_) {
            if (text && /^\s*</.test(text)) {
                throw new Error("Rumble returned an HTML page instead of JSON data.");
            }
            throw new Error("Rumble did not return valid JSON.");
        }
        if (!response.ok) {
            const error = new Error((data && (data.error || data.message)) || ("HTTP " + response.status));
            error.status = response.status;
            throw error;
        }
        return {
            status: response.status,
            data
        };
    }

    ipcMain.handle("rumble-fetch-json", async (_event, args = {}) => {
        try {
            const rumbleResponse = await fetchRumbleJsonResponse(args.url);
            return { ok: true, status: rumbleResponse.status, data: rumbleResponse.data };
        } catch (error) {
            return {
                ok: false,
                status: error && typeof error.status !== "undefined" ? error.status : undefined,
                error: error?.message || "Rumble fetch failed"
            };
        }
    });

    async function handleStreamDeckSourceCommand(request = {}) {
        const command = request && request.request && typeof request.request === "object"
            ? request.request
            : {
                action: request && typeof request.action === "string" ? request.action : "",
                value: request ? request.value : undefined,
                target: request ? request.target : undefined,
                get: request ? request.get : undefined
            };

        if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
            return {
                ok: false,
                error: {
                    code: "SSAPP_UNAVAILABLE",
                    message: "SSApp renderer is unavailable."
                }
            };
        }

        try {
            const script = `
                (async () => {
                    const request = ${JSON.stringify(command)};
                    if (!window.SSAppStreamDeckBridge || typeof window.SSAppStreamDeckBridge.handleCommand !== "function") {
                        return {
                            ok: false,
                            error: {
                                code: "SSAPP_UNAVAILABLE",
                                message: "SSApp source bridge is not ready."
                            }
                        };
                    }
                    return await window.SSAppStreamDeckBridge.handleCommand(request);
                })()
            `;
            return await mainWindow.webContents.executeJavaScript(script, true);
        } catch (error) {
            return {
                ok: false,
                error: {
                    code: "SSAPP_UNAVAILABLE",
                    message: error?.message || "SSApp source command failed."
                }
            };
        }
    }

    llmControlCommandHandler = handleStreamDeckSourceCommand;

    const backgroundCommandHandlers = {
        streamDeckSourceCommand: handleStreamDeckSourceCommand,
        vpzoneFetchJson: handleVpzoneFetchJsonCommand,
        joystickFetchJson: handleJoystickFetchJsonCommand
    };

    function isTrustedStreamDeckSourceCommandSender(event) {
        const sender = event && event.sender;
        if (!(
            sender &&
            mainWindow &&
            !mainWindow.isDestroyed() &&
            mainWindow.webContents &&
            sender.id === mainWindow.webContents.id
        )) {
            return false;
        }

        const frame = event.senderFrame;
        if (!frame) return false;

        try {
            if (frame === mainWindow.webContents.mainFrame) {
                return true;
            }
        } catch (_) { }

        const frameUrl = typeof frame.url === "string" ? frame.url : "";
        if (!frameUrl || !matchesSocialStreamPagePath(frameUrl, "background")) {
            return false;
        }
        return frameUrl.startsWith("file://") || isSocialStreamRemoteUrl(frameUrl);
    }

    ipcMain.handle("ssapp:background-command", async (event, request = {}) => {
        const command = request && typeof request.cmd === "string" ? request.cmd : "";
        const handler = backgroundCommandHandlers[command];
        if (!handler) {
            return { ok: false, error: "Unsupported background command" };
        }
        if (command === "streamDeckSourceCommand" && !isTrustedStreamDeckSourceCommandSender(event)) {
            return {
                ok: false,
                error: {
                    code: "SSAPP_FORBIDDEN",
                    message: "Stream Deck source commands are only available to the SSApp controller."
                }
            };
        }
        return handler(request);
    });

    // Keep the synchronous version for backward compatibility
    ipcMain.on("nodefetch", function (eventRet, args) {
        log("NODE FETCHING! (sync)");
        fetch(args.url, {
            method: args.method || "GET",
            headers: args.headers,
            body: args.method === 'POST' ? JSON.stringify(args.body) : undefined,
            timeout: args.timeout || 30000
        })
            .then((response) => {
                log(response);
                return response.text().then(text => ({
                    status: response.status,
                    data: text
                }));
            })
            .then((result) => {
                eventRet.returnValue = result;
            })
            .catch((error) => {
                console.error("Fetch error:", error);
                eventRet.returnValue = normalizeNodeFetchError(error);
            });
    });

    // Add async version
    ipcMain.handle("nodefetch", async function (event, args) {
        log("NODE FETCHING! (async)");
        try {
            const response = await fetch(args.url, {
                method: args.method || "GET",
                headers: args.headers,
                body: args.method === 'POST' ? JSON.stringify(args.body) : undefined,
                timeout: args.timeout || 30000
            });

            const text = await response.text();
            return {
                status: response.status,
                data: text
            };
        } catch (error) {
            console.error("Fetch error:", error);
            return normalizeNodeFetchError(error);
        }
    });

    ipcMain.on("nodepost", function (eventRet, args2) {
        log("NODE POSTING!");
        fetch(args2.url, {
            method: "POST",
            headers: args2.headers,
            body: (typeof args2.body === 'object') ? JSON.stringify(args2.body) : args2.body,
        })
            .then((response) => response.text())
            .then((data) => {
                eventRet.returnValue = data;
            })
            .catch((error) => {
                log(error);
                eventRet.returnValue = null;
            });
    });

    ipcMain.on("nodeput", function (eventRet, args2) {
        log("NODE PUTTING!");
        fetch(args2.url, {
            method: "PUT",
            headers: args2.headers,
            body: (typeof args2.body === 'object') ? JSON.stringify(args2.body) : args2.body,
        })
            .then((response) => response.text())
            .then((data) => {
                eventRet.returnValue = data;
            })
            .catch((error) => {
                log(error);
                eventRet.returnValue = null;
            });
    });


    ipcMain.on("streaming-nodepost", async (event, args) => {
        const {
            channelId,
            url,
            body,
            headers
        } = args;
        const abortController = new AbortController();
        const abortChannel = `${channelId}-abort`;
        const closeChannel = `${channelId}-close`;
        const abortHandler = () => {
            try {
                abortController.abort();
            } catch (_) { }
        };

        ipcMain.once(abortChannel, abortHandler);
        ipcMain.once(closeChannel, abortHandler);

        try {
            const response = await undiciFetch(url, {
                method: "POST",
                headers: headers,
                body: (typeof body === 'object') ? JSON.stringify(body) : body,
                signal: abortController.signal
            });


            if (!response.ok) {
                // log("FAILLLLLLLLL "+response.status);
                event.reply(channelId, {
                    error: response.status,
                    message: `HTTP error! status: ${response.status}`
                });
                return;
            }


            const reader = response.body.getReader();
            const textDecoder = new TextDecoder();

            while (true) {
                const {
                    done,
                    value
                } = await reader.read();
                if (done) {
                    event.reply(channelId, null); // Signal end of stream
                    break;
                }

                const chunk = textDecoder.decode(value);
                event.reply(channelId, chunk);
                // {"model":"llama3.2:latest","created_at":"2024-10-11T07:49:42.864094Z","response":"","done":true,"done_reason":"stop","context":[128006,9125,128007,271,38766,1303,33025,2696,25,6790,220,2366,18,271,128009,128006,882,128007,271,882,25,24748,198,78191,25,128009,128006,78191,128007,271,9906,0,2650,649,358,7945,499,3432,30],"total_duration":196930300,"load_duration":19191800,"prompt_eval_count":31,"prompt_eval_duration":21749000,"eval_count":10,"eval_duration":154659000}
            }

        } catch (error) {
            if (error?.name !== 'AbortError') {
                console.error('Fetch error:', error);
            }
            event.reply(channelId, null);
        } finally {
            ipcMain.removeListener(abortChannel, abortHandler);
            ipcMain.removeListener(closeChannel, abortHandler);
        }
    });


    function getPrimaryDomain(url) {
        try {

            if (url.startsWith("about:blank") || url.startsWith("https://about:blank")) {
                return null;
            }
            // Ensure the URL has a protocol
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'https://' + url;
            }

            const parsedUrl = new URL(url);
            const hostParts = parsedUrl.hostname.split('.');

            // Check if it's a common subdomain like 'www'
            if (hostParts.length > 2 && hostParts[0] === 'www') {
                return hostParts.slice(-2).join('.');
            }

            // Return the last two parts of the hostname
            return hostParts.slice(-2).join('.');
        } catch (error) {
            console.error('Invalid URL:', error);
            return null;
        }
    }

    function getDomainToPlatform(domain) {
        // Map common domains to platform names (without TLD)
        const domainMap = {
            'youtube.com': 'youtube',
            'twitch.tv': 'twitch',
            'kick.com': 'kick',
            'tiktok.com': 'tiktok',
            'facebook.com': 'facebook',
            'instagram.com': 'instagram',
            'x.com': 'x',
            'twitter.com': 'x',
            'rumble.com': 'rumble',
            'dlive.tv': 'dlive',
            'trovo.live': 'trovo',
            'vimeo.com': 'vimeo',
            'restream.io': 'restream',
            'zoom.us': 'zoom'
        };

        return domainMap[domain] || domain;
    }

    function resolveSessionPlatform(args, domain) {
        let platform = getDomainToPlatform(domain);
        if (args && args.url && args.wss) {
            const platformMatch = args.url.match(/(?:sources\/)?websocket\/(\w+)\.html/i);
            if (platformMatch && platformMatch[1]) {
                platform = platformMatch[1].toLowerCase();
                log(`Detected WebSocket platform from URL path: ${platform}`);
            }
        }
        return platform;
    }

    async function handleSignInRequest(args2) {
        log("IPC CREATE WINDOW - SIGN IN");
        var args = Object.assign({}, Argv, args2);

        if (isDevMode) {
            try {
                const configPreview = {
                    url: args?.url || null,
                    platformConfigKeys: args?.config ? Object.keys(args.config) : [],
                    session: args?.customSession || 'AUTO',
                    userAgent: args?.config?.userAgent || null,
                    mockUserAgentData: args?.config?.mockUserAgentData ? {
                        brands: args.config.mockUserAgentData.brands || [],
                        fullVersionList: args.config.mockUserAgentData.fullVersionList || [],
                        platform: args.config.mockUserAgentData.platform || null,
                        uaFullVersion: args.config.mockUserAgentData.uaFullVersion || null
                    } : null,
                    configSource: args?.config?.__configSource || null,
                    configMeta: args?.config?.__configMeta || null
                };
                console.log('[SignIn Config]', JSON.stringify(configPreview, null, 2));
            } catch (logError) {
                console.error('[SignIn Config] Failed to log config preview:', logError?.message || logError);
            }
        }

        if (!args.url) {
            log("No URL; can't load");
            return null;
        }

        args.url = args.url.trim();
        if (args.url == null || args.url == "https://null") {
            args.url = "https://google.com";
        }

        const signInHeaderOverrides = resolveHeaderOverridesFromConfig(args.config, args.url);

        // Handle existing tab case
        if (args.tab) {
            const existingView = getActiveBrowserView(args.tab);
            if (existingView && existingView.webContents) {
                log("Existing tab");
                try {
                    if (args.userInitiated) {
                        try {
                            if (existingView.__ss_visible === false) {
                                stealthShowView(existingView, { bringToFront: true });
                            } else {
                                existingView.show();
                                existingView.focus();
                            }
                        } catch (_) { }
                    }
                    const existingLoadOptions = {};
                    if (args?.config?.userAgent) {
                        existingLoadOptions.userAgent = args.config.userAgent;
                    }
                    if (signInHeaderOverrides.referer) {
                        existingLoadOptions.httpReferrer = {
                            url: signInHeaderOverrides.referer,
                            policy: 'strict-origin-when-cross-origin'
                        };
                    }
                    if (Object.keys(existingLoadOptions).length) {
                        existingView.webContents.loadURL(args.url, existingLoadOptions);
                    } else {
                        existingView.webContents.loadURL(args.url);
                    }
                    return args.tab;
                } catch (e) {
                    console.error(e);
                }
            }
        }

        try {
            return await createSignInWindow(args);
        } catch (error) {
            console.error('Failed to create sign-in window:', error);
            return null;
        }
    }

    ipcMain.handle("signIn", async (_event, args2) => {
        return await handleSignInRequest(args2);
    });

    ipcMain.on("signIn", function (eventRet, args2) {
        eventRet.returnValue = null;
        handleSignInRequest(args2).catch(error => {
            console.error('Failed to create sign-in window:', error);
        });
    });


    function getSignInUserAgent(url, config, configs) {
        try {
            // Prefer per-target signin UA, then per-target UA, then global signin UA, then global UA, else 'Chrome'
            if (config?.signin?.userAgent) return config.signin.userAgent;
            if (config?.userAgent) return config.userAgent;
            if (configs?.global?.signin?.userAgent) return configs.global.signin.userAgent;
            if (configs?.global?.userAgent) return configs.global.userAgent;
            return 'Chrome';
        } catch (e) {
            console.error(e);
            return 'Chrome';
        }
    }

    function shouldEnforceSignInCSP(args) {
        const sources = [
            args?.config?.signin,
            args?.config,
            args?.configs?.global?.signin,
            args?.configs?.global
        ];

        for (const source of sources) {
            if (source && typeof source.enforceSigninCSP === 'boolean') {
                return source.enforceSigninCSP;
            }
        }

        return true;
    }

    async function createSignInWindow(args) {
        try {
            const domain = getPrimaryDomain(args.url);
            const platform = resolveSessionPlatform(args, domain);

            const signInHeaderOverrides = resolveHeaderOverridesFromConfig(args.config, args.url);
            const isLocalSocialStreamSignIn = /^file:/i.test(String(args.url || ""))
                && /[\\/]sources[\\/]websocket[\\/]/i.test(String(args.url || "").replace(/\//g, path.sep));

            // Always use in-app sign-in (never system browser)

            // Determine session partition name first (same logic as below)
            let sessionPartition;
            if (args.customSession && args.customSession !== 'AUTO') {
                const normalizedSession = String(args.customSession).trim();
                if (normalizedSession.startsWith('default-')) {
                    const explicitPlatform = normalizedSession.replace('default-', '').trim();
                    sessionPartition = `persist:${explicitPlatform || platform}`;
                } else if (normalizedSession === 'default') {
                    // Backward compatibility for older records that used plain "default".
                    // Keep legacy partition mapping to avoid breaking existing sign-ins.
                    sessionPartition = 'persist:custom-default';
                } else {
                    sessionPartition = `persist:custom-${normalizedSession}`;
                }
            } else {
                sessionPartition = `persist:${platform}`;
            }

            // Now check for existing session using the correct partition
            const ses = session.fromPartition(sessionPartition);
            const existingCookies = await ses.cookies.get({});
            const hasExistingSession = existingCookies.length > 0;

            // Simple, config-driven popup behavior
            // Popup policy: per-target override wins, otherwise global, default allow
            let allowPopups = true;
            if (args?.config?.signin && args.config.signin.allowPopups === false) {
                allowPopups = false;
            } else if (args?.configs?.global?.signin && args.configs.global.signin.allowPopups === false) {
                allowPopups = false;
            }
            // Removed SSO-specific UA map; keep behavior simple and config-driven per target

            let shouldClearSession = false;

            if (hasExistingSession && !isLocalSocialStreamSignIn) {
                // Show confirmation dialog
                const result = await dialog.showMessageBox(mainWindow, {
                    type: 'question',
                    buttons: ['Keep Session (Recommended)', 'Sign Out (Clear Session - Not Recommended)'],
                    defaultId: 0,
                    title: 'Existing Session Detected',
                    message: `You have an existing session for ${domain}.`,
                    detail: 'Would you like to keep your current session or sign out and start fresh?\n\nKeeping your session is recommended as it preserves your login state and preferences.',
                    cancelId: 0
                });

                // result.response is 0 for "Keep Session", 1 for "Sign Out"
                shouldClearSession = result.response === 1;
            }

            if (shouldClearSession) {
                // Check if we should preserve Kasada cookies (default: false when clearing)
                const preserveKasadaCookies = false; // Never preserve when user chooses to clear

                // Store existing Kasada cookies before clearing
                const kasadaCookieNames = ['KP_UIDz', 'KP_UIDZ', 'kpid', 'kppid', 'kppidg', 'ga__12_abel', 'ga__15_abel', 'ga__12_abel-ssn', 'ga__15_abel-ssn'];
                let kasadaCookies = [];

                // Get all cookies and filter for Kasada ones
                ses.cookies.get({}).then(cookies => {
                    if (preserveKasadaCookies) {
                        kasadaCookies = cookies.filter(cookie =>
                            kasadaCookieNames.some(name => cookie.name.includes(name))
                        );
                        log(`Found ${kasadaCookies.length} Kasada cookies to preserve`);
                    } else {
                        log(`Not preserving Kasada cookies (preserveAntiBot: false)`);
                    }

                    // Clear all session data
                    ses.clearStorageData({
                        storages: [
                            'appcache',
                            'cookies',
                            'filesystem',
                            'indexdb',
                            'localstorage',
                            'shadercache',
                            'websql',
                            'serviceworkers',
                            'cachestorage',
                        ],
                        quotas: [
                            'temporary',
                            'persistent',
                            'syncable',
                        ],
                    }).then(() => {
                        // Restore Kasada cookies after clearing
                        kasadaCookies.forEach(cookie => {
                            const cookieDetails = {
                                url: `https://${cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain}${cookie.path}`,
                                name: cookie.name,
                                value: cookie.value,
                                domain: cookie.domain,
                                path: cookie.path,
                                secure: cookie.secure,
                                httpOnly: cookie.httpOnly,
                                expirationDate: cookie.expirationDate,
                                sameSite: cookie.sameSite
                            };

                            ses.cookies.set(cookieDetails).then(() => {
                                log(`Restored Kasada cookie: ${cookie.name}`);
                            }).catch(err => {
                                log(`Failed to restore Kasada cookie ${cookie.name}: ${err}`);
                            });
                        });
                    });
                }).catch(err => {
                    log(`Error getting cookies: ${err}`);
                    // If we can't get cookies, just clear everything as before
                    ses.clearStorageData({
                        storages: [
                            'appcache',
                            'cookies',
                            'filesystem',
                            'indexdb',
                            'localstorage',
                            'shadercache',
                            'websql',
                            'serviceworkers',
                            'cachestorage',
                        ],
                        quotas: [
                            'temporary',
                            'persistent',
                            'syncable',
                        ],
                    });
                });

                // Clear cache operations
                await ses.clearCache();
                await ses.clearHostResolverCache();
                await ses.clearAuthCache();

                // Small delay to ensure clearing operations complete
                await new Promise(resolve => setTimeout(resolve, 100));
            } else if (hasExistingSession && isLocalSocialStreamSignIn) {
                log(`Keeping existing local Social Stream sign-in session for ${domain}`);
            } else {
                log(`User chose to keep existing session for ${domain}`);
            }

            // Use the session partition we already determined above
            const persistentSession = ses; // We already have this from line 3212


            log(`[SIGN-IN] URL: ${args.url}, Domain: ${domain}, Platform: ${getDomainToPlatform(domain)}, Session: ${sessionPartition}, CustomSession: ${args.customSession}`);

            // Debug: Check cookies after sign-in window closes
            setTimeout(async () => {
                const cookies = await ses.cookies.get({ domain: '.twitch.tv' });
                log(`[SIGN-IN DEBUG] Cookies for .twitch.tv after 5s: ${cookies.length} cookies found`);
                cookies.forEach(cookie => {
                    log(`  - ${cookie.name}: ${cookie.value.substring(0, 10)}... (domain: ${cookie.domain})`);
                });
            }, 5000);
            createdPartitions.add(sessionPartition); // Track this partition

            // Kasada interceptor removed - handled by preload-kasada.js instead
            // const { setupKasadaInterceptor } = require('./kasada-intercept');
            // setupKasadaInterceptor(persistentSession);

            // Check if this is a trusted domain
            const trustedDomains = ['socialstream.ninja', 'beta.socialstream.ninja', 'cache.socialstream.ninja'];
            const isTrustedDomain = trustedDomains.some(trusted =>
                args.url.includes(trusted) || domain === trusted
            );


            // Determine preload script based on configuration
            let preloadScript = null;
            const isFacebookSignIn = platform === 'facebook' || domain === 'facebook.com';

            // Domains known to use Kasada protection
            const kasadaDomains = ['twitch.tv', 'kick.com'];
            const isKasadaDomain = kasadaDomains.some(kd => domain.includes(kd));

            // Check if there's a specific preload config for this domain's signin
            if (isFacebookSignIn) {
                // Facebook's login and two-factor pages use native Credential Management and
                // WebAuthn APIs. The Kasada preload replaces window.navigator with a Proxy,
                // which makes those native calls fail with "Illegal invocation".
                preloadScript = null;
                if (args?.config?.signin?.preload && args.config.signin.preload !== 'none') {
                    log(`[Facebook] Ignoring incompatible sign-in preload: ${args.config.signin.preload}`);
                }
            } else if (args.config && args.config.signin && args.config.signin.preload !== undefined) {
                const preloadConfig = args.config.signin.preload;
                if (preloadConfig === 'none' || preloadConfig === false) {
                    preloadScript = null;
                } else if (preloadConfig === 'mock') {
                    preloadScript = 'preload-mock.js';
                } else if (preloadConfig === 'kasada') {
                    preloadScript = 'preload-kasada.js';
                } else if (preloadConfig === 'full') {
                    preloadScript = 'preload.js';
                }
            } else {
                // Default behavior:
                // - Trusted domains get full preload
                // - Kasada domains get enhanced preload
                // - Others get mock preload
                if (isTrustedDomain) {
                    preloadScript = 'preload.js';
                } else if (isKasadaDomain) {
                    preloadScript = 'preload-kasada.js';
                } else {
                    preloadScript = 'preload-mock.js';
                }
            }

            const isKickAdaptiveSignIn = platform === 'kick' && preloadScript === 'preload-mock.js';
            const effectivePreloadScript = isKickAdaptiveSignIn ? 'preload-kick.js' : preloadScript;
            const usesKasadaPreferences = effectivePreloadScript === 'preload-kasada.js' || isKickAdaptiveSignIn;

            const hasSignInPreload = Boolean(effectivePreloadScript);
            const preloadDescription = isKickAdaptiveSignIn
                ? `${effectivePreloadScript} (Kasada on Kick, Mock on Google)`
                : (preloadScript || 'none');
            console.log(`Using preload: ${preloadDescription} for domain: ${domain}`);
            if (!hasSignInPreload) {
                log('Sign-in preload disabled via config; using clean sign-in window (no CSP or DOM injection overrides).');
            }

            // Build webPreferences object - MATCH WORKING CODE EXACTLY
            const webPreferences = {
                preload: effectivePreloadScript ? path.join(__dirname, effectivePreloadScript) : undefined,

                // Critical Chrome-matching settings from working code
                contextIsolation: usesKasadaPreferences ? false : true,
                nodeIntegration: false,
                // DON'T set nodeIntegrationInSubFrames - working code doesn't have it
                sandbox: false, // FALSE to avoid automation detection
                webSecurity: true, // TRUE to match working code
                allowRunningInsecureContent: false,
                experimentalFeatures: false,
                // Ensure proper window.open/opener semantics for OAuth popups
                nativeWindowOpen: true,

                // Chrome's plugin settings
                plugins: true,

                // Chrome's default web preferences
                images: true,
                javascript: true,
                webgl: true,

                // Chrome process model
                affinity: 'browser'
            };

            // Always specify session
            webPreferences.session = persistentSession;

            // Pass Chrome-specific arguments for kasada preload - match working code exactly
            if (usesKasadaPreferences) {
                webPreferences.additionalArguments = [
                    '--enable-blink-features=CSSColorSchemeUARendering',
                    '--enable-features=WebUIDarkMode',
                    '--force-color-profile=srgb',
                    '--metrics-recording-only',
                    '--no-first-run',
                    '--password-store=basic',
                    '--use-mock-keychain'
                ];
            }

            // Create window - minimal for kasada to match working code EXACTLY
            let windowOptions = {
                width: 1280,
                height: 720,
                webPreferences: webPreferences
            };

            // Only add extra options if NOT using kasada
            if (!usesKasadaPreferences) {
                windowOptions = {
                    ...windowOptions,
                    minWidth: 400,
                    minHeight: 300,
                    backgroundColor: '#ffffff',
                    show: false,
                    frame: true,
                    hasShadow: true,
                    thickFrame: true,
                    titleBarStyle: 'default',
                    center: true,
                    movable: true,
                    resizable: true,
                    closable: true,
                    focusable: true,
                    fullscreenable: true,
                    minimizable: true,
                    maximizable: true
                };
            } else {
                // For kasada, match working code exactly
                windowOptions.minWidth = 400;
                windowOptions.minHeight = 300;
                windowOptions.backgroundColor = '#ffffff';
                windowOptions.show = false;
                // Chrome's frame options from working code
                windowOptions.frame = true;
                windowOptions.hasShadow = true;
                windowOptions.thickFrame = true;
                windowOptions.titleBarStyle = 'default';
                // Chrome window behavior
                windowOptions.center = true;
                windowOptions.movable = true;
                windowOptions.resizable = true;
                windowOptions.closable = true;
                windowOptions.focusable = true;
                windowOptions.fullscreenable = true;
                windowOptions.minimizable = true;
                windowOptions.maximizable = true;
            }

            const view = new BrowserWindow(windowOptions);

			// Chrome's loading behavior
            view.once('ready-to-show', () => {
                view.show();
            });

            // Enhanced protection when Kasada preload is used
            // This applies to any domain where the user has specified kasada preload in config
            if (usesKasadaPreferences) {
                log(`Using minimal config for kasada (matching working code)...`);
                // Additional session configuration for Kasada
                persistentSession.setPermissionRequestHandler((webContents, permission, callback) => {
                    // Match Chrome's default permission behavior
                    const allowedByDefault = ['clipboard-read', 'clipboard-write', 'fullscreen'];
                    callback(allowedByDefault.includes(permission));
                });
            }

            view.setMenuBarVisibility(true);

            const enforceSignInCSP = isFacebookSignIn ? false : shouldEnforceSignInCSP(args);

            // Set Content-Security-Policy once per session to avoid listener accumulation
            // (skip when preload is disabled, for Kasada preload, or when disabled via config)
            if (enforceSignInCSP && hasSignInPreload && !usesKasadaPreferences) {
                const ses = view.webContents.session;
                if (ses && !cspConfiguredSessions.has(ses)) {
                    ses.webRequest.onHeadersReceived((details, callback) => {
                        try {
                            const responseHeaders = details && details.responseHeaders
                                ? { ...details.responseHeaders }
                                : {};
                            // Also remove Accept-CH here so CSP + client-hints logic can share one listener.
                            delete responseHeaders['Accept-CH'];
                            delete responseHeaders['accept-ch'];
                            responseHeaders['Content-Security-Policy'] = ["default-src 'self' https: wss: data: blob:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:;"];
                            callback({
                                responseHeaders
                            });
                        } catch (e) {
                            callback({ responseHeaders: details.responseHeaders });
                        }
                    });
                    cspConfiguredSessions.add(ses);
                }
            } else if (!enforceSignInCSP) {
                log('Sign-in CSP override disabled via config');
            } else if (!hasSignInPreload) {
                log('Sign-in CSP override skipped because signin.preload is none');
            }

            // Store window configuration
            view.args = args;
            view.tabID = generateUniqueWindowId();
            log("Generated tabID for sign-in window:", view.tabID);
            // Initialize logical visibility flag for stealth-hide/show
            view.__ss_visible = true;
            try { view.setSkipTaskbar(false); } catch (_) { }
            browserViews[view.tabID] = view;
            if (sourceObservationService) sourceObservationService.trackView(view);
            const releaseSignInWindowSessionHooks = registerActivatedWindowSessionHooks(view, args);
            let releaseSignInClientHintFiltering = () => { };


            // Strip Accept-CH for the adaptive window just like the known-working Mock setup.
            if (args.config && args.config.userAgent && args.config.mockUserAgentData && preloadScript !== 'preload-kasada.js') {
                const session = view.webContents.session;
                if (session && !enforceSignInCSP && !cspConfiguredSessions.has(session)) {
                    releaseSignInClientHintFiltering = registerClientHintFiltering(
                        session,
                        view.webContents.id
                    );
                }
            }

            view.setBounds(loadRememberedSourceWindowBounds(args, "signin"));
            installRememberedSourceWindowBoundsTracking(view, "signin");


            // Set up window behaviors
            if (view.webContents) {
                // Handle audio
                if ("muted" in args) {
                    log(`Setting audio muted to: ${args.muted}`);
                    view.webContents.setAudioMuted(args.muted);
                } else {
                    log("No muted arg, defaulting to muted=true");
                    view.webContents.setAudioMuted(true);
                }

                // Set window title
                const hostname = new URL(args.url).hostname;

                view.setTitle(`${hostname} - ⚠️⚠️ Close this window after signing in ⚠️⚠️`);

                view.on('page-title-updated', (event, title) => {
                    event.preventDefault();
                    const hostname = new URL(view.webContents.getURL()).hostname;
                    view.setTitle(`${hostname} - ⚠️⚠️ Close this window after signing in ⚠️⚠️`);
                });

                view.webContents.on("zoom-changed", (event, zoomDirection) => {
                    const currentZoom = view.webContents.getZoomFactor();
                    if (zoomDirection === "in") {
                        view.webContents.setZoomFactor(currentZoom + 0.1);
                    } else if (zoomDirection === "out") {
                        view.webContents.setZoomFactor(currentZoom - 0.1);
                    }
                });

                view.webContents.on("before-input-event", (event, input) => {
                    if (input.control && input.type === "mouseWheel") {
                        const zoomDirection = input.deltaY < 0 ? "in" : "out";
                        view.webContents.emit("zoom-changed", event, zoomDirection);
                    }
                });

                view.webContents.setWindowOpenHandler(({ url }) => {
                    if (!allowPopups) {
                        // Open OAuth target in the same window instead of a popup
                        try {
                            const ua = getSignInUserAgent(url, args.config, args.configs);
                            try { view.webContents.setUserAgent(ua); } catch (_) { }
                            view.webContents.loadURL(url, { userAgent: ua }).catch(() => { });
                        } catch (_) { }
                        return { action: 'deny' };
                    }
                    const childContextIsolation = webPreferences.contextIsolation;
                    return {
                        action: 'allow',
                        overrideBrowserWindowOptions: {
                            autoHideMenuBar: false,
                            frame: true,
                            titleBarStyle: 'default',
                            title: `${new URL(url).hostname} - ⚠️⚠️ Close this window after signing in ⚠️⚠️`,
                            webPreferences: {
                                nodeIntegration: false,
                                contextIsolation: childContextIsolation,
                                nativeWindowOpen: true,
                                sandbox: false,
                                webviewTag: false,
                                webSecurity: true,
                                allowRunningInsecureContent: false,
                                additionalPermissions: ['clipboard-write']
                            }
                        }
                    };
                });


                view.webContents.on('will-navigate', (event, url) => {
                    if (url.includes('oauth') || url.includes('signin') || url.includes('login')) {
                        try {
                            const userAgent = getSignInUserAgent(url, args.config, args.configs);
                            view.webContents.setUserAgent(userAgent);
                        } catch (_) { }
                    }
                });

                // Inject chrome.runtime mock for sign-in windows that need it
                view.webContents.on('dom-ready', () => {
                    log('Sign-in window DOM ready, checking if chrome.runtime mock needed');

                    // Skip all DOM injection when preload is explicitly disabled.
                    if (!hasSignInPreload) {
                        log('Skipping all DOM injections because signin.preload is none');
                        return;
                    }

                    if (usesKasadaPreferences) {
                        log('Skipping all DOM injections for Kasada-compatible sign-in window');
                        return;
                    }

                    // Check if this is a page that needs chrome.runtime (like twitch.html)
                    const currentURL = view.webContents.getURL();
                    if (currentURL.includes('twitch.html') || currentURL.includes('tiktok.html')) {
                        log('Injecting chrome.runtime mock for sign-in window');
                        const chromeRuntimeCode = `
                            if (!window.chrome) {
                                window.chrome = {};
                            }
                            if (!window.chrome.runtime) {
                                window.chrome.runtime = {
                                    id: 'socialstream-extension-mock',
                                    sendMessage: function(extensionId, message, callback) {
                                                                                
                                        // Handle specific message types
                                        if (message && message.getSettings) {
                                            // Return mock settings response
                                            if (callback) {
                                                setTimeout(() => {
                                                    callback({
                                                        state: true,
                                                        streamID: 'mock-stream',
                                                        settings: {}
                                                    });
                                                }, 0);
                                            }
                                        } else if (callback) {
                                            // For other messages, just call the callback with an empty response
                                            setTimeout(() => {
                                                callback({});
                                            }, 0);
                                        }
                                    },
                                    onMessage: {
                                        addListener: function(listener) {
                                            console.log('[Chrome Runtime Mock] onMessage.addListener called');
                                            // Store the listener but don't do anything with it for now
                                            window.chrome.runtime.onMessage._listeners = window.chrome.runtime.onMessage._listeners || [];
                                            window.chrome.runtime.onMessage._listeners.push(listener);
                                        },
                                        removeListener: function(listener) {
                                            console.log('[Chrome Runtime Mock] onMessage.removeListener called');
                                            if (window.chrome.runtime.onMessage._listeners) {
                                                const index = window.chrome.runtime.onMessage._listeners.indexOf(listener);
                                                if (index > -1) {
                                                    window.chrome.runtime.onMessage._listeners.splice(index, 1);
                                                }
                                            }
                                        },
                                        _listeners: []
                                    }
                                };
                                console.log('[Chrome Runtime Mock] Injection complete for sign-in window');
                            } else {
                                console.log('[Chrome Runtime Mock] chrome.runtime already exists in sign-in window');
                            }
                        `;
                        view.webContents.executeJavaScript(chromeRuntimeCode).catch(err => {
                            console.error('Failed to inject chrome.runtime in sign-in window:', err);
                        });
                    }

                    // Inject additional anti-detection code for all sign-in windows
                    const antiDetectionCode = `
                        // Additional anti-detection measures for Kasada
                        (function() {
                            // Override navigator.permissions more thoroughly
                            if (navigator.permissions && navigator.permissions.query) {
                                const originalQuery = navigator.permissions.query;
                                navigator.permissions.query = function(descriptor) {
                                    return new Promise((resolve) => {
                                        // Return realistic permission states
                                        let state = 'prompt';
                                        if (descriptor.name === 'clipboard-read' || descriptor.name === 'clipboard-write') {
                                            state = 'granted';
                                        }
                                        
                                        resolve({
                                            state: state,
                                            onchange: null,
                                            addEventListener: () => {},
                                            removeEventListener: () => {},
                                            dispatchEvent: () => true
                                        });
                                    });
                                };
                            }
                            
                            // Fix Notification.permission
                            try {
                                Object.defineProperty(Notification, 'permission', {
                                    get: () => 'default',
                                    configurable: true
                                });
                            } catch(e) {}
                            
                            // Remove CDP artifacts
                            delete window.$cdc_asdjflasutopfhvcZLmcfl_;
                            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
                            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
                            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
                            
                            // Override runtime detection
                            const originalRuntime = window.chrome?.runtime;
                            if (window.chrome && !originalRuntime) {
                                Object.defineProperty(window.chrome, 'runtime', {
                                    get: () => undefined,
                                    configurable: true
                                });
                            }
                            
                            // Fix window.chrome properties
                            if (window.chrome) {
                                // Add csi function (Chrome Speed Index)
                                if (!window.chrome.csi) {
                                    window.chrome.csi = function() {
                                        return {
                                            onloadT: Date.now(),
                                            startE: Date.now() - 1000,
                                            pageT: Date.now() - Date.now(),
                                            tran: 15
                                        };
                                    };
                                }
                                
                                // Add loadTimes (deprecated but still checked)
                                if (!window.chrome.loadTimes) {
                                    window.chrome.loadTimes = function() {
                                        return {
                                            requestTime: Date.now() / 1000 - 1,
                                            startLoadTime: Date.now() / 1000 - 0.5,
                                            commitLoadTime: Date.now() / 1000 - 0.3,
                                            finishDocumentLoadTime: Date.now() / 1000 - 0.1,
                                            finishLoadTime: Date.now() / 1000,
                                            firstPaintTime: Date.now() / 1000 - 0.2,
                                            firstPaintAfterLoadTime: 0,
                                            navigationType: "Other",
                                            wasFetchedViaSpdy: false,
                                            wasNpnNegotiated: true,
                                            npnNegotiatedProtocol: "h2",
                                            wasAlternateProtocolAvailable: false,
                                            connectionInfo: "h2"
                                        };
                                    };
                                }
                            }
                            
                            // Override Object.getOwnPropertyNames to hide modifications
                            const originalGetOwnPropertyNames = Object.getOwnPropertyNames;
                            Object.getOwnPropertyNames = function(obj) {
                                const props = originalGetOwnPropertyNames(obj);
                                // Remove suspicious properties from the list
                                return props.filter(prop => !prop.includes('$cdc') && !prop.includes('selenium') && !prop.includes('webdriver'));
                            };
                            
                            // More aggressive CDP detection removal
                            const cdpProps = Object.getOwnPropertyNames(window).filter(prop => prop.includes('$cdc') || prop.includes('_cdc'));
                            cdpProps.forEach(prop => {
                                try {
                                    delete window[prop];
                                } catch(e) {}
                            });
                        })();
                    `;

                    view.webContents.executeJavaScript(antiDetectionCode).catch(err => {
                        console.error('Failed to inject additional anti-detection code:', err);
                    });
                });

                // Kasada monitoring removed - handled by preload-kasada.js
                /*
                view.webContents.on('did-start-loading', () => {
                    const { kasadaBypassScript } = require('./kasada-intercept');
                    view.webContents.executeJavaScript(kasadaBypassScript).catch(err => {
                        console.error('Failed to inject Kasada bypass script:', err);
                    });
                });
                */

                // TEMPORARILY DISABLED: Kasada fix injection creates fake KPSDK with placeholder tokens
                // This prevents the real SDK from loading properly
                /*
                view.webContents.on('did-navigate', (event, url) => {
                    if (url.includes('twitch.tv') || url.includes('kick.com')) {
                        // Read and inject the Kasada fix
                        const fs = require('fs');
                        const kasadaFixPath = path.join(__dirname, 'kasada-fix-injection.js');
                        
                        fs.readFile(kasadaFixPath, 'utf8', (err, data) => {
                            if (err) {
                                console.error('Failed to read Kasada fix script:', err);
                                return;
                            }
                            
                            view.webContents.executeJavaScript(data).then(() => {
                                log('Kasada fix injection successful');
                            }).catch(err => {
                                console.error('Failed to inject Kasada fix:', err);
                            });
                        });
                    }
                });
                */

                // Anti-detection is now handled by preload.js to avoid conflicts
                // The preload script provides more comprehensive and consistent spoofing

                // Monitor for new Kasada cookies (if not disabled)
                if (args.config?.signin?.monitorAntiBot !== false) {
                    const sess = view.webContents.session;
                    if (sess && !cookiesListenerConfiguredSessions.has(sess)) {
                        sess.cookies.on('changed', (event, cookie, cause, removed) => {
                            const kasadaCookieNames = ['KP_UIDz', 'KP_UIDZ', 'kpid', 'kppid', 'kppidg'];

                            // Check if this is a Kasada cookie
                            if (kasadaCookieNames.some(name => cookie.name.includes(name))) {
                                if (!removed) {
                                    log(`New Kasada cookie set: ${cookie.name} = ${cookie.value.substring(0, 20)}...`);
                                    log(`Cookie details: domain=${cookie.domain}, path=${cookie.path}, expires=${cookie.expirationDate}`);
                                } else {
                                    log(`Kasada cookie removed: ${cookie.name}`);
                                }
                            }
                        });
                        cookiesListenerConfiguredSessions.add(sess);
                    }
                }

                // Add a small delay before loading to ensure all interceptors are set up
                const loadDelay = view.urlLoadDelay || 100;
                log(`Delaying URL load by ${loadDelay}ms...`);
                setTimeout(() => {
                    log(`Loading sign-in URL: ${args.url}`);
                    if (usesKasadaPreferences) {
                        // Use config user agent if provided, otherwise use platform-specific fallback
                        let userAgent;
                        if (args.config?.userAgent) {
                            userAgent = args.config.userAgent;
                            log(`Loading URL with configured user agent for kasada: ${userAgent}`);
                        } else {
                            // Use platform-specific fallback
                            const CHROME_UA_VERSION = '144.0.0.0';
                            if (isMac) {
                                userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_VERSION} Safari/537.36`;
                            } else if (process.platform === 'linux') {
                                userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_VERSION} Safari/537.36`;
                            } else {
                                userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_VERSION} Safari/537.36`;
                            }
                            log(`Loading URL with platform-specific fallback user agent for kasada: ${userAgent}`);
                        }
                        try { view.webContents.setUserAgent(userAgent); } catch (_) { }
                        view.webContents.loadURL(args.url, {
                            userAgent: userAgent,
                            httpReferrer: {
                                url: signInHeaderOverrides.referer || '',
                                policy: 'strict-origin-when-cross-origin'
                            }
                        });
                    } else if (args.config?.userAgent) {
                        log(`Using configured user agent: ${args.config.userAgent}`);
                        const loadOptions = { userAgent: args.config.userAgent };
                        if (signInHeaderOverrides.referer) {
                            loadOptions.httpReferrer = {
                                url: signInHeaderOverrides.referer,
                                policy: 'strict-origin-when-cross-origin'
                            };
                        }
                        try { view.webContents.setUserAgent(args.config.userAgent); } catch (_) { }
                        view.webContents.loadURL(args.url, loadOptions);
                    } else if (signInHeaderOverrides.referer) {
                        view.webContents.loadURL(args.url, {
                            httpReferrer: {
                                url: signInHeaderOverrides.referer,
                                policy: 'strict-origin-when-cross-origin'
                            }
                        });
                    } else {
                        view.webContents.loadURL(args.url);
                    }
                }, loadDelay);

                view.webContents.on("did-fail-load", function (event, errorCode, errorDescription, validatedURL) {
                    console.error("Sign-in window failed to load:", validatedURL);
                    console.error("Error:", errorDescription, "Code:", errorCode);

                    // Common error codes:
                    // -3 = ERR_ABORTED
                    // -6 = ERR_FILE_NOT_FOUND  
                    // -7 = ERR_TIMED_OUT
                    // -105 = ERR_NAME_NOT_RESOLVED
                    // -106 = ERR_INTERNET_DISCONNECTED

                    if (errorCode === -7) {
                        log("Connection timed out - retrying in 2 seconds...");
                        setTimeout(() => {
                            if (!isBrowserViewDestroyed(view)) {
                                view.webContents.reload();
                            }
                        }, 2000);
                    }
                });

                // Add navigation debugging
                view.webContents.on('did-start-loading', () => {
                    log(`Sign-in window started loading: ${args.url}`);
                });

                view.webContents.on('did-stop-loading', () => {
                    log(`Sign-in window stopped loading`);
                });

                view.webContents.on('dom-ready', () => {
                    log(`Sign-in window DOM ready`);
                });

                // URL loading is already handled above in the setTimeout - DON'T DUPLICATE!

                // Handle window closure
                view.on('closed', () => {
                    const tabID = view.tabID; // Store it immediately
                    log("Sign-in window closed, destroyed: " + isBrowserViewDestroyed(view));
                    try {
                        releaseSignInWindowSessionHooks();
                    } catch (_) { }
                    try {
                        releaseSignInClientHintFiltering();
                    } catch (_) { }

                    // Clean up if possible
                    if (!isBrowserViewDestroyed(view)) {
                        try {
                            view.destroy();
                        } catch (e) {
                            log("Error destroying view: " + e);
                        }
                    }

                    // Always clean up references and send the message
                    if (browserViews[tabID]) {
                        delete browserViews[tabID];
                    }

                    if (mainWindow && !mainWindow.isDestroyed() && !app.isQuitting) {
                        try {
                            log("Sending window-closed event for tab: " + tabID);
                            mainWindow.webContents.send(`window-closed-${tabID}`);
                        } catch (e) {
                            log("Error sending window-closed event: " + e);
                        }
                    }
                });

                return view.tabID;
            }
        } catch (error) {
            console.error('Error creating sign-in window:', error);
            return null;
        }
    }

    // Keep the old sync handler for backward compatibility  
  const originalCreateWindowHandler = function (eventRet, args2) {
        log("IPC CREATE WINDOW");
        var args = Object.assign({}, Argv, args2);
        let runningLocally = args.filesource || "";
        if (runningLocally && !runningLocally.endsWith("/") && !runningLocally.endsWith("\\")) {
            runningLocally += "/";
        }
        if (!args.url) {
            log("No URL; can't load");
            eventRet.returnValue = null;
            return;
        }

        const isBetaMode = args.isBetaMode || false;

        // Check if we're already creating a window for this source to prevent duplicates
        if (args.sourceId) {
            for (const [id, view] of Object.entries(browserViews)) {
                if (view.args && view.args.sourceId === args.sourceId && !isBrowserViewDestroyed(view)) {
                    log("Window already exists for source: " + args.sourceId);
                    eventRet.returnValue = id;
                    return;
                }
            }
        }

        // If updating existing window
        if (args.tab) {
            const existingView = getActiveBrowserView(args.tab);
            if (existingView && existingView.webContents) {
                try {
                    existingView.args = { ...(existingView.args || {}), ...args };
                    if (args?.config?.userAgent) {
                        existingView.webContents.loadURL(args.url, {
                            userAgent: args.config.userAgent
                        });
                    } else {
                        existingView.webContents.loadURL(args.url);
                    }
                    eventRet.returnValue = args.tab;
                    return;
                } catch (e) {
                    console.error(e);
                }
            }
        }

        var loaded = false;
        var timeout = false;

        let visibibility = !headlessControlEnabled;
        if ("visible" in args && !args.visible) {
            visibibility = false;
        }


        // Determine session based on customSession parameter
        const domain = getPrimaryDomain(args.url);
        const platform = resolveSessionPlatform(args, domain);
        let sessionPartition;
        let persistentSession;

        if (args.customSession && args.customSession !== 'AUTO') {
            const normalizedSession = String(args.customSession).trim();
            if (normalizedSession.startsWith('default-')) {
                const explicitPlatform = normalizedSession.replace('default-', '').trim();
                sessionPartition = `persist:${explicitPlatform || platform}`;
            } else if (normalizedSession === 'default') {
                // Backward compatibility for older records that used plain "default".
                // Keep legacy partition mapping to avoid breaking existing sign-ins.
                sessionPartition = 'persist:custom-default';
            } else {
                sessionPartition = `persist:custom-${normalizedSession}`;
            }
            log(`Using custom session: ${sessionPartition}`);
        } else {
            sessionPartition = `persist:${platform}`;
            log(`Using auto session based on platform: ${sessionPartition}`);
        }

        // Always use the platform-based session, regardless of preload type
        persistentSession = session.fromPartition(sessionPartition);
        createdPartitions.add(sessionPartition); // Track this partition
        log(`[ACTIVATE] URL: ${args.url}, Domain: ${domain}, Platform: ${platform}, Session: ${sessionPartition}, CustomSession: ${args.customSession}`);

        // Language is now set globally via command line to match system locale
        // This avoids Electron's en-GB bug for Canadians and should work properly
        log(`[ACTIVATE] Using system locale: ${SYSTEM_LOCALE} (set globally via command line)`)

        // Debug: Check cookies when activate window is created
        persistentSession.cookies.get({ domain: '.twitch.tv' }).then(cookies => {
            log(`[ACTIVATE DEBUG] Cookies for .twitch.tv: ${cookies.length} cookies found`);
            cookies.forEach(cookie => {
                log(`  - ${cookie.name}: ${cookie.value.substring(0, 10)}... (domain: ${cookie.domain})`);
            });
        }).catch(err => {
            log(`[ACTIVATE DEBUG] Error getting cookies: ${err}`);
        });

        try {
            let webSecurity = true;
            if (args.config && ("webSecurity" in args.config)) {
                webSecurity = args.config.webSecurity;
            }
            let contextIsolation = true;

            // Allow websocket windows to select a preload via config (to better match sign-in behavior)
            // Supported values: 'mock' -> preload-mock.js, 'kasada' -> preload-kasada.js, 'full'|true -> preload.js, 'none'|false -> no preload
            let preloadPath = path.join(__dirname, 'preload.js');
            if (args.wss && args.config && ("preload" in args.config)) {
                const p = args.config.preload;
                if (p === 'mock') {
                    preloadPath = path.join(__dirname, 'preload-mock.js');
                } else if (p === 'kasada') {
                    preloadPath = path.join(__dirname, 'preload-kasada.js');
                    // Match sign-in behavior: disable contextIsolation for kasada preload unless explicitly overridden
                    if (!("contextIsolation" in (args.config || {}))) {
                        contextIsolation = false;
                    }
                } else if (p === 'full' || p === true) {
                    preloadPath = path.join(__dirname, 'preload.js');
                } else if (p === 'none' || p === false) {
                    preloadPath = null; // omit preload entirely
                } else {
                    // Unknown preload value — ignore to prevent path traversal
                    console.warn('[createWindow] Ignoring unknown preload config value:', p);
                }
            }

            log("Context isolation for window:", contextIsolation, "Platform:", args.domain);
            log("Preload path for window:", preloadPath, "args.wss:", args.wss, "has config.preload:", args.config && ("preload" in args.config));
            log("Source window URL:", args.url, "config.preload value:", args.config?.preload);

            // Build webPreferences dynamically so we can omit preload when asked
            const webPreferences = {
                contextIsolation: contextIsolation,
                // Keeps document.visibilityState at "visible" and DOM timers unthrottled
                // while the window is hidden, which is what lets capture keep running.
                backgroundThrottling: false,
                webSecurity: webSecurity,
                nodeIntegrationInSubFrames: false,
                nodeIntegration: false,
                session: persistentSession,
                additionalPermissions: ['clipboard-write']
            };
            if (preloadPath) {
                webPreferences.preload = preloadPath;
            }

            const view = new BrowserWindow({
                webPreferences,
                show: false,  // Always create hidden to prevent focus stealing
                backgroundColor: "#0000",
                transparent: false,
                frame: true,
                autoHideMenuBar: false,
                title: args.url.replace("https://", "").slice(0, 50),
            });
            //log(args);
            view.args = args;
            view.__ss_visible = !!visibibility;
            const releaseActivatedWindowSessionHooks = registerActivatedWindowSessionHooks(view, args);
            view.once('closed', () => {
                try {
                    releaseActivatedWindowSessionHooks();
                } catch (_) { }
            });

            view.tabID = generateUniqueWindowId();;
            browserViews[view.tabID] = view;
            if (sourceObservationService) sourceObservationService.trackView(view);
            const sourceWindowMode = args.wss ? "wss" : "classic";
            const rememberedSourceWindowBounds = loadRememberedSourceWindowBounds(args, sourceWindowMode);
            view.__prevBounds = rememberedSourceWindowBounds;
            view.setBounds(rememberedSourceWindowBounds);
            installRememberedSourceWindowBoundsTracking(view, sourceWindowMode);
            installWindowsSourceWindowMinimizeGuard(view);
            // Keeps requestAnimationFrame work running if the compositor stops giving this
            // window frames (hidden, minimized, occluded, or on another workspace).
            attachFramePump(view, { webFrameMain, log });

            // Show without stealing focus if visibility is enabled
            if (visibibility) {
                view.__ss_visible = true;
                try { view.setSkipTaskbar(false); } catch (_) { }
                // showInactive() does nothing on Wayland, which would leave a source window
                // that is supposed to be visible stuck off screen.
                if (isWaylandSession()) {
                    view.show();
                } else {
                    view.showInactive();
                }
            } else {
                view.__ss_visible = false;
                try { view.setSkipTaskbar(true); } catch (_) { }
                stealthHideView(view);
                if (process.platform !== 'linux') {
                    try { view.showInactive(); } catch (_) { }
                }
                const reparkHiddenWindow = () => {
                    try {
                        if (!isBrowserViewDestroyed(view) && view.__ss_visible === false) {
                            stealthHideView(view);
                        }
                    } catch (_) { }
                };
                view.once('ready-to-show', reparkHiddenWindow);
                if (view.webContents) {
                    view.webContents.once('did-finish-load', () => {
                        setTimeout(reparkHiddenWindow, 0);
                    });
                }
                setTimeout(reparkHiddenWindow, 100);
            }

            if (view.webContents) {
                // Auto-close on navigate for activated (classic) windows only
                try {
                    const enforceCloseOnNavigate = (!args.wss && args.config
                        && (args.config.closeOnNavigate === true || args.config.closeOnNavigateV2 === true));
                    if (enforceCloseOnNavigate) {
                        const mode = (args.config && args.config.closeOnNavigateMode) || 'prefix'; // 'origin' | 'prefix' | 'exact' | 'channel'
                        const preserveManualTikTokStandard = shouldPreserveManualTikTokStandardNavigation(args);
                        let navigationWarningSent = false;
                        let navigationCloseStarted = false;
                        let pendingViolationTimer = null;
                        const isAllowed = createCloseOnNavigateAllowance(args, mode);

                        const clearPendingViolation = () => {
                            if (pendingViolationTimer) {
                                clearTimeout(pendingViolationTimer);
                                pendingViolationTimer = null;
                            }
                        };

                        const closeNow = (navUrl, reason) => {
                            if (navigationCloseStarted) return;
                            navigationCloseStarted = true;
                            clearPendingViolation();
                            try { log(`Auto-closing activated window due to navigation (${reason}): ${navUrl}`); } catch (_) { }

                            // Best-effort UI notification with details for toast
                            try {
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send('window-auto-closed', {
                                        tabID: view.tabID,
                                        sourceId: view.args && view.args.sourceId,
                                        reason,
                                        mode,
                                        initialUrl: args.url,
                                        newUrl: navUrl
                                    });
                                }
                            } catch (_) { }

                            // Also send the legacy per-tab closed event (used by sign-in flow, harmless here)
                            try {
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send(`window-closed-${view.tabID}`);
                                }
                            } catch (_) { }

                            // Destroy the window and clean up bookkeeping
                            try { if (!isBrowserViewDestroyed(view)) view.destroy(); } catch (_) { }
                            try { delete browserViews[view.tabID]; releaseWindowId(view.tabID); } catch (_) { }
                        };

                        // Only committed navigations are judged: redirect chains (login,
                        // consent, anti-bot bounces) pass through disallowed URLs but only
                        // commit at their final destination, and a disallowed commit still
                        // gets a settle window to bounce back before the window is closed.
                        const handleCommittedNavigation = (navUrl, reason) => {
                            if (isAllowed(navUrl)) {
                                clearPendingViolation();
                                return;
                            }
                            if (preserveManualTikTokStandard) {
                                try { log(`Keeping manual TikTok Standard window open after navigation (${reason}): ${navUrl}`); } catch (_) { }
                                if (!navigationWarningSent) {
                                    navigationWarningSent = true;
                                    sendWindowNavigationWarning(view, args, navUrl, reason, mode);
                                }
                                return;
                            }
                            if (navigationCloseStarted || pendingViolationTimer) return;
                            pendingViolationTimer = setTimeout(() => {
                                pendingViolationTimer = null;
                                if (navigationCloseStarted || isBrowserViewDestroyed(view)) return;
                                let settledUrl = navUrl;
                                try { settledUrl = view.webContents.getURL() || navUrl; } catch (_) { }
                                if (isAllowed(settledUrl)) return;
                                closeNow(settledUrl, reason);
                            }, CLOSE_ON_NAVIGATE_SETTLE_MS);
                        };

                        view.webContents.on('did-navigate', (event, url) => {
                            handleCommittedNavigation(getCloseOnNavigateEventUrl(event, url), 'did-navigate');
                        });
                        view.webContents.on('did-navigate-in-page', (event, url, isMainFrame) => {
                            if (!isCloseOnNavigateMainFrameEvent(event, isMainFrame)) return;
                            handleCommittedNavigation(getCloseOnNavigateEventUrl(event, url), 'did-navigate-in-page');
                        });
                        view.webContents.once('destroyed', clearPendingViolation);
                    }
                } catch (e) {
                    try { console.warn('Error attaching closeOnNavigate handlers (classic window):', e); } catch (_) { }
                }
                // Add navigation debugging for regular windows
                view.webContents.on('did-start-loading', () => {
                    log(`Regular window started loading: ${args.url}`);
                });

                view.webContents.on('did-stop-loading', () => {
                    log(`Regular window stopped loading`);
                });

                view.webContents.on('dom-ready', () => {
                    log(`Regular window DOM ready`);
                });

                view.webContents.on("did-fail-load", function (event, errorCode, errorDescription, validatedURL) {
                    console.error("Regular window failed to load:", validatedURL);
                    console.error("Error:", errorDescription, "Code:", errorCode);

                    if (errorCode === -7) {
                        log("Connection timed out - retrying in 2 seconds...");
                        setTimeout(() => {
                            if (!isBrowserViewDestroyed(view)) {
                                view.webContents.reload();
                            }
                        }, 2000);
                    }
                });



        // Helper to load the URL after monitor setup (or if it is skipped/failed)
        const loadURL = () => {
          if (view.isDestroyed()) return;
          log(`Loading regular window URL: ${args.url}`);
          log(`User agent config: ${args.config?.userAgent}`);
          const navigationOptions = {};
          const initialHeaderOverrides = resolveHeaderOverridesFromConfig(args.config, args.url);
          if (view.args?.config?.userAgent) {
            navigationOptions.userAgent = view.args.config.userAgent;
            try { view.webContents.setUserAgent(view.args.config.userAgent); } catch (_) { }
            log(`Setting custom user agent for source window loadURL: ${view.args.config.userAgent}`);
          } else {
            log(`Using default user agent for loadURL`);
          }
          if (initialHeaderOverrides.referer) {
            navigationOptions.httpReferrer = {
              url: initialHeaderOverrides.referer,
              policy: 'strict-origin-when-cross-origin'
            };
          }
          if (Object.keys(navigationOptions).length) {
            return view.webContents.loadURL(args.url, navigationOptions);
          } else {
            return view.webContents.loadURL(args.url);
          }
        };

                // Set up WebSocket monitoring if configured in args or config
                // Configuration can be set in config files (e.g., config_0.json) or passed via args
                // Configuration options:
                //   websocketMonitoring = true                           // Monitor all WebSockets
                //   websocketMonitoring = "streamelements.com"           // Monitor WebSockets containing this domain
                //   websocketMonitoring = { filter: "domain.com" }       // Object format with filter
                const websocketMonitoring = args.websocketMonitoring || (args.config && args.config.websocketMonitoring);
                if (websocketMonitoring) {
          /**
           * Normalizes WebSocket frame data, returning the raw string for text frames (opcode 1)
           * or a decoded Uint8Array for binary frames (other opcodes).
           * @param {string} data A utf-8 or base64 encoded string
           * @param {number} opcode The opcode received from the Network.webSocketFrameReceived or Network.webSocketFrameSent event
           * @returns {opcode extends 1 ? string : Uint8Array<Buffer>}
           */
          function normalizeWSData(data, opcode) {
            if (opcode === 1) return data;

            return Uint8Array.from(Buffer.from(data, 'base64'));
          }

                        let websocketFilter = null;

                        // Handle different configuration formats
                        if (typeof websocketMonitoring === 'object' && websocketMonitoring.filter) {
                            // Object format: { filter: "domain.com" }
                            const filterDomain = websocketMonitoring.filter;
                            websocketFilter = (url) => url && url.includes(filterDomain);
                        } else if (typeof websocketMonitoring === 'string') {
                            // String format: "domain.com"
                            const filterDomain = websocketMonitoring;
                            websocketFilter = (url) => url && url.includes(filterDomain);
                        } else if (websocketMonitoring === true) {
                            // Boolean true: monitor all WebSockets
                            websocketFilter = null;
                        }

          (async () => {
            let navigationStarted = false;
            try {
              if (view.isDestroyed()) return;
              // Attach debugger & enable CDP Network and Runtime domains
              const cleanup = await setupWebSocketMonitor(view.webContents, {
                            filter: websocketFilter,
                            onAttached: () => {
                                navigationStarted = true;
                                return loadURL();
                            },
                            onMessage: (data) => {
                                view.webContents.send('websocket-message', {
                                    type: 'message',
                                    data: normalizeWSData(data.data, data.opcode),
                                    url: data.url,
                                    timestamp: data.timestamp,
                                    requestId: data.requestId
                                });
                            },
                            onOpen: (data) => {
                                view.webContents.send('websocket-message', {
                                    type: 'open',
                                    url: data.url,
                                    timestamp: data.timestamp,
                                    requestId: data.requestId
                                });
                            },
                            onClose: (data) => {
                                view.webContents.send('websocket-message', {
                                    type: 'close',
                                    url: data.url,
                                    timestamp: data.timestamp,
                                    requestId: data.requestId
                                });
                            },
                            onSend: (data) => {
                                view.webContents.send('websocket-message', {
                                    type: 'send',
                                    data: normalizeWSData(data.data, data.opcode),
                                    url: data.url,
                                    timestamp: data.timestamp,
                                    requestId: data.requestId
                                });
                            }
                        });

              if (view.isDestroyed()) {
                try { cleanup(); } catch (_) { }
                return;
              }
                        // Store cleanup function for later
                        view.__websocketMonitorCleanup = cleanup;
                        log(`WebSocket monitoring enabled${websocketFilter ? ' with filter' : ' for all WebSockets'}`);
                    } catch (error) {
                        log('Failed to set up WebSocket monitoring:', error);
                        // Monitor failure must not leave the source window blank
                        if (!navigationStarted && !view.isDestroyed()) {
                            try { loadURL(); } catch (_) { }
                        }
            }
          })();
                } else {
          loadURL();
                }
            }

            view.onbeforeunload = (e) => {
                if (app.isQuitting) {
                    return;
                }
                log("I do not want to be closed 1");
                e.preventDefault();
                try { stealthHideView(view); } catch (_) { try { view.hide(); } catch (_) { } }
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('window-hidden', {
                        tabID: view.tabID,
                        url: view.args.url
                    });
                }
                e.returnValue = false;
            };

            view.on("close", function (e) {
                if (app.isQuitting) {
                    return;
                }
                log("I do not want to be closed 2");
                e.preventDefault();

                // Clean up WebSocket debugger if it exists
                if (view.__websocketMonitorCleanup) {
                    try {
                        view.__websocketMonitorCleanup();
                        delete view.__websocketMonitorCleanup;
                    } catch (error) {
                        console.error('Error cleaning up WebSocket debugger:', error);
                    }
                }

                try { stealthHideView(view); } catch (_) {
                    try { if (!isBrowserViewDestroyed(view)) view.hide(); } catch (_) { }
                }
                if (mainWindow && !mainWindow.isDestroyed() && !isBrowserViewDestroyed(view)) {
                    mainWindow.webContents.send('window-hidden', {
                        tabID: view.tabID,
                        url: view.args.url
                    });
                }
                e.returnValue = false;
            });

            if (view.webContents) {
                if ("muted" in args) {
                    log(`Setting audio muted to: ${args.muted}`);
                    view.webContents.setAudioMuted(args.muted);
                } else {
                    log("No muted arg, defaulting to muted=true");
                    view.webContents.setAudioMuted(true);
                }


                //view.webContents.on("will-navigate", handleNavigation);
                //view.webContents.on("new-window", handleNavigation);

                view.webContents.on("zoom-changed", (event, zoomDirection) => {
                    const currentZoom = view.webContents.getZoomFactor();
                    if (zoomDirection === "in") {
                        view.webContents.setZoomFactor(currentZoom + 0.1);
                    } else if (zoomDirection === "out") {
                        view.webContents.setZoomFactor(currentZoom - 0.1);
                    }
                });

                // Handle Ctrl+mousewheel zoom
                view.webContents.on("before-input-event", (event, input) => {
                    if (input.control && input.type === "mouseWheel") {
                        const zoomDirection = input.deltaY < 0 ? "in" : "out";
                        view.webContents.emit("zoom-changed", event, zoomDirection);
                    }
                });

                view.webContents.on("did-start-loading", function () {
                    //loaded = false;
                    timeout = setTimeout(function () {
                        if (!loaded) {
                            loaded = true;
                            startRunning();
                        }
                    }, 3000);
                });

                view.webContents.on("dom-ready", function () {
                    if (!loaded) {
                        loaded = true;
                        clearTimeout(timeout);
                        // Add a delay to ensure preload script has finished setting up contextBridge
                        setTimeout(() => {
                            startRunning();
                        }, 500);
                    }

                    if (view.args?.config && view.args.config.userAgent && view.args.config.mockUserAgentData) {
                        const userAgent = view.args.config.userAgent;

                        const mockData = view.args.config.mockUserAgentData;
                        view.webContents.executeJavaScript(`
					  Object.defineProperty(navigator, 'userAgent', {
						get: () => '${userAgent}',
						configurable: true
					  });
					  
					  Object.defineProperty(navigator, 'appVersion', {
						get: () => '${userAgent.replace('Mozilla/', '')}',
						configurable: true
					  });
					  
					  Object.defineProperty(navigator, 'platform', {
						get: () => '${mockData.platform === 'macOS' ? 'MacIntel' : mockData.platform === 'Linux' ? 'Linux x86_64' : 'Win32'}',
						configurable: true
					  });
					  
					  Object.defineProperty(navigator, 'vendor', {
						get: () => 'Google Inc.',
						configurable: true
					  });
					  
					  const mockUserAgentData = {
						brands: ${JSON.stringify(mockData.brands)},
						mobile: ${mockData.mobile},
						platform: "${mockData.platform}",
						getHighEntropyValues: async function(hints) {
						  const values = {
							brands: this.brands,
							mobile: this.mobile,
							platform: this.platform
						  };
						  
						  // Add specific high entropy values based on hints
						  if (hints.includes('fullVersionList') && ${JSON.stringify(mockData.fullVersionList)}) {
							values.fullVersionList = ${JSON.stringify(mockData.fullVersionList)};
						  }
						  if (hints.includes('architecture')) {
							values.architecture = "${mockData.architecture || 'x86'}";
						  }
						  if (hints.includes('bitness')) {
							values.bitness = "${mockData.bitness || '64'}";
						  }
						  if (hints.includes('model')) {
							values.model = "${mockData.model || ''}";
						  }
						  if (hints.includes('platformVersion')) {
							values.platformVersion = "${mockData.platformVersion || '19.0.0'}";
						  }
						  if (hints.includes('uaFullVersion')) {
                            values.uaFullVersion = "${mockData.uaFullVersion || '142.0.7444.163'}";
						  }
						  if (hints.includes('wow64')) {
							values.wow64 = ${mockData.wow64 || false};
						  }
						  
						  return Promise.resolve(values);
						},
						toJSON: function() {
						  return {
							brands: this.brands,
							mobile: this.mobile,
							platform: this.platform
						  };
						}
					  };
					  
					  Object.defineProperty(navigator, 'userAgentData', {
						get: () => mockUserAgentData,
						configurable: true
					  });
					  
					  // Return a simple value to avoid serialization issues
					  true;
					`);
                    }
                });

                view.webContents.on("did-navigate", function (e) {
                    log("did-navigate");
                    loaded = false;
                    scriptInjected = false; // Reset injection flag on navigation
                    frameInjectionCode = null;
                    injectedFrameKeys.clear();
                });

            }

            // Move this declaration before it's used in event handlers
            let scriptInjected = false; // Track if script has been injected
            const sourceManifestEntries = Array.isArray(args.sourceManifestEntries) ? args.sourceManifestEntries : [];
            const compileManifestPattern = (pattern) => {
                if (typeof pattern !== "string" || !pattern.trim()) return null;
                try {
                    const escaped = pattern.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
                    return new RegExp(`^${escaped}$`);
                } catch (_) {
                    return null;
                }
            };
            const manifestInjectionRules = sourceManifestEntries
                .map((entry) => {
                    const regexes = (Array.isArray(entry?.matches) ? entry.matches : [])
                        .map((pattern) => compileManifestPattern(pattern))
                        .filter(Boolean);
                    return {
                        allFrames: entry?.allFrames === true,
                        regexes
                    };
                })
                .filter((entry) => entry.regexes.length > 0);
            const hasManifestRules = manifestInjectionRules.length > 0;
            const allFramesEnabled = manifestInjectionRules.some((entry) => entry.allFrames);
            let frameInjectionCode = null;
            let frameInjectionWebContents = null;
            let frameInjectionHandlersBound = false;
            const injectedFrameKeys = new Set();

            function getManifestUrlCandidates(urlValue) {
                if (typeof urlValue !== "string") {
                    return [];
                }
                const trimmed = urlValue.trim();
                if (!trimmed) {
                    return [];
                }
                const candidates = new Set();
                const addCandidate = (value) => {
                    if (typeof value !== "string") {
                        return;
                    }
                    const normalized = value.trim();
                    if (!normalized) {
                        return;
                    }
                    candidates.add(normalized);
                    if ((normalized.length > 1) && normalized.endsWith("/")) {
                        const withoutTrailingSlash = normalized.replace(/\/+$/, "");
                        if (withoutTrailingSlash) {
                            candidates.add(withoutTrailingSlash);
                        }
                    }
                };

                addCandidate(trimmed);
                try {
                    const withoutHash = new URL(trimmed);
                    withoutHash.hash = "";
                    addCandidate(withoutHash.toString());

                    const withoutSearchOrHash = new URL(trimmed);
                    withoutSearchOrHash.search = "";
                    withoutSearchOrHash.hash = "";
                    addCandidate(withoutSearchOrHash.toString());
                } catch (_) { }

                return [...candidates];
            }

            function urlMatchesManifestRules(urlValue, requireAllFrames = false) {
                const candidates = getManifestUrlCandidates(urlValue);
                if (!candidates.length) {
                    return false;
                }
                return manifestInjectionRules.some((entry) => {
                    if (requireAllFrames && !entry.allFrames) {
                        return false;
                    }
                    return entry.regexes.some((regex) => candidates.some((candidate) => regex.test(candidate)));
                });
            }

            function frameMatchesSourceManifest(frame) {
                if (!frame) return false;
                if (!frame.parent) return false; // Skip top-level frame
                const frameUrl = typeof frame.url === "string" ? frame.url.trim() : "";
                if (!frameUrl || frameUrl === "about:blank") return false;
                return urlMatchesManifestRules(frameUrl, true);
            }

            function getFrameInjectionKey(frame) {
                if (!frame) return "";
                const processId = Number.isFinite(frame.processId) ? frame.processId : "na";
                const routingId = Number.isFinite(frame.routingId) ? frame.routingId : "na";
                const frameUrl = typeof frame.url === "string" ? frame.url : "";
                return `${processId}:${routingId}:${frameUrl}`;
            }

            function injectSourceIntoFrame(frame, reason = "frame") {
                if (!allFramesEnabled || !frameInjectionCode || !frame) return;
                if (typeof frame.isDestroyed === "function" && frame.isDestroyed()) return;
                if (!frameMatchesSourceManifest(frame)) return;

                const key = getFrameInjectionKey(frame);
                if (!key || injectedFrameKeys.has(key)) return;
                injectedFrameKeys.add(key);

                frame.executeJavaScript(frameInjectionCode, true)
                    .then(() => {
                        log(`[all_frames] Injected source into frame (${reason}): ${frame.url || "unknown"}`);
                    })
                    .catch((error) => {
                        injectedFrameKeys.delete(key);
                        const message = error && error.message ? error.message : String(error);
                        if (message.includes("Object has been destroyed")) return;
                        log(`[all_frames] Failed frame injection (${reason}): ${message}`);
                    });
            }

            function injectSourceIntoExistingFrames(reason = "scan") {
                if (!allFramesEnabled || !frameInjectionCode || !frameInjectionWebContents) return;
                let frames = [];
                try {
                    const rootFrame = frameInjectionWebContents.mainFrame;
                    frames = rootFrame && Array.isArray(rootFrame.framesInSubtree) ? rootFrame.framesInSubtree : [];
                } catch (_) {
                    frames = [];
                }
                frames.forEach((frame) => {
                    try {
                        injectSourceIntoFrame(frame, reason);
                    } catch (_) { }
                });
            }

            function bindAllFrameInjectionHandlers(webContents) {
                if (!allFramesEnabled || frameInjectionHandlersBound || !webContents) return;
                frameInjectionWebContents = webContents;
                frameInjectionHandlersBound = true;

                const onDidFrameFinishLoad = (_event, isMainFrame, frameProcessId, frameRoutingId) => {
                    if (isMainFrame || !frameInjectionCode) return;
                    try {
                        const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
                        injectSourceIntoFrame(frame, "did-frame-finish-load");
                    } catch (_) { }
                };

                const onDidFrameNavigate = (_event, _url, _httpResponseCode, _httpStatusText, isMainFrame, frameProcessId, frameRoutingId) => {
                    if (isMainFrame || !frameInjectionCode) return;
                    try {
                        const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
                        injectSourceIntoFrame(frame, "did-frame-navigate");
                    } catch (_) { }
                };

                const onFrameCreated = (_event, details = {}) => {
                    if (!frameInjectionCode || !details || !details.frame) return;
          const processId = details.frame.processId;
          const routingId = details.frame.routingId;
                    setTimeout(() => {
                        try {
              const frame = webFrameMain.fromId(processId, routingId);
              if (frame) {
                injectSourceIntoFrame(frame, "frame-created");
              }
                        } catch (_) { }
                    }, 250);
                };

                webContents.on("did-frame-finish-load", onDidFrameFinishLoad);
                webContents.on("did-frame-navigate", onDidFrameNavigate);
                webContents.on("frame-created", onFrameCreated);

                view.once("closed", () => {
                    try { webContents.removeListener("did-frame-finish-load", onDidFrameFinishLoad); } catch (_) { }
                    try { webContents.removeListener("did-frame-navigate", onDidFrameNavigate); } catch (_) { }
                    try { webContents.removeListener("frame-created", onFrameCreated); } catch (_) { }
                    injectedFrameKeys.clear();
                    frameInjectionCode = null;
                    frameInjectionWebContents = null;
                    frameInjectionHandlersBound = false;
                });
            }

            function setAllFrameInjectionCode(webContents, code) {
                if (!allFramesEnabled || !webContents || !code) return;
                frameInjectionCode = code;
                injectedFrameKeys.clear();
                bindAllFrameInjectionHandlers(webContents);
                injectSourceIntoExistingFrames("main-injection");
            }

            function shouldInjectMainFrame(_webContents) {
                // The user explicitly chose this classic source for the top-level page.
                // Manifest rules should only scope all_frames injection, not block main-frame injection
                // on custom domains selected via the "Other site" flow.
                return true;
            }

            function logManifestMainFrameSkip(webContents) {
                if (!hasManifestRules) {
                    log("[manifest] Skipping main-frame injection; no manifest rules available.");
                    return;
                }
                let currentUrl = "";
                try {
                    currentUrl = webContents && typeof webContents.getURL === "function" ? (webContents.getURL() || "") : "";
                } catch (_) {
                    currentUrl = "";
                }
                const rulePatterns = sourceManifestEntries
                    .map((entry) => Array.isArray(entry?.matches) ? entry.matches : [])
                    .flat()
                    .filter(Boolean);
                log(`[manifest] Skipping main-frame injection; current URL does not match source manifest. URL: ${currentUrl || "unknown"} Rules: ${rulePatterns.join(", ") || "none"}`);
            }

            function startRunning() {
                // Prevent duplicate injection
                if (scriptInjected) {
                    log("Script already injected, skipping duplicate injection");
                    return;
                }

                if (isBrowserViewDestroyed(view)) {
                    log("Cannot start injection; view is already destroyed");
                    return;
                }

                let webContents;
                try {
                    webContents = view.webContents;
                } catch (err) {
                    const reason = err && err.message ? err.message : String(err);
                    log("Cannot start injection; failed to access webContents: " + reason);
                    return;
                }

                const isDestroyedError = (err) => {
                    if (!err) {
                        return false;
                    }
                    const message = err && err.message ? err.message : String(err);
                    return typeof message === "string" && message.indexOf("Object has been destroyed") !== -1;
                };

                const isWebContentsAlive = () => {
                    if (!webContents) {
                        return false;
                    }
                    if (typeof webContents.isDestroyed === "function") {
                        return !webContents.isDestroyed();
                    }
                    return true;
                };

                if (!isWebContentsAlive()) {
                    log("Cannot start injection; webContents is already destroyed");
                    return;
                }

                const runWithWebContents = (context, action) => {
                    if (!isWebContentsAlive()) {
                        log(context + ": webContents is no longer available; skipping");
                        return;
                    }
                    try {
                        action(webContents);
                    } catch (err) {
                        if (isDestroyedError(err)) {
                            log(context + ": webContents was destroyed during operation; skipping");
                            return;
                        }
                        throw err;
                    }
                };

                const whenDestroyedReject = (context) => (err) => {
                    if (isDestroyedError(err)) {
                        log(context + ": webContents was destroyed during async operation; skipping error");
                        return;
                    }
                    console.error(context + " failed:", err);
                };

                scriptInjected = true;
                const normalizeSelectedSourcePath = (value) => {
                    if (!value || typeof value !== "string") return "";
                    return value.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
                };
                const isAbsoluteScriptUrl = (value) => /^https?:\/\//i.test(String(value || ""));
                let explicitSourceFiles = Array.isArray(args.sourceFiles)
                    ? args.sourceFiles.map((value) => normalizeSelectedSourcePath(value)).filter(Boolean)
                    : [];
                explicitSourceFiles = [...new Set(explicitSourceFiles)];
                const selectedSourceFiles = explicitSourceFiles.length
                    ? explicitSourceFiles
                    : (args.source ? [normalizeSelectedSourcePath(args.source)] : []);
                let sourceInjectionHandled = false;

                if (runningLocally && selectedSourceFiles.length && selectedSourceFiles.every((value) => value && !isAbsoluteScriptUrl(value))) {
                    const normalizeRoot = (value) => {
                        if (!value || typeof value !== "string") return "";
                        return (value.endsWith("/") || value.endsWith("\\")) ? value : `${value}/`;
                    };
                    const toFsPath = (value) => {
                        if (!value || typeof value !== "string") return "";
                        if (value.startsWith("file://")) {
                            try {
                                return fileURLToPath(value);
                            } catch (_) {
                                if (process.platform === "win32") {
                                    return value.replace("file:///", "").replace(/\//g, path.sep);
                                }
                                return value.replace("file://", "").replace(/\//g, path.sep);
                            }
                        }
                        return value;
                    };
                    const candidateRoots = [];
                    const addCandidateRoot = (value) => {
                        const normalized = normalizeRoot(value);
                        if (!normalized) return;
                        if (!candidateRoots.includes(normalized)) {
                            candidateRoots.push(normalized);
                        }
                    };

                    addCandidateRoot(runningLocally);
                    try {
                        const storedLocalSource = store.get("localSourcePath");
                        addCandidateRoot(storedLocalSource);
                    } catch (_) { }

                    const loadedSourceTexts = [];
                    const sourceLoadFailures = [];

                    for (const sourceValue of selectedSourceFiles) {
                        const rawCandidates = [];
                        const pushRawCandidate = (raw) => {
                            if (!raw || typeof raw !== "string") return;
                            if (!rawCandidates.includes(raw)) {
                                rawCandidates.push(raw);
                            }
                        };

                        if (/^(file:\/\/|[A-Za-z]:[\\/]|\/)/.test(sourceValue)) {
                            pushRawCandidate(sourceValue);
                        }
                        for (const root of candidateRoots) {
                            const rootWithoutTrailing = root.replace(/[\\/]+$/, "");
                            if (sourceValue.includes(rootWithoutTrailing)) {
                                pushRawCandidate(sourceValue);
                            } else {
                                pushRawCandidate(root + sourceValue.replace(/^\.?\//, ""));
                            }
                        }
                        if (!rawCandidates.length) {
                            pushRawCandidate(sourceValue);
                        }

                        let jsSource = "";
                        const attemptedPaths = [];
                        for (const rawCandidate of rawCandidates) {
                            const fsCandidate = toFsPath(rawCandidate);
                            if (!fsCandidate) continue;
                            attemptedPaths.push(fsCandidate);
                            if (fs.existsSync(fsCandidate)) {
                                jsSource = fsCandidate;
                                break;
                            }
                        }
                        if (!jsSource && attemptedPaths.length) {
                            jsSource = attemptedPaths[0];
                        }

                        log("jsSource: " + jsSource);
                        try {
                            const text = fs.readFileSync(jsSource, "utf8");
                            if (text) {
                                loadedSourceTexts.push({ path: sourceValue, text });
                            } else {
                                sourceLoadFailures.push({ path: sourceValue, message: "Empty script file", attemptedPaths });
                            }
                        } catch (e) {
                            sourceLoadFailures.push({
                                path: sourceValue,
                                message: e && e.message ? e.message : String(e),
                                attemptedPaths
                            });
                            console.error(`[Injection] Failed to load local source ${sourceValue}:`, e);
                        }
                    }

                    if (loadedSourceTexts.length) {
                        sourceInjectionHandled = true;
                        const text = loadedSourceTexts.map((entry) => entry.text).join("\n\n");
                        if (sourceLoadFailures.length) {
                            console.warn("[Injection] Continuing after local source load failures:", sourceLoadFailures);
                        }
                        runWithWebContents("Script injection", (wc) => {
                            // Removed empty console-message handler to allow console logs to flow through

                            var code =
                                `
								// Get the random flag from contextBridge if available
								var __ssappInjectedScriptFlag = window.ninjafy?.getInjectedScriptFlag?.() || '` + INJECTED_SCRIPT_FLAG + `';
								window.__SSAPP_TAB_ID__ = ${view.tabID};
								var __SSAPP_MESSAGE_TARGET__ = window;
								try {
									if (window.top && window.top !== window) {
										__SSAPP_MESSAGE_TARGET__ = window.top;
									}
								} catch(_) {}
								// Per-tab reply-only mode (disable capture forwarding)
								var __SSAPP_REPLY_ONLY__ = ${args.replyOnly ? 'true' : 'false'};
								
								// Create a more complete chrome.runtime mock
								chrome.runtime = {};
								chrome.runtime.id = 1;
								chrome.runtime.getURL = function(path) {
									// Return a placeholder
									return 'electron-inject:' + path;
								};
								chrome.runtime.onMessage = {};
								chrome.runtime.onMessage.addListener = function(callback) {
									// Set up the callback for sendToTab messages
									function tryRegister() {
										if (window.ninjafy && window.ninjafy.exposeDoSomethingInWebApp) {
											window.ninjafy.exposeDoSomethingInWebApp(function(message, sender, sendResponse) {
												callback(message, sender, sendResponse);
											});
											return true;
										}
										return false;
									}

									// Try immediately
									if (!tryRegister()) {
										// If failed, retry a few times with delays
										let retries = 0;
										const maxRetries = 10;
										const retryInterval = setInterval(() => {
											retries++;
											if (tryRegister() || retries >= maxRetries) {
												clearInterval(retryInterval);
												if (retries >= maxRetries) {
													console.warn("Failed to register chrome.runtime.onMessage handler after " + maxRetries + " retries");
													console.warn("window.ninjafy status:", window.ninjafy);
												}
											}
										}, 100);
									}
									
									// Also listen for responses from preload script
									window.addEventListener('message', (event) => {
										if (event.data && event.data._isResponse) {
											callback(event.data, null, () => {});
										}
									});
								};
								// Use closure to hide cached settings
								(function() {
									const cachedSettings = ${JSON.stringify(cachedState)};
									
								chrome.runtime.sendMessage = function(a=null,b=null,c=null){
									// Use postMessage to communicate with preload script
									const messageData = b || a;
									
									// Handle getSettings synchronously from cached data
									if (messageData && messageData.getSettings && c) {
										c(cachedSettings);
										return;
									}

									// If reply-only, drop all non-status messages
									try {
										if (typeof __SSAPP_REPLY_ONLY__ !== 'undefined' && __SSAPP_REPLY_ONLY__) {
											if (!messageData || (!messageData.wssStatus && !messageData.youtubeWssStatus)) {
												if (typeof c === 'function') { try { c(null); } catch(_){} }
												return;
											}
										}
									} catch(_){}
									
									// For other messages, check if we can use ninjafy.sendMessage first
									if (window.ninjafy && window.ninjafy.sendMessage) {
										window.ninjafy.sendMessage(null, messageData, c, window.__SSAPP_TAB_ID__);
									} else {
										// Fallback to postMessage
										const outgoingMessage = {
											...messageData
										};
										outgoingMessage[__ssappInjectedScriptFlag] = true;
										outgoingMessage.__tabID__ = window.__SSAPP_TAB_ID__;
										__SSAPP_MESSAGE_TARGET__.postMessage(outgoingMessage, '*');
										
										if (c && !messageData.getSettings) {
											setTimeout(() => c(null), 0);
										}
									}
								};
								})();
                                
                                // Lightweight WSS status hooks for YouTube when upstream isn't patched
                                (function(){
                                  try {
                                    var href = '' + (location && location.href);
                                    var isYT = href.indexOf('/websocket/youtube.html') !== -1 || href.indexOf('/websocket/youtube?') !== -1;
                                    if (!isYT) return;
                                    function __ss_wssNotify(status, message){
                                      try {
                                        var payload = { wssStatus: { platform: 'youtube', status: status, message: message } };
                                        if (window.chrome && window.chrome.runtime && window.chrome.runtime.id) {
                                          window.chrome.runtime.sendMessage(window.chrome.runtime.id, payload, function(){});
                                        } else if (window.ninjafy && window.ninjafy.sendMessage) {
                                          window.ninjafy.sendMessage(null, payload, null, window.__SSAPP_TAB_ID__);
                                        } else {
                                          var data = Object.assign({}, payload);
                                          data.__tabID__ = window.__SSAPP_TAB_ID__;
                                          __SSAPP_MESSAGE_TARGET__.postMessage(data, '*');
                                        }
                                      } catch(e){}
                                    }
                                    (function(){
                                      try {
                                        function __ss_hasActiveYouTubeOAuthState(){
                                          try { if (sessionStorage.getItem('youtubeOAuthState')) return true; } catch(_){ }
                                          var storedState = '';
                                          try { storedState = localStorage.getItem('youtubeOAuthState') || ''; } catch(_){ }
                                          if (!storedState) return false;
                                          try {
                                            var params = new URLSearchParams(location.search || '');
                                            var callbackState = params.get('state') || '';
                                            if (params.has('code') && callbackState && callbackState === storedState) return true;
                                          } catch(_){ }
                                          try { localStorage.removeItem('youtubeOAuthState'); } catch(_){ }
                                          return false;
                                        }
                                        var hasToken = false;
                                        var hasRefreshToken = false;
                                        var hasPendingAuth = false;
                                        try { hasToken = !!localStorage.getItem('youtubeOAuthToken'); } catch(_){ }
                                        try { hasRefreshToken = !!localStorage.getItem('youtubeRefreshToken'); } catch(_){ }
                                        hasPendingAuth = __ss_hasActiveYouTubeOAuthState();
                                        if (!hasToken && !hasRefreshToken && !hasPendingAuth) __ss_wssNotify('signin_required','Sign in with YouTube to continue');
                                      } catch(_){ }
                                    })();
                                    (function(){
                                      try {
                                        var prev = null;
                                        setInterval(function(){
                                          try {
                                            var cur = (typeof window.liveChatId !== 'undefined') ? window.liveChatId : null;
                                            if (cur && !prev) __ss_wssNotify('connected','Connected to YouTube live chat');
                                            if (!cur && prev) __ss_wssNotify('disconnected','Disconnected from YouTube live chat');
                                            prev = cur;
                                          } catch(_){ }
                                        }, 1500);
                                      } catch(_){ }
                                    })();
                                    (function(){
                                      try {
                                        if (window.__ss_fetch_patched__) return; window.__ss_fetch_patched__ = true;
                                        var _orig = window.fetch;
                                        if (typeof _orig !== 'function') return;
                                        var lastAt = 0; var throttle = 3000; var hadError = false;
                                        var ping = function(status, msg){ hadError = true; var now = Date.now(); if (now - lastAt > throttle) { __ss_wssNotify('error', msg || ('YouTube API error: ' + status)); lastAt = now; } };
                                        window.fetch = async function(input, init){
                                          try {
                                            var res = await _orig(input, init);
                                            var url = (typeof input === 'string') ? input : (input && input.url) || '';
                                            if (url.indexOf('googleapis.com/youtube') !== -1 || url.indexOf('youtube.googleapis.com') !== -1){
                                              if (!res.ok){
                                                var msg = 'YouTube API ' + res.status;
                                                try {
                                                  var body = await res.clone().json().catch(function(){ return null; });
                                                  if (body && body.error){
                                                    var emsg = body.error.message || '';
                                                    var reason = (body.error.errors && body.error.errors[0] && body.error.errors[0].reason) || '';
                                                    if (emsg) msg = emsg;
                                                    if (reason) msg += ' (' + reason + ')';
                                                  }
                                                } catch(_){ }
                                                ping(res.status, msg);
                                              } else if (hadError) {
                                                hadError = false;
                                                __ss_wssNotify('connected', 'YouTube API recovered');
                                              }
                                            }
                                            return res;
                                          } catch(e){ ping('network_error', e && e.message ? e.message : 'Network error'); throw e; }
                                        };
                                      } catch(_){ }
                                    })();
                                  } catch(_){ }
                                })();

                                try {
                                    ` + text + `
                                } catch(err) {
                                    try {
                                        throw { name: err.name, message: err.message, stack: err.stack }
                                    } catch(e){}
                                }
                                `;

                            setAllFrameInjectionCode(wc, code);
                            if (!shouldInjectMainFrame(wc)) {
                                logManifestMainFrameSkip(wc);
                                return;
                            }
                            // Inject into main world (worldId: 0) to access contextBridge APIs
                            wc.executeJavaScriptInIsolatedWorld(0, [{ code }])
                                .then(() => {
                                    log("Script injection completed successfully in main world");
                                })
                                .catch(whenDestroyedReject("Script injection"));
                        });
                    } else if (sourceLoadFailures.length) {
                        const failureDetails = sourceLoadFailures.map((entry) => {
                            const tried = Array.isArray(entry.attemptedPaths) && entry.attemptedPaths.length
                                ? `\nTried:\n${entry.attemptedPaths.join("\n")}`
                                : "";
                            return `${entry.path}: ${entry.message}${tried}`;
                        }).join("\n\n");
                        console.warn("[Injection] Local Social Stream source failed. Falling back to remote/bundled scripts:", failureDetails);
                        clearSavedLocalSourcePath("Local Social Stream source files were missing. Retrying with online/packaged scripts.", runningLocally);
                    }
                }
                if (!sourceInjectionHandled && selectedSourceFiles.length) {
                    sourceInjectionHandled = true;
                    (async () => {
                        try {
                            const branch = normalizeSocialStreamBranch(
                                (typeof args.assetBranch === 'string' && args.assetBranch.trim())
                                    ? args.assetBranch
                                    : (isBetaMode ? 'beta' : 'main')
                            );
                            const loadedSourceTexts = [];
                            const sourceLoadFailures = [];

                            for (const sourceValue of selectedSourceFiles) {
                                try {
                                    const isUrlSource = isAbsoluteScriptUrl(sourceValue);
                                    const relativeSource = extractSocialStreamRelativePath(sourceValue) || '';
                                    const remoteSourcePath = (relativeSource || sourceValue).replace(/\\/g, '/');
                                    const jsSource = isUrlSource ? sourceValue : `https://raw.githubusercontent.com/steveseguin/social_stream/${branch}/${remoteSourcePath}`;

                                    log(jsSource);

                                    const { text, origin, meta } = await loadSocialStreamSource(jsSource, {
                                        branch,
                                        relativePath: relativeSource,
                                        timeoutMs: SOCIAL_STREAM_REMOTE_TIMEOUT_MS
                                    });

                                    if (origin === 'cache') {
                                        const reason = meta && meta.reason ? meta.reason : 'remote fetch unavailable';
                                        console.warn(`Using cached Social Stream scripts for ${relativeSource || jsSource}: ${reason}`);
                                        queueInjectorToast('warning', 'Classic Mode Fallback', `Using cached Social Stream scripts (${reason}).`);
                                    } else if (origin === 'fallback') {
                                        const reason = meta && meta.reason ? meta.reason : 'remote fetch unavailable';
                                        console.warn(`Using bundled Social Stream scripts for ${relativeSource || jsSource}: ${reason}`);
                                        queueInjectorToast('warning', 'Classic Mode Fallback', `Using bundled Social Stream scripts (${reason}).`);
                                    }

                                    loadedSourceTexts.push({ path: sourceValue, text });
                                } catch (loadError) {
                                    sourceLoadFailures.push({
                                        path: sourceValue,
                                        message: loadError && loadError.message ? loadError.message : String(loadError)
                                    });
                                    console.error(`[Injection] Failed to load remote source ${sourceValue}:`, loadError);
                                }
                            }

                            if (!loadedSourceTexts.length) {
                                throw new Error(sourceLoadFailures.map((entry) => `${entry.path}: ${entry.message}`).join("\n"));
                            }

                            try {
                                const text = loadedSourceTexts.map((entry) => entry.text).join("\n\n");
                                if (sourceLoadFailures.length) {
                                    console.warn("[Injection] Continuing after remote source load failures:", sourceLoadFailures);
                                }
                                runWithWebContents("Remote script injection", (wc) => {
                                    // Removed empty console-message handler to allow console logs to flow through

                                    var code =
                                        `
										// Debug window.ninjafy availability
										console.log("[Injection Remote] window.ninjafy:", window.ninjafy);
										console.log("[Injection Remote] window.ninjafy._authToken:", window.ninjafy?._authToken);
                                            
                                            // Get the random flag from contextBridge if available
										var __ssappInjectedScriptFlag = window.ninjafy?.getInjectedScriptFlag?.() || '` + INJECTED_SCRIPT_FLAG + `';
										window.__SSAPP_TAB_ID__ = ${view.tabID};
										var __SSAPP_MESSAGE_TARGET__ = window;
										try {
											if (window.top && window.top !== window) {
												__SSAPP_MESSAGE_TARGET__ = window.top;
											}
										} catch(_) {}
										var __SSAPP_REPLY_ONLY__ = ${args.replyOnly ? 'true' : 'false'};
										
										chrome.runtime = {};
										chrome.runtime.id = 1;
										chrome.runtime.getURL = function(path) {
											return 'electron-inject:' + path;
										};
										chrome.runtime.onMessage = {};
										chrome.runtime.onMessage.addListener = function(callback) {
											// Set up the callback for sendToTab messages
											function tryRegister() {
												if (window.ninjafy && window.ninjafy.exposeDoSomethingInWebApp) {
													window.ninjafy.exposeDoSomethingInWebApp(function(message, sender, sendResponse) {
														// This receives messages from sendToTab
														callback(message, sender, sendResponse);
													});
													return true;
												}
												return false;
											}
											
											// Try immediately
											if (!tryRegister()) {
												// If failed, retry a few times with delays
												let retries = 0;
												const maxRetries = 10;
												const retryInterval = setInterval(() => {
													retries++;
													if (tryRegister() || retries >= maxRetries) {
														clearInterval(retryInterval);
														if (retries >= maxRetries) {
															//console.warn("Failed to register chrome.runtime.onMessage handler after " + maxRetries + " retries");
														}
													}
												}, 100);
											}
											
											// Also listen for responses from preload script
											window.addEventListener('message', (event) => {
												if (event.data && event.data._isResponse) {
													callback(event.data, null, () => {});
												}
											});
										};
                                            // Use closure to hide cached settings
                                            (function() {
											const cachedSettings = ${JSON.stringify(cachedState)};
											
											chrome.runtime.sendMessage = function(a=null,b=null,c=null){
												// Use postMessage to communicate with preload script
												const messageData = b || a;
												
												// Handle getSettings synchronously from cached data
												if (messageData && messageData.getSettings && c) {
													c(cachedSettings);
													return;
												}
												try {
													if (typeof __SSAPP_REPLY_ONLY__ !== 'undefined' && __SSAPP_REPLY_ONLY__) {
														if (!messageData || (!messageData.wssStatus && !messageData.youtubeWssStatus)) {
															if (typeof c === 'function') { try { c(null); } catch(_){} }
															return;
														}
													}
												} catch(_){}
											
											// For other messages, check if we can use ninjafy.sendMessage first
											if (window.ninjafy && window.ninjafy.sendMessage) {
												window.ninjafy.sendMessage(null, messageData, c, window.__SSAPP_TAB_ID__);
											} else {
												// Fallback to postMessage
												const outgoingMessage = {
													...messageData
												};
												outgoingMessage[__ssappInjectedScriptFlag] = true;
												outgoingMessage.__tabID__ = window.__SSAPP_TAB_ID__;
												__SSAPP_MESSAGE_TARGET__.postMessage(outgoingMessage, '*');
												
												if (c && !messageData.getSettings) {
													setTimeout(() => c(null), 0);
												}
											}
										};
										})();
										new Promise((resolve, reject) => {
										   try {
											  ` + text + `
										   } catch(err) {
											  throw { name: err.name, message: err.message, stack: err.stack }
										   }
                                            })
                                            
                                            // Lightweight WSS status hooks for YouTube when upstream isn't patched
                                            ;(function(){
                                              try {
                                                var href = '' + (location && location.href);
                                                var isYT = href.indexOf('/websocket/youtube.html') !== -1 || href.indexOf('/websocket/youtube?') !== -1;
                                                if (!isYT) return;
                                                function __ss_wssNotify(status, message){
                                                  try {
                                                    var payload = { wssStatus: { platform: 'youtube', status: status, message: message } };
                                                    if (window.chrome && window.chrome.runtime && window.chrome.runtime.id) {
                                                      window.chrome.runtime.sendMessage(window.chrome.runtime.id, payload, function(){});
                                                    } else if (window.ninjafy && window.ninjafy.sendMessage) {
                                                      window.ninjafy.sendMessage(null, payload, null, window.__SSAPP_TAB_ID__);
                                                    } else {
                                                      var data = Object.assign({}, payload);
                                                      data.__tabID__ = window.__SSAPP_TAB_ID__;
                                                      __SSAPP_MESSAGE_TARGET__.postMessage(data, '*');
                                                    }
                                                  } catch(e){}
                                                }
                                                (function(){
                                                  try {
                                                    function __ss_hasActiveYouTubeOAuthState(){
                                                      try{ if (sessionStorage.getItem('youtubeOAuthState')) return true; } catch(_){ }
                                                      var storedState = '';
                                                      try{ storedState = localStorage.getItem('youtubeOAuthState') || ''; } catch(_){ }
                                                      if (!storedState) return false;
                                                      try {
                                                        var params = new URLSearchParams(location.search || '');
                                                        var callbackState = params.get('state') || '';
                                                        if (params.has('code') && callbackState && callbackState === storedState) return true;
                                                      } catch(_){ }
                                                      try{ localStorage.removeItem('youtubeOAuthState'); } catch(_){ }
                                                      return false;
                                                    }
                                                    var hasToken=false, hasRefreshToken=false, hasPendingAuth=false;
                                                    try{ hasToken = !!localStorage.getItem('youtubeOAuthToken'); } catch(_){ }
                                                    try{ hasRefreshToken = !!localStorage.getItem('youtubeRefreshToken'); } catch(_){ }
                                                    hasPendingAuth = __ss_hasActiveYouTubeOAuthState();
                                                    if (!hasToken && !hasRefreshToken && !hasPendingAuth) __ss_wssNotify('signin_required','Sign in with YouTube to continue');
                                                  } catch(_){ }
                                                })();
                                                (function(){
                                                  try {
                                                    var prev = null;
                                                    setInterval(function(){
                                                      try {
                                                        var cur = (typeof window.liveChatId !== 'undefined') ? window.liveChatId : null;
                                                        if (cur && !prev) __ss_wssNotify('connected','Connected to YouTube live chat');
                                                        if (!cur && prev) __ss_wssNotify('disconnected','Disconnected from YouTube live chat');
                                                        prev = cur;
                                                      } catch(_){ }
                                                    }, 1500);
                                                  } catch(_){ }
                                                })();
                                                (function(){
                                                  try {
                                                    if (window.__ss_fetch_patched__) return; window.__ss_fetch_patched__ = true;
                                                    var _orig = window.fetch; if (typeof _orig !== 'function') return;
                                                    var lastAt=0, throttle=3000, hadError=false;
                                                    var ping=function(status,msg){ hadError=true; var now=Date.now(); if (now-lastAt>throttle){ __ss_wssNotify('error', msg || ('YouTube API error: ' + status)); lastAt=now; } };
                                                    window.fetch = async function(input, init){
                                                      try {
                                                        var res = await _orig(input, init);
                                                        var url = (typeof input === 'string') ? input : (input && input.url) || '';
                                                        if (url.indexOf('googleapis.com/youtube') !== -1 || url.indexOf('youtube.googleapis.com') !== -1){
                                                          if (!res.ok){
                                                            var msg = 'YouTube API ' + res.status;
                                                            try {
                                                              var body = await res.clone().json().catch(function(){ return null; });
                                                              if (body && body.error){
                                                                var emsg = body.error.message || '';
                                                                var reason = (body.error.errors && body.error.errors[0] && body.error.errors[0].reason) || '';
                                                                if (emsg) msg = emsg; if (reason) msg += ' (' + reason + ')';
                                                              }
                                                            } catch(_){ }
                                                            ping(res.status, msg);
                                                          } else if (hadError) {
                                                            hadError = false;
                                                            __ss_wssNotify('connected', 'YouTube API recovered');
                                                          }
                                                        }
                                                        return res;
                                                      } catch(e){ ping('network_error', e && e.message ? e.message : 'Network error'); throw e; }
                                                    };
                                                  } catch(_){ }
                                                })();
                                              } catch(_){ }
                                            })();
                                            `;

                                    setAllFrameInjectionCode(wc, code);
                                    if (!shouldInjectMainFrame(wc)) {
                                        logManifestMainFrameSkip(wc);
                                        return;
                                    }
                                    // Inject into main world (worldId: 0) to access contextBridge APIs
                                    wc.executeJavaScriptInIsolatedWorld(0, [{ code }])
                                        .catch(whenDestroyedReject("Remote script injection"));
                                });
                            } catch (e) {
                                let options = {
                                    title: "Could not inject required code.",
                                    buttons: ["OK"],
                                    message: "An error occured parsing or injecting the required js script.",
                                };
                                if (appDialogService?.isArmed()) void dialog.showMessageBox(options);
                                else dialog.showMessageBoxSync(options);
                                console.error(e);
                            }
                        } catch (e) {
                            console.error('Failed to load Social Stream injector:', e);
                            queueInjectorToast('error', 'Classic Mode Failed', `Could not load Social Stream scripts (${e && e.message ? e.message : 'unknown error'}).`);
                            try {
                                const options = {
                                    title: "Site not supported or injection script not found",
                                    buttons: ["OK"],
                                    message: `${selectedSourceFiles.join("\n")}\n\n${e && e.message ? e.message : "Unable to load Social Stream scripts"}\n\njoin the Discord for support: \nhttps://discord.socialstream.ninja`,
                                };
                                if (appDialogService?.isArmed()) void dialog.showMessageBox(options);
                                else dialog.showMessageBoxSync(options);
                            } catch (dialogError) {
                                console.error('Failed to show injector error dialog:', dialogError);
                            }
                        }
                    })();
                }
                if (!sourceInjectionHandled) {
                    var code =
                        `
					// Get the random flag from contextBridge if available
					var __ssappInjectedScriptFlag = window.ninjafy?.getInjectedScriptFlag?.() || '` + INJECTED_SCRIPT_FLAG + `';
					window.__SSAPP_TAB_ID__ = ${view.tabID};
					var __SSAPP_MESSAGE_TARGET__ = window;
					try {
						if (window.top && window.top !== window) {
							__SSAPP_MESSAGE_TARGET__ = window.top;
						}
					} catch(_) {}
					// Per-tab reply-only mode
					var __SSAPP_REPLY_ONLY__ = ${args.replyOnly ? 'true' : 'false'};
					
					chrome.runtime = {};
					chrome.runtime.id = 1;
					chrome.runtime.getURL = function(path) {
						return 'electron-inject:' + path;
					};
					chrome.runtime.onMessage = {};
					chrome.runtime.onMessage.addListener = function(callback) {
						// Listen for responses from preload script
						window.addEventListener('message', (event) => {
							if (event.data && event.data._isResponse) {
								callback(event.data, null, () => {});
							}
						});
					};
					chrome.runtime.sendMessage = function(a=null,b=null,c=null){
						// Use postMessage to communicate with preload script
						const messageData = b || a;
						// If reply-only, drop non-status messages
						try {
							if (typeof __SSAPP_REPLY_ONLY__ !== 'undefined' && __SSAPP_REPLY_ONLY__) {
								if (!messageData || (!messageData.wssStatus && !messageData.youtubeWssStatus)) {
									if (typeof c === 'function') { try { c(null); } catch(_){} }
									return;
								}
							}
						} catch(_){}
						const outgoingMessage = {
							...messageData
						};
						outgoingMessage[__ssappInjectedScriptFlag] = true;
						outgoingMessage.__tabID__ = window.__SSAPP_TAB_ID__;
						__SSAPP_MESSAGE_TARGET__.postMessage(outgoingMessage, '*');
						
						// Handle callback if provided
						if (typeof c === 'function') {
							// Simple callback with empty response for now
							setTimeout(() => c({}), 0);
						}
					};
                    `;
                    runWithWebContents("Default script injection", (wc) => {
                        setAllFrameInjectionCode(wc, code);
                        if (!shouldInjectMainFrame(wc)) {
                            logManifestMainFrameSkip(wc);
                            return;
                        }
                        // Inject into main world (worldId: 0) to access contextBridge APIs
                        wc.executeJavaScriptInIsolatedWorld(0, [{ code }]);
                    });
                }
                // Set mute state based on args
                runWithWebContents("Applying mute state", (wc) => {
                    if ("muted" in args) {
                        log(`Setting audio muted to: ${args.muted}`);
                        wc.setAudioMuted(args.muted);
                        if (args.muted && typeof wc.send === "function") {
                            wc.send("sendToTab", {
                                muteWindow: true
                            });
                        }
                    } else {
                        log("No muted arg, defaulting to muted=true");
                        wc.setAudioMuted(true);
                        if (typeof wc.send === "function") {
                            wc.send("sendToTab", {
                                muteWindow: true
                            });
                        }
                    }
                });
            }
            // Preserve the logical visibility decided during window creation.
            if (view.__ss_visible === false) {
                try { view.setSkipTaskbar(true); } catch (_) { }
                const reparkHiddenWindow = () => {
                    try {
                        if (!isBrowserViewDestroyed(view) && view.__ss_visible === false) {
                            stealthHideView(view);
                        }
                    } catch (_) { }
                };
                setTimeout(reparkHiddenWindow, 0);
                setTimeout(reparkHiddenWindow, 250);
            } else {
                view.__ss_visible = true;
                try { view.setSkipTaskbar(false); } catch (_) { }
            }
            eventRet.returnValue = view.tabID;
            log(`Window created successfully with ID: ${view.tabID}`);
        } catch (e) {
            log(e);
            eventRet.returnValue = null;
        }
    };

    // Register the sync handler for backward compatibility
    ipcMain.on("createWindow", originalCreateWindowHandler);
    // Also expose it at module scope so diagnostics can build a source window through the
    // same path the renderer uses.
    sourceWindowCreateHandler = originalCreateWindowHandler;

    ipcMain.on("getVersion", function (eventRet) {
        eventRet.returnValue = app.getVersion();
    });

    // TikTok handlers moved to top level

    /* ipcMain.on('inject', function(eventRet,args) {
        const view = browserViews[args.vid];
        log("https://raw.githubusercontent.com/steveseguin/social_stream/main/"+args.source);
        fetch("https://raw.githubusercontent.com/steveseguin/social_stream/main/"+args.source).then((response) => response.text()).then(text=>{
            try {
                view.webContents.on("console-message", async (event, level, message,line, sourceId) => {
                    log(message);
                });
            	
            } catch(e){
                log(e);
            }
        });
        eventRet.returnValue = args.vid || null;
    }); */

    ipcMain.on("reloadWindow", function (eventRet, args) {
        try {
            const byVid = getActiveBrowserView(args.vid);
            if (byVid && byVid.webContents) {
                byVid.webContents.reload();
            } else if (args.tab) {
                const byTab = getActiveBrowserView(args.tab);
                if (byTab && byTab.webContents) {
                    byTab.webContents.reload();
                }
            }
            eventRet.returnValue = true;
        } catch (e) {
            eventRet.returnValue = false;
        }
    });

    ipcMain.on("closeWindow", function (eventRet, args) {
        log("close window: " + args.vid);
        try {
            const view = browserViews[args.vid];
            if (!view) {
                eventRet.returnValue = false;
                return;
            }

            if (view.isTikTokVirtual) {
                const wssID = view.wssID;
                if (wssID !== undefined) {
                    cleanupConnection(wssID);
                } else {
                    delete browserViews[args.vid];
                }
                eventRet.returnValue = true;
                return;
            }

            if (view.webContents && typeof view.webContents.removeAllListeners === 'function') {
                view.webContents.removeAllListeners();
            }

            const tabID = view.tabID;

            if (typeof view.close === 'function') {
                try { view.close(); } catch (closeErr) { console.warn('Error closing view:', closeErr); }
            }
            if (typeof view.destroy === 'function') {
                try { view.destroy(); } catch (destroyErr) { console.warn('Error destroying view:', destroyErr); }
            }

            delete browserViews[args.vid];

            if (tabID) {
                releaseWindowId(tabID);
            }

            eventRet.returnValue = true;
        } catch (e) {
            console.error('closeWindow handler error:', e);
            eventRet.returnValue = false;
        }
    });

    function getTLD(url) {
        try {
            const parsedUrl = new URL(url);
            if (parsedUrl.protocol === "file:") {
                return "file://";
            }
            const hostParts = parsedUrl.hostname.split(".");
            return hostParts.length > 2 ? hostParts.slice(-2).join(".") : parsedUrl.hostname;
        } catch (error) {
            console.error("Error parsing URL:", error);
            return null;
        }
    }

    function clearCacheForDomainSession(url) {
        const domain = getPrimaryDomain(url);
        const sess = getOrCreatePersistentSession(domain);
        sess.clearCache().then(() => {
            log(`Cache cleared for ${domain} of this session`);
        });
    }

    ipcMain.handle('clearWindowCache', async (event, windowId) => {
        try {

            const view = browserViews[windowId];
            if (!view || !view.webContents) {
                console.error(`No view found for window ID ${windowId}`);
                return {
                    success: false,
                    error: 'No view found'
                };
            }

            // Clear all possible data for the specific domain
            const result = await clearDataForDomain(view.webContents);

            // Add a delay before reloading
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay

            // Force reload ignoring cache
            view.webContents.reloadIgnoringCache();

            return {
                success: result,
                error: null
            };
        } catch (error) {
            console.error('Error in clearWindowCache:', error);
            return {
                success: false,
                error: error.message
            };
        }
    });

    async function clearDataForDomain(webContentsInstance) {
        const ses = webContentsInstance.session;
        try {
            const url = webContentsInstance.getURL();
            const {
                protocol,
                hostname
            } = new URL(url);
            log(`Starting to clear data for: ${url}`);

            // Get the base domain (e.g., 'youtube.com' from 'www.youtube.com')
            const baseDomain = hostname.split('.').slice(-2).join('.');

            // Clear all storage types for the specific domain and its subdomains
            await ses.clearStorageData({
                origin: `${protocol}//*.${baseDomain}`,
                storages: [
                    'appcache',
                    'cookies',
                    'filesystem',
                    'indexdb',
                    'localstorage',
                    'shadercache',
                    'websql',
                    'serviceworkers',
                    'cachestorage',
                ],
            });
            log('Domain-specific storage cleared');

            // Clear cookies for the specific domain and its subdomains
            const cookies = await ses.cookies.get({
                domain: baseDomain
            });
            for (const cookie of cookies) {
                await ses.cookies.remove(`${protocol}//${cookie.domain}`, cookie.name);
            }
            log('Domain-specific cookies cleared');

            // Inject JavaScript to clear client-side storage
            await webContentsInstance.executeJavaScript(`
		  // Clear localStorage and sessionStorage
		  localStorage.clear();
		  sessionStorage.clear();
		  
		  // Clear cookies (limited to those accessible by JavaScript)
		  document.cookie.split(";").forEach(function(c) { 
			document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/"); 
		  });
		  
		  // Clear IndexedDB
		  if (window.indexedDB) {
			indexedDB.databases().then(dbs => {
			  dbs.forEach(db => indexedDB.deleteDatabase(db.name));
			});
		  }
		  
		  // Clear Cache Storage
		  if (window.caches) {
			caches.keys().then(names => {
			  names.forEach(name => caches.delete(name));
			});
		  }
		  
		  // Unregister Service Workers
		  if (navigator.serviceWorker) {
			navigator.serviceWorker.getRegistrations().then(registrations => {
			  registrations.forEach(registration => registration.unregister());
			});
		  }

		  console.log('Client-side storage and accessible cookies cleared');
		`);
            log('Client-side storage cleared');

            // Clear cache for the specific domain
            await ses.clearCache({
                origin: `${protocol}//*.${baseDomain}`
            });
            log('Domain-specific cache cleared');

            // Clear auth cache for the specific domain and its subdomains
            if (typeof ses.clearAuthCache === 'function') {
                await ses.clearAuthCache({
                    type: 'password',
                    origin: `${protocol}//*.${baseDomain}`
                });
                log('Domain-specific auth cache cleared');
            }
            try {
                clearCacheForDomainSession(url)
            } catch (e) {
                console.error(e);
            }

            log(`All possible data cleared for ${baseDomain} and its subdomains`);
            return true;
        } catch (error) {
            console.error(`Error clearing data:`, error);
            return false;
        }
    }


    ipcMain.on("clearAllCache", async () => {
        try {
            return await clearAllData([URI]);
        } catch (error) {
            log(error);
        }
    });

    // i need to have the injected code be made aware it shoudl stop video; on window create. figure out how
    //  need to save the state of mute and visibility, so remembers on page load.  should be muted by default?

    ipcMain.on("muteWindow", function (eventRet, args) {
        try {
            log("muteWindow 1");
            const view = getActiveBrowserView(args.vid);
            if (view && view.webContents) {
                try {
                    view.webContents.setAudioMuted(!!args.muteWindow);
                    view.webContents.send("sendToTab", {
                        muteWindow: !!args.muteWindow
                    });
                    eventRet.returnValue = true;
                } catch (error) {
                    console.error('muteWindow send failed:', error);
                    eventRet.returnValue = false;
                }
            } else {
                eventRet.returnValue = false;
            }
        } catch (e) {
            eventRet.returnValue = false;
        }
    });

    // Async handler for messages that need responses
    ipcMain.handle("sendToTab-async", async (event, args) => {
        log("sendToTab-async");
        const view = getActiveBrowserView(args.tab);
        if (view && view.webContents) {
            return new Promise((resolve) => {
                const requestId = `${Date.now()}-${Math.random()}`;

                const timeoutId = setTimeout(() => {
                    ipcMain.removeAllListeners(`sendToTab-response-${requestId}`);
                    resolve(false);
                }, 5000);

                ipcMain.once(`sendToTab-response-${requestId}`, (_evt, response) => {
                    clearTimeout(timeoutId);
                    log(`sendToTab-async response for ${args.message}: ${response}`);
                    resolve(response);
                });

                try {
                    view.webContents.send("sendToTab-request", {
                        message: args.message,
                        requestId
                    });
                } catch (error) {
                    console.error('sendToTab-async send failed:', error);
                    clearTimeout(timeoutId);
                    ipcMain.removeAllListeners(`sendToTab-response-${requestId}`);
                    resolve(false);
                }
            });
        }
        return false;
    });

    // Performance monitoring IPC handlers
    ipcMain.handle('getPerformanceMetrics', async () => {
        try {
            const metrics = {
                cpu: 0,
                memory: process.memoryUsage().heapUsed,
                memoryPercent: 0,
                windows: []
            };

            // Get total system memory
            const totalMem = require('os').totalmem();
            metrics.memoryPercent = (metrics.memory / totalMem) * 100;

            // Get CPU usage (averaged over 1 second)
            const startUsage = process.cpuUsage();
            await new Promise(resolve => setTimeout(resolve, 100));
            const endUsage = process.cpuUsage(startUsage);
            const totalCPUTime = (endUsage.user + endUsage.system) / 1000; // microseconds to milliseconds
            metrics.cpu = (totalCPUTime / 100) * 100; // percentage over 100ms

            // Collect metrics for each window/tab
            for (const [id, view] of Object.entries(browserViews)) {
                if (view && view.webContents && !isBrowserViewDestroyed(view)) {
                    try {
                        const wcMetrics = await view.webContents.executeJavaScript(`
                            ({
                                memory: performance.memory ? performance.memory.usedJSHeapSize : 0,
                                title: document.title,
                                url: window.location.href
                            })
                        `).catch(() => ({ memory: 0, title: 'Unknown', url: '' }));

                        metrics.windows.push({
                            id: id,
                            title: wcMetrics.title || view.args?.title || 'Tab ' + id,
                            url: wcMetrics.url || view.args?.url || '',
                            memory: wcMetrics.memory || 0,
                            cpu: 0 // CPU per window is complex to measure accurately
                        });
                    } catch (e) {
                        // Window might be loading or destroyed
                    }
                }
            }

            return metrics;
        } catch (error) {
            console.error('Error getting performance metrics:', error);
            return {
                cpu: 0,
                memory: 0,
                memoryPercent: 0,
                windows: []
            };
        }
    });

    // Original synchronous handler for backward compatibility
    ipcMain.on("sendToTab", function (eventRet, args) {
        // log("sendToTab 1");
        const tabId = args.tab || args.tabID;
        const message = args.message || args;

        const view = getActiveBrowserView(tabId);
        if (view && view.webContents) {
            try {
                view.webContents.send("sendToTab", message);
                eventRet.returnValue = true;
            } catch (error) {
                console.error('sendToTab send failed:', error);
                eventRet.returnValue = false;
            }
        } else {
            eventRet.returnValue = false;
        }
    });

    ipcMain.on("getTabs", function (eventRet, args) {
        var keys = Object.keys(browserViews);
        var tabs = [];
        keys.forEach((key) => {
            const view = browserViews[key];
            if (!view) return;
            let url = null;
            if (view.args && view.args.url) {
                url = view.args.url;
            } else if (view.webContents && !view.webContents.isDestroyed()) {
                url = view.webContents.getURL();
            } else if (view.url) {
                url = view.url;
            }
            if (url) {
                const viewArgs = view.args || {};
                tabs.push({
                    id: parseInt(key),
                    url: url,
                    accountRole: normalizeSourceAccountRole(viewArgs.accountRole),
                    sourceId: viewArgs.sourceId || view.sourceId || null,
                    customSession: viewArgs.customSession || null
                });
            }
        });
        eventRet.returnValue = tabs;
    });

    const pendingDebuggerInputByContents = new WeakMap();

    function buildDebuggerKeyboardCommand(args) {
        if (!args || !args.type) return null;
        const command = {
            type: args.type
        };
        const allowedKeys = [
            "modifiers",
            "text",
            "unmodifiedText",
            "key",
            "code",
            "windowsVirtualKeyCode",
            "nativeVirtualKeyCode",
            "autoRepeat",
            "isKeypad",
            "isSystemKey",
            "location",
            "commands"
        ];
        allowedKeys.forEach((key) => {
            if (args[key] !== undefined) {
                command[key] = args[key];
            }
        });
        if ((args.type === "char") && (typeof args.text === "string") && args.text) {
            command.text = args.text;
            command.unmodifiedText = args.unmodifiedText !== undefined ? args.unmodifiedText : args.text;
        }
        if (!command.key && typeof args.key === "string" && args.key) {
            command.key = args.key;
        }
        return command;
    }

    function queueDebuggerInput(webContents, task) {
        const previousTask = pendingDebuggerInputByContents.get(webContents) || Promise.resolve();
        const nextTask = previousTask
            .catch(() => { })
            .then(task);
        pendingDebuggerInputByContents.set(webContents, nextTask.finally(() => {
            if (pendingDebuggerInputByContents.get(webContents) === nextTask) {
                pendingDebuggerInputByContents.delete(webContents);
            }
        }));
        return nextTask;
    }

    const debuggerDetachTimers = new WeakMap();

    function scheduleDebuggerDetach(webContents, delayMs = 3000) {
        if (!webContents.__debuggerOwnedByInput) {
            return; // Do not detach if we didn't attach it
        }
        const existing = debuggerDetachTimers.get(webContents);
        if (existing) clearTimeout(existing);
        debuggerDetachTimers.set(webContents, setTimeout(() => {
            debuggerDetachTimers.delete(webContents);
            try {
                if (webContents.debugger && webContents.debugger.isAttached()) {
                    webContents.debugger.detach();
                }
                webContents.__debuggerOwnedByInput = false;
            } catch (_) { }
        }, delayMs));
    }

    function sendDebuggerKeyboardCommand(webContents, args) {
        const command = buildDebuggerKeyboardCommand(args);
        if (!command || !webContents?.debugger) {
            return Promise.resolve(false);
        }
        return queueDebuggerInput(webContents, async () => {
            if (!webContents.debugger.isAttached()) {
                webContents.debugger.attach("1.3");
                webContents.__debuggerOwnedByInput = true;
            }
            await webContents.debugger.sendCommand("Input.dispatchKeyEvent", command);
            scheduleDebuggerDetach(webContents);
            return true;
        });
    }

    ipcMain.on("sendInputToTab", function (eventRet, args) {
        log("sendInputToTab 1");
        const view = getActiveBrowserView(args.tab);
        if (view) {

            // Check if this is a TikTok virtual tab
            if (view && view.isTikTokVirtual) {
                log("TikTok virtual tab - input received. Skipping direct sendToTikTok to avoid double-send (handled by handleDockChatSend).");
                eventRet.returnValue = true;
                return;

                /* 
                // LEGACY: This causes double-sends because handleDockChatSend also triggers.
                log("TikTok virtual tab - sending message via WebSocket");
                const text = typeof args.text === 'string' ? args.text : '';
                if (!text.trim() || view.wssID === undefined) {
                    log("TikTok virtual tab - missing text or wssID");
                    eventRet.returnValue = false;
                    return;
                }

                const manager = websocketConnections[view.wssID];
                const isConnected = !!(manager && manager.connection && manager.connection.isConnected && !manager.isStopped);
                const hasSession = !!manager?.sessionId;

                if (!manager || !isConnected || !hasSession) {
                    log(`TikTok virtual tab - connection not ready for outbound send. Manager: ${!!manager}, Connected: ${isConnected}, Session: ${hasSession}`);
                    eventRet.returnValue = false;
                    return;
                }

                sendToTikTok({
                    wssID: view.wssID,
                    message: text
                }).then(result => {
                    if (!result?.success) {
                        log(`TikTok virtual tab - outbound send failed: ${result?.error || 'unknown error'}`);
                        try {
                            if (mainWindow?.webContents) {
                                mainWindow.webContents.send('tiktokSendResult', {
                                    wssID: view.wssID,
                                    success: false,
                                    error: result?.error || 'Unknown error'
                                });
                            }
                        } catch (notifyErr) {
                            console.warn('Failed to notify renderer about TikTok send failure:', notifyErr);
                        }
                    }
                }).catch(error => {
                    console.error('TikTok virtual tab - outbound send threw:', error);
                    try {
                        if (mainWindow?.webContents) {
                            mainWindow.webContents.send('tiktokSendResult', {
                                wssID: view.wssID,
                                success: false,
                                error: error?.message || 'Failed to send TikTok message'
                            });
                        }
                    } catch (notifyErr) {
                        console.warn('Failed to notify renderer about TikTok send exception:', notifyErr);
                    }
                });

                log("Sent message to TikTok WebSocket");
                eventRet.returnValue = true;
                */
            } else if (view && view.webContents && (view.webContents.sendInputEvent || view.webContents.insertText || view.webContents.debugger)) {
                try {
                    let method = null;
                    const wc = view.webContents;

                    const cdpPromise = queueDebuggerInput(wc, async () => {
                        if (!wc.debugger.isAttached()) {
                            wc.debugger.attach("1.3");
                            wc.__debuggerOwnedByInput = true;
                        }
                        if (args.type && ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(args.type)) {
                            const { tab: _tab, ...mouseArgs } = args;
                            await wc.debugger.sendCommand("Input.dispatchMouseEvent", mouseArgs);
                        } else if (args.type) {
                            const command = buildDebuggerKeyboardCommand(args);
                            if (command) {
                                await wc.debugger.sendCommand("Input.dispatchKeyEvent", command);
                            }
                        } else if (args.text) {
                            await wc.debugger.sendCommand("Input.insertText", { text: args.text });
                            // Give React time to process the onChange from
                            // insertText before the next CDP command (Enter)
                            await new Promise(r => setTimeout(r, 100));
                        }
                        scheduleDebuggerDetach(wc);
                    });
                    cdpPromise.catch((error) => {
                        console.error("CDP command failed:", error);
                    });
                    method = args.type ? "cdp.dispatchKeyEvent" : "cdp.insertText";
                    log("ISSUED KEY EVENT");
                    eventRet.returnValue = true;
                } catch (error) {
                    console.error('sendInputToTab failed:', error);
                    eventRet.returnValue = false;
                }
            } else {
                log("ISSUED KEY EVENT failed - webContents or sendInputEvent not available");
                eventRet.returnValue = false;
            }
        } else {
            eventRet.returnValue = false;
        }
    });

    ipcMain.on("getSources", async function (eventRet, args) {
        try {
            if (mainWindow) {
                const sources = await desktopCapturer.getSources({
                    types: args.types
                });
                eventRet.returnValue = sources;
            }
        } catch (e) {
            console.error(e);
        }
    });

    /* if (mainWindow){
        const ret = globalShortcut.register('CommandOrControl+M', () => {
            log('CommandOrControl+M is pressed');
            if (mainWindow.node && mainWindow.vdonVersion){
                mainWindow.webContents.send('postMessage', {'micOld':'toggle'});
            } else if (mainWindow && mainWindow.vdonVersion) {
                mainWindow.webContents.send('postMessage', {'mic':'toggle'});
            }
        });
        if (!ret) {
            log('registration failed1')
        }
    } */

    const ret_refresh = globalShortcut.register("CommandOrControl+Shift+Alt+R", () => {
        log("CommandOrControl+Shift+Alt+R");

        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
            focusedWindow.reload();
        } else {
            const windows = BrowserWindow.getAllWindows();
            for (const win of windows) {
                win.reload();
            }
        }
    });
    if (!ret_refresh) {
        log("registration failed2");
    }

    const socialstream = globalShortcut.register("CommandOrControl+Shift+Alt+X", () => {
        log("CommandOrControl+Shift+Alt+X");

        const windows = BrowserWindow.getAllWindows();
        const hasPinnedWindow = windows.some(win => win.args?.pin);

        if (hasPinnedWindow) {
            for (const win of windows) {
                win.args.pin = false;
                win.setAlwaysOnTop(false);
            }
        } else {
            for (const win of windows) {
                win.mouseEvent = !win.mouseEvent;
                win.setIgnoreMouseEvents(win.mouseEvent);

                if (win.mouseEvent) {
                    if (process.platform == "darwin") {
                        win.setAlwaysOnTop(true, "floating", 1);
                    } else {
                        win.setAlwaysOnTop(true, "level");
                    }
                } else {
                    win.show();
                    if (!win.args?.pin) {
                        win.setAlwaysOnTop(false);
                    }
                }
            }
        }
    });
    if (!socialstream) {
        log("registration failed3");
    }

    // "CommandOrControl+Shift+X

    try {
        if (PIN == true) {
            // "floating" + 1 is higher than all regular windows, but still behind things
            // like spotlight or the screen saver
            mainWindow.setAlwaysOnTop(true, "level");
            // allows the window to show over a fullscreen window
            mainWindow.setVisibleOnAllWorkspaces(true);
        } else {
            mainWindow.setAlwaysOnTop(false);
            // allows the window to show over a fullscreen window
            mainWindow.setVisibleOnAllWorkspaces(false);
        }

        if (FULLSCREEN) {
            if (process.platform == "darwin") {
                mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
            } else {
                mainWindow.isFullScreen() ? mainWindow.setFullScreen(false) : mainWindow.setFullScreen(true);
            }
        }

        if (process.platform == "darwin") {
            try {
                // MacOS
                app.dock.hide();
            } catch (e) {
                // Windows?
            }
        }
    } catch (e) {
        console.error(e);
    }

    mainWindow.once("ready-to-show", () => {
        if (headlessControlEnabled) {
            try { mainWindow.setSkipTaskbar(true); } catch (_) { }
            return;
        }
        if (MINIMIZED) {
            mainWindow.minimize();
            //+ KravchenkoAndrey 08.01.2022
		} else if (UNCLICKABLE) {
			// Electron does not support showInactive() on Wayland. The window already ignores
			// mouse input in this mode, so showing it normally is the usable fallback there.
			if (isWaylandSession()) {
				mainWindow.show();
			} else {
				mainWindow.showInactive();
			}
			//- KravchenkoAndrey 08.01.2022
        } else {
            mainWindow.show();
        }
    });

    // Intercept in-page navigation attempts
    mainWindow.webContents.on("will-navigate", handleNavigation);

    // Intercept new window/tab attempts
    mainWindow.webContents.on("new-window", handleNavigation);

    /* session.defaultSession.webRequest.onBeforeRequest({urls: ['file://*']}, (details, callback) => { // added for added security, but doesn't seem to be working.
      if (details.referrer.startsWith("http://")){
         callback({response:{cancel:true}});
      } else if (details.referrer.startsWith("https://")){ // do not let a third party load a local resource.
          callback({response:{cancel:true}});
      } else {
          callback({response:{cancel:false}});
      }
    }); */

    /* try {
        var HTML = '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" /><style>body {padding:0;height:100%;width:100%;margin:0;}</style></head><body ><div style="-webkit-app-region: drag;height:25px;width:100%"></div></body></html>';
        await mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURI(HTML));
    } catch(e){
        console.error(e);
    } */

    try {
        log("LOAD MAIN WINDOW");
        mainWindow.loadURL(URI);
    } catch (e) {
        console.error(e);
        //quitApp();
    }
}

contextMenu({
    prepend: (defaultActions, params, browserWindow) => [{
        label: "🔙 Go Back",
        // Only show it when right-clicking text
        visible: browserWindow.webContents.navigationHistory.canGoBack(),
        click: () => {
            //var args = browserWindow.args; // reloading doesn't work otherwise
            //args.url = "https://vdo.ninja/electron?version="+ver;
            //browserWindow.destroy();
            //createWindow(args); // we close the window and open it again; a faked refresh
            //DoNotClose = false;
            browserWindow.webContents.goBack();
        },
    },
    {
        label: "♻ Reload (Ctrl+Shift+Alt+R)",
        // Only show it when right-clicking text
        visible: true,
        click: () => {
            browserWindow.reload();

            /* DoNotClose = true; // avoids fully closing the app if no other windows are open
            
            var args = browserWindow.args; // reloading doesn't work otherwise
            args.url = browserWindow.webContents.getURL();
            var title = browserWindow.getTitle();
            browserWindow.destroy();
            createWindow(args, title); // we close the window and open it again; a faked refresh
            DoNotClose = false; */
        },
    },
    /////////////
    {
        label: "🎶 Change media device",
        // Only show it when right-clicking text
        visible: false,
        type: "submenu",
        submenu: [{
            label: "🔈 Change audio destination for THIS element only",
            // Only show it when right-clicking text

            visible: params.mediaType == "video" || params.mediaType == "audio" || false,
            click: () => {
                var buttons = ["Cancel"];
                var details = [false];

                // browserWindow.inspectElement(params.x, params.y)
                browserWindow.webContents.send("postMessage", {
                    getDeviceList: true,
                    params: params
                });

                ipcMain.once("deviceList", async (event, data) => {
                    //log(data);
                    var deviceList = data.deviceInfos;

                    //data.menu = menu || false;
                    //data.eleId = ele.id || false;
                    //data.UUID = ele.dataset.UUID || false;
                    //data.deviceInfos;
                    //data.params = params;

                    for (var i = 0; i < deviceList.length; i++) {
                        if (deviceList[i].kind === "audiooutput") {
                            buttons.push(deviceList[i].label);
                            details.push(deviceList[i].deviceId);
                        }
                    }
                    let options = {
                        title: "Change audio output device",
                        buttons: buttons,
                        message: "Change audio output specifically for this media element",
                    };

                    const response = appDialogService?.isArmed()
                        ? (await dialog.showMessageBox(options)).response
                        : dialog.showMessageBoxSync(options);
                    if (response) {
                        browserWindow.webContents.send("postMessage", {
                            changeAudioOutputDevice: details[response],
                            data: data,
                        });
                    }
                });
            },
        },
        {
            label: "🔈 Change audio destination",
            // Only show it when right-clicking text

            visible: false, //browserWindow.node,
            click: () => {
                var buttons = ["Cancel"];
                var details = [false];

                // browserWindow.inspectElement(params.x, params.y)
                browserWindow.webContents.send("postMessage", {
                    getDeviceList: true,
                    params: params
                });

                ipcMain.once("deviceList", async (event, data) => {
                    log(data);
                    var deviceList = data.deviceInfos;

                    //data.menu = menu || false;
                    //data.eleId = ele.id || false;
                    //data.UUID = ele.dataset.UUID || false;
                    //data.deviceInfos;
                    //data.params = params;

                    for (var i = 0; i < deviceList.length; i++) {
                        if (deviceList[i].kind === "audiooutput") {
                            buttons.push(deviceList[i].label);
                            details.push(deviceList[i].deviceId);
                        }
                    }
                    let options = {
                        title: "Change audio output device",
                        buttons: buttons,
                        message: "Change the audio output device",
                    };

                    const response = appDialogService?.isArmed()
                        ? (await dialog.showMessageBox(options)).response
                        : dialog.showMessageBoxSync(options);
                    if (response) {
                        browserWindow.webContents.send("postMessage", {
                            changeAudioOutputDevice: details[response]
                        });
                    }
                });
            },
        },
        {
            label: "🎤 Change audio input",
            // Only show it when right-clicking text

            visible: false,
            click: () => {
                var buttons = ["Cancel"];
                var details = [false];

                browserWindow.webContents.send("postMessage", {
                    getDeviceList: true,
                    params: params
                });

                ipcMain.once("deviceList", async (event, data) => {
                    log(data);
                    var deviceList = data.deviceInfos;

                    //data.menu = menu || false;
                    //data.eleId = ele.id || false;
                    //data.UUID = ele.dataset.UUID || false;
                    //data.deviceInfos;
                    //data.params = params;

                    var deviceCounter = 0;
                    for (var i = 0; i < deviceList.length; i++) {
                        if (deviceList[i].kind === "audioinput") {
                            deviceCounter += 1;
                            buttons.push(deviceList[i].label);
                            details.push(deviceList[i].deviceId);
                        }
                    }

                    let options = {
                        title: "Change audio input device",
                        buttons: buttons,
                        message: "Change your local audio input source",
                    };

                    if (!deviceCounter) {
                        options.message = "No audio input devices available here";
                    }

                    const response = appDialogService?.isArmed()
                        ? (await dialog.showMessageBox(options)).response
                        : dialog.showMessageBoxSync(options);
                    if (response) {
                        browserWindow.webContents.send("postMessage", {
                            changeAudioDevice: details[response]
                        });
                    }
                });
            },
        },
        ],
    },
    {
        label: "🧰 Enable Chrome Extension",
        // Only show it when right-clicking text

        visible: extensions.length,
        click: async () => {
            var buttons = ["Cancel"];

            for (var i = 0; i < extensions.length; i++) {
                buttons.push(extensions[i].name);
            }
            var options = {
                title: "Choose an extension to enable",
                buttons: buttons,
                message: "Choose an extension to enable. You may need to reload the window to trigger once loaded.",
            };

            let idx = appDialogService?.isArmed()
                ? (await dialog.showMessageBox(options)).response
                : dialog.showMessageBoxSync(options);
            if (idx) {
                idx -= 1;
                //log(idx, extensions[idx].location);

                browserWindow.webContents.session.loadExtension(extensions[idx].location + "").then(({
                    id
                }) => {
                    log("loadExtension");
                });
                // extensions
            }
        },
    },
    {
        label: "🔇 Mute the window",
        type: "checkbox",
        visible: true,
        checked: browserWindow.webContents.isAudioMuted(),
        click: () => {
            if (browserWindow.webContents.isAudioMuted()) {
                browserWindow.webContents.setAudioMuted(false);
            } else {
                browserWindow.webContents.setAudioMuted(true);
            }
        },
    },
    {
        label: "🔴 Record Video (toggle)",
        // Only show it when right-clicking text
        visible: false,
        click: () => {
            if (browserWindow) {
                browserWindow.webContents.send("postMessage", {
                    record: true,
                    params: params
                });
            }
        },
    },
    {
        label: "✏ Edit URL",
        // Only show it when right-clicking text
        visible: true,
        click: () => {
            var URI = browserWindow.webContents.getURL();
            var onTop = browserWindow.isAlwaysOnTop();
            if (onTop) {
                browserWindow.setAlwaysOnTop(false);
            }
            prompt({
                title: "Edit the URL",
                label: "URL:",
                value: URI,
                inputAttrs: {
                    type: "text",
                    placeholder: "Enter URL or search term"
                },
                resizable: true,
                type: "input",
                alwaysOnTop: true,
            })
                .then(async (r) => {
                    if (r === null) {
                        log("user cancelled");
                        if (onTop) {
                            browserWindow.setAlwaysOnTop(true);
                        }
                    } else {
                        log("result", r);
                        if (onTop) {
                            browserWindow.setAlwaysOnTop(true);
                        }

                        const formattedURL = await formatURL(r, browserWindow);
                        if (formattedURL) {
                            if (browserWindow?.args?.config?.userAgent) {
                                browserWindow.webContents.loadURL(formattedURL, {
                                    userAgent: browserWindow.args.config.userAgent
                                });
                            } else {
                                browserWindow.loadURL(formattedURL);
                            }
                        }
                    }
                })
                .catch(console.error);
        },
    },
    {
        label: "🪟 IFrame Options",
        // Only show it when right-clicking text
        visible: params.frameURL,
        type: "submenu",
        submenu: [{
            label: "✏ Edit IFrame URL",
            // Only show it when right-clicking text
            visible: true,
            click: () => {
                log(browserWindow.webContents);
                log(params);

                var URI = params.frameURL;
                var onTop = browserWindow.isAlwaysOnTop();
                if (onTop) {
                    browserWindow.setAlwaysOnTop(false);
                }
                prompt({
                    title: "Edit the target IFrame URL",
                    label: "URL:",
                    value: URI,
                    inputAttrs: {
                        type: "url",
                    },
                    resizable: true,
                    type: "input",
                    alwaysOnTop: true,
                })
                    .then((r) => {
                        if (r === null) {
                            log("user cancelled");
                            if (onTop) {
                                browserWindow.setAlwaysOnTop(true);
                            }
                        } else {
                            log("result", r);
                            if (onTop) {
                                browserWindow.setAlwaysOnTop(true);
                            }

                            browserWindow.webContents.executeJavaScript(
                                "(function () {\
								var ele = document.elementFromPoint(" +
                                params.x +
                                ", " +
                                params.y +
                                ');\
								if (ele.tagName !== "IFRAME"){\
									ele = false;\
									document.querySelectorAll("iframe").forEach(ee=>{\
										if (ee.src == "' +
                                URI +
                                '"){\
											ele = ee;\
										}\
									});\
								}\
								if (ele && (ele.tagName == "IFRAME")){\
									ele.src = "' +
                                r +
                                '";\
								}\
							})();'
                            );
                        }
                    })
                    .catch(console.error);
            },
        },
        {
            label: "♻ Reload IFrame",
            // Only show it when right-clicking text
            visible: true,
            click: () => {
                browserWindow.webContents.mainFrame.frames.forEach((frame) => {
                    if (frame.url === params.frameURL) {
                        frame.reload();
                    }
                });
            },
        },
        {
            label: "🔙 Go Back in IFrame",
            // Only show it when right-clicking text
            visible: true,
            click: () => {
                browserWindow.webContents.mainFrame.frames.forEach((frame) => {
                    if (frame.url === params.frameURL) {
                        frame.executeJavaScript("(function () {window.history.back();})();");
                    }
                });
            },
        },
        {
            label: "Go Forward in IFrame",
            // Only show it when right-clicking text
            visible: true,
            click: () => {
                browserWindow.webContents.mainFrame.frames.forEach((frame) => {
                    if (frame.url === params.frameURL) {
                        frame.executeJavaScript("(function () {window.history.forward();})();");
                    }
                });
            },
        },
        ],
        },
        {
            label: "📑 Insert CSS",
            // Only show it when right-clicking text
            visible: true,
        click: async () => {
            try {
                var onTop = browserWindow.isAlwaysOnTop();
                if (onTop) {
                    browserWindow.setAlwaysOnTop(false);
                }
                if (browserWindow.webContents) {
                    const savedValue = await browserWindow.webContents.executeJavaScript(`localStorage.getItem('insertCSS');`);

                    log(savedValue);
                    prompt({
                        title: "Insert Custom CSS",
                        label: "CSS:",
                        value: savedValue || "body {background-color:#0000;}",
                        inputAttrs: {
                            type: "text",
                        },
                        resizable: true,
                        type: "input",
                        alwaysOnTop: true,
                    })
                        .then((r) => {
                            if (r === null) {
                                log("user cancelled");
                                if (onTop) {
                                    browserWindow.setAlwaysOnTop(true);
                                }
                            } else {
                                log("result", r);
                                const safeJSString = JSON.stringify(r);
                                browserWindow.webContents.executeJavaScript(
                                    `localStorage.setItem('insertCSS', ${safeJSString});`
                                );
                                if (onTop) {
                                    browserWindow.setAlwaysOnTop(true);
                                }
                                browserWindow.webContents.insertCSS(r, {
                                    cssOrigin: "user"
                                });
                            }
                        })
                        .catch(console.error);
                }
            } catch (error) {
                log(error);
            }
        },
    },
    {
        label: "✏ Edit Window Title",
        // Only show it when right-clicking text
        visible: true,
        click: () => {
            if (!browserWindow.args) {
                browserWindow.args = {};
            }
            var title2 = browserWindow.getTitle();
            var onTop = browserWindow.isAlwaysOnTop();
            if (onTop) {
                browserWindow.setAlwaysOnTop(false);
            }
            prompt({
                title: "Edit Window Title",
                label: "Title:",
                value: title2,
                inputAttrs: {
                    type: "string",
                },
                resizable: true,
                type: "input",
                alwaysOnTop: true,
            })
                .then((r) => {
                    if (r === null) {
                        if (onTop) {
                            browserWindow.setAlwaysOnTop(true);
                        }
                        log("user cancelled");
                    } else {
                        if (onTop) {
                            browserWindow.setAlwaysOnTop(true);
                        }
                        log("result", r);
                        browserWindow.args.title = r;
                        browserWindow.setTitle(r);
                    }
                })
                .catch(console.error);
        },
    },
    {
        label: "↔ Resize window",
        // Only show it when right-clicking text
        visible: true,
        type: "submenu",
        submenu: [{
            label: "Fullscreen",
            // Only show if not already full-screen
            visible: !browserWindow.isMaximized(),
            click: () => {
                if (process.platform == "darwin") {
                    // On certain electron builds, fullscreen fails on macOS; this is in case it starts happening again
                    browserWindow.isMaximized() ? browserWindow.unmaximize() : browserWindow.maximize();
                } else {
                    browserWindow.isFullScreen() ? browserWindow.setFullScreen(false) : browserWindow.setFullScreen(true);
                }
                //browserWindow.setMenu(null);
                //const {width,height} = screen.getPrimaryDisplay().workAreaSize;
                //browserWindow.setSize(width, height);
            },
        },
        {
            label: "1920x1080",
            // Only show it when right-clicking text
            visible: true,
            click: () => {
                if (process.platform !== "darwin") {
                    if (browserWindow.isFullScreen()) {
                        browserWindow.setFullScreen(false);
                    }
                } else {
                    if (browserWindow.isMaximized()) {
                        browserWindow.unmaximize();
                    }
                }
                //let factor = screen.getPrimaryDisplay().scaleFactor;
                //browserWindow.setSize(1920/factor, 1080/factor);
                let point = screen.getCursorScreenPoint();
                let factor = screen.getDisplayNearestPoint(point).scaleFactor || 1;
                browserWindow.setSize(parseInt(1920 / factor), parseInt(1080 / factor));
            },
        },
        {
            label: "1280x720",
            // Only show it when right-clicking text
            visible: true,
            click: () => {
                if (process.platform !== "darwin") {
                    if (browserWindow.isFullScreen()) {
                        browserWindow.setFullScreen(false);
                    }
                } else {
                    if (browserWindow.isMaximized()) {
                        browserWindow.unmaximize();
                    }
                }
                let point = screen.getCursorScreenPoint();
                let factor = screen.getDisplayNearestPoint(point).scaleFactor || 1;
                browserWindow.setSize(parseInt(1280 / factor), parseInt(720 / factor));
            },
        },
        {
            label: "640x360",
            // Only show it when right-clicking text
            visible: true,
            click: () => {
                if (process.platform !== "darwin") {
                    if (browserWindow.isFullScreen()) {
                        browserWindow.setFullScreen(false);
                    }
                } else {
                    if (browserWindow.isMaximized()) {
                        browserWindow.unmaximize();
                    }
                }
                let point = screen.getCursorScreenPoint();
                let factor = screen.getDisplayNearestPoint(point).scaleFactor || 1;
                browserWindow.setSize(parseInt(640 / factor), parseInt(360 / factor));
            },
        },
        {
            label: "Custom resolution",
            // Only show it when right-clicking text
            visible: true,
            click: () => {
                const getScaleFactor = () => {
                    try {
                        const bounds = browserWindow.getBounds();
                        const display = screen.getDisplayMatching(bounds);
                        return display.scaleFactor || 1;
                    } catch (error) {
                        return 1;
                    }
                };

                const onTop = browserWindow.isAlwaysOnTop();
                if (onTop) {
                    browserWindow.setAlwaysOnTop(false);
                }
                const promptScaleFactor = getScaleFactor();
                const size = browserWindow.getSize();
                const currentWidthPx = Math.max(1, Math.round(size[0] * promptScaleFactor));
                const currentHeightPx = Math.max(1, Math.round(size[1] * promptScaleFactor));
                prompt({
                    title: "Custom window resolution",
                    label: "Enter a resolution:",
                    value: currentWidthPx + "x" + currentHeightPx,
                    inputAttrs: {
                        type: "text",
                        placeholder: "1280x720",
                    },
                    type: "input",
                    alwaysOnTop: true,
                })
                    .then((r) => {
                        if (r === null) {
                            log("user cancelled");
                            if (onTop) {
                                browserWindow.setAlwaysOnTop(true);
                            }
                        } else {
                            log("Window resized to ", r);
                            if (onTop) {
                                browserWindow.setAlwaysOnTop(true);
                            }
                            const resolution = String(r || "").trim();
                            const match = resolution.match(/^(\d+)\s*[xX×]\s*(\d+)$/);
                            if (!match) {
                                dialog.showMessageBox({
                                    type: "warning",
                                    title: "Invalid resolution",
                                    message: 'Use format "WIDTHxHEIGHT", for example: 1280x720',
                                });
                                return;
                            }

                            const targetWidthPx = parseInt(match[1], 10);
                            const targetHeightPx = parseInt(match[2], 10);
                            if (!Number.isFinite(targetWidthPx) || !Number.isFinite(targetHeightPx) || targetWidthPx < 1 || targetHeightPx < 1) {
                                dialog.showMessageBox({
                                    type: "warning",
                                    title: "Invalid resolution",
                                    message: "Width and height must be positive numbers.",
                                });
                                return;
                            }

                            if (process.platform !== "darwin") {
                                if (browserWindow.isFullScreen()) {
                                    browserWindow.setFullScreen(false);
                                }
                            }
                            if (browserWindow.isMaximized()) {
                                browserWindow.unmaximize();
                            }
                            const factor = getScaleFactor();
                            const dipWidth = Math.max(1, Math.round(targetWidthPx / factor));
                            const dipHeight = Math.max(1, Math.round(targetHeightPx / factor));
                            log(resolution);
                            log(factor);
                            browserWindow.setSize(dipWidth, dipHeight);
                        }
                    })
                    .catch(console.error);
            },
        },
        ],
    },
    {
        label: "🚿 Clean Video Output",
        type: "checkbox",
        visible: false,
        checked: false,
        click: () => {
            var css =
                " \
					.html5-video-player {\
						z-index:unset!important;\
					}\
					.html5-video-container {	\
						z-index:unset!important;\
					}\
					video { \
						width: 100vw!important;height: 100vh!important;  \
						left: 0px!important;    \
						object-fit: cover!important;\
						top: 0px!important;\
						overflow:hidden;\
						z-index: 2147483647!important;\
						position: fixed!important;\
					}\
					body {\
						overflow: hidden!important;\
					}";
            browserWindow.webContents.insertCSS(css, {
                cssOrigin: "user"
            });
            browserWindow.webContents.executeJavaScript(
                '(function () {\
					var videos = document.querySelectorAll("video");\
					if (videos.length>1){\
						var video = videos[0];\
						for (var i=1;i<videos.length;i++){\
							if (!video.videoWidth){\
								video = videos[i];\
							} else if (videos[i].videoWidth && (videos[i].videoWidth>video.videoWidth)){\
								video = videos[i];\
							}\
						}\
						document.body.appendChild(video);\
					} else if (videos.length){\
						document.body.appendChild(videos[0]);\
					}\
				})();'
            );

            if (browserWindow.webContents.getURL().includes("youtube.com")) {
                browserWindow.webContents.executeJavaScript(
                    '(function () {\
						if (!window.__ssnYtAdSkipper){\
							window.__ssnYtAdSkipper = setInterval(function(){\
							if (document.querySelector(".ytp-ad-skip-button")){\
								document.querySelector(".ytp-ad-skip-button").click();\
							}\
							},500);\
						}\
					})();'
                );
            }
        },
    },
    {
        label: "📌 Always on top",
        type: "checkbox",
        visible: true,
        checked: browserWindow.isAlwaysOnTop(),
        click: () => {
            if (!browserWindow.args) {
                browserWindow.args = {};
            }
            if (browserWindow.isAlwaysOnTop()) {
                browserWindow.setAlwaysOnTop(false);
                browserWindow.args.pin = false;
                browserWindow.setVisibleOnAllWorkspaces(false);
            } else {
                browserWindow.args.pin = true;
                if (process.platform == "darwin") {
                    browserWindow.setAlwaysOnTop(true, "floating", 1);
                } else {
                    browserWindow.setAlwaysOnTop(true, "level");
                }

                browserWindow.setVisibleOnAllWorkspaces(true);
            }
        },
    },
    {
        label: "🚫🖱 ️Make UnClickable until in-focus (CTRL+SHIFT+ALT+X)",
        visible: true, // Only show it when pinned
        click: () => {
            if (browserWindow) {
                if (!browserWindow.isAlwaysOnTop()) {
                    if (process.platform == "darwin") {
                        browserWindow.setAlwaysOnTop(true, "floating", 1);
                    } else {
                        browserWindow.setAlwaysOnTop(true, "level");
                    }
                    browserWindow.setVisibleOnAllWorkspaces(true);
                }
                browserWindow.mouseEvent = true;
                browserWindow.setIgnoreMouseEvents(browserWindow.mouseEvent);
            }
        },
    },
    {
        label: "Force 16/9 aspect ratio",
        type: "checkbox",
        visible: false, // need to re-ensable this at some point
        checked: forcingAspectRatio,
        click: () => {
            if (forcingAspectRatio) {
                browserWindow.setAspectRatio(0);
                forcingAspectRatio = false;
            } else {
                browserWindow.setAspectRatio(16 / 9);
                forcingAspectRatio = true;
            }
        },
    },
    {
        label: "🔍 Inspect Element",
        visible: true,
        click: () => {
            browserWindow.inspectElement(params.x, params.y);
        },
    },
    {
        label: "❌ Close",
        // Only show it when right-clicking text
        visible: true,
        click: () => {
            browserWindow.close(); // hide, and wait 2 second before really closing; this allows for saving of files.
        },
    },
    ],
});

app.on("second-instance", (event, commandLine, workingDirectory, argv2) => {
    log("second instance launched; restoring the existing window");
    // Launching the app again is how people ask for the running copy, so bring it back
    // rather than doing nothing. This is the only way out of a hidden main window on a
    // Linux desktop with no system tray host (GNOME has none by default, and plenty of
    // minimal window managers never had one): with close-to-tray on, the window would
    // otherwise be unrecoverable without killing the process from a terminal.
    //
    // Headless control mode deliberately keeps every window hidden, so leave it be. Source
    // windows are left alone too; their visibility is managed separately.
    if (headlessControlEnabled) return;
    try {
        // Reuse the tray restore path, which shows unconditionally. Do not gate this on
        // isVisible(): a main window hidden by minimizeToTray() still reports visible on
        // Linux, so checking first skips the show() that is actually needed.
        showMainWindowFromTray();
    } catch (error) {
        console.warn('[SecondInstance] Could not restore the main window:', error && error.message ? error.message : error);
    }
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        quitApp();
    }
});


app.on("before-quit", (event) => {
    if (BrowserWindow.getAllWindows().length > 0) {
        event.preventDefault();
        BrowserWindow.getAllWindows().forEach((window) => {
            if (window && !window.isDestroyed()) {
                window.close();
            }
        });
    }
    if (tray) {
        tray.destroy();
    }
    if (typeof disposeTikTokSigningWindow === 'function') {
        try {
            disposeTikTokSigningWindow();
        } catch (error) {
            console.warn('[TikTok] Failed to dispose signing window during quit:', error);
        }
    }
    shutdownTtsWorker();
    shutdownSttWorker();
    if (localMediaService) {
        localMediaService.stop().catch(() => { });
    }
    if (controlApiRouter) {
        controlApiRouter.close();
    }
    if (sourceObservationService) {
        sourceObservationService.close();
    }
    if (appWindowControlService) {
        appWindowControlService.close();
    }
    if (appDialogService) {
        appDialogService.close();
    }
});

app.on("will-quit", () => {
    markStabilitySessionGraceful('will-quit');
    safeUnregisterGlobalShortcuts('will-quit');
});

const folder = earlyDataPaths ? earlyDataPaths.userData : path.join(app.getPath("appData"), `${app.name}`);
if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, {
        recursive: true
    });
}
app.setPath("userData", folder);
log("folder: " + folder);

function getSavedSyncPaths(sessionName = currentSessionName) {
	const sessionScope = getUserSessionPersistenceScope(sessionName);
	const fileName = sessionScope === "default"
		? "savedSync.json"
		: `savedSync.${sessionScope}.json`;
	const mainPath = path.join(folder, fileName);
	return {
		mainPath,
		tmpPath: `${mainPath}.tmp`,
		bakPath: `${mainPath}.bak`
	};
}

function getCachedStateSettingsKeyCount(state) {
	if (!state || typeof state !== "object") return 0;
	const settings = state.settings;
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) return 0;
	return Object.keys(settings).length;
}

function describeCachedStateQuality(state) {
	const normalizedState = normalizeCachedStateSnapshot(state);
	const settingsCount = getCachedStateSettingsKeyCount(normalizedState);
	const streamID = normalizeStreamIdValue(normalizedState.streamID);
	const password = normalizePasswordValue(normalizedState.password);
	const hasStreamID = streamID !== null;
	const hasPassword = password !== null;
	const hasStateFlag = typeof normalizedState.state === "boolean" || normalizedState.state === "true" || normalizedState.state === "false";
	const hasCoreData = settingsCount > 0 || hasStreamID || hasPassword;
	const hasRecoverableData = hasCoreData || hasStateFlag;
	const topLevelKeyCount = Object.keys(normalizedState).length;

	let score = 0;
	score += settingsCount * 5;
	if (hasStreamID) score += 3;
	if (hasPassword) score += 2;
	if (hasStateFlag) score += 1;
	if (topLevelKeyCount > 0) score += 1;

	return {
		normalizedState,
		settingsCount,
		hasStreamID,
		hasPassword,
		hasStateFlag,
		hasCoreData,
		hasRecoverableData,
		topLevelKeyCount,
		score
	};
}

function hasCachedStateData(state) {
	return describeCachedStateQuality(state).hasCoreData;
}

function isLikelySettingsDowngrade(candidateMetrics, baselineMetrics) {
	if (!candidateMetrics || !baselineMetrics) return false;
	const baselineSettingsCount = Number(baselineMetrics.settingsCount) || 0;
	if (baselineSettingsCount <= SETTINGS_VALIDATION.MIN_EXISTING_KEYS) return false;
	const candidateSettingsCount = Number(candidateMetrics.settingsCount) || 0;
	if (candidateSettingsCount === 0) return true;
	return candidateSettingsCount < baselineSettingsCount * SETTINGS_VALIDATION.PARTIAL_THRESHOLD_RATIO;
}

function formatCachedStateQuality(metrics) {
	if (!metrics || typeof metrics !== "object") return "unknown";
	return `score=${metrics.score || 0}, settings=${metrics.settingsCount || 0}, streamID=${metrics.hasStreamID ? 1 : 0}, password=${metrics.hasPassword ? 1 : 0}`;
}

function normalizeSessionCredentialValue(value, options = {}) {
	const { allowZero = false, coerceSentinelStrings = true } = options;
	if (value === undefined || value === null) return null;
	if (typeof value === "boolean") return null;
	if (typeof value === "object" || typeof value === "function" || typeof value === "symbol") return null;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return null;
		if (value === 0 && !allowZero) return null;
		return String(value);
	}
	let asString = null;
	try {
		asString = typeof value === "string" ? value : String(value);
	} catch (_) {
		return null;
	}
	const trimmed = asString.trim();
	if (!trimmed) return null;
	if (coerceSentinelStrings) {
		const lowered = trimmed.toLowerCase();
		if (lowered === "undefined" || lowered === "null" || lowered === "false") {
			return null;
		}
	}
	return asString;
}

function normalizeStreamIdValue(value) {
	return normalizeSessionCredentialValue(value, { allowZero: false });
}

function normalizePasswordValue(value) {
	// Preserve string passwords verbatim (including "false", "0", "off");
	// only true non-values (null/undefined/boolean/empty string) are cleared.
	return normalizeSessionCredentialValue(value, { allowZero: true, coerceSentinelStrings: false });
}

function normalizeCachedStateSnapshot(state) {
	if (!state || typeof state !== "object") return {};
	const normalized = { ...state };
	if ("streamID" in normalized) {
		const streamID = normalizeStreamIdValue(normalized.streamID);
		if (streamID === null) {
			delete normalized.streamID;
		} else {
			normalized.streamID = streamID;
		}
	}
	if ("password" in normalized) {
		const password = normalizePasswordValue(normalized.password);
		if (password === null) {
			delete normalized.password;
		} else {
			normalized.password = password;
		}
	}
	return normalized;
}

function getCachedStateSourcePriority(source) {
	return CACHED_STATE_SOURCE_PRIORITY[source] || 0;
}

function createCachedStateCandidate(state, source, timestamp = 0) {
	const metrics = describeCachedStateQuality(state);
	if (!metrics.hasRecoverableData) return null;
	return {
		state: metrics.normalizedState,
		source,
		timestamp: Number(timestamp) || 0,
		metrics
	};
}

function compareCachedStateCandidates(a, b) {
	if (!a && !b) return 0;
	if (!a) return 1;
	if (!b) return -1;

	const scoreA = a.metrics && Number.isFinite(a.metrics.score) ? a.metrics.score : 0;
	const scoreB = b.metrics && Number.isFinite(b.metrics.score) ? b.metrics.score : 0;
	if (scoreA !== scoreB) return scoreB - scoreA;

	const settingsA = a.metrics && Number.isFinite(a.metrics.settingsCount) ? a.metrics.settingsCount : 0;
	const settingsB = b.metrics && Number.isFinite(b.metrics.settingsCount) ? b.metrics.settingsCount : 0;
	if (settingsA !== settingsB) return settingsB - settingsA;

	const timeA = Number(a.timestamp) || 0;
	const timeB = Number(b.timestamp) || 0;
	if (timeA !== timeB) return timeB - timeA;

	return getCachedStateSourcePriority(b.source) - getCachedStateSourcePriority(a.source);
}

function parseCachedStateFromLocalStorageRecord(raw) {
	if (!raw || typeof raw !== "object") return null;
	const next = {};

	const streamID = normalizeStreamIdValue(raw.streamID || raw.ssninja_stream_id);
	if (streamID !== null) {
		next.streamID = streamID;
	}

	const hasPasswordKey = Object.prototype.hasOwnProperty.call(raw, "password");
	const normalizedPassword = normalizePasswordValue(raw.password);
	if (normalizedPassword !== null) {
		next.password = normalizedPassword;
	} else if (hasPasswordKey) {
		next.password = null;
	}

	const stateValue = raw.state !== undefined ? raw.state : raw.ssninja_state;
	if (typeof stateValue === "string") {
		if (stateValue === "true" || stateValue === "false") {
			next.state = stateValue === "true";
		}
	} else if (typeof stateValue === "boolean") {
		next.state = stateValue;
	}

	if (raw.settings !== undefined) {
		if (typeof raw.settings === "string") {
			try {
				const parsed = JSON.parse(raw.settings);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					next.settings = parsed;
				}
			} catch (_) { }
		} else if (raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)) {
			next.settings = raw.settings;
		}
	}

	if (!Object.keys(next).length) return null;
	return normalizeCachedStateSnapshot(next);
}

function readCachedStateFileCandidate(filePath, source) {
	try {
		const txt = fs.readFileSync(filePath, "utf8");
		if (!txt || !txt.trim()) return null;
		const parsed = JSON.parse(txt);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const stat = fs.statSync(filePath);
		return createCachedStateCandidate(parsed, source, stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0);
	} catch (_) {
		return null;
	}
}

function collectCachedStateCandidates(options = {}) {
	const includeDisk = options.includeDisk !== false;
	const includeStoreBackup = options.includeStoreBackup !== false;
	const includeLocalStorageBackup = options.includeLocalStorageBackup !== false;
	const candidates = [];

	if (includeDisk) {
		const { mainPath, bakPath } = getSavedSyncPaths();
		const primaryCandidate = readCachedStateFileCandidate(mainPath, "savedSync.json");
		if (primaryCandidate) candidates.push(primaryCandidate);
		const bakCandidate = readCachedStateFileCandidate(bakPath, "savedSync.json.bak");
		if (bakCandidate) candidates.push(bakCandidate);
	}

	if (includeStoreBackup) {
		try {
			const storeBackup = getUserSessionStoreValue('cachedStateBackup');
			const storeBackupTime = getUserSessionStoreValue('cachedStateBackupTime');
			const candidate = createCachedStateCandidate(storeBackup, "electron-store backup", storeBackupTime);
			if (candidate) candidates.push(candidate);
		} catch (_) { }
	}

	if (includeLocalStorageBackup) {
		try {
			const localStorageBackup = getUserSessionStoreValue('localStorageBackup');
			const localStorageBackupTime = getUserSessionStoreValue('localStorageBackupTime');
			const reconstructed = parseCachedStateFromLocalStorageRecord(localStorageBackup);
			const candidate = createCachedStateCandidate(reconstructed, "localStorage backup", localStorageBackupTime);
			if (candidate) candidates.push(candidate);
		} catch (_) { }
	}

	return candidates;
}

function setCachedStatePersistenceBaseline(candidate) {
	if (!candidate || !candidate.state || !candidate.metrics) return;
	cachedStatePersistenceBaseline = {
		state: { ...candidate.state },
		source: candidate.source || "runtime",
		timestamp: Number(candidate.timestamp) || Date.now(),
		metrics: candidate.metrics
	};
}

function refreshCachedStatePersistenceBaseline() {
	const candidates = collectCachedStateCandidates({ includeLocalStorageBackup: false });
	if (!candidates.length) return cachedStatePersistenceBaseline;
	candidates.sort(compareCachedStateCandidates);
	setCachedStatePersistenceBaseline(candidates[0]);
	return cachedStatePersistenceBaseline;
}

function getCachedStatePersistenceBaseline() {
	if (cachedStatePersistenceBaseline && cachedStatePersistenceBaseline.metrics) {
		return cachedStatePersistenceBaseline;
	}
	return refreshCachedStatePersistenceBaseline();
}

function shouldRecoverCachedStateFromBackups(state) {
	const metrics = describeCachedStateQuality(state);
	const baseline = getCachedStatePersistenceBaseline();
	if (!metrics.hasCoreData) {
		if (baseline && baseline.metrics && !baseline.metrics.hasCoreData) {
			return false;
		}
		return true;
	}
	if (!baseline || !baseline.metrics) return false;
	return isLikelySettingsDowngrade(metrics, baseline.metrics);
}

function applyRecoveredCachedState(candidate, reason = "") {
	if (!candidate || !candidate.state || typeof candidate.state !== "object") return false;
	const incoming = candidate.state;
	const incomingMetrics = candidate.metrics && typeof candidate.metrics === "object"
		? candidate.metrics
		: describeCachedStateQuality(incoming);
	const currentMetrics = describeCachedStateQuality(cachedState);
	const baseline = cachedStatePersistenceBaseline && cachedStatePersistenceBaseline.metrics
		? cachedStatePersistenceBaseline
		: null;
	const incomingTimestamp = Number(candidate.timestamp) || 0;
	const baselineTimestamp = baseline ? (Number(baseline.timestamp) || 0) : 0;
	const preserveExistingOnConflict = incomingTimestamp > 0 && baselineTimestamp > 0 && incomingTimestamp < baselineTimestamp && currentMetrics.hasCoreData;

	let merged;
	if (preserveExistingOnConflict) {
		// Candidate is older than our best-known persisted baseline; keep current values on conflict
		// and only use recovered data to fill gaps.
		merged = { ...incoming, ...cachedState };
		const incomingSettings = incoming && incoming.settings;
		const existingSettings = cachedState && cachedState.settings;
		const hasIncomingSettings = incomingSettings && typeof incomingSettings === "object" && !Array.isArray(incomingSettings);
		const hasExistingSettings = existingSettings && typeof existingSettings === "object" && !Array.isArray(existingSettings);
		if (hasIncomingSettings && hasExistingSettings) {
			merged.settings = { ...incomingSettings, ...existingSettings };
		} else if (hasIncomingSettings && !hasExistingSettings) {
			merged.settings = incomingSettings;
		}
		log(`[cachedState] Older recovery candidate from ${candidate.source || "unknown"}${reason ? ` (${reason})` : ""}; preserving in-memory values on key conflicts.`);
	} else {
		merged = { ...cachedState, ...incoming };
		if (incomingMetrics.settingsCount > 0) {
			merged.settings = incoming.settings;
		}
	}
	cachedState = normalizeCachedStateSnapshot(merged);
	if (!preserveExistingOnConflict) {
		const mergedMetrics = describeCachedStateQuality(cachedState);
		setCachedStatePersistenceBaseline({
			state: mergedMetrics.normalizedState,
			source: candidate.source || "recovered",
			timestamp: incomingTimestamp || Date.now(),
			metrics: mergedMetrics
		});
	}
	log(`Recovered cachedState from ${candidate.source || "unknown"}${reason ? ` (${reason})` : ""} [${formatCachedStateQuality(incomingMetrics)}]`);
	return true;
}

function persistCachedStateSafely(state, options = {}) {
	const reason = options.reason || "unspecified";
	const allowSettingsDowngrade = options.allowSettingsDowngrade === true;
	const shouldPersistStoreBackup = options.persistStoreBackup !== false;

	let metrics = describeCachedStateQuality(state);
	if (!metrics.hasCoreData && !allowSettingsDowngrade) {
		log(`[cachedState] Skipped persist (${reason}): no meaningful settings data`);
		return { saved: false, reason: "no-core-data" };
	}

	let stateToPersist = metrics.normalizedState;
	const baseline = getCachedStatePersistenceBaseline();
	if (!allowSettingsDowngrade && baseline && baseline.metrics && isLikelySettingsDowngrade(metrics, baseline.metrics)) {
		const baselineSettings = baseline.state && baseline.state.settings;
		if (baselineSettings && typeof baselineSettings === "object" && !Array.isArray(baselineSettings) && Object.keys(baselineSettings).length > 0) {
			stateToPersist = { ...stateToPersist, settings: { ...baselineSettings } };
			metrics = describeCachedStateQuality(stateToPersist);
			console.warn(`[cachedState] Repaired partial settings before persist (${reason}) using baseline from ${baseline.source}.`);
		} else {
			console.warn(`[cachedState] Blocked persist (${reason}) due to partial settings and missing baseline settings.`);
			return { saved: false, reason: "partial-settings-blocked" };
		}
	}

	saveCachedStateAtomic(stateToPersist);
	if (shouldPersistStoreBackup && (metrics.hasCoreData || !allowSettingsDowngrade)) {
		try {
			setUserSessionStoreValue('cachedStateBackup', stateToPersist);
			setUserSessionStoreValue('cachedStateBackupTime', Date.now());
		} catch (e) {
			console.warn("Failed to update electron-store cachedState backup:", e?.message || e);
		}
	}
	if (allowSettingsDowngrade && !metrics.hasCoreData) {
		try {
			const { bakPath } = getSavedSyncPaths();
			if (fs.existsSync(bakPath)) {
				fs.unlinkSync(bakPath);
			}
		} catch (e) {
			console.warn("Failed to clear cachedState .bak during explicit reset:", e?.message || e);
		}
		try {
			deleteUserSessionStoreValue('cachedStateBackup');
			deleteUserSessionStoreValue('cachedStateBackupTime');
			deleteUserSessionStoreValue('localStorageBackup');
			deleteUserSessionStoreValue('localStorageBackupTime');
		} catch (e) {
			console.warn("Failed to clear cachedState backups during explicit reset:", e?.message || e);
		}
	}

	cachedState = { ...stateToPersist };
	if (metrics.settingsCount > 0) {
		cachedState.settings = stateToPersist.settings;
	}
	setCachedStatePersistenceBaseline({
		state: stateToPersist,
		source: "runtime",
		timestamp: Date.now(),
		metrics
	});

	return { saved: true, state: stateToPersist, metrics };
}

function buildLocalStorageMirrorPayload(state) {
	const payload = {};
	const settings = state && state.settings;
	if (settings && typeof settings === "object") {
		payload.settings = JSON.stringify(settings);
	} else if (typeof settings === "string") {
		payload.settings = settings;
	} else {
		payload.settings = null;
	}

	const normalizedStreamID = normalizeStreamIdValue(state && state.streamID);
	const normalizedPassword = normalizePasswordValue(state && state.password);
	payload.streamID = normalizedStreamID;
	payload.password = normalizedPassword;
	if (state && typeof state.state === "boolean") {
		payload.state = state.state ? "true" : "false";
	} else if (state && typeof state.state === "string") {
		payload.state = state.state;
	} else {
		payload.state = null;
	}

	payload.ssninja_stream_id = payload.streamID;
	payload.ssninja_state = payload.state;

	return payload;
}

function updateLocalStorageBackup(payload, options = {}) {
	try {
		if (!payload || typeof payload !== "object") return;
		const allowSettingsDowngrade = options.allowSettingsDowngrade === true;
		const payloadState = parseCachedStateFromLocalStorageRecord(payload);
		const payloadMetrics = describeCachedStateQuality(payloadState);
		const baseline = getCachedStatePersistenceBaseline();
		if (!payloadMetrics.hasCoreData && !allowSettingsDowngrade) {
			log("Skipped localStorageBackup update due to missing core settings data");
			return;
		}
		if (!allowSettingsDowngrade && baseline && baseline.metrics && isLikelySettingsDowngrade(payloadMetrics, baseline.metrics)) {
			console.warn("Skipped localStorageBackup update due to partial settings downgrade gate");
			return;
		}
		const existing = getUserSessionStoreValue('localStorageBackup');
		const merged = existing && typeof existing === "object" ? { ...existing } : {};
		Object.entries(payload).forEach(([key, value]) => {
			if (value === null || value === undefined) {
				delete merged[key];
				return;
			}
			merged[key] = value;
		});
		setUserSessionStoreValue('localStorageBackup', merged);
		setUserSessionStoreValue('localStorageBackupTime', Date.now());
		log(`Updated localStorageBackup with ${Object.keys(payload).length} keys`);
	} catch (e) {
		console.warn("Failed to update localStorageBackup:", e?.message || e);
	}
}

async function mirrorCachedStateToLocalStorage(win) {
	if (!win || win.isDestroyed() || !win.webContents) return;
	if (!hasCachedStateData(cachedState)) return;
	if (shouldRecoverCachedStateFromBackups(cachedState)) {
		log("Skipped mirroring cachedState to localStorage due to partial-state recovery gate");
		return;
	}
	const payload = buildLocalStorageMirrorPayload(cachedState);
	const script = `(function(){\n` +
		`const payload = ${JSON.stringify(payload)};\n` +
		`Object.keys(payload).forEach((key) => {\n` +
		`  const value = payload[key];\n` +
		`  try {\n` +
		`    if (value === null || value === undefined) {\n` +
		`      localStorage.removeItem(key);\n` +
		`    } else {\n` +
		`      localStorage.setItem(key, String(value));\n` +
		`    }\n` +
		`  } catch (e) {}\n` +
		`});\n` +
		`})();`;
	try {
		await win.webContents.executeJavaScript(script, true);
		log("Mirrored cachedState to localStorage");
	} catch (e) {
		console.warn("Failed to mirror cachedState to localStorage:", e?.message || e);
	}
}

async function readLocalStorageMirror(win) {
	if (!win || win.isDestroyed() || !win.webContents) return null;
	const keys = ["settings", "streamID", "password", "state", "ssninja_stream_id", "ssninja_state"];
	const script = `(function(){\n` +
		`const keys = ${JSON.stringify(keys)};\n` +
		`const out = {};\n` +
		`keys.forEach((key) => {\n` +
		`  try {\n` +
		`    const value = localStorage.getItem(key);\n` +
		`    if (value !== null) { out[key] = value; }\n` +
		`  } catch (e) {}\n` +
		`});\n` +
		`return out;\n` +
		`})();`;
	try {
		return await win.webContents.executeJavaScript(script, true);
	} catch (e) {
		console.warn("Failed to read localStorage mirror:", e?.message || e);
		return null;
	}
}

function hydrateCachedStateFromLocalStorage(raw) {
	const next = parseCachedStateFromLocalStorageRecord(raw);
	if (!next || typeof next !== "object") return false;
	const merged = { ...cachedState, ...next };
	if (next.settings && typeof next.settings === "object") {
		merged.settings = next.settings;
	}
	cachedState = merged;
	try {
		const persistResult = persistCachedStateSafely(cachedState, { reason: "hydrate-from-localStorage" });
		if (!persistResult.saved) {
			return false;
		}
		log(`Hydrated cachedState from localStorage with ${Object.keys(next).length} keys`);
	} catch (e) {
		console.warn("Failed to persist cachedState after localStorage hydrate:", e?.message || e);
		return false;
	}
	return true;
}

function hydrateCachedStateFromStoreBackup() {
	try {
		const backup = getUserSessionStoreValue('localStorageBackup');
		if (backup && typeof backup === "object" && Object.keys(backup).length > 0) {
			return hydrateCachedStateFromLocalStorage(backup);
		}
	} catch (e) {
		console.warn("Failed to hydrate cachedState from localStorage backup:", e?.message || e);
	}
	return false;
}

async function recoverCachedStateIfNeeded(reason = "") {
	if (shouldRecoverCachedStateFromBackups(cachedState)) {
		const diskResult = loadCachedStateWithBackupSource({ logSelection: true, updateBaseline: false });
		if (diskResult && diskResult.state) {
			applyRecoveredCachedState(diskResult, reason);
		}
	}
	if (shouldRecoverCachedStateFromBackups(cachedState)) {
		const raw = await readLocalStorageMirror(mainWindow);
		if (hydrateCachedStateFromLocalStorage(raw)) {
			log(`Hydrated cachedState from localStorage mirror${reason ? ` (${reason})` : ""}`);
		}
	}
	if (shouldRecoverCachedStateFromBackups(cachedState)) {
		if (hydrateCachedStateFromStoreBackup()) {
			log(`Hydrated cachedState from localStorage backup${reason ? ` (${reason})` : ""}`);
		}
	}
}

function queueCachedStateRecovery(reason = "") {
	if (cachedStateRecoveryQueued) return;
	cachedStateRecoveryQueued = true;
	setTimeout(() => {
		(async () => {
			try {
				await recoverCachedStateIfNeeded(reason);
			} catch (e) {
				console.warn(`[cachedState] Deferred recovery failed${reason ? ` (${reason})` : ""}:`, e?.message || e);
			} finally {
				cachedStateRecoveryQueued = false;
			}
		})();
	}, 0);
}

async function syncCachedStateWithLocalStorage(win, reason = "") {
	if (!win || win.isDestroyed()) return;
	if (shouldRecoverCachedStateFromBackups(cachedState)) {
		const raw = await readLocalStorageMirror(win);
		if (hydrateCachedStateFromLocalStorage(raw)) {
			log(`Hydrated cachedState from localStorage${reason ? ` (${reason})` : ""}`);
		}
	}
	if (hasCachedStateData(cachedState) && !shouldRecoverCachedStateFromBackups(cachedState)) {
		await mirrorCachedStateToLocalStorage(win);
	} else {
		log(`No cachedState data available${reason ? ` (${reason})` : ""}`);
	}
}

function loadCachedStateWithBackupSource(options = {}) {
	const includeLocalStorageBackup = options.includeLocalStorageBackup !== false;
	const includeStoreBackup = options.includeStoreBackup !== false;
	const includeDisk = options.includeDisk !== false;
	const updateBaseline = options.updateBaseline !== false;
	const logSelection = options.logSelection === true;

	const candidates = collectCachedStateCandidates({
		includeDisk,
		includeStoreBackup,
		includeLocalStorageBackup
	});
	if (!candidates.length) return null;

	candidates.sort(compareCachedStateCandidates);
	const best = candidates[0];
	if (!best || !best.state) return null;

	if (updateBaseline) {
		setCachedStatePersistenceBaseline(best);
	}
	if (logSelection) {
		log(`[cachedState] Selected ${best.source} [${formatCachedStateQuality(best.metrics)}] from ${candidates.length} candidate(s).`);
	}
	return {
		state: { ...best.state },
		source: best.source,
		timestamp: best.timestamp,
		metrics: best.metrics,
		candidateCount: candidates.length
	};
}

function loadCachedStateWithBackup(options = {}) {
	const result = loadCachedStateWithBackupSource(options);
	return result && result.state ? result.state : null;
}

function areSettingsSnapshotsEqual(a, b) {
	if (a === b) return true;
	if (!a || typeof a !== "object" || Array.isArray(a)) return false;
	if (!b || typeof b !== "object" || Array.isArray(b)) return false;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch (_) {
		return false;
	}
}

function areStorageValuesEqual(a, b) {
	if (a === b) return true;
	const aIsObject = a && typeof a === "object";
	const bIsObject = b && typeof b === "object";
	if (!aIsObject && !bIsObject) return false;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch (_) {
		return false;
	}
}

function hasPersistedFieldPayload(value) {
	if (!value || typeof value !== "object") return false;
	if (Object.prototype.hasOwnProperty.call(value, "settings")) return true;
	if (Object.prototype.hasOwnProperty.call(value, "streamID")) return true;
	if (Object.prototype.hasOwnProperty.call(value, "password")) return true;
	if (Object.prototype.hasOwnProperty.call(value, "state")) return true;
	return false;
}

function applyPersistedStateFieldsFromResponse(value, sourceTag = "fromBackgroundResponse") {
	if (!value || typeof value !== "object") return false;
	let changed = false;

	if (value.settings && typeof value.settings === "object") {
		const existingSettings = cachedState?.settings || {};
		const existingCount = Object.keys(existingSettings).length;
		const incomingCount = Object.keys(value.settings).length;
		const hasEstablished = existingCount > SETTINGS_VALIDATION.MIN_EXISTING_KEYS;
		const isPartial = incomingCount < existingCount * SETTINGS_VALIDATION.PARTIAL_THRESHOLD_RATIO;

		if (hasEstablished && isPartial) {
			log(`[${sourceTag}] Blocking settings downgrade (incoming: ${incomingCount}, existing: ${existingCount})`);
		} else if (incomingCount === 0 && existingCount > 0) {
			log(`[${sourceTag}] Blocking empty settings overwrite (existing: ${existingCount})`);
		} else if (!areSettingsSnapshotsEqual(cachedState.settings, value.settings)) {
			cachedState.settings = value.settings;
			changed = true;
		}
	}

	if ("password" in value) {
		const normalizedPassword = normalizePasswordValue(value.password);
		const existingPassword = normalizePasswordValue(cachedState.password);
		if (normalizedPassword !== null) {
			if (existingPassword !== normalizedPassword) {
				cachedState.password = normalizedPassword;
				changed = true;
			}
		} else if (Object.prototype.hasOwnProperty.call(cachedState, "password")) {
			delete cachedState.password;
			changed = true;
		}
	}

	if ("streamID" in value) {
		const normalizedStreamID = normalizeStreamIdValue(value.streamID);
		const existingStreamID = normalizeStreamIdValue(cachedState.streamID);
		if (normalizedStreamID !== null && existingStreamID !== normalizedStreamID) {
			cachedState.streamID = normalizedStreamID;
			changed = true;
		}
	}

	if ("state" in value && cachedState.state !== value.state) {
		cachedState.state = value.state;
		changed = true;
	}

	return changed;
}

function saveCachedStateAtomic(state) {
    const { mainPath, tmpPath, bakPath } = getSavedSyncPaths();
    const data = JSON.stringify(state);
    fs.writeFileSync(tmpPath, data);
    try {
        if (fs.existsSync(mainPath)) {
            fs.renameSync(mainPath, bakPath);
        }
    } catch (e) {
        console.warn("Failed to rotate cachedState backup", e);
    }
    fs.renameSync(tmpPath, mainPath);
}

app.whenReady().then(async function () {
    //app.allowRendererProcessReuse = false;
    log("APP READY");

    if (await handlePendingPortableMigration()) return;

    try {
        await processPendingUserSessionPartitionCleanup();
    } catch (error) {
        console.warn('[User Sessions] Deferred partition cleanup failed:', error?.message || error);
    }

    // Log actual app locale to see what Electron is using
    log(`Electron app.getLocale(): ${app.getLocale()}`);
    log(`Expected SYSTEM_LOCALE: ${SYSTEM_LOCALE}`);

    // Set a global fallback user agent WITHOUT Electron to avoid detection
    // Chrome shows simplified version in UA string
    const CHROME_UA_VERSION = '148.0.0.0';
    let CHROME_UA;
    if (isMac) {
        CHROME_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_VERSION} Safari/537.36`;
    } else if (process.platform === 'linux') {
        CHROME_UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_VERSION} Safari/537.36`;
    } else {
        CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_VERSION} Safari/537.36`;
    }
    app.userAgentFallback = CHROME_UA;

    // Configure defaultSession to match Chrome exactly BEFORE creating windows (from working code)
    const ses = session.defaultSession;

    // Chrome's exact user agent - MUST BE SET BEFORE WINDOW CREATION
    // Don't set locale here - let the command line switch handle it
    ses.setUserAgent(CHROME_UA);

    // Chrome's exact headers (from working code)
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = details.requestHeaders;

        headers['User-Agent'] = CHROME_UA;

        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'sec-ch-ua') {
                headers[key] = '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"';
            }
        }

        headers['Accept'] = headers['Accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
        headers['Accept-Encoding'] = 'gzip, deflate, br, zstd';
        headers['Cache-Control'] = headers['Cache-Control'] || 'max-age=0';

        // Remove Electron specific headers
        delete headers['X-DevTools-Request-Id'];
        delete headers['X-DevTools-Emulate-Network-Conditions-Client-Id'];

        callback({ requestHeaders: headers });
    });

    session.fromPartition("default").setPermissionRequestHandler((webContents, permission, callback) => {
        try {
            let allowedPermissions = ["audioCapture", "desktopCapture", "pageCapture", "tabCapture", "experimental"]; // Full list here: https://developer.chrome.com/extensions/declare_permissions#manifest

            if (allowedPermissions.includes(permission)) {
                callback(true); // Approve permission request
            } else {
                console.error(
                    `The application tried to request permission for '${permission}'. This permission was not whitelisted and has been blocked.`
                );
                callback(false); // Deny
            }

            ttt = screen.getPrimaryDisplay().workAreaSize;

        } catch (e) {
            console.error(e);
        }
    });

    if (TTS_DIAGNOSTICS_ENABLED) {
        try {
            const report = await runTtsDiagnostics();
            console.log('[TtsDiagnostics] Summary:', JSON.stringify(report.summary));
            shutdownTtsWorker();
            app.exit(report.success ? 0 : 1);
        } catch (error) {
            const failureReport = {
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                success: false,
                error: error && error.message ? error.message : String(error),
                snapshots: {
                    after: getTtsDiagnosticsSnapshot()
                }
            };
            if (TTS_DIAGNOSTICS_REPORT_PATH) {
                try {
                    await fsp.writeFile(TTS_DIAGNOSTICS_REPORT_PATH, JSON.stringify(failureReport, null, 2), 'utf8');
                } catch (_) { }
            }
            console.error('[TtsDiagnostics] Failed:', failureReport.error);
            shutdownTtsWorker();
            app.exit(1);
        }
        return;
    }

	    try {
	        const diskResult = loadCachedStateWithBackupSource({ logSelection: true });
	        if (diskResult && diskResult.state) {
	            const normalizedDiskState = normalizeCachedStateSnapshot(diskResult.state);
	            applyRecoveredCachedState({
	                ...diskResult,
	                state: normalizedDiskState,
	                metrics: describeCachedStateQuality(normalizedDiskState)
	            }, "startup");
	            if ("streamID" in cachedState && !cachedState.streamID) {
	                log("invalid cachedState");
	            } else {
	                log(`loaded cachedState from ${diskResult.source}`);
	                if (cachedState && !("state" in cachedState) && "isExtensionOn" in cachedState) {
	                    cachedState.state = cachedState.isExtensionOn;
	                    delete cachedState.isExtensionOn;
	                } else if (cachedState && "isExtensionOn" in cachedState) {
	                    delete cachedState.isExtensionOn;
	                }
	            }
	            setCachedStatePersistenceBaseline({
	                state: normalizeCachedStateSnapshot(cachedState),
	                source: diskResult.source,
	                timestamp: diskResult.timestamp,
	                metrics: describeCachedStateQuality(cachedState)
	            });
		            log(cachedState);
		            try {
		                if (JSON.stringify(diskResult.state) !== JSON.stringify(cachedState)) {
		                    const normalizeResult = persistCachedStateSafely(cachedState, { reason: "startup-normalize" });
		                    if (normalizeResult && normalizeResult.saved) {
		                        log("Normalized cachedState credentials and persisted sanitized values");
		                    } else {
		                        log(`[cachedState] Startup normalization skipped: ${normalizeResult && normalizeResult.reason ? normalizeResult.reason : "unknown"}`);
		                    }
		                }
		            } catch (normalizePersistError) {
		                console.warn("Failed to persist normalized cachedState on startup:", normalizePersistError?.message || normalizePersistError);
		            }

	            if (cachedState.wsServer) {
	                // cachedState.wsServer is only truthy for installs that already
	                // had the local server switched on, so this is the upgrade path.
	                migrateLegacyLocalServerPort();
	                wsServer.start();
	            }
	        } else {
	            log("Failed to load cachedState -- it probably doesn't yet exist");
	        }
	    } catch (e) {
	        console.error("[STARTUP] Error loading cachedState:", e);
	    } finally {
	        cachedStateReady = true;
	        log(`[STARTUP] cachedState ready. Settings keys: ${cachedState?.settings ? Object.keys(cachedState.settings).length : 0}`);
	    }

    // If no --filesource provided, use saved local source path (if any)
    try {
        const savedLocalSource = store.get('localSourcePath');
        if (!Argv.filesource && !preferLocalAssetsFlag && savedLocalSource) {
            const validation = validateSocialStreamSourceRoot(savedLocalSource);
            if (validation.valid) {
                Argv.filesource = savedLocalSource;
                log(`Using saved local source: ${savedLocalSource}`);
            } else {
                clearSavedLocalSourcePath(
                    `Saved Social Stream source is invalid: ${validation.reason || 'unknown problem'}`,
                    savedLocalSource
                );
            }
        }
    } catch (e) {
        console.error('Error applying saved local source:', e);
    }

    if (preferLocalAssetsFlag && !Argv.filesource) {
        try {
            const fallbackRoot = await resolveBundledSocialStreamRoot('main');
            if (fallbackRoot) {
                const fileUrl = pathToFileUrl(ensureTrailingSep(fallbackRoot));
                Argv.filesource = fileUrl;
                console.info('[SSAPP] Prefer-local assets enabled. Using bundled Social Stream from', fileUrl);
            } else {
                console.warn('[SSAPP] Prefer-local assets requested, but bundled resources were not found. Falling back to remote assets.');
            }
        } catch (error) {
            console.error('[SSAPP] Failed to enable prefer-local assets:', error && error.message ? error.message : error);
        }
    }

    localMediaService = setupElectronLocalMedia({
        ipcMain,
        dialog,
        shell,
        store,
        isTrustedSender: (event) => {
            const frame = event && event.senderFrame;
            if (!frame || (frame.mainFrame && frame !== frame.mainFrame)) return false;
            const senderUrl = String(frame.url || (event.sender && event.sender.getURL()) || '');
            if (isSocialStreamRemoteUrl(senderUrl)) return true;
            try {
                if (!senderUrl.startsWith('file:')) return false;
                const senderPath = fileURLToPath(senderUrl);
                const trustedRoots = [path.resolve(__dirname)];
                if (Argv.filesource) {
                    try {
                        trustedRoots.push(path.resolve(String(Argv.filesource).startsWith('file:')
                            ? fileURLToPath(Argv.filesource)
                            : String(Argv.filesource)));
                    } catch (_) { }
                }
                return trustedRoots.some((root) => isPathInsideDirectory(root, senderPath));
            } catch (_) {
                return false;
            }
        },
        getRuntimeRoot: async () => {
            if (Argv.filesource) return Argv.filesource;
            return resolveBundledSocialStreamRoot('main');
        },
        showOpenDialog: (legacyRemoteControlEnabled || headlessControlEnabled) ? async (dialogOptions) => {
            const filePath = remoteControlFileSelections.shift();
            if (filePath) {
                console.log('[Remote Control] Supplying queued local media selection:', path.basename(filePath));
                return { canceled: false, filePaths: [filePath] };
            }
            if (headlessControlEnabled) {
                const error = new Error('A visible app session is required to choose a local file.');
                error.code = 'USER_INTERACTION_REQUIRED';
                throw error;
            }
            return dialog.showOpenDialog(dialogOptions);
        } : undefined
    });
    try {
        await localMediaService.start();
    } catch (error) {
        console.warn('[Local Media] Server did not start:', error && error.message ? error.message : error);
    }

    createWindow(Argv, false, true);
    queueStabilityStartupNotice();
    setupRemoteControlServer();

    if (HIDDEN_CAPTURE_SOAK_ENABLED) {
        setTimeout(() => {
            runHiddenCaptureSoak()
                .then((summary) => {
                    console.log('[HiddenCaptureSoak] success:', summary.success);
                    app.exit(summary.success ? 0 : 1);
                })
                .catch((error) => {
                    console.error('[HiddenCaptureSoak] Failed:', error && error.message ? error.message : error);
                    app.exit(1);
                });
        }, 1500);
    }

    if (HIDDEN_CAPTURE_DIAGNOSTICS_ENABLED) {
        setTimeout(() => {
            runHiddenCaptureDiagnostics()
                .then((report) => {
                    console.log('[HiddenCaptureDiagnostics] Summary:', JSON.stringify(report.summary));
                    app.exit(report.success ? 0 : 1);
                })
                .catch(async (error) => {
                    const failureReport = {
                        startedAt: new Date().toISOString(),
                        finishedAt: new Date().toISOString(),
                        success: false,
                        error: error && error.message ? error.message : String(error)
                    };
                    if (HIDDEN_CAPTURE_DIAGNOSTICS_REPORT_PATH) {
                        try {
                            await fsp.writeFile(
                                HIDDEN_CAPTURE_DIAGNOSTICS_REPORT_PATH,
                                JSON.stringify(failureReport, null, 2),
                                'utf8'
                            );
                        } catch (_) { }
                    }
                    console.error('[HiddenCaptureDiagnostics] Failed:', failureReport.error);
                    app.exit(1);
                });
        }, 1500);
    }

    if (WINDOW_STATE_DIAGNOSTICS_ENABLED) {
        setTimeout(() => {
            runWindowStateDiagnostics()
                .then((report) => {
                    console.log('[WindowStateDiagnostics] Summary:', JSON.stringify(report.summary));
                    app.exit(report.success ? 0 : 1);
                })
                .catch(async (error) => {
                    const failureReport = {
                        startedAt: new Date().toISOString(),
                        finishedAt: new Date().toISOString(),
                        success: false,
                        error: error && error.message ? error.message : String(error)
                    };
                    if (WINDOW_STATE_DIAGNOSTICS_REPORT_PATH) {
                        try {
                            await fsp.writeFile(WINDOW_STATE_DIAGNOSTICS_REPORT_PATH, JSON.stringify(failureReport, null, 2), 'utf8');
                        } catch (_) { }
                    }
                    console.error('[WindowStateDiagnostics] Failed:', failureReport.error);
                    app.exit(1);
                });
        }, 1000);
    }

    // Start/refresh transfer backup timers after app is ready.
    try {
        scheduleTransferBackupTimers();
    } catch (error) {
        console.warn('[TransferBackup] Failed to schedule timers:', error && error.message ? error.message : error);
    }
})
    .catch(console.error);

const STT_WORKER_PATH = path.join(__dirname, 'stt-worker.js');
const STT_MODEL_ID = String(process.env.SSAPP_STT_MODEL_ID || 'Xenova/whisper-tiny.en').trim() || 'Xenova/whisper-tiny.en';
const STT_SAMPLE_RATE = 16000;
const STT_MIN_SAMPLES = Math.round(STT_SAMPLE_RATE * 0.25);
const STT_MAX_SAMPLES = STT_SAMPLE_RATE * 20;
const STT_MAX_QUEUE_DEPTH = 3;
const STT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
let sttWorker = null;
let sttActiveRequest = null;
let sttRequestId = 0;
let sttWorkerCreateCount = 0;
let sttWorkerModelLoadCount = 0;
let sttCompletedRequestCount = 0;
const sttQueue = [];

function createSttError(code, message) {
    const error = new Error(`[${code}] ${message}`);
    error.code = code;
    return error;
}

function getSttModelCacheDir() {
    const override = String(process.env.SSAPP_STT_MODEL_CACHE_DIR || '').trim();
    if (override) return path.resolve(override);
    return path.join(app.getPath('userData'), 'models', 'whisper');
}

function getSttSenderUrl(event) {
    if (!event || !event.sender || !event.senderFrame) return '';
    if (!event.sender.mainFrame || event.senderFrame !== event.sender.mainFrame) return '';
    return String(event.senderFrame.url || event.sender.getURL() || '');
}

function isTrustedSttSender(event) {
    const senderUrl = getSttSenderUrl(event);
    if (!senderUrl) return false;
    if (isSocialStreamRemoteUrl(senderUrl) && matchesSocialStreamPagePath(senderUrl, 'cohost')) return true;
    return senderUrl.startsWith('file://') && matchesSocialStreamPagePath(senderUrl, 'cohost');
}

function assertTrustedSttSender(event) {
    if (!isTrustedSttSender(event)) {
        throw createSttError('SSAPP_STT_FORBIDDEN', 'Local speech recognition is only available to the main cohost page.');
    }
}

function normalizeSttAudioPayload(payload) {
    const sampleRate = Number(payload && payload.sampleRate);
    if (sampleRate !== STT_SAMPLE_RATE) {
        throw createSttError('SSAPP_STT_SAMPLE_RATE', `Expected ${STT_SAMPLE_RATE} Hz mono PCM audio.`);
    }
    const rawAudio = payload && payload.audio;
    const isArrayBuffer = rawAudio instanceof ArrayBuffer;
    const isView = ArrayBuffer.isView(rawAudio);
    const byteLength = isArrayBuffer ? rawAudio.byteLength : isView ? rawAudio.byteLength : 0;
    if (!byteLength || byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        throw createSttError('SSAPP_STT_AUDIO', 'Expected mono Float32 PCM audio.');
    }
    const sampleCount = byteLength / Float32Array.BYTES_PER_ELEMENT;
    if (sampleCount < STT_MIN_SAMPLES) {
        throw createSttError('SSAPP_STT_AUDIO_SHORT', 'Speech segment was too short to transcribe.');
    }
    if (sampleCount > STT_MAX_SAMPLES) {
        throw createSttError('SSAPP_STT_AUDIO_LONG', 'Speech segment exceeded the 20 second limit.');
    }
    const audioBuffer = isArrayBuffer
        ? rawAudio.slice(0)
        : rawAudio.buffer.slice(rawAudio.byteOffset, rawAudio.byteOffset + rawAudio.byteLength);
    return {
        audioBuffer,
        sampleCount,
    };
}

function isSttModelCached() {
    try {
        const modelParts = STT_MODEL_ID.split('/').filter(Boolean);
        const onnxDir = path.join(getSttModelCacheDir(), ...modelParts, 'onnx');
        return fs.existsSync(path.join(onnxDir, 'encoder_model_quantized.onnx'))
            && fs.existsSync(path.join(onnxDir, 'decoder_model_merged_quantized.onnx'));
    } catch (_) {
        return false;
    }
}

function sendSttStatus(request, status) {
    if (!request || !request.sender || request.sender.isDestroyed()) return;
    try {
        request.sender.send('stt:status', {
            requestId: request.id,
            engine: 'whisper',
            model: STT_MODEL_ID,
            ...status,
        });
    } catch (_) { }
}

function createSttWorker() {
    sttWorkerCreateCount += 1;
    const cacheDir = getSttModelCacheDir();
    fs.mkdirSync(cacheDir, { recursive: true });
    const worker = new Worker(STT_WORKER_PATH, {
        workerData: {
            cacheDir,
            modelId: STT_MODEL_ID,
        },
    });
    sttWorker = worker;
    worker.on('message', (message) => {
        if (sttWorker !== worker || !message) return;
        const request = sttActiveRequest;
        if (message.type === 'status') {
            if (request && (message.id === request.id || message.id === null || message.id === undefined)) {
                sendSttStatus(request, message);
            }
            return;
        }
        if (message.type !== 'result' || !request) return;
        clearTimeout(request.timeoutId);
        sttActiveRequest = null;
        sttCompletedRequestCount += 1;
        if (Number.isFinite(message.modelLoadCount)) {
            sttWorkerModelLoadCount = message.modelLoadCount;
        }
        if (message.id !== request.id) {
            request.reject(createSttError('SSAPP_STT_RESPONSE', 'Whisper returned an unexpected response.'));
        } else if (message.error) {
            request.reject(createSttError('SSAPP_STT_TRANSCRIBE', message.error));
        } else {
            request.resolve({
                text: String(message.text || '').slice(0, 4000),
                engine: 'whisper',
                model: STT_MODEL_ID,
                elapsedMs: Number(message.elapsedMs) || 0,
                modelLoadCount: sttWorkerModelLoadCount,
            });
        }
        processSttQueue();
    });
    worker.on('error', (error) => {
        if (sttWorker !== worker) return;
        sttWorker = null;
        const request = sttActiveRequest;
        sttActiveRequest = null;
        if (request) {
            clearTimeout(request.timeoutId);
            request.reject(createSttError('SSAPP_STT_WORKER', error && error.message ? error.message : 'Whisper worker failed.'));
        }
        try {
            worker.terminate();
        } catch (_) { }
        processSttQueue();
    });
    worker.on('exit', (code) => {
        if (sttWorker !== worker) return;
        sttWorker = null;
        const request = sttActiveRequest;
        sttActiveRequest = null;
        if (request) {
            clearTimeout(request.timeoutId);
            request.reject(createSttError('SSAPP_STT_WORKER', `Whisper worker exited with code ${code}.`));
        }
        processSttQueue();
    });
    return worker;
}

function getSttWorker() {
    return sttWorker || createSttWorker();
}

function processSttQueue() {
    if (sttActiveRequest || sttQueue.length === 0) return;
    const request = sttQueue.shift();
    if (!request.sender || request.sender.isDestroyed()) {
        request.reject(createSttError('SSAPP_STT_CLOSED', 'The cohost window closed before transcription started.'));
        processSttQueue();
        return;
    }
    let worker;
    try {
        worker = getSttWorker();
        sttActiveRequest = request;
        request.timeoutId = setTimeout(() => {
            if (sttActiveRequest !== request) return;
            sttActiveRequest = null;
            request.reject(createSttError('SSAPP_STT_TIMEOUT', 'Local Whisper transcription timed out.'));
            if (sttWorker === worker) sttWorker = null;
            try {
                worker.terminate();
            } catch (_) { }
            processSttQueue();
        }, STT_REQUEST_TIMEOUT_MS);
        sendSttStatus(request, {
            type: 'status',
            phase: isSttModelCached() ? 'queued' : 'model-download-needed',
        });
        worker.postMessage({
            id: request.id,
            audioBuffer: request.audioBuffer,
        }, [request.audioBuffer]);
    } catch (error) {
        if (sttActiveRequest === request) sttActiveRequest = null;
        request.reject(error instanceof Error ? error : createSttError('SSAPP_STT_WORKER', String(error)));
        if (worker && sttWorker === worker) {
            sttWorker = null;
            try {
                worker.terminate();
            } catch (_) { }
        }
        processSttQueue();
    }
}

function enqueueSttRequest(sender, normalizedAudio) {
    if (sttQueue.length + (sttActiveRequest ? 1 : 0) >= STT_MAX_QUEUE_DEPTH) {
        return Promise.reject(createSttError('SSAPP_STT_BUSY', 'Local Whisper is busy; wait for the current speech segment to finish.'));
    }
    return new Promise((resolve, reject) => {
        sttQueue.push({
            id: ++sttRequestId,
            sender,
            audioBuffer: normalizedAudio.audioBuffer,
            sampleCount: normalizedAudio.sampleCount,
            timeoutId: null,
            resolve,
            reject,
        });
        processSttQueue();
    });
}

function shutdownSttWorker() {
    const shutdownError = createSttError('SSAPP_STT_SHUTDOWN', 'Local Whisper is shutting down.');
    if (sttActiveRequest) {
        clearTimeout(sttActiveRequest.timeoutId);
        sttActiveRequest.reject(shutdownError);
        sttActiveRequest = null;
    }
    while (sttQueue.length > 0) {
        sttQueue.shift().reject(shutdownError);
    }
    if (sttWorker) {
        const worker = sttWorker;
        sttWorker = null;
        try {
            worker.terminate();
        } catch (_) { }
    }
}

ipcMain.handle('stt:get-capabilities', async (event) => {
    assertTrustedSttSender(event);
    return {
        available: true,
        engine: 'whisper',
        model: STT_MODEL_ID,
        sampleRate: STT_SAMPLE_RATE,
        modelCached: isSttModelCached(),
        maxDurationMs: Math.round((STT_MAX_SAMPLES / STT_SAMPLE_RATE) * 1000),
    };
});

ipcMain.handle('stt:transcribe', async (event, payload) => {
    assertTrustedSttSender(event);
    return enqueueSttRequest(event.sender, normalizeSttAudioPayload(payload));
});

ipcMain.handle('stt:get-diagnostics', async (event) => {
    assertTrustedSttSender(event);
    return {
        hasWorker: !!sttWorker,
        activeRequestId: sttActiveRequest ? sttActiveRequest.id : null,
        queueLength: sttQueue.length,
        workerCreateCount: sttWorkerCreateCount,
        completedRequestCount: sttCompletedRequestCount,
        workerModelLoadCount: sttWorkerModelLoadCount,
        modelCached: isSttModelCached(),
        model: STT_MODEL_ID,
    };
});

ipcMain.handle("tts", async (event, data) => {
    return enqueueTtsRequest(data);
});

const TTS_WORKER_PATH = path.join(__dirname, 'tts-worker.js');
let ttsWorker = null;
let ttsActiveRequest = null;
let ttsRequestId = 0;
const ttsQueue = [];
let ttsWorkerShuttingDown = false;
let ttsWorkerCreateCount = 0;
let ttsCompletedRequestCount = 0;
let ttsWorkerModelLoadCount = 0;

function getKokoroModelPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'app.asar.unpacked', 'Kokoro-82M-ONNX');
    }
    return path.join(__dirname, 'Kokoro-82M-ONNX');
}

function normalizeTtsError(error, fallbackMessage) {
    if (error instanceof Error) return error;
    if (error && typeof error.message === 'string') return new Error(error.message);
    if (typeof error === 'string' && error.trim()) return new Error(error);
    return new Error(fallbackMessage || 'TTS request failed');
}

function createTtsWorker() {
    const appPath = getKokoroModelPath();
    log("Using Kokoro model path:" + appPath);
    ttsWorkerShuttingDown = false;
    ttsWorkerCreateCount += 1;

    const worker = new Worker(TTS_WORKER_PATH, {
        workerData: {
            appPath
        }
    });

    ttsWorker = worker;

    worker.on('message', (result) => {
        handleTtsWorkerMessage(worker, result);
    });

    worker.on('error', (error) => {
        handleTtsWorkerCrash(worker, error);
    });

    worker.on('exit', (code) => {
        if (ttsWorker !== worker) return;
        ttsWorker = null;

        if (ttsWorkerShuttingDown) {
            ttsWorkerShuttingDown = false;
            return;
        }

        const error = new Error(code === 0 ? 'TTS worker exited unexpectedly' : `TTS worker exited with code ${code}`);
        console.error("TTS Worker Error:", error);
        failActiveTtsRequest(error);
        scheduleNextTtsRequest();
    });

    return worker;
}

function getTtsWorker() {
    return ttsWorker || createTtsWorker();
}

function handleTtsWorkerMessage(worker, result) {
    if (ttsWorker !== worker) return;

    const request = ttsActiveRequest;
    if (!request) {
        console.warn('[TTS] Worker returned a result with no active request.');
        return;
    }

    if (!result || result.id !== request.id) {
        ttsActiveRequest = null;
        request.reject(new Error('TTS worker returned an unexpected response.'));
        scheduleNextTtsRequest();
        return;
    }

    ttsActiveRequest = null;
    ttsCompletedRequestCount += 1;
    if (result && Number.isFinite(result.modelLoadCount)) {
        ttsWorkerModelLoadCount = result.modelLoadCount;
    }
    if (result.error) {
        request.reject(normalizeTtsError(result.error, 'TTS request failed'));
    } else {
        request.resolve(result.wavBuffer);
    }
    scheduleNextTtsRequest();
}

function handleTtsWorkerCrash(worker, error) {
    if (ttsWorker !== worker) return;

    ttsWorker = null;
    const normalizedError = normalizeTtsError(error, 'TTS worker crashed');
    console.error("TTS Worker Error:", normalizedError);
    failActiveTtsRequest(normalizedError);

    try {
        worker.terminate();
    } catch (_) { }

    scheduleNextTtsRequest();
}

function failActiveTtsRequest(error) {
    const request = ttsActiveRequest;
    ttsActiveRequest = null;
    if (request) {
        request.reject(normalizeTtsError(error, 'TTS request failed'));
    }
}

function scheduleNextTtsRequest() {
    if (ttsQueue.length > 0) {
        setImmediate(processTtsQueue);
    }
}

function processTtsQueue() {
    if (ttsActiveRequest || ttsQueue.length === 0) return;

    const request = ttsQueue.shift();
    let worker;
    try {
        worker = getTtsWorker();
        ttsActiveRequest = request;
        worker.postMessage({
            id: request.id,
            data: request.data
        });
    } catch (error) {
        if (ttsActiveRequest === request) {
            ttsActiveRequest = null;
        }
        request.reject(normalizeTtsError(error, 'Failed to send TTS request to worker'));
        if (worker && ttsWorker === worker) {
            ttsWorker = null;
            try {
                worker.terminate();
            } catch (_) { }
        }
        scheduleNextTtsRequest();
    }
}

function enqueueTtsRequest(data) {
    return new Promise((resolve, reject) => {
        ttsQueue.push({
            id: ++ttsRequestId,
            data,
            resolve,
            reject
        });
        processTtsQueue();
    });
}

function getTtsDiagnosticsSnapshot() {
    return {
        hasWorker: !!ttsWorker,
        activeRequestId: ttsActiveRequest ? ttsActiveRequest.id : null,
        queueLength: ttsQueue.length,
        workerCreateCount: ttsWorkerCreateCount,
        completedRequestCount: ttsCompletedRequestCount,
        workerModelLoadCount: ttsWorkerModelLoadCount
    };
}

function shutdownTtsWorker() {
    ttsWorkerShuttingDown = true;
    const shutdownError = new Error('TTS worker is shutting down');

    failActiveTtsRequest(shutdownError);
    while (ttsQueue.length > 0) {
        const request = ttsQueue.shift();
        request.reject(shutdownError);
    }

    if (ttsWorker) {
        const worker = ttsWorker;
        ttsWorker = null;
        try {
            worker.terminate();
        } catch (_) { }
    }
}

app.on("ready", () => {
    app.on('web-contents-created', (event, contents) => {
        // NB: Work around electron/electron#6643
        contents.on("context-menu", (event, params) => {
            contents.send("context-menu-ipc", params);
        });


        // Handle new window creation
        contents.setWindowOpenHandler(({ url, features }) => {
            // Always open links in-app, inheriting the opener's session
            // Apply a sensible default window configuration
            const frame = !shouldUseFramelessForUrl(url);
            const backgroundColor = frame ? '#DDD' : '#0000';
            const useTransparency = shouldUseTransparentWindowForUrl(url);
            const forceWin10Compatibility = shouldUseWin10TransparencyCompat(frame, useTransparency);
            const overrideBrowserWindowOptions = applyPlatformWindowCompatibility({
                width: 800,
                height: 600,
                minWidth: 400,
                minHeight: 200,
                frame,
                transparent: useTransparency,
                backgroundColor,
                resizable: !forceWin10Compatibility,
                autoHideMenuBar: false,
                webPreferences: {
                    // Inherit session by default (Electron handles this when allowing)
                    // Keep a safe renderer environment
                    nodeIntegration: false,
                    contextIsolation: true,
                    additionalPermissions: ['clipboard-write']
                }
            });

            return {
                action: 'allow',
                overrideBrowserWindowOptions
            };
        });

        // Handle navigation within the window
        //contents.on('will-navigate', (event, navigationUrl) => {
        //const parsedUrl = new URL(navigationUrl);

        // If it's an external URL, open in default browser
        // if (!parsedUrl.hostname.includes('localhost') && !parsedUrl.protocol.includes('file:')) {
        //   event.preventDefault();
        //   shell.openExternal(navigationUrl);
        // }
        // For internal navigation, allow it to proceed
        // });
    });

    app.on("browser-window-focus", (event, win) => {
        // Initially keep window non-clickable
        //win.setIgnoreMouseEvents(true);

        // Wait 1 second to check if still focused
        setTimeout(() => {
            // Check if window is still focused
            try {
                // Check if window still exists and is not destroyed
                if (win && !win.isDestroyed() && win.isFocused()) {
                    if (popupUnclickableEnabled && win !== mainWindow) {
                        return;
                    }
                    win.setIgnoreMouseEvents(false);
                }
            } catch (e) {
                // Window was destroyed, ignore
            }
        }, 800);
    });
});

app.on("activate", function () {
    // social stream activating a window from the index.html page
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(Argv, false, true);
    }
});

app.on('browser-window-created', (event, window) => {
    window.webContents.on('will-prevent-unload', (event) => {
        event.preventDefault();
    });

    if (popupUnclickableEnabled && window !== mainWindow) {
        setPopupUnclickableForWindow(window, true);
    }

    /*   window.on('close', (event) => {
         log("window close");
         
        if (!app.isQuitting) {
          event.preventDefault();
          if (window && !window.isDestroyed()) {
            log("Hiding window instead of closing");
            window.hide();
          }
        } else {
            log("closign window");
        }
      }); */
});


async function quitApp() {
    app.isQuitting = true;
    markStabilitySessionGraceful('quitApp');
    const skipUserSessionPersistence = shouldSuppressCurrentUserSessionPersistence();

    // Flush any pending debounced storageSave immediately to prevent data loss
    // This also cancels the debounce timer so it won't fire after windows are destroyed
    if (skipUserSessionPersistence) {
        clearTimeout(storageSaveDebounceTimer);
        storageSaveDebounceTimer = null;
        storageSavePending = false;
        storageSavePendingAllowSettingsDowngrade = false;
        log(`[User Sessions] Skipping shutdown persistence for deleted session ${currentSessionName}`);
    } else {
        try {
            if (typeof global.flushPendingStorageSave === 'function') {
                global.flushPendingStorageSave();
            }
        } catch (e) {
            console.warn("Failed to flush pending storageSave on quit:", e?.message || e);
        }
    }

    // Save cachedState before quitting to prevent data loss
    if (!skipUserSessionPersistence) {
        try {
            if (cachedState && Object.keys(cachedState).length > 0) {
                const persistResult = persistCachedStateSafely(cachedState, { reason: "quitApp" });
                if (persistResult && persistResult.saved) {
                    log("Saved cachedState on quit (primary + electron-store backup)");
                } else {
                    log(`[cachedState] Quit persist skipped: ${persistResult && persistResult.reason ? persistResult.reason : "unknown"}`);
                }
            }
        } catch (e) {
            console.error("Failed to save cachedState on quit:", e);
        }
    }

    // Backup localStorage from main window before destroying (lightweight settings backup)
    if (!skipUserSessionPersistence) {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
                await mirrorCachedStateToLocalStorage(mainWindow);
                const localStorageData = await mainWindow.webContents.executeJavaScript(`
                    (function() {
                        const data = {};
                        for (let i = 0; i < localStorage.length; i++) {
                            const key = localStorage.key(i);
                            data[key] = localStorage.getItem(key);
                        }
                        return data;
                    })();
                `).catch(() => null);

                if (localStorageData && Object.keys(localStorageData).length > 0) {
                    setUserSessionStoreValue('localStorageBackup', localStorageData);
                    setUserSessionStoreValue('localStorageBackupTime', Date.now());
                    log(`Backed up ${Object.keys(localStorageData).length} localStorage keys on quit`);
                }
            }
        } catch (e) {
            console.error("Failed to backup localStorage on quit:", e);
        }
    }


    // Clear all global intervals
    if (global.intervals) {
        global.intervals.forEach(interval => clearInterval(interval));
        global.intervals = [];
    }

    // Clear all websocket connections
    if (websocketConnections) {
        Object.keys(websocketConnections).forEach(id => {
            try {
                if (websocketConnections[id] && websocketConnections[id].stop) {
                    websocketConnections[id].stop();
                }
            } catch (e) {
                console.error('Error stopping websocket:', e);
            }
        });
    }

    if (kickWsConnections && kickWsConnections.size) {
        for (const entry of kickWsConnections.values()) {
            try {
                stopKickWsEntry(entry, 'app_quit');
            } catch (e) {
                console.error('Error stopping Kick websocket:', e);
            }
        }
        kickWsConnections.clear();
    }

    // Close all browser views immediately
    if (browserViews) {
        Object.keys(browserViews).forEach(id => {
            try {
                if (browserViews[id]) {
                    // Check if it's a BrowserView with isDestroyed method
                    if (typeof browserViews[id].isDestroyed === 'function' && !browserViews[id].isDestroyed()) {
                        browserViews[id].destroy();
                    } else if (typeof browserViews[id].destroy === 'function') {
                        // If no isDestroyed method, try to destroy anyway
                        browserViews[id].destroy();
                    }
                }
                delete browserViews[id];
                releaseWindowId(id);
            } catch (e) {
                console.error('Error destroying browser view:', e);
            }
        });
    }

    // Close all windows
    BrowserWindow.getAllWindows().forEach(window => {
        try {
            if (window && !window.isDestroyed()) {
                // Clear any window-specific intervals
                if (window.intervals) {
                    window.intervals.forEach(interval => clearInterval(interval));
                    window.intervals = [];
                }
                window.destroy(); // Immediate destruction
            }
        } catch (e) {
            console.error('Error destroying window:', e);
        }
    });

    // Small delay for cleanup
    await sleep(100);

    if (tray) {
        try {
            tray.destroy();
        } catch (e) { }
    }
    app.quit();
}

function minimizeToTray() {
    if (mainWindow) {
        mainWindowVisible = false;
        mainWindow.hide();
    }
}

function showMainWindowFromTray() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }
    try {
        if (typeof app.focus === "function") {
            try {
                app.focus({ steal: true });
            } catch (_) {
                app.focus();
            }
        }
    } catch (_) { }

    try {
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
    } catch (_) { }

    try {
        mainWindow.show();
        mainWindowVisible = true;
    } catch (_) { }

    try {
        mainWindow.moveTop();
    } catch (_) { }

    try {
        const wasAlwaysOnTop = mainWindow.isAlwaysOnTop();
        if (!wasAlwaysOnTop) {
            mainWindow.setAlwaysOnTop(true);
        }
        mainWindow.focus();
        if (!wasAlwaysOnTop) {
            mainWindow.setAlwaysOnTop(false);
        }
    } catch (_) {
        try {
            mainWindow.focus();
        } catch (_) { }
    }
}


// Offline source helpers
function ensureTrailingSep(pth) {
    if (!pth) return pth;
    return pth.endsWith(path.sep) ? pth : pth + path.sep;
}

function pathToFileUrl(pth) {
    if (!pth) return pth;
    // Use Node's pathToFileURL for proper encoding of special characters (#, %, etc.)
    let url = pathToFileURL(pth).href;
    // Ensure trailing separator for directory paths
    if (!url.endsWith('/')) url += '/';
    return url;
}

function fsPathFromMaybeFileUrl(p) {
    try {
        if (typeof p === 'string' && p.startsWith('file://')) {
            const { fileURLToPath } = require('url');
            return ensureTrailingSep(fileURLToPath(p));
        }
    } catch (e) { }
    return p;
}

function validateSocialStreamSourceRoot(sourcePath) {
    const resolved = fsPathFromMaybeFileUrl(sourcePath);
    if (!resolved || typeof resolved !== 'string') {
        return { valid: false, path: resolved || '', reason: 'No folder path was provided.' };
    }

    const root = path.resolve(resolved);
    const requiredFiles = [
        'manifest.json',
        'background.html',
        'popup.html',
        path.join('sources', 'twitch.js')
    ];

    try {
        if (!fs.existsSync(root)) {
            return { valid: false, path: root, reason: 'Folder does not exist.' };
        }
        const stat = fs.statSync(root);
        if (!stat.isDirectory()) {
            return { valid: false, path: root, reason: 'Path is not a folder.' };
        }
        for (const relativePath of requiredFiles) {
            const candidate = path.join(root, relativePath);
            if (!fs.existsSync(candidate)) {
                return {
                    valid: false,
                    path: root,
                    reason: `Missing required Social Stream file: ${relativePath.replace(/\\/g, '/')}`
                };
            }
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
        if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.content_scripts)) {
            return { valid: false, path: root, reason: 'manifest.json is not a valid Social Stream manifest.' };
        }
        return { valid: true, path: ensureTrailingSep(root), reason: null };
    } catch (error) {
        return {
            valid: false,
            path: root,
            reason: error && error.message ? error.message : String(error)
        };
    }
}

function clearSavedLocalSourcePath(reason, sourcePath = null) {
    try {
        store.delete('localSourcePath');
    } catch (_) { }
    try {
        if (Argv) Argv.filesource = null;
    } catch (_) { }
    const detail = reason ? ` ${reason}` : '';
    console.warn(`[SSAPP] Cleared saved local Social Stream source.${detail}`, sourcePath || '');
    queueInjectorToast(
        'warning',
        'Local Social Stream Disabled',
        reason || 'Saved local Social Stream files were invalid. Reverting to online/packaged assets.'
    );
}

function reloadWithLocalSource(localPath) {
    try {
        if (!mainWindow) return;
        const src = localPath.startsWith('file://') ? localPath : pathToFileUrl(localPath);
        const indexUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
        const loadUrl = `${indexUrl}?sourcemode=${encodeURIComponent(src)}`;
        mainWindowReadyForInjectorToasts = false;
        mainWindow.loadURL(loadUrl);
    } catch (e) {
        console.error('Failed to reload with local source:', e);
    }
}

function clearLocalSourceAndReload() {
    try { store.delete('localSourcePath'); } catch (e) { }
    try { Argv.filesource = null; } catch (e) { }
    try {
        if (mainWindow) {
            const indexUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
            mainWindowReadyForInjectorToasts = false;
            mainWindow.loadURL(indexUrl);
            queueInjectorToast('info', 'Classic Mode', 'Returned to online Social Stream scripts.');
        }
    } catch (e) {
        console.error('Failed to reload default index:', e);
    }
}

function findSocialStreamRoot(startDir) {
    try {
        const direct = path.join(startDir, 'manifest.json');
        if (fs.existsSync(direct)) return startDir;
        const entries = fs.readdirSync(startDir, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory()) {
                const p = path.join(startDir, e.name);
                if (fs.existsSync(path.join(p, 'manifest.json'))) return p;
            }
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const p1 = path.join(startDir, e.name);
            let subs = [];
            try { subs = fs.readdirSync(p1, { withFileTypes: true }); } catch { }
            for (const s of subs) {
                if (s.isDirectory()) {
                    const p2 = path.join(p1, s.name);
                    if (fs.existsSync(path.join(p2, 'manifest.json'))) return p2;
                }
            }
        }
    } catch (e) {
        console.error('Error scanning for manifest.json:', e);
    }
    return startDir;
}

function findPreferredGithubZipRoot(startDir, zipPath = '') {
    try {
        const zipBaseName = String(path.basename(zipPath || '')).toLowerCase();
        const preferredByName = [];
        if (zipBaseName.includes('social_stream-beta')) preferredByName.push('social_stream-beta');
        if (zipBaseName.includes('social_stream-main')) preferredByName.push('social_stream-main');
        if (zipBaseName.includes('social_stream')) preferredByName.push('social_stream');
        preferredByName.push('social_stream-main', 'social_stream-beta', 'social_stream');
        const preferredNames = Array.from(new Set(preferredByName));

        const entries = fs.readdirSync(startDir, { withFileTypes: true });
        const directories = entries.filter((entry) => entry && entry.isDirectory());
        for (const preferredName of preferredNames) {
            const match = directories.find((entry) => entry.name.toLowerCase() === preferredName);
            if (!match) continue;
            const candidateRoot = path.join(startDir, match.name);
            if (fs.existsSync(path.join(candidateRoot, 'manifest.json'))) {
                return candidateRoot;
            }
        }
    } catch (error) {
        console.warn('Failed to scan ZIP root for preferred social_stream-* folder:', error?.message || error);
    }
    return null;
}

function extractZipToTemp(zipPath) {
    return new Promise((resolve, reject) => {
        try {
            const baseTemp = path.join(app.getPath('userData'), 'localSource');
            if (!fs.existsSync(baseTemp)) fs.mkdirSync(baseTemp, { recursive: true });
            const dest = path.join(baseTemp, `extracted_${Date.now()}`);
            fs.mkdirSync(dest, { recursive: true });

            if (process.platform === 'win32') {
                const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
                const cmd = `powershell -NoProfile -Command "Expand-Archive -Path ${psQuote(zipPath)} -DestinationPath ${psQuote(dest)} -Force"`;
                exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
                    if (err) return reject(new Error(stderr || err.message || 'Expand-Archive failed'));
                    resolve(dest);
                });
            } else {
                // Pre-check for unzip to provide clearer instructions if missing
                exec('command -v unzip', (whichErr) => {
                    if (whichErr) {
                        const noUnzipError = new Error('UNZIP_NOT_FOUND');
                        noUnzipError.code = 'UNZIP_NOT_FOUND';
                        return reject(noUnzipError);
                    }
                    const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
                    const cmd = `unzip -o ${shQuote(zipPath)} -d ${shQuote(dest)}`;
                    exec(cmd, (err, stdout, stderr) => {
                        if (err) return reject(new Error(stderr || err.message || 'unzip failed'));
                        resolve(dest);
                    });
                });
            }
        } catch (e) { reject(e); }
    });
}

async function handleLoadFromFolder() {
    try {
        const result = await dialog.showOpenDialog({
            title: 'Select Social Stream Ninja folder',
            properties: ['openDirectory']
        });
        if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;
        const chosen = result.filePaths[0];
        const root = findSocialStreamRoot(chosen);
        const finalPath = ensureTrailingSep(root);
        const validation = validateSocialStreamSourceRoot(finalPath);
        if (!validation.valid) {
            throw new Error(`Selected folder is not a valid Social Stream source folder.\n\n${validation.reason || 'Missing required files.'}`);
        }
        const fileUrl = pathToFileUrl(finalPath);
        store.set('localSourcePath', fileUrl);
        try { Argv.filesource = fileUrl; } catch (e) { }
        reloadWithLocalSource(fileUrl);
        createMenu();
    } catch (e) {
        dialog.showErrorBox('Load From Folder Failed', e.message || String(e));
    }
}

async function handleLoadFromZip() {
    let zipLoadStarted = false;
    try {
        const result = await dialog.showOpenDialog({
            title: 'Select Social Stream Ninja ZIP',
            properties: ['openFile'],
            filters: [{ name: 'ZIP files', extensions: ['zip'] }]
        });
        if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;
        const zip = result.filePaths[0];
        const zipName = path.basename(zip);
        const startedAt = Date.now();
        zipLoadStarted = true;
        queueInjectorToast(
            'info',
            'Loading Social Stream ZIP',
            `Extracting ${zipName}... this can take up to a minute for large ZIP files.`
        );
        try {
            if (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.setProgressBar === 'function') {
                mainWindow.setProgressBar(2, { mode: 'indeterminate' });
            }
        } catch (_) { }
        const extractedDir = await extractZipToTemp(zip);
        const preferredGithubRoot = findPreferredGithubZipRoot(extractedDir, zip);
        const root = preferredGithubRoot || findSocialStreamRoot(extractedDir);
        const finalPath = ensureTrailingSep(root);
        const validation = validateSocialStreamSourceRoot(finalPath);
        if (!validation.valid) {
            throw new Error(`ZIP did not contain a valid Social Stream source folder.\n\n${validation.reason || 'Missing required files.'}`);
        }
        const fileUrl = pathToFileUrl(finalPath);
        store.set('localSourcePath', fileUrl);
        try { Argv.filesource = fileUrl; } catch (e) { }
        reloadWithLocalSource(fileUrl);
        createMenu();
        const elapsedMs = Date.now() - startedAt;
        const elapsedSeconds = Math.max(1, Math.round(elapsedMs / 1000));
        queueInjectorToast(
            'success',
            'Social Stream ZIP Loaded',
            `Loaded ${path.basename(root)} from ${zipName} (${elapsedSeconds}s).`
        );
    } catch (e) {
        console.error('ZIP load failed:', e);
        let instructions = '';
        if (process.platform === 'win32') {
            instructions = [
                'Windows could not extract the ZIP automatically.',
                '- Option A: Right-click the ZIP in File Explorer → "Extract All..." → pick a folder → then use File → Load Social Stream From Folder…',
                '- Option B: Ensure PowerShell is available and try again.',
            ].join('\n');
        } else if (process.platform === 'darwin') {
            if (e && (e.code === 'UNZIP_NOT_FOUND' || String(e.message).includes('UNZIP_NOT_FOUND'))) {
                instructions = [
                    'macOS: The "unzip" tool is not available.',
                    '- Option A: Open Terminal and run: brew install unzip',
                    '- Option B: Double‑click the ZIP in Finder to extract, then use File → Load Social Stream From Folder…',
                ].join('\n');
            } else {
                instructions = [
                    'macOS could not extract the ZIP.',
                    '- Try double‑clicking the ZIP in Finder to extract, then use File → Load Social Stream From Folder…',
                    '- Or install the unzip tool via Homebrew: brew install unzip',
                ].join('\n');
            }
        } else {
            // Linux
            if (e && (e.code === 'UNZIP_NOT_FOUND' || String(e.message).includes('UNZIP_NOT_FOUND'))) {
                instructions = [
                    'Linux: The "unzip" tool is not installed.',
                    '- Debian/Ubuntu: sudo apt update && sudo apt install unzip',
                    '- Fedora: sudo dnf install unzip',
                    '- Arch: sudo pacman -S unzip',
                    '- Or extract with your file manager, then use File → Load Social Stream From Folder…',
                ].join('\n');
            } else {
                instructions = [
                    'Linux could not extract the ZIP.',
                    '- Ensure the "unzip" tool is installed, e.g.:',
                    '  Debian/Ubuntu: sudo apt update && sudo apt install unzip',
                    '  Fedora: sudo dnf install unzip',
                    '  Arch: sudo pacman -S unzip',
                    '- Or extract with your file manager, then use File → Load Social Stream From Folder…',
                ].join('\n');
            }
        }

        dialog.showMessageBox({
            type: 'error',
            title: 'Load From ZIP Failed',
            message: 'Could not extract Social Stream Ninja ZIP',
            detail: `${e && e.message ? e.message : e}\n\n${instructions}`,
            buttons: ['OK']
        });
        if (zipLoadStarted) {
            queueInjectorToast(
                'error',
                'Social Stream ZIP Failed',
                e && e.message ? e.message : 'Could not extract Social Stream ZIP.'
            );
        }
    } finally {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.setProgressBar === 'function') {
                mainWindow.setProgressBar(-1);
            }
        } catch (_) { }
    }
}

let startupPreferencesWindow = null;

function getStoredStartupFlagsForUI() {
    const fallback = {
        locale: '',
        preferLocalAssets: false,
        forceTikTokClassic: false,
        allowMultipleInstances: false,
        win10TransparencyCompat: IS_WINDOWS_10,
        macPerformanceMode: isMac ? 'balanced' : 'aggressive'
    };
    try {
        const raw = store.get('startupFlags');
        if (!raw || typeof raw !== 'object') return fallback;
        return {
            locale: typeof raw.locale === 'string' ? raw.locale : '',
            preferLocalAssets: raw.preferLocalAssets === true,
            forceTikTokClassic: raw.forceTikTokClassic === true,
            allowMultipleInstances: raw.allowMultipleInstances === true,
            win10TransparencyCompat: typeof raw.win10TransparencyCompat === 'boolean'
                ? raw.win10TransparencyCompat
                : fallback.win10TransparencyCompat,
            macPerformanceMode: normalizeMacPerformanceModeCandidate(raw.macPerformanceMode) || fallback.macPerformanceMode
        };
    } catch (_) {
        return fallback;
    }
}

function saveStartupFlagsFromUI(input) {
    const localeRaw = input && typeof input.locale === 'string' ? input.locale : '';
    const locale = normalizeLocaleCandidate(localeRaw);
    const preferLocalAssets = !!(input && input.preferLocalAssets);
    const forceTikTokClassic = !!(input && input.forceTikTokClassic);
    const allowMultipleInstances = !!(input && input.allowMultipleInstances);
    const win10TransparencyCompat = !!(input && input.win10TransparencyCompat);
    const macPerformanceMode = normalizeMacPerformanceModeCandidate(input && input.macPerformanceMode) || 'balanced';

    if (locale) {
        store.set('startupFlags.locale', locale);
    } else {
        store.delete('startupFlags.locale');
    }
    store.set('startupFlags.preferLocalAssets', preferLocalAssets);
    store.set('startupFlags.forceTikTokClassic', forceTikTokClassic);
    store.set('startupFlags.allowMultipleInstances', allowMultipleInstances);
    store.set('startupFlags.win10TransparencyCompat', win10TransparencyCompat);
    store.set('startupFlags.macPerformanceMode', macPerformanceMode);

    return {
        locale: locale || '',
        preferLocalAssets,
        forceTikTokClassic,
        allowMultipleInstances,
        win10TransparencyCompat,
        macPerformanceMode
    };
}

function shouldShowStartupPreferencesMenu() {
    // On macOS, prefer placing Preferences under the app menu.
    return !isMac;
}

function generateStartupPreferencesHTML() {
    return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data:; img-src 'self' data:;" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Preferences</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 0; padding: 16px; background: #0b0b0b; color: #eaeaea; }
      h1 { font-size: 18px; margin: 0 0 10px; }
      p { margin: 6px 0 12px; color: #bdbdbd; }
      .card { background: #141414; border: 1px solid #2a2a2a; border-radius: 10px; padding: 12px; margin: 12px 0; }
      .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      label { display: block; font-size: 13px; color: #d6d6d6; margin-bottom: 6px; }
      select, input[type="text"] { background: #0f0f0f; color: #eaeaea; border: 1px solid #2a2a2a; border-radius: 8px; padding: 8px 10px; min-width: 240px; }
      input[type="checkbox"] { transform: translateY(1px); }
      .checkbox { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
      .hint { font-size: 12px; color: #a7a7a7; margin-top: 6px; }
      .buttons { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
      button { background: #1f6feb; border: 1px solid #1f6feb; color: #fff; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
      button.secondary { background: transparent; border-color: #3a3a3a; color: #eaeaea; }
      button.danger { background: #b42318; border-color: #b42318; }
      .status { margin-top: 8px; font-size: 12px; color: #a7a7a7; white-space: pre-wrap; }
      code { background: #0f0f0f; padding: 2px 5px; border-radius: 6px; border: 1px solid #2a2a2a; }
    </style>
  </head>
  <body>
    <h1>Preferences (Startup Flags)</h1>
    <p>These options affect Chromium/Electron startup. Changes require a restart to take effect.</p>

    <div class="card">
      <label for="localePreset">Chromium Locale</label>
      <div class="row">
        <select id="localePreset">
          <option value="">System default (recommended)</option>
          <option value="en-US">English (United States) — en-US</option>
          <option value="en-GB">English (United Kingdom) — en-GB</option>
          <option value="es-ES">Español (España) — es-ES</option>
          <option value="es-MX">Español (México) — es-MX</option>
          <option value="fr-FR">Français (France) — fr-FR</option>
          <option value="fr-CA">Français (Canada) — fr-CA</option>
          <option value="pt-BR">Português (Brasil) — pt-BR</option>
          <option value="de-DE">Deutsch (Deutschland) — de-DE</option>
          <option value="it-IT">Italiano — it-IT</option>
          <option value="ja-JP">日本語 — ja-JP</option>
          <option value="ko-KR">한국어 — ko-KR</option>
        </select>
        <input id="localeCustom" type="text" placeholder="Custom (e.g. es-AR)" />
      </div>
      <div class="hint">This feeds Chromium <code>--lang</code> and <code>--accept-lang</code>, and can influence available system voices.</div>
    </div>

    <div class="card">
      <div class="checkbox">
        <input id="preferLocalAssets" type="checkbox" />
        <label for="preferLocalAssets" style="margin:0;">Prefer bundled Social Stream assets on startup</label>
      </div>
      <div class="checkbox">
        <input id="forceTikTokClassic" type="checkbox" />
        <label for="forceTikTokClassic" style="margin:0;">Force TikTok classic (HTTP) mode on startup</label>
      </div>
      <div class="checkbox">
        <input id="allowMultipleInstances" type="checkbox" />
        <label for="allowMultipleInstances" style="margin:0;">Allow multiple instances</label>
      </div>
      <div class="hint">These mirror existing command-line flags / env vars, but persist via app preferences.</div>
    </div>

    <div class="card">
      <div class="checkbox">
        <input id="win10TransparencyCompat" type="checkbox" />
        <label for="win10TransparencyCompat" style="margin:0;">Windows 10 transparency compatibility mode</label>
      </div>
      <label for="macPerformanceMode">macOS performance mode</label>
      <div class="row">
        <select id="macPerformanceMode">
          <option value="balanced">Balanced (recommended)</option>
          <option value="aggressive">Aggressive (legacy behavior)</option>
        </select>
      </div>
      <div class="hint">Win10 mode keeps frameless transparent windows non-resizable. macOS balanced mode avoids aggressive global Chromium flags.</div>
    </div>

    <div class="card">
      <div><strong>Current run:</strong></div>
      <div class="status" id="effectiveStatus">Loading…</div>
    </div>

    <div class="buttons">
      <button class="secondary" id="closeBtn">Close</button>
      <button class="danger" id="resetBtn">Reset</button>
      <button id="saveBtn">Save</button>
    </div>
    <div class="status" id="status"></div>

    <script>
      const { ipcRenderer } = require('electron');

      const byId = (id) => document.getElementById(id);
      const localePreset = byId('localePreset');
      const localeCustom = byId('localeCustom');
      const preferLocalAssets = byId('preferLocalAssets');
      const forceTikTokClassic = byId('forceTikTokClassic');
      const allowMultipleInstances = byId('allowMultipleInstances');
      const win10TransparencyCompat = byId('win10TransparencyCompat');
      const macPerformanceMode = byId('macPerformanceMode');
      const status = byId('status');
      const effectiveStatus = byId('effectiveStatus');

      function setStatus(msg) {
        status.textContent = msg || '';
      }

      function pickLocaleValue() {
        const custom = (localeCustom.value || '').trim();
        if (custom) return custom;
        return localePreset.value || '';
      }

      async function loadState() {
        const data = await ipcRenderer.invoke('startupPrefs:get');
        const stored = data && data.stored ? data.stored : {};
        const effective = data && data.effective ? data.effective : {};

        const storedLocale = (stored.locale || '').trim();
        if (storedLocale) {
          localePreset.value = storedLocale;
          if (localePreset.value !== storedLocale) {
            localePreset.value = '';
            localeCustom.value = storedLocale;
          }
        } else {
          localePreset.value = '';
          localeCustom.value = '';
        }

        preferLocalAssets.checked = !!stored.preferLocalAssets;
        forceTikTokClassic.checked = !!stored.forceTikTokClassic;
        allowMultipleInstances.checked = !!stored.allowMultipleInstances;
        win10TransparencyCompat.checked = !!stored.win10TransparencyCompat;
        macPerformanceMode.value = (stored.macPerformanceMode === 'aggressive') ? 'aggressive' : 'balanced';

        const isWin10 = !!effective.isWindows10;
        win10TransparencyCompat.disabled = !isWin10;
        if (!isWin10) {
          win10TransparencyCompat.checked = !!effective.win10TransparencyCompat;
        }

        const isMacPlatform = effective.platform === 'darwin';
        macPerformanceMode.disabled = !isMacPlatform;
        if (!isMacPlatform) {
          macPerformanceMode.value = 'aggressive';
        }

        const lines = [];
        if (effective.platform) lines.push(\`Platform: \${effective.platform}\`);
        if (typeof effective.windowsBuild === 'number' && effective.windowsBuild > 0) {
          lines.push(\`Windows build: \${effective.windowsBuild}\`);
          lines.push(\`Windows 11: \${effective.isWindows11 ? 'yes' : 'no'}\`);
        }
        lines.push(\`Locale: \${effective.locale || ''} (\${effective.localeSource || ''})\`);
        if (effective.acceptLanguage) lines.push(\`Accept-Language: \${effective.acceptLanguage}\`);
        lines.push(\`Prefer local assets: \${effective.preferLocalAssets ? 'on' : 'off'}\`);
        lines.push(\`TikTok classic: \${effective.forceTikTokClassic ? 'on' : 'off'}\`);
        lines.push(\`Multi-instance: \${effective.allowMultipleInstances ? 'on' : 'off'}\`);
        lines.push(\`Win10 transparency compatibility: \${effective.win10TransparencyCompat ? 'on' : 'off'}\`);
        lines.push(\`macOS performance mode: \${effective.macPerformanceMode || 'aggressive'}\`);
        effectiveStatus.textContent = lines.join('\\n');
      }

      byId('closeBtn').addEventListener('click', () => window.close());
      byId('resetBtn').addEventListener('click', async () => {
        setStatus('Resetting…');
        await ipcRenderer.invoke('startupPrefs:reset');
        setStatus('');
        await loadState();
      });
      byId('saveBtn').addEventListener('click', async () => {
        setStatus('Saving…');
        const payload = {
          locale: pickLocaleValue(),
          preferLocalAssets: preferLocalAssets.checked,
          forceTikTokClassic: forceTikTokClassic.checked,
          allowMultipleInstances: allowMultipleInstances.checked,
          win10TransparencyCompat: win10TransparencyCompat.checked,
          macPerformanceMode: macPerformanceMode.value
        };
        await ipcRenderer.invoke('startupPrefs:set', payload);
        setStatus('');
        await loadState();
      });

      loadState().catch((e) => {
        effectiveStatus.textContent = 'Failed to load preferences.';
        setStatus(String(e && e.message ? e.message : e));
      });
    </script>
  </body>
</html>
`;
}

function showStartupPreferencesWindow() {
    try {
        if (startupPreferencesWindow && !startupPreferencesWindow.isDestroyed()) {
            startupPreferencesWindow.show();
            startupPreferencesWindow.focus();
            return;
        }

        const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        startupPreferencesWindow = new BrowserWindow({
            width: 620,
            height: 660,
            resizable: false,
            title: 'Preferences',
            parent: parent || undefined,
            modal: false,
            backgroundColor: '#0b0b0b',
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        });
        startupPreferencesWindow.on('closed', () => {
            startupPreferencesWindow = null;
        });

        startupPreferencesWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(generateStartupPreferencesHTML())}`);
    } catch (error) {
        console.error('Failed to open preferences window:', error);
        dialog.showMessageBox({
            type: 'error',
            title: 'Preferences Error',
            message: 'Could not open Preferences window.',
            detail: error && error.message ? error.message : String(error),
            buttons: ['OK']
        });
    }
}

async function promptStartupPreferencesRestart(message, detail) {
    const result = await dialog.showMessageBox(startupPreferencesWindow || mainWindow || undefined, {
        type: 'info',
        title: 'Restart Required',
        message,
        detail,
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1
    });

    if (result.response === 0) {
        try {
            markStabilitySessionGraceful('startup-preferences-restart');
            app.relaunch();
        } catch (e) {
            console.warn('app.relaunch failed:', e);
        }
        app.exit(0);
        return true;
    }
    return false;
}

ipcMain.handle('startupPrefs:get', () => {
    const stored = getStoredStartupFlagsForUI();
    return {
        stored,
        effective: {
            platform: process.platform,
            windowsBuild: WINDOWS_BUILD_NUMBER,
            isWindows10: IS_WINDOWS_10,
            isWindows11: IS_WINDOWS_11,
            locale: SYSTEM_LOCALE,
            localeSource: process.env.SSAPP_LOCALE_SOURCE || 'system',
            acceptLanguage: process.env.SSAPP_ACCEPT_LANGUAGE || null,
            preferLocalAssets: preferLocalAssetsFlag,
            forceTikTokClassic: runtimeForceTikTokClassic,
            allowMultipleInstances,
            win10TransparencyCompat: WIN10_TRANSPARENCY_COMPAT_ENABLED,
            macPerformanceMode: MAC_PERFORMANCE_MODE,
            macBalancedMode: IS_MAC_BALANCED_MODE
        }
    };
});

ipcMain.handle('startupPrefs:set', async (_event, payload) => {
    saveStartupFlagsFromUI(payload);

    await promptStartupPreferencesRestart(
        'Startup preferences saved.',
        'Restart Social Stream Ninja to apply these startup flags.'
    );

    return { ok: true };
});

ipcMain.handle('startupPrefs:reset', async () => {
    store.delete('startupFlags');

    await promptStartupPreferencesRestart(
        'Startup preferences reset.',
        'Restart Social Stream Ninja to apply the defaults.'
    );

    return { ok: true };
});

function getReporterDialogParent() {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

function showReporterMessageBox(options) {
    const parent = getReporterDialogParent();
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

function getTikTokDiagnosticReportContext() {
    const connections = [];
    try {
        for (const [rawWssID, manager] of Object.entries(websocketConnections || {})) {
            if (!manager || typeof manager.getTikTokDiagnosticStats !== 'function') {
                continue;
            }
            const numericWssID = Number(rawWssID);
            connections.push({
                wssID: Number.isFinite(numericWssID) ? numericWssID : rawWssID,
                sourceId: typeof manager.sourceId === 'string' ? manager.sourceId : null,
                ...manager.getTikTokDiagnosticStats()
            });
        }
    } catch (error) {
        return {
            error: error && error.message ? error.message : String(error)
        };
    }
    return {
        connections
    };
}

async function uploadDiagnosticReport(type, message, context = {}) {
    return reporter.send(type, message, context, { bypassRateLimit: true });
}

async function showDiagnosticReportUploadError(error) {
    await showReporterMessageBox({
        type: 'error',
        title: 'Report Not Sent',
        message: 'Could not send the report.',
        detail: error && error.message ? error.message : String(error),
        buttons: ['OK']
    });
}

async function sendErrorReportingEnabledSnapshot() {
    try {
        await uploadDiagnosticReport(
            'diagnostic_snapshot',
            'User enabled error reporting; sending current settings snapshot.',
            {
                trigger: 'enable_error_reporting',
                platform: process.platform,
                tiktokDiagnostics: getTikTokDiagnosticReportContext()
            }
        );
        return true;
    } catch (error) {
        await showDiagnosticReportUploadError(error);
        return false;
    }
}

async function promptAndSendManualIssueReport() {
    if (!reporter.isEnabled()) {
        const { response } = await showReporterMessageBox({
            type: 'info',
            buttons: ['Enable and Continue', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
            title: 'Report Issue',
            message: 'Error reporting needs to be enabled to send a diagnostic report.',
            detail:
                'This sends your app version, a random install ID, your current app settings, and the issue description you enter next.\n\n' +
                'OAuth tokens, session data, and backup credentials are not sent.'
        });
        if (response !== 0) {
            return;
        }
        reporter.enable();
        createMenu();
    }

    const description = await prompt({
        title: 'Report Issue',
        label: 'Describe the issue:',
        value: '',
        inputAttrs: {
            type: 'text',
            placeholder: 'Example: TikTok messages are relaying back and doubling'
        },
        buttonLabels: {
            ok: 'Send',
            cancel: 'Cancel'
        },
        width: 560,
        height: 170,
        minWidth: 480,
        resizable: true,
        type: 'input'
    }, getReporterDialogParent());

    if (description === null) {
        return;
    }

    const cleanedDescription = String(description || '').trim();
    try {
        const result = await uploadDiagnosticReport(
            'manual_issue_report',
            cleanedDescription || 'Manual issue report submitted without a description.',
            {
                trigger: 'manual_issue_report',
                description: cleanedDescription,
                platform: process.platform,
                tiktokDiagnostics: getTikTokDiagnosticReportContext()
            }
        );
        await showReporterMessageBox({
            type: 'info',
            title: 'Report Sent',
            message: 'Diagnostic report sent to the developer.',
            detail: result && result.install_id ? `Install ID: ${result.install_id}` : undefined,
            buttons: ['OK']
        });
    } catch (error) {
        await showDiagnosticReportUploadError(error);
    }
}

function createMenu() {
    const transferBackupConfig = getTransferBackupConfig();
    const hasTransferBackupFolder = !!(transferBackupConfig.folderPath && String(transferBackupConfig.folderPath).trim());
    const transferBackupFilePath = buildTransferBackupFilePath(transferBackupConfig);
    const autoBackupConfigured = !!(transferBackupConfig.enabled && transferBackupFilePath && transferBackupConfig.password && transferBackupConfig.password.method);
    const customJsFileState = getCustomJsFileState();

    const template = [
        // Mac specific top menu
        ...(isMac ? [{
            label: app.name,
            submenu: [
                { role: "about" },
                { type: "separator" },
                {
                    label: 'Preferences…',
                    accelerator: 'CmdOrCtrl+,',
                    click: () => showStartupPreferencesWindow()
                },
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideothers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
            ],
        }] : []),
        // File menu
        {
            label: 'File',
            submenu: [
                isMac ? {
                    role: 'close'
                } : {
                    role: 'quit'
                },
                {
                    label: 'Clear All Sources',
                    click: () => promptClearAllSources()
                },
                {
                    label: 'Reset Everything (Full Reset)',
                    click: () => clearAllData()
                },
                {
                    label: 'Settings Backup',
                    submenu: [
                        {
                            label: 'Export Settings…',
                            click: async () => {
                                await exportSettingsBackupWithDialog();
                            }
                        },
                        {
                            label: 'Import Settings…',
                            click: async () => {
                                await importSettingsBackupWithDialog();
                            }
                        }
                    ]
                },
                {
                    label: 'Set Up Stream Deck',
                    click: () => {
                        if (mainWindow && mainWindow.webContents) {
                            mainWindow.show();
                            mainWindow.focus();
                            mainWindow.webContents.send('open-streamdeck-setup');
                        }
                    }
                },
                {
                    label: 'Local AI / Automation',
                    submenu: [
                        {
                            label: 'Enable Local Control API',
                            type: 'checkbox',
                            checked: store.get('controlApi.enabled', false) === true,
                            click: async menuItem => {
                                store.set('controlApi.enabled', menuItem.checked === true);
                                const result = await dialog.showMessageBox({
                                    type: 'info',
                                    buttons: ['Restart Now', 'Later'],
                                    defaultId: 0,
                                    cancelId: 1,
                                    title: 'Local AI / Automation',
                                    message: menuItem.checked ? 'Local control API enabled.' : 'Local control API disabled.',
                                    detail: 'Restart Social Stream Ninja to apply this change.'
                                });
                                if (result.response === 0) {
                                    markStabilitySessionGraceful('control-api-setting-restart');
                                    app.relaunch();
                                    app.exit();
                                }
                            }
                        },
                        {
                            label: 'Copy Local Connection',
                            enabled: controlApiEnabled,
                            click: async () => {
                                clipboard.writeText(JSON.stringify({
                                    url: `http://127.0.0.1:${remoteControlPort}`,
                                    ssappVersion: app.getVersion()
                                }, null, 2));
                                await dialog.showMessageBox({
                                    type: 'info',
                                    buttons: ['OK'],
                                    title: 'Local Connection Copied',
                                    message: 'The localhost connection was copied.',
                                    detail: 'It is available only to programs running on this computer.'
                                });
                            }
                        },
                        {
                            label: 'Copy MCP Setup',
                            enabled: controlApiEnabled,
                            click: async () => {
                                const setup = buildMcpLaunchConfig({
                                    isPackaged: app.isPackaged,
                                    platform: process.platform,
                                    execPath: process.execPath,
                                    appPath: app.getAppPath(),
                                    appImagePath: process.env.APPIMAGE,
                                    portableExecutablePath: process.env.PORTABLE_EXECUTABLE_FILE,
                                    controlUrl: `http://127.0.0.1:${remoteControlPort}`
                                });
                                clipboard.writeText(JSON.stringify(setup, null, 2));
                                await dialog.showMessageBox({
                                    type: 'info',
                                    buttons: ['OK'],
                                    title: 'MCP Setup Copied',
                                    message: 'The MCP server configuration was copied.',
                                    detail: 'Paste it into your local AI tool\'s MCP settings. The downloaded app is the MCP command; Node and a source checkout are not required.'
                                });
                            }
                        },
                        { type: 'separator' },
                        {
                            label: 'Open AI Control Guide',
                            click: () => shell.openExternal('https://socialstream.ninja/docs/llm-control-guide.html')
                        }
                    ]
                },
                {
                    label: 'Advanced Full Session Transfer',
                    submenu: [
                        {
                            label: 'Create Full Session Transfer Backup…',
                            click: async () => {
                                await handleCreateTransferBackupMenu();
                            }
                        },
                        {
                            label: 'Restore Full Session Transfer Backup…',
                            click: async () => {
                                await restoreTransferBackupWithDialog();
                            }
                        },
                        { type: 'separator' },
                        {
                            label: autoBackupConfigured ? 'Reconfigure Auto Full Session Transfer…' : 'Configure Auto Full Session Transfer…',
                            click: async () => {
                                await configureAutoTransferBackup();
                            }
                        },
                        {
                            label: 'Run Auto Full Session Transfer Now',
                            enabled: autoBackupConfigured && !transferBackupRuntime.inProgress,
                            click: async () => {
                                await handleAutoTransferBackupNowMenu();
                            }
                        },
                        {
                            label: 'Disable Auto Full Session Transfer',
                            enabled: transferBackupConfig.enabled === true,
                            click: () => {
                                disableAutoTransferBackup();
                            }
                        },
                        { type: 'separator' },
                        {
                            label: 'Open Backup Folder',
                            enabled: hasTransferBackupFolder,
                            click: async () => {
                                if (transferBackupConfig.folderPath) {
                                    await shell.openPath(transferBackupConfig.folderPath);
                                }
                            }
                        }
                    ]
                },
                {
                    type: 'separator'
                },
                {
                    label: wsServer.server ? `Stop Local Server (${wsServer.port})` : `Enable Local Server (${wsServer.port})`,
                    click: async () => {
                        if (wsServer.server) {
                            const result = wsServer.stop(true);
                            log(result.success);
                            createMenu();
                        } else {
                            const result = wsServer.start(true);
                            log(result.success);
                            createMenu();
                        }
                    }
                },
                {
                    label: `Set Local Server Port… (current: ${wsServer.port})`,
                    click: async () => {
                        await configureLocalWebSocketPort();
                    }
                },
                {
                    label: 'Allow Local Server Connections from the LAN',
                    type: 'checkbox',
                    checked: !isLoopbackHost(wsServer.host),
                    click: async menuItem => {
                        await configureLocalWebSocketLanAccess(menuItem.checked);
                    }
                },
                {
                    type: 'separator'
                },
                { label: 'Load Social Stream From Folder…', click: () => handleLoadFromFolder() },
                { label: 'Load Social Stream From ZIP…', click: () => handleLoadFromZip() },
                ...(store.get('localSourcePath') ? [
                    { label: 'Open Local Source Folder', click: async () => { const p = store.get('localSourcePath'); if (p) await shell.openPath(fsPathFromMaybeFileUrl(p)); } },
                    { label: 'Stop Using Local Social Stream Source', click: () => clearLocalSourceAndReload() },
                ] : []),
                { type: 'separator' },
                {
                    label: 'Load a custom.js file...',
                    click: async () => {
                        await handleLoadCustomJsFileMenu();
                    }
                },
                {
                    label: customJsFileState.fileName ? `Clear custom.js file (${customJsFileState.fileName})` : 'Clear custom.js file',
                    enabled: !!customJsFileState.filePath,
                    click: async () => {
                        await handleClearCustomJsFileMenu();
                    }
                },
                { type: 'separator' },
                {
                    label: 'Edit URL',
                    click: () => {
                        if (mainWindow && mainWindow.webContents) {

                            const currentURL = mainWindow.webContents.getURL();
                            prompt({
                                title: 'Edit the URL',
                                label: 'URL:',
                                value: currentURL,
                                inputAttrs: {
                                    type: 'url'
                                },
                                type: 'input'
                            }).then(r => {
                                if (r !== null) {
                                    mainWindow.loadURL(r);
                                }
                            }).catch(console.error);
                        }
                    }
                }
            ]
        },
        // Edit menu
        {
            label: "Edit",
            submenu: [{
                role: "undo"
            },
            {
                role: "redo"
            },
            {
                type: "separator"
            },
            {
                role: "cut"
            },
            {
                role: "copy"
            },
            {
                role: "paste"
            },
            ...(isMac ? [{
                role: "pasteAndMatchStyle"
            },
            {
                role: "delete"
            },
            {
                role: "selectAll"
            },
            {
                type: "separator"
            },
            {
                label: "Speech",
                submenu: [{
                    role: "startspeaking"
                }, {
                    role: "stopspeaking"
                }],
            },
            ] : [{
                role: "delete"
            }, {
                type: "separator"
            }, {
                role: "selectAll"
            }]),

            ],
        },
        {
            label: 'View',
            submenu: [{
                role: 'reload'
            },
            {
                role: 'forceReload'
            },
            {
                type: 'separator'
            },
            {
                label: 'Zoom In',
                accelerator: 'CommandOrControl+=',
                click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) {
                        const currentZoom = win.webContents.getZoomFactor();
                        win.webContents.setZoomFactor(currentZoom + 0.1);
                    }
                }
            },
            {
                role: 'zoomOut'
            },
            {
                role: 'resetZoom'
            },
            {
                type: 'separator'
            },
            {
                role: 'togglefullscreen'
            },
            {
                type: 'separator'
            },
            //{
            //  label: 'Clean Video Output',
            //  click: () => {
            //	if (mainWindow && mainWindow.webContents) {
            //	  // Insert the CSS and execute the JavaScript as in the context menu
            //	  const css = `/* ... CSS content ... */`;
            //	  mainWindow.webContents.insertCSS(css, { cssOrigin: 'user' });
            //	  mainWindow.webContents.executeJavaScript(`/* ... JavaScript content ... */`);
            //	}
            //  }
            //},
            {
                label: 'Insert Custom CSS',
                click: async () => {
                    if (mainWindow && mainWindow.webContents) {
                        let savedValue = null;
                        try {
                            savedValue = await executeJavaScriptWithReport(mainWindow.webContents, `localStorage.getItem('insertCSS');`, 'menu.insert_custom_css.read');
                        } catch (_) { }
                        prompt({
                            title: 'Insert Custom CSS',
                            label: 'CSS:',
                            value: savedValue || 'body {background-color:#0000;}',
                            inputAttrs: {
                                type: 'text'
                            },
                            type: 'input'
                        }).then(r => {
                            if (r !== null) {
                                executeJavaScriptQuietly(mainWindow.webContents, `localStorage.setItem('insertCSS', ${JSON.stringify(r)});`, 'menu.insert_custom_css.save');
                                mainWindow.webContents.insertCSS(r, {
                                    cssOrigin: 'user'
                                });
                            }
                        }).catch(console.error);
                    }
                }
            }
            ]
        },

	        // Window menu (including your custom "Minimize to Tray")
	        {
	            label: 'Window',
	            submenu: [{
                role: 'minimize'
            },
            {
                role: 'zoom'
            },
            {
                type: 'separator'
            },
            {
                label: 'Always on Top',
                type: 'checkbox',
                checked: mainWindow ? mainWindow.isAlwaysOnTop() : false,
                click: () => {
                    if (mainWindow) {
                        const shouldPin = !mainWindow.isAlwaysOnTop();
                        mainWindow.setAlwaysOnTop(shouldPin);
                        mainWindow.setVisibleOnAllWorkspaces(shouldPin);
                    }
                }
            },
            {
                label: 'Lock popups unclickable (global)',
                type: 'checkbox',
                checked: popupUnclickableEnabled,
                click: (menuItem) => {
                    setPopupUnclickableEnabled(menuItem.checked);
                }
            },
            {
                label: 'Make main window unclickable',
                click: () => {
                    if (mainWindow) {
                        mainWindow.setIgnoreMouseEvents(true);
                    }
                }
            },
            {
                type: 'separator'
            },
            {
                label: 'Minimize to Tray',
                click: () => minimizeToTray()
            },
            {
                label: 'Close to Tray',
                type: 'checkbox',
                checked: closeToTrayEnabled,
                click: (menuItem) => {
                    closeToTrayEnabled = menuItem.checked;
                    store.set('startupFlags.closeToTray', closeToTrayEnabled);
                }
            },
            {
                type: 'separator'
            },
            {
                role: 'front'
            },
            ...(isMac ? [{
                type: 'separator'
            }, {
                role: 'window'
            }] : [])
	            ]
	        },
	        ...(shouldShowStartupPreferencesMenu() ? [{
	            label: 'Preferences',
	            submenu: [
	                {
	                    label: 'Startup Flags…',
	                    accelerator: 'CmdOrCtrl+,',
	                    click: () => showStartupPreferencesWindow()
	                },
	                {
	                    type: 'separator'
	                },
	                {
	                    label: 'Reset Startup Flags…',
	                    click: async () => {
	                        store.delete('startupFlags');
	                        await promptStartupPreferencesRestart(
	                            'Startup preferences reset.',
	                            'Restart Social Stream Ninja to apply the defaults.'
	                        );
	                    }
	                }
	            ]
	        }] : []),
	        // Help menu
	        {
	            role: "help",
	            submenu: [{
                label: "Get support on Discord",
                click: async () => {
                    await shell.openExternal("https://discord.socialstream.ninja");
                },
            },
            {
                label: "Visit main website",
                click: async () => {
                    await shell.openExternal("https://socialstream.ninja/");
                },
            },
            {
                label: "Terms of service",
                click: async () => {
                    await shell.openExternal("https://socialstream.ninja/TOS");
                },
            },
            {
                label: "Privacy policy",
                click: async () => {
                    await shell.openExternal("https://socialstream.ninja/privacy");
                },
            },
            {
                label: "YouTube's terms of service",
                click: async () => {
                    await shell.openExternal("https://www.youtube.com/t/terms");
                },
            },
            {
                label: 'Command Line Arguments',
                click: () => showCommandLineArguments()
            },
            { type: 'separator' },
            {
                label: 'Report current issue to developer...',
                click: async () => {
                    await promptAndSendManualIssueReport();
                }
            },
            {
                label: 'Enable automatic bug reports',
                type: 'checkbox',
                checked: store.get('errorReportingEnabled', false),
                async click(item) {
                    if (!item.checked) {
                        reporter.disable();
                        return;
                    }
                    const { response } = await dialog.showMessageBox({
                        type: 'info',
                        buttons: ['Enable', 'Cancel'],
                        defaultId: 0,
                        cancelId: 1,
                        title: 'Error Reporting',
                        message: 'What will be sent to the developer?',
                        detail:
                            'When you enable this, a current diagnostic snapshot is sent once. After that, the following is sent automatically when an error occurs:\n\n' +
                            '  • Error message and stack trace\n' +
                            '  • App settings (startup flags, window state, language, etc.)\n' +
                            '  • App version and a random install ID\n\n' +
                            'OAuth tokens, session data, and backup credentials are never sent.\n\n' +
                            'Where does it go?\n' +
                            '  Cloudflare (ssapp-error-logger.vdo.workers.dev) — only the developer can access it.\n\n' +
                            'How long is it kept?\n' +
                            '  Reports are automatically deleted after 30 days.\n\n' +
                            'You can turn this off at any time from the Help menu.'
                    });
                    if (response !== 0) {
                        item.checked = false;
                        return;
                    }
                    reporter.enable();
                    const sent = await sendErrorReportingEnabledSnapshot();
                    if (sent) {
                        await showReporterMessageBox({
                            type: 'info',
                            title: 'Error Reporting Enabled',
                            message: 'Error reporting is enabled and a current diagnostic snapshot was sent.',
                            buttons: ['OK']
                        });
                    }
                }
            },
            ],
        },
    ];

    // Initialize (or update) the tray; avoid spawning multiple tray icons when createMenu is called repeatedly
    const trayMenu = Menu.buildFromTemplate([
        {
            label: "Show App",
            click: () => showMainWindowFromTray(),
        },
        {
            label: "Exit",
            click: () => {
                app.isQuitting = true;
                quitApp();
            },
        },
    ]);

    const iconPath = isMac
        ? path.join(__dirname, "assets", "icons", "png", "24x24.png")
        : path.join(__dirname, "assets", "icons", "png", "256x256.png");

    if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed())) {
        tray = new Tray(iconPath);
    }
    tray.setToolTip("Social Stream Ninja");
    tray.setContextMenu(trayMenu);
    tray.removeListener("double-click", showMainWindowFromTray);
    tray.on("double-click", showMainWindowFromTray);

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

electron.powerMonitor.on("on-battery", () => {
    showDesktopNotification({
        title: "Social Stream Ninja performance is degraded",
        body: "You are now on battery power. Please consider connecting your charger for improved performance.",
        icon: path.join(__dirname, "assets", "icons", "png", "256x256.png"),
    });
});

ipcMain.on('set-force-tiktok-classic', (_event, enabled) => {
    if (CLI_FORCE_TIKTOK_CLASSIC) {
        runtimeForceTikTokClassic = true;
        process.env.SSAPP_FORCE_TIKTOK_CLASSIC = '1';
        return;
    }
    const next = !!enabled;
    runtimeForceTikTokClassic = next;
    process.env.SSAPP_FORCE_TIKTOK_CLASSIC = next ? '1' : '0';
});

function normalizeTikTokSigningServiceUrl(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') {
        return null;
    }
    let value = rawValue.trim();
    if (!value) {
        return null;
    }
    if (!/^https?:\/\//i.test(value)) {
        value = `https://${value}`;
    }
    try {
        const parsed = new URL(value);
        return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '');
    } catch (_) {
        return value.replace(/\/+$/, '');
    }
}

function ensureDeviceId(value) {
    const digits = typeof value === 'string' ? value.replace(/\D+/g, '') : '';
    if (digits && digits.length >= 19) {
        return digits.slice(0, 19);
    }
    if (digits && digits.length > 0) {
        return (digits + '0000000000000000000').slice(0, 19);
    }
    const random = String(crypto.randomInt(1e6, 9e6)) + Date.now().toString();
    return random.slice(0, 19).padEnd(19, '0');
}

async function validateTikTokFetch(parameters, options = {}) {
    const roomId = typeof options.roomId === 'string' && options.roomId.trim()
        ? options.roomId.trim()
        : (typeof parameters?.room_id === 'string' ? parameters.room_id.trim() : '');
    const msToken = typeof parameters?.msToken === 'string' ? parameters.msToken.trim() : '';
    const xBogus = typeof parameters?.["X-Bogus"] === 'string' ? parameters["X-Bogus"].trim() : '';
    const signatureParam = typeof parameters?._signature === 'string' ? parameters._signature.trim() : '';
    if (!roomId || !msToken || !xBogus) {
        return {
            attempted: false,
            ok: false,
            error: !roomId ? 'Room ID missing for validation.' : 'Missing msToken or X-Bogus for validation.'
        };
    }
    const browserName = typeof parameters?.browserName === 'string' && parameters.browserName.trim()
        ? parameters.browserName.trim()
        : 'Electron';
    const browserVersion = typeof parameters?.browserVersion === 'string' && parameters.browserVersion.trim()
        ? parameters.browserVersion.trim()
        : (process.versions.chrome || '1.0.0');
    const userAgent = typeof parameters?.userAgent === 'string' && parameters.userAgent.trim()
        ? parameters.userAgent
        : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36`;
    const deviceId = ensureDeviceId(parameters?.device_id);

    const qs = new URLSearchParams({
        aid: '1988',
        app_language: 'en',
        app_name: 'tiktok_web',
        browser_language: 'en-US',
        browser_name: browserName,
        browser_online: 'true',
        browser_version: browserVersion,
        cookie_enabled: 'true',
        cursor: '',
        debug: 'false',
        device_id: deviceId,
        device_platform: 'web',
        did_rule: '3',
        fetch_rule: '1',
        history_comment_count: '0',
        identity: 'audience',
        internal_ext: '',
        live_id: '12',
        notice: 'SSAPP_SIGN_VALIDATE',
        resp_content_type: 'protobuf',
        room_id: roomId,
        screen_height: '1080',
        screen_width: '1920',
        tz_name: 'UTC',
        version_code: '331310',
        msToken,
        'X-Bogus': xBogus,
        user_agent: userAgent
    });

    if (typeof parameters?.["X-Gnarly"] === 'string' && parameters["X-Gnarly"].trim()) {
        qs.set('X-Gnarly', parameters["X-Gnarly"].trim());
    }
    if (signatureParam) {
        qs.set('_signature', signatureParam);
    }
    if (typeof options.email === 'string' && options.email.trim()) {
        qs.set('contact_us', options.email.trim());
    }

    const requestUrl = `https://webcast.tiktok.com/webcast/im/fetch/?${qs.toString()}`;
    try {
        const response = await fetch(requestUrl, {
            method: 'GET',
            headers: {
                'User-Agent': userAgent,
                'Referer': typeof options.referer === 'string' && options.referer ? options.referer : 'https://www.tiktok.com/',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cookie': `msToken=${encodeURIComponent(msToken)}`
            }
        });
        return {
            attempted: true,
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            timestamp: new Date().toISOString(),
            error: response.ok ? null : `HTTP ${response.status} ${response.statusText || ''}`.trim()
        };
    } catch (error) {
        return {
            attempted: true,
            ok: false,
            status: null,
            statusText: null,
            timestamp: new Date().toISOString(),
            error: error && error.message ? error.message : String(error)
        };
    }
}

function attachSigningWindow(win) {
    if (!win || win.isDestroyed()) {
        return;
    }
    if (detachSigningWindowHook && typeof detachSigningWindowHook === 'function') {
        try {
            detachSigningWindowHook();
        } catch (_) { }
        detachSigningWindowHook = null;
    }
    const handleClosed = () => {
        if (tiktokSigningWindow === win) {
            tiktokSigningWindow = null;
        }
    };
    win.once('closed', handleClosed);
    detachSigningWindowHook = () => {
        try {
            win.removeListener('closed', handleClosed);
        } catch (_) { }
    };
}

function normalizeTikTokLandingUrl(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') {
        return DEFAULT_TIKTOK_SIGNING_URL;
    }
    const trimmed = rawValue.trim();
    if (!trimmed) {
        return DEFAULT_TIKTOK_SIGNING_URL;
    }
    try {
        return new URL(trimmed).toString();
    } catch (_) {
        try {
            return new URL(trimmed, DEFAULT_TIKTOK_SIGNING_URL).toString();
        } catch (__error) {
            return DEFAULT_TIKTOK_SIGNING_URL;
        }
    }
}

function getTikTokSigningWindowState() {
    const exists = !!(tiktokSigningWindow && !tiktokSigningWindow.isDestroyed());
    const isVisible = exists ? tiktokSigningWindow.isVisible() && !tiktokSigningWindow.isMinimized() : false;
    const isMuted = exists && tiktokSigningWindow.webContents && typeof tiktokSigningWindow.webContents.isAudioMuted === 'function'
        ? tiktokSigningWindow.webContents.isAudioMuted()
        : false;
    const currentUrl = exists && tiktokSigningWindow.webContents && typeof tiktokSigningWindow.webContents.getURL === 'function'
        ? tiktokSigningWindow.webContents.getURL()
        : null;
    return {
        exists,
        visible: isVisible,
        muted: isMuted,
        url: currentUrl
    };
}

function getTikTokPopupRelayOrigin(popupWindow) {
    try {
        if (popupWindow && !popupWindow.isDestroyed() && popupWindow.webContents) {
            return new URL(popupWindow.webContents.getURL()).origin;
        }
    } catch (_) { }
    return 'https://accounts.google.com';
}

function buildTikTokGoogleOAuthRelayScript(data, targetOrigin, sourceOrigin) {
    const safeTargetOrigin = typeof targetOrigin === 'string' && targetOrigin ? targetOrigin : '*';
    const safeSourceOrigin = typeof sourceOrigin === 'string' && sourceOrigin ? sourceOrigin : 'https://accounts.google.com';
    return `
        (() => {
            const data = ${JSON.stringify(data)};
            const targetOrigin = ${JSON.stringify(safeTargetOrigin)};
            const sourceOrigin = ${JSON.stringify(safeSourceOrigin)};
            let normalizedTargetOrigin = targetOrigin;
            try { normalizedTargetOrigin = new URL(targetOrigin).origin; } catch (_) { }
            const canDeliver = targetOrigin === '*' || normalizedTargetOrigin === window.location.origin;
            if (!canDeliver) return false;
            const relayKey = JSON.stringify([sourceOrigin, typeof data, data]);
            window.__ssappGoogleOAuthRelaySeen = window.__ssappGoogleOAuthRelaySeen || new Set();
            if (window.__ssappGoogleOAuthRelaySeen.has(relayKey)) return false;
            window.__ssappGoogleOAuthRelaySeen.add(relayKey);
            try {
                window.dispatchEvent(new MessageEvent('message', {
                    data,
                    origin: sourceOrigin,
                    source: window
                }));
            } catch (_) { }
            return true;
        })();
    `;
}

function installTikTokSigningWindowPopupHandling(win) {
    if (!win || win.isDestroyed() || !win.webContents || win.__ssappTikTokPopupHandlingInstalled) {
        return;
    }
    win.__ssappTikTokPopupHandlingInstalled = true;

    const popupPreferences = {
        nodeIntegration: false,
        contextIsolation: false,
        sandbox: false,
        partition: TIKTOK_AUTH_PARTITION,
        nativeWindowOpen: true,
        preload: path.join(__dirname, 'preload-mock.js')
    };

    win.webContents.setWindowOpenHandler(({ url }) => {
        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                parent: win,
                modal: false,
                width: 640,
                height: 760,
                webPreferences: popupPreferences
            }
        };
    });

    const relayedGoogleMessages = new Set();
    win.webContents.on('did-create-window', (popupWindow) => {
        try {
            popupWindow.webContents.setUserAgent(win.webContents.getUserAgent());
        } catch (_) { }
        popupWindow.webContents.on('ipc-message', (event, channel, ...args) => {
            if (channel !== 'google-oauth-relay') {
                return;
            }
            try {
                const { data, targetOrigin, sourceOrigin } = JSON.parse(args[0]);
                const relaySourceOrigin = sourceOrigin || getTikTokPopupRelayOrigin(popupWindow);
                const relayKey = JSON.stringify([relaySourceOrigin, targetOrigin || '*', typeof data, data]);
                if (relayedGoogleMessages.has(relayKey)) {
                    return;
                }
                relayedGoogleMessages.add(relayKey);
                setTimeout(() => {
                    if (!win || win.isDestroyed() || !win.webContents) return;
                    win.webContents.executeJavaScript(
                        buildTikTokGoogleOAuthRelayScript(data, targetOrigin, relaySourceOrigin),
                        true
                    ).catch(() => { });
                }, 150);
            } catch (_) { }
        });
    });
}

async function ensureTikTokSigningWindow(targetUrl, options = {}) {
    console.log('[TikTok] ensureTikTokSigningWindow called. targetUrl:', targetUrl, 'options:', options);
    configureTikTokAuthPartition();
    const normalizedTarget = typeof targetUrl === 'string' && targetUrl.trim()
        ? normalizeTikTokLandingUrl(targetUrl.trim())
        : null;

    const landingUrl = normalizedTarget || DEFAULT_TIKTOK_SIGNING_URL;
    const mode = options.mode || 'background'; // 'login' or 'background'
    console.log('[TikTok] normalizedTarget:', normalizedTarget, 'landingUrl:', landingUrl, 'mode:', mode);

    if (!tiktokSigningWindow || tiktokSigningWindow.isDestroyed()) {
        tiktokSigningWindow = new BrowserWindow({
            show: mode === 'login',
            width: 1100,
            height: 720,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                partition: TIKTOK_AUTH_PARTITION,
                nativeWindowOpen: true,
                backgroundThrottling: false // Critical for headless signing
            }
        });
        try {
            tiktokSigningWindow.setMenuBarVisibility(false);
        } catch (_) { }
        attachSigningWindow(tiktokSigningWindow);
        installTikTokSigningWindowPopupHandling(tiktokSigningWindow);
        await tiktokSigningWindow.loadURL(landingUrl);
    } else {
        installTikTokSigningWindowPopupHandling(tiktokSigningWindow);
        // If window exists, check if we need to navigate
        const currentUrl = tiktokSigningWindow.webContents.getURL();
        console.log('[TikTok] Existing window currentUrl:', currentUrl);
        // If a specific target is requested and it's different from current, or if allowNavigation is explicitly true
        if (normalizedTarget && (options.allowNavigation === true || currentUrl !== normalizedTarget)) {
            console.log('[TikTok] Navigating signing window to:', normalizedTarget);
            await tiktokSigningWindow.loadURL(normalizedTarget);
        }
    }

    try {
        // Handle visibility based on mode
        if (mode === 'login') {
            if (!tiktokSigningWindow.isVisible()) {
                tiktokSigningWindow.show();
            }
            tiktokSigningWindow.focus();
        } else if (mode === 'background') {
            if (tiktokSigningWindow.isVisible()) {
                tiktokSigningWindow.hide();
            }
        }

        // Mute the window to prevent audio playback
        tiktokSigningWindow.webContents.setAudioMuted(true);

        // Inject script to stop video playback and save resources
        const resourceSaverScript = `
            (function() {
                try {
                    if (window.__ssappTikTokResourceSaverInterval) {
                        return;
                    }
                    window.__ssappTikTokResourceSaverInterval = setInterval(() => {
                        const videos = document.querySelectorAll('video');
                        if (!videos || videos.length === 0) {
                            return;
                        }
                        videos.forEach((v) => {
                            try {
                                if (!v.paused) v.pause();
                                v.src = '';
                                v.load();
                                v.remove(); // Aggressively remove video elements
                            } catch (_) { }
                        });
                    }, 1000);
                } catch (_) { }
            })();
        `;
        tiktokSigningWindow.webContents.executeJavaScript(resourceSaverScript).catch(() => { });
    } catch (_) { }
    return tiktokSigningWindow;
}

// IPC Handlers for TikTok Window Management
ipcMain.on('tiktok-login', async (event, args) => {
    log('[IPC] tiktok-login requested');
    await ensureTikTokSigningWindow(null, { mode: 'login', allowNavigation: false });
});

ipcMain.on('tiktok-hide-window', (event) => {
    log('[IPC] tiktok-hide-window requested');
    if (tiktokSigningWindow && !tiktokSigningWindow.isDestroyed()) {
        tiktokSigningWindow.hide();
    }
});

function disposeTikTokSigningWindow() {
    if (tiktokSigningWindow && !tiktokSigningWindow.isDestroyed()) {
        tiktokSigningWindow.destroy();
    }
    tiktokSigningWindow = null;
}

function normalizeTikTokSigningArgs(input) {
    if (!input || typeof input !== 'object') {
        return null;
    }
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const serviceUrl = normalizeTikTokSigningServiceUrl(typeof input.serviceUrl === 'string' ? input.serviceUrl : '');
    const payload = {};
    if (apiKey) {
        payload.apiKey = apiKey;
    }
    if (serviceUrl) {
        payload.serviceUrl = serviceUrl;
    }
    return Object.keys(payload).length ? payload : null;
}

function normalizeTikTokConnectionHandle(value) {
    let parsed = null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        parsed = value;
    } else if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        parsed = Number.isFinite(numeric) ? numeric : null;
    }
    if (!parsed) {
        return null;
    }
    return parsed >= 900001 ? parsed - 900000 : parsed;
}

ipcMain.handle("createTikTokConnection", async function (_event, args) {
    if (runtimeForceTikTokClassic) {
        console.info('[TikTok] Skipping WebSocket connection - classic mode is forced.');
        const fallbackError = new Error('SSAPP_TIKTOK_FORCED_CLASSIC: TikTok WebSocket disabled by classic mode preference');
        fallbackError.code = 'SSAPP_TIKTOK_FORCED_CLASSIC';
        fallbackError.ssappFallback = true;
        fallbackError.ssappFallbackMode = 'classic';
        fallbackError.ssappFallbackMessage = 'TikTok WebSocket disabled by classic mode preference';
        fallbackError.payloadLength = 0;
        throw fallbackError;
    }

    if (!ConnectionManager) {
        console.warn('[TikTok] ConnectionManager unavailable (tiktok-live-connector missing); falling back to classic mode');
        const fallbackError = new Error('SSAPP_TIKTOK_CONNECTOR_MISSING: TikTok WebSocket connector not installed');
        fallbackError.code = 'SSAPP_TIKTOK_CONNECTOR_MISSING';
        fallbackError.ssappFallback = true;
        fallbackError.ssappFallbackMode = 'classic';
        fallbackError.ssappFallbackMessage = 'TikTok WebSocket connector not installed';
        fallbackError.payloadLength = 0;
        throw fallbackError;
    }

    wssID++;
    const sourceIdFromRenderer = typeof args.sourceId === 'string' ? args.sourceId : null;
    let username = args.username;
    if (username) {
        username = username.replace("@", "").toLowerCase().trim();
        // Warn if username contains spaces or special chars (might be display name)
        if (username.includes(' ') || username.match(/[^a-z0-9._]/)) {
            console.warn('Username contains invalid characters - might be a display name:', username);
            // Remove spaces and special chars to try to extract username
            username = username.replace(/[^a-z0-9._]/g, '');
        }
    }
    if (!username) {
        return null;
    }
    console.log('Attempting TikTok connection with username:', username);

    // Extract session credentials if provided
    const rawSessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
    const rawTtTargetIdc = typeof args.ttTargetIdc === 'string' ? args.ttTargetIdc.trim() : '';
    const sessionId = rawSessionId || null;
    const ttTargetIdc = rawTtTargetIdc || null;
    const signing = normalizeTikTokSigningArgs(args?.signing);
    const signingProvider = args?.signingProvider || 'auto';
    const autoActivate = args?.autoActivate === true;
    
    // Debug: Log signing config received from renderer
    console.log('[TikTok] Signing config received:', {
        rawSigning: args?.signing,
        normalizedSigning: signing,
        signingProvider,
        hasApiKey: !!(signing && signing.apiKey),
        hasServiceUrl: !!(signing && signing.serviceUrl)
    });

    const requestedStrategy = args && args.strategy === 'websocket' ? 'websocket' : 'legacy';
    const manager = new ConnectionManager(
        username,
        wssID,
        sessionId,
        ttTargetIdc,
        { forceLegacyConnector: requestedStrategy === 'legacy', signing, signingProvider, autoActivate }
    );
    if (args && args.replyOnly === true) {
        manager.replyOnly = true;
    }
    manager.accountRole = normalizeSourceAccountRole(args?.accountRole);
    manager.customSession = args?.customSession || null;
    manager.sourceId = sourceIdFromRenderer || null;
    if (manager.sourceId) {
        const retiredWssIds = registerActiveTikTokSourceConnection(manager, 'createTikTokConnection');
        if (retiredWssIds && retiredWssIds.length) {
            console.info('[TikTok] Retired stale connection(s) for source before creating replacement:', {
                sourceId: manager.sourceId,
                replacementWssID: wssID,
                retiredWssIds
            });
        }
    }
    websocketConnections[wssID] = manager;

    connectionStates.set(wssID, {
        isConnected: false,
        lastAttempt: Date.now(),
        isReconnecting: false,
        attemptInProgress: false
    });

    // Create a virtual tab entry for the TikTok connection
    // Use a special tab ID that won't conflict with real browser tabs
    const virtualTabId = 900000 + wssID; // High number to avoid conflicts
    browserViews[virtualTabId] = {
        isTikTokVirtual: true,
        wssID: wssID,
        sourceId: sourceIdFromRenderer || null,
        username: username,
        args: {
            url: `https://www.tiktok.com/@${username}/live`,
            sourceId: sourceIdFromRenderer || null,
            accountRole: normalizeSourceAccountRole(args?.accountRole),
            customSession: args?.customSession || null
        },
        webContents: {
            getURL: () => `https://www.tiktok.com/@${username}/live`,
            send: (channel, data) => {
                // Handle messages sent to this virtual tab
                if (channel !== "sendToTab") return;

                const text = typeof data?.text === 'string' ? data.text.trim() : '';
                console.log('[TikTok Virtual Tab] send called', { channel, text, hasSession: !!manager.sessionId });

                if (!text) {
                    console.warn('Ignoring empty TikTok chat send request');
                    return;
                }

                if (!manager.sessionId) {
                    console.warn('TikTok outbound messaging ignored: sessionid cookie missing');
                    return;
                }

                if (!manager.ttTargetIdc && !manager.warnedMissingTtTargetIdc) {
                    console.warn('TikTok outbound messaging proceeding without tt-target-idc cookie');
                    manager.warnedMissingTtTargetIdc = true;
                }

                manager.sendChatMessage(text).then(result => {
                    console.log('[TikTok Virtual Tab] sendChatMessage result:', result);
                    if (!result?.success && result?.error) {
                        console.log('Failed to send TikTok message:', result.error);
                    }
                }).catch(error => {
                    console.error('Failed to send TikTok message:', error);
                });
            }
        }
    };

    // Store the virtual tab ID in the manager for reference
    manager.virtualTabId = virtualTabId;
    manager.wssID = wssID; // Store wssID for reference too
    if (typeof manager.logDebug === 'function') {
        manager.logDebug('lifecycle.virtualTab.assigned', { virtualTabId });
    }

    try {
        await manager.initialize();
    } catch (e) {
        console.error('Error creating TikTok connection:', e);
        try {
            cleanupConnection(wssID);
        } catch (cleanupError) {
            console.warn('[TikTok] Failed to clean up failed connection:', cleanupError?.message || cleanupError);
        }
        // Propagate the error to the renderer so the UI can react accordingly
        throw e;
    }

    // Return the virtual tab ID instead of wssID so it can be used with browserViews
    return virtualTabId;
});

ipcMain.on("disconnectTikTokConnection", function (eventRet, args) {
    if (!args.wssID) {
        eventRet.returnValue = false;
        return;
    }

    try {
        const normalizedWssID = normalizeTikTokConnectionHandle(args.wssID) || args.wssID;
        const managerMeta = websocketConnections[normalizedWssID] || websocketConnections[args.wssID];
        const sourceId = managerMeta && managerMeta.sourceId ? managerMeta.sourceId : null;
        try {
            // Notify renderer to clear UI/countdowns
            mainWindow.webContents.send('tiktokConnectionStatus', {
                wssID: normalizedWssID,
                status: 'stopped_by_user',
                sourceId
            });
        } catch (_) { }
        cleanupConnection(normalizedWssID);
        eventRet.returnValue = true;
    } catch (e) {
        console.error('Error in disconnectTikTokConnection:', e);
        eventRet.returnValue = false;
    }
});

// TikTok authentication handlers
ipcMain.handle("authenticateTikTok", async (_event, args = {}) => {
    try {
        const forceRefresh = args && args.forceRefresh === true;
        if (forceRefresh) {
            disposeTikTokSigningWindow();
        }
        const auth = new TikTokAuth(mainWindow);
        const credentials = await auth.authenticate({
            forceRefresh
        });
        return {
            success: true,
            credentials
        };
    } catch (error) {
        console.error('TikTok authentication failed:', error);
        return {
            success: false,
            error: error.message
        };
    }
});

ipcMain.handle("clearTikTokAuthSession", async () => {
    try {
        disposeTikTokSigningWindow();
        await clearTikTokAuthSession();
        return { success: true };
    } catch (error) {
        console.error('Failed to clear TikTok auth session:', error);
        return {
            success: false,
            error: error?.message || String(error)
        };
    }
});

ipcMain.handle("tiktokShowSigningWindow", async (_event, args = {}) => {
    try {
        const landingUrl = typeof args?.landingUrl === 'string' && args.landingUrl.trim()
            ? args.landingUrl.trim()
            : null;
        await ensureTikTokSigningWindow(landingUrl, { allowNavigation: Boolean(landingUrl) });
        return { success: true, state: getTikTokSigningWindowState() };
    } catch (error) {
        console.error('[TikTok] Failed to show signing window:', error);
        return {
            success: false,
            error: error && error.message ? error.message : 'Unable to show the TikTok window.'
        };
    }
});

ipcMain.handle('tiktokSigningWindowCommand', async (_event, args = {}) => {
    const action = typeof args?.action === 'string' ? args.action : 'state';
    const currentState = () => getTikTokSigningWindowState();

    const ensureWindow = async () => {
        if (tiktokSigningWindow && !tiktokSigningWindow.isDestroyed()) {
            return tiktokSigningWindow;
        }
        const win = await ensureTikTokSigningWindow(DEFAULT_TIKTOK_SIGNING_URL, { allowNavigation: true });
        return win;
    };

    try {
        switch (action) {
            case 'state':
                return { success: true, state: currentState() };
            case 'show':
            case 'reveal': {
                const win = await ensureWindow();
                try { win.show(); win.focus(); } catch (_) { }
                return { success: true, state: currentState() };
            }
            case 'hide': {
                if (!tiktokSigningWindow || tiktokSigningWindow.isDestroyed()) {
                    return { success: false, error: 'Signing window not open', state: currentState() };
                }
                try { tiktokSigningWindow.hide(); } catch (_) { }
                return { success: true, state: currentState() };
            }
            case 'toggle-visibility': {
                if (!tiktokSigningWindow || tiktokSigningWindow.isDestroyed()) {
                    const win = await ensureWindow();
                    try { win.show(); win.focus(); } catch (_) { }
                    return { success: true, state: currentState() };
                }
                if (tiktokSigningWindow.isVisible() && !tiktokSigningWindow.isMinimized()) {
                    try { tiktokSigningWindow.hide(); } catch (_) { }
                } else {
                    try { tiktokSigningWindow.show(); tiktokSigningWindow.focus(); } catch (_) { }
                }
                return { success: true, state: currentState() };
            }
            case 'refresh': {
                if (!tiktokSigningWindow || tiktokSigningWindow.isDestroyed()) {
                    const win = await ensureWindow();
                    try { win.webContents.reload(); } catch (_) { }
                } else {
                    try { await tiktokSigningWindow.webContents.reload(); } catch (_) { }
                }
                return { success: true, state: currentState() };
            }
            case 'mute':
            case 'unmute':
            case 'toggle-mute': {
                if (!tiktokSigningWindow || tiktokSigningWindow.isDestroyed()) {
                    return { success: false, error: 'Signing window not open', state: currentState() };
                }
                const desired = action === 'mute'
                    ? true
                    : (action === 'unmute'
                        ? false
                        : !(tiktokSigningWindow.webContents?.isAudioMuted?.() || false));
                try {
                    tiktokSigningWindow.webContents.setAudioMuted(!!desired);
                } catch (_) { }
                return { success: true, state: currentState() };
            }
            case 'stop': {
                disposeTikTokSigningWindow();
                return { success: true, state: currentState() };
            }
            default:
                return { success: false, error: `Unknown action: ${action}`, state: currentState() };
        }
    } catch (error) {
        console.error('[TikTok] Signing window command failed:', error);
        return {
            success: false,
            error: error?.message || String(error),
            state: currentState()
        };
    }
});

ipcMain.handle("getTikTokCookies", async () => {
    try {
        const auth = new TikTokAuth(mainWindow);
        const credentials = await auth.getCookiesFromSession();
        return {
            success: true,
            credentials
        };
    } catch (error) {
        console.error('Failed to get TikTok cookies:', error);
        return {
            success: false,
            error: error.message
        };
    }
});

ipcMain.handle("promptTikTokCookies", async () => {
    try {
        const auth = new TikTokAuth(mainWindow);
        const credentials = await auth.promptForCookies();
        if (credentials) {
            return {
                success: true,
                credentials
            };
        } else {
            return {
                success: false,
                error: 'User cancelled'
            };
        }
    } catch (error) {
        console.error('Failed to prompt for TikTok cookies:', error);
        return {
            success: false,
            error: error.message
        };
    }
});

ipcMain.handle("getTikTokSignInStatus", async () => {
    if (!tiktokSigningWindow || tiktokSigningWindow.isDestroyed()) {
        // If window is closed, we assume not signed in (or unknown).
        // We could try to open it hidden to check, but that might be intrusive.
        // For now, let's just return false.
        return { signedIn: false, username: null };
    }
    if (!tikTokSignerHelper || typeof tikTokSignerHelper.readSessionIdFromSession !== 'function') {
        return { signedIn: false, error: 'Signer helper missing' };
    }
    try {
        const sessionId = await tikTokSignerHelper.readSessionIdFromSession(tiktokSigningWindow);

        let ttTargetIdc = null;
        try {
            let cookies = await tiktokSigningWindow.webContents.session.cookies.get({ url: 'https://www.tiktok.com/', name: 'tt_target_idc' });
            if (!cookies || cookies.length === 0) {
                cookies = await tiktokSigningWindow.webContents.session.cookies.get({ url: 'https://www.tiktok.com/', name: 'tt-target-idc' });
            }
            if (cookies && cookies.length > 0 && cookies[0].value) {
                ttTargetIdc = cookies[0].value;
            }
        } catch (_) { }

        return {
            signedIn: !!sessionId,
            hasTtTargetIdc: !!ttTargetIdc,
            username: null
        };
    } catch (error) {
        console.error('Failed to check TikTok sign-in status:', error);
        return { signedIn: false, error: error.message };
    }
});

ipcMain.handle("tiktokGenerateSigningParameters", async (_event, args = {}) => {
    if (!tikTokSignerHelper || typeof tikTokSignerHelper.injectCrawlerBundle !== 'function' || typeof tikTokSignerHelper.generateSigningParameters !== 'function') {
        return {
            success: false,
            error: 'TikTok signing helper is not available in this build.'
        };
    }

    const {
        pathWithQuery,
        urlToSign,
        landingUrl,
        browserName,
        browserVersion,
        userAgent,
        msToken,
        deviceId,
        roomId,
        email,
        validate,
        performFetch
    } = args;

    const normalizedLanding = typeof landingUrl === 'string' && landingUrl.trim()
        ? landingUrl.trim()
        : null;

    try {
        const signingWindow = await ensureTikTokSigningWindow(normalizedLanding, { allowNavigation: Boolean(normalizedLanding) });
        const activeUrl = (() => {
            try {
                const current = typeof signingWindow.webContents.getURL === 'function'
                    ? signingWindow.webContents.getURL()
                    : signingWindow.webContents.getURL;
                return typeof current === 'string' && current ? current : null;
            } catch (_) {
                return null;
            }
        })();
        const isTikTokOrigin = (() => {
            if (!activeUrl) {
                return false;
            }
            try {
                const parsed = new URL(activeUrl);
                return /(?:^|\.)tiktok\.com$/.test(parsed.hostname);
            } catch (_) {
                return false;
            }
        })();
        if (!isTikTokOrigin) {
            return {
                success: false,
                error: 'Open a TikTok live room in the helper window before generating signing keys.'
            };
        }
        const normalizedRoomId = typeof roomId === 'string' && roomId.trim() ? roomId.trim() : null;
        const normalizedEmail = typeof email === 'string' && email.trim() ? email.trim() : null;
        await tikTokSignerHelper.injectCrawlerBundle(signingWindow);
        const parameters = await tikTokSignerHelper.generateSigningParameters(signingWindow, {
            browserName: typeof browserName === 'string' && browserName.trim() ? browserName.trim() : 'Electron',
            browserVersion: typeof browserVersion === 'string' && browserVersion.trim() ? browserVersion.trim() : process.versions.electron,
            userAgent: typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : signingWindow.webContents.getUserAgent(),
            pathWithQuery: typeof pathWithQuery === 'string' && pathWithQuery.trim() ? pathWithQuery.trim() : null,
            urlToSign: typeof urlToSign === 'string' && urlToSign.trim() ? urlToSign.trim() : activeUrl,
            msToken: typeof msToken === 'string' && msToken.trim() ? msToken.trim() : null,
            deviceId: typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim() : undefined,
            roomId: normalizedRoomId,
            email: normalizedEmail,
            activeUrl: activeUrl || null,
            performFetch: !!performFetch
        });
        const sanitized = {
            device_id: parameters?.device_id || null,
            msToken: parameters?.msToken || '',
            "X-Bogus": parameters?.["X-Bogus"] || '',
            "X-Gnarly": parameters?.["X-Gnarly"] || '',
            "_signature": parameters?._signature || parameters?.signature || '',
            browserName: parameters?.browserName || 'Electron',
            browserVersion: parameters?.browserVersion || process.versions.electron,
            userAgent: parameters?.userAgent || signingWindow.webContents.getUserAgent(),
            pathWithQuery: parameters?.pathWithQuery || (typeof pathWithQuery === 'string' ? pathWithQuery : null)
        };

        // Attempt to extract session credentials from the signing window
        try {
            if (typeof tikTokSignerHelper.readSessionIdFromSession === 'function') {
                const sessionId = await tikTokSignerHelper.readSessionIdFromSession(signingWindow);
                if (sessionId) {
                    sanitized.sessionid = sessionId;
                }
            }

            // Also try to get tt_target_idc
            let cookies = await signingWindow.webContents.session.cookies.get({ url: 'https://www.tiktok.com/', name: 'tt_target_idc' });
            if (!cookies || cookies.length === 0) {
                cookies = await signingWindow.webContents.session.cookies.get({ url: 'https://www.tiktok.com/', name: 'tt-target-idc' });
            }
            if (cookies && cookies.length > 0 && cookies[0].value) {
                sanitized.tt_target_idc = cookies[0].value;
            }

            // Retrieve ALL cookies for the fallback fetch
            const allCookies = await signingWindow.webContents.session.cookies.get({ url: 'https://www.tiktok.com/' });
            if (allCookies && allCookies.length > 0) {
                sanitized.allCookies = allCookies.map(c => `${c.name}=${c.value}`).join('; ');
            }

            console.log('[TikTok] Generated signing parameters. SessionID present:', !!sanitized.sessionid, 'tt_target_idc present:', !!sanitized.tt_target_idc, 'allCookies length:', sanitized.allCookies ? sanitized.allCookies.length : 0);
        } catch (cookieError) {
            console.warn('[TikTok] Failed to read session cookies during signing generation:', cookieError);
        }
        if (parameters?.room_id) {
            sanitized.room_id = parameters.room_id;
        }
        if (parameters?.cursor) {
            sanitized.cursor = parameters.cursor;
        }
        if (parameters?.notice) {
            sanitized.notice = parameters.notice;
        }
        if (parameters?.fetchResult) {
            sanitized.fetchResult = parameters.fetchResult;
        }
        if (parameters?.fetchError) {
            sanitized.fetchError = parameters.fetchError;
        }
        const warnings = [];
        if (!sanitized.msToken) {
            warnings.push('msToken cookie not found. Stay signed into TikTok in the helper window and reload the live room.');
        }
        if (!sanitized["X-Bogus"]) {
            warnings.push('X-Bogus signature is empty. Ensure the helper window is on the same path or API URL you plan to call.');
        }
        if (!sanitized["X-Gnarly"]) {
            warnings.push('X-Gnarly signature was not returned. TikTok sometimes omits it, but double-check before relying on this payload.');
        }
        if (!sanitized["_signature"]) {
            warnings.push('_signature parameter missing from TikTok response.');
        }
        let validation = null;
        if (validate) {
            validation = await validateTikTokFetch(sanitized, {
                roomId: normalizedRoomId || sanitized.room_id,
                email: normalizedEmail,
                referer: activeUrl
            }).catch(error => ({
                attempted: true,
                ok: false,
                error: error && error.message ? error.message : String(error),
                timestamp: new Date().toISOString()
            }));
            if (validation && validation.error && !validation.ok) {
                warnings.push(validation.error);
            }
        }
        return {
            success: true,
            parameters: sanitized,
            warnings,
            validation
        };
    } catch (error) {
        console.error('Failed to generate TikTok signing parameters:', error?.stack || error);
        return {
            success: false,
            error: error && error.message ? error.message : 'Failed to generate signing parameters.'
        };
    }
});

// Handler for sending TikTok chat messages
ipcMain.handle("sendTikTokMessage", async (event, args) => {
    try {
        const {
            wssID,
            message
        } = args || {};

        const numericWssID = typeof wssID === 'number' ? wssID : Number.parseInt(wssID, 10);

        if (!Number.isFinite(numericWssID)) {
            return {
                success: false,
                error: 'Missing wssID or message'
            };
        }

        if (typeof message !== 'string' || !message.trim()) {
            return {
                success: false,
                error: 'Message must be a non-empty string'
            };
        }

        const connection = websocketConnections[numericWssID];
        if (!connection) {
            return {
                success: false,
                error: 'Connection not found'
            };
        }

        // Send the message
        const result = await connection.sendChatMessage(message);
        return result;

    } catch (error) {
        console.error('Error in sendTikTokMessage handler:', error);
        return {
            success: false,
            error: error.message
        };
    }
});

ipcMain.handle('kick-ws-connect', async (event, args = {}) => {
    const sender = event.sender;
    if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
        return { ok: false, error: 'Kick websocket sender not available.' };
    }

    const slug = normalizeKickSlug(args.slug || args.channel || args.username);
    if (!slug) {
        return { ok: false, error: 'Kick channel slug required.' };
    }

    logKickWs('Connect request', {
        slug,
        chatroomId: args.chatroomId ?? null,
        channelId: args.channelId ?? null,
        userId: args.userId ?? null,
        senderId: sender.id,
        force: Boolean(args.force),
        hasToken: typeof args.accessToken === 'string' && args.accessToken.trim().length > 0,
        hasClientId: typeof args.clientId === 'string' && args.clientId.trim().length > 0,
        hasSiteApiBase: typeof args.siteApiBase === 'string' && args.siteApiBase.trim().length > 0,
        allowProxy: args.allowProxy !== false
    });

    const existing = kickWsConnections.get(sender.id);
    if (existing) {
        if (existing.slug === slug && !args.force) {
            return {
                ok: true,
                connectionId: existing.id,
                slug: existing.client.slug || existing.slug,
                chatroomId: existing.client.chatroomId,
                channelId: existing.client.channelId,
                userId: existing.client.userId
            };
        }
        stopKickWsEntry(existing, 'replaced');
        kickWsConnections.delete(sender.id);
    }

    const connectionId = kickWsNextId++;
    const client = new KickWsClient({
        slug,
        chatroomId: args.chatroomId ?? null,
        channelId: args.channelId ?? null,
        userId: args.userId ?? null,
        userAgent: typeof args.userAgent === 'string' ? args.userAgent : undefined,
        accessToken: typeof args.accessToken === 'string' ? args.accessToken : undefined,
        clientId: typeof args.clientId === 'string' ? args.clientId : undefined,
        pusherKey: typeof args.pusherKey === 'string' ? args.pusherKey : undefined,
        pusherQuery: typeof args.pusherQuery === 'string' ? args.pusherQuery : undefined,
        siteApiBase: typeof args.siteApiBase === 'string' ? args.siteApiBase : undefined,
        siteApiProxyBase: typeof args.siteApiProxyBase === 'string' ? args.siteApiProxyBase : undefined,
        allowProxy: args.allowProxy !== false,
        logger: (...logArgs) => {
            try {
                console.log('[KickWs]', ...logArgs);
            } catch (_) {}
        }
    });

    const entry = {
        id: connectionId,
        slug,
        client,
        sender,
        createdAt: Date.now(),
        chatLogCount: 0
    };
    kickWsConnections.set(sender.id, entry);

    const statusHandler = (payload) => {
        logKickWs('Status update', {
            connectionId,
            slug: client.slug || slug,
            status: payload?.status,
            error: payload?.error || payload?.reason || null
        });
        sendKickWsStatus(sender, {
            connectionId,
            slug: client.slug || slug,
            chatroomId: client.chatroomId,
            channelId: client.channelId,
            userId: client.userId,
            ...payload
        });
    };

    const resolvedHandler = (payload) => {
        logKickWs('Resolved IDs', {
            connectionId,
            slug: payload.slug || client.slug || slug,
            chatroomId: payload.chatroomId || client.chatroomId,
            channelId: payload.channelId || client.channelId,
            userId: payload.userId || client.userId
        });
        sendKickWsStatus(sender, {
            connectionId,
            status: client.status || 'connecting',
            resolved: true,
            slug: payload.slug || client.slug || slug,
            chatroomId: payload.chatroomId || client.chatroomId,
            channelId: payload.channelId || client.channelId,
            userId: payload.userId || client.userId
        });
    };

    const chatHandler = (message) => {
        if (entry.chatLogCount < 3) {
            entry.chatLogCount += 1;
            logKickWs('Chat message received', {
                connectionId,
                messageId: message?.id || message?.message_id || null
            });
        }
        const packet = buildKickSocketPacket(message, client);
        packet.connectionId = connectionId;
        sendKickWsEvent(sender, packet);
    };

    client.on('status', statusHandler);
    client.on('resolved', resolvedHandler);
    client.on('chat', chatHandler);
    // Non-chat events are ignored here; alerts flow through the webhook bridge.

    sender.once('destroyed', () => {
        const current = kickWsConnections.get(sender.id);
        if (current && current.id === connectionId) {
            stopKickWsEntry(current, 'sender_destroyed');
            kickWsConnections.delete(sender.id);
        }
    });

    try {
        await client.connect();
        logKickWs('Connect success', {
            connectionId,
            slug: client.slug || slug,
            chatroomId: client.chatroomId,
            channelId: client.channelId,
            userId: client.userId
        });
        return {
            ok: true,
            connectionId,
            slug: client.slug || slug,
            chatroomId: client.chatroomId,
            channelId: client.channelId,
            userId: client.userId
        };
    } catch (error) {
        logKickWs('Connect failed', {
            connectionId,
            slug,
            error: error?.message || String(error)
        });
        statusHandler({ status: 'error', error: error?.message || String(error) });
        return { ok: false, error: error?.message || String(error) };
    }
});

ipcMain.handle('kick-ws-disconnect', async (event, args = {}) => {
    const sender = event.sender;
    if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
        return { ok: false, error: 'Kick websocket sender not available.' };
    }
    const targetId = typeof args.connectionId === 'number' ? args.connectionId : null;
    let entry = kickWsConnections.get(sender.id);
    if (!entry && targetId != null) {
        for (const candidate of kickWsConnections.values()) {
            if (candidate.id === targetId) {
                entry = candidate;
                break;
            }
        }
    }
    if (!entry) {
        return { ok: false, error: 'Kick websocket connection not found.' };
    }
    logKickWs('Disconnect requested', {
        connectionId: entry.id,
        slug: entry.slug || entry.client?.slug || null
    });
    stopKickWsEntry(entry, 'user_disconnect');
    const deleteKey = entry.sender && entry.sender.id ? entry.sender.id : sender.id;
    kickWsConnections.delete(deleteKey);
    return { ok: true };
});
