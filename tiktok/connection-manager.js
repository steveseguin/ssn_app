'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const {
    cleanVisibleString,
    firstNonEmptyVisibleString,
    normalizeTikTokImageUrl,
    collectTikTokBadges,
    getBadgeImageUrl
} = require('../tiktok-badges');
const giftMapping = require('./gift-mapping.json');
const reporter = require('../error-reporter');

let connectorDeserializeMessage = null;
try {
    ({ deserializeMessage: connectorDeserializeMessage } = require('tiktok-live-connector/dist/lib/utilities'));
} catch (_) {
    connectorDeserializeMessage = null;
}

let SendRoomChatRoute = null;
try {
    ({ SendRoomChatRoute } = require('tiktok-live-connector/dist/lib/web/routes/send-room-chat.js'));
} catch (error) {
    SendRoomChatRoute = null;
    if (process.env.SSAPP_DISABLE_DIRECT_TIKTOK_CHAT !== '1') {
        console.info('[TikTok] Direct room/chat route unavailable; continuing to use Euler chat endpoint.');
    }
}

const isDirectChatRouteSupported = typeof SendRoomChatRoute === 'function';
const disableDirectChatRoute = process.env.SSAPP_DISABLE_DIRECT_TIKTOK_CHAT === '1';
const {
    createWebSocketUrl: createEulerWebSocketUrl,
    normalizeUniqueId: normalizeEulerUniqueId,
    deserializeWebSocketMessage,
    SchemaVersion
} = require('@eulerstream/euler-websocket-sdk');
const { WebcastEventMap, WebcastEvent } = require('tiktok-live-connector/dist/types/events');
const { ControlAction, GiftMessageIgnoreConfig } = require('tiktok-live-connector/dist/types/tiktok/enums');

(function applyAnchorIdentityPatch() {
    try {
        const wsClientPath = require.resolve('tiktok-live-connector/dist/lib/ws/lib/ws-client.js');
        const content = fs.readFileSync(wsClientPath, 'utf8');
        if (content.includes("identity: 'audience',") && !content.includes("identity: 'anchor',")) {
            const patched = content.replace("identity: 'audience',", "identity: 'anchor',");
            fs.writeFileSync(wsClientPath, patched, 'utf8');
            console.log('[TikTok] Applied runtime anchor identity patch to ws-client.js');
        }
    } catch (_) { }
})();

const env = {
    shouldEnableTikTokLogging: false,
    resolveLogDirectory: null,
    getMainWindow: () => null,
    browserViews: Object.create(null),
    websocketConnections: Object.create(null),
    log: (...args) => console.log(...args),
    onStatus: () => { },
    isCaptureEventsEnabled: () => false,
    isCaptureJoinedEventEnabled: () => false,
    isCaptureLikedEventEnabled: () => false,
    isViewerUpdateAllowed: () => false,
    isTextOnlyModeEnabled: () => false,
    getCachedSettings: () => ({}),
    onEvent: () => { },
    isDevMode: () => false
};

const EULER_SIGNING_HOST = 'tiktok.eulerstream.com';
let activeAuthWsHostRef = { count: 0, host: null };

const SIGNING_SERVICE_HELP_URL = (process.env.SSAPP_TIKTOK_SIGNING_GUIDE_URL && process.env.SSAPP_TIKTOK_SIGNING_GUIDE_URL.trim())
    ? process.env.SSAPP_TIKTOK_SIGNING_GUIDE_URL.trim()
    : 'https://github.com/SocialStreamNinja/ssapp/wiki/TikTok-Signing';
const EULER_DASHBOARD_URL = 'https://www.eulerstream.com/dashboard';
const EULER_RATE_LIMITS_URL = 'https://www.eulerstream.com/docs/sign-server/rate-limits';
const SHARED_EULER_SIGNING_FALLBACK_KEY = (process.env.SSAPP_TIKTOK_SHARED_EULER_SIGNING_KEY && process.env.SSAPP_TIKTOK_SHARED_EULER_SIGNING_KEY.trim())
    ? process.env.SSAPP_TIKTOK_SHARED_EULER_SIGNING_KEY.trim()
    : 'euler_OTlhOWRhNGRiZGYxM2U1MTQyY2EzNDA0ZTdlNDgyMjkxOGRkZjIzNmNhODIyOTExZjE4MDVk';
const SHARED_EULER_PROXY_FALLBACK_KEY = (process.env.SSAPP_TIKTOK_SHARED_EULER_PROXY_KEY && process.env.SSAPP_TIKTOK_SHARED_EULER_PROXY_KEY.trim())
    ? process.env.SSAPP_TIKTOK_SHARED_EULER_PROXY_KEY.trim()
    : 'euler_ZjE0MTMwMWJiMGJkZmI3OTFjMWM0NDI2ZTk0MWEzZmQwODY5NGQwMTMyMWU1MWM3NzBjMzkz';

const TIKTOK_LOG_SUBDIR = 'tiktok-logs';
let cachedTikTokLogDir = null;
let connectionStates = new Map();
let TikTokLiveConnectionClass = null;
let TikTokPollingFallbackClass = null;
let usingLegacyTikTokConnector = false;
let EulerSignerClass = null;
const SIGN_SERVER_FAILURE_FALLBACK_THRESHOLD = 3;
const DEFAULT_TIKTOK_WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
const EULER_WS_PROVIDER = 'euler-ws';
const GIFT_IGNORE_CONFIG_NOT_IGNORE = Number.isFinite(Number(GiftMessageIgnoreConfig?.GIFT_MESSAGE_IGNORE_CONFIG_NOT_IGNORE))
    ? Number(GiftMessageIgnoreConfig.GIFT_MESSAGE_IGNORE_CONFIG_NOT_IGNORE)
    : 0;
const GIFT_IGNORE_CONFIG_IGNORE_TRAY = Number.isFinite(Number(GiftMessageIgnoreConfig?.GIFT_MESSAGE_IGNORE_CONFIG_IGNORE_TRAY))
    ? Number(GiftMessageIgnoreConfig.GIFT_MESSAGE_IGNORE_CONFIG_IGNORE_TRAY)
    : 1;
const GIFT_IGNORE_CONFIG_IGNORE_TRAY_AND_PS_M = Number.isFinite(Number(GiftMessageIgnoreConfig?.GIFT_MESSAGE_IGNORE_CONFIG_IGNORE_TRAY_AND_PS_M))
    ? Number(GiftMessageIgnoreConfig.GIFT_MESSAGE_IGNORE_CONFIG_IGNORE_TRAY_AND_PS_M)
    : 3;
const GIFT_IGNORE_CONFIG_HIDE_TRAY_VALUES = new Set([
    GIFT_IGNORE_CONFIG_IGNORE_TRAY,
    GIFT_IGNORE_CONFIG_IGNORE_TRAY_AND_PS_M
]);

class EulerWebsocketServerConnection extends EventEmitter {
    constructor(uniqueId, options = {}) {
        super();
        this.uniqueId = normalizeEulerUniqueId(typeof uniqueId === 'string' ? uniqueId : '');
        this.apiKey = typeof options.apiKey === 'string' && options.apiKey.trim() ? options.apiKey.trim() : null;
        this.jwtKey = typeof options.jwtKey === 'string' && options.jwtKey.trim() ? options.jwtKey.trim() : null;
        this.features = options.features || {};
        this.roomId = options.roomId || null;
        this.isConnected = false;
        this.enableExtendedGiftInfo = false;
        this.ws = null;
    }

    async connect() {
        const urlOptions = {
            uniqueId: this.uniqueId,
            ...(this.apiKey ? { apiKey: this.apiKey } : {}),
            ...(this.jwtKey ? { jwtKey: this.jwtKey } : {}),
            features: {
                rawMessages: true,
                bundleEvents: true,
                ...(this.features || {})
            }
        };
        const url = createEulerWebSocketUrl(urlOptions);
        
        // Debug: Log connection details (mask API key for security)
        const maskedKey = this.apiKey ? `${this.apiKey.slice(0, 10)}...${this.apiKey.slice(-4)}` : null;
        console.log('[EulerWS] Connecting:', {
            uniqueId: this.uniqueId,
            hasApiKey: !!this.apiKey,
            apiKeyPreview: maskedKey,
            hasJwtKey: !!this.jwtKey,
            urlPreview: url.replace(/apiKey=[^&]+/, 'apiKey=***').replace(/jwtKey=[^&]+/, 'jwtKey=***')
        });

        return new Promise((resolve, reject) => {
            try {
                const socket = new WebSocket(url);
                this.ws = socket;

                const finalize = (fn) => {
                    try {
                        fn();
                    } catch (_) { }
                };

                socket.on('open', () => {
                    this.isConnected = true;
                    this.emit('websocketConnected');
                    resolve(true);
                });

                socket.on('message', (data) => this.handleMessage(data));

                socket.on('close', (code, reason) => {
                    this.isConnected = false;
                    const reasonStr = reason ? reason.toString() : '';
                    // Log close code for debugging - see https://www.eulerstream.com/docs/sign-server/websockets
                    const codeLabels = {
                        1000: 'NORMAL',
                        1011: 'INTERNAL_SERVER_ERROR',
                        4005: 'STREAM_END',
                        4006: 'NO_MESSAGES_TIMEOUT',
                        4400: 'INVALID_OPTIONS',
                        4401: 'INVALID_AUTH',
                        4403: 'NO_PERMISSION',
                        4404: 'NOT_LIVE',
                        4429: 'TOO_MANY_CONNECTIONS',
                        4500: 'TIKTOK_CLOSED_CONNECTION',
                        4555: 'MAX_LIFETIME_EXCEEDED',
                        4556: 'WEBCAST_FETCH_ERROR',
                        4557: 'ROOM_INFO_FETCH_ERROR'
                    };
                    const codeLabel = codeLabels[code] || 'UNKNOWN';
                    console.warn(`[EulerWS] WebSocket closed: code=${code} (${codeLabel})${reasonStr ? `, reason=${reasonStr}` : ''}`);
                    this.emit('disconnect', {
                        code,
                        reason: reasonStr,
                        codeLabel
                    });
                });

                socket.on('error', (error) => {
                    this.emit('error', error);
                    if (!this.isConnected) {
                        reject(error);
                    }
                });

                socket.on('unexpected-response', (_req, res) => {
                    const status = res && res.statusCode ? res.statusCode : null;
                    const statusText = res && res.statusMessage ? res.statusMessage : '';
                    const err = new Error(`Euler WebSocket server rejected connection${status ? ` (${status}${statusText ? ` ${statusText}` : ''})` : ''}`);
                    this.emit('error', err);
                    if (!this.isConnected) {
                        reject(err);
                    }
                    finalize(() => socket.close());
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    async disconnect() {
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
            } catch (_) { }
            try {
                this.ws.close();
            } catch (_) { }
        }
        this.ws = null;
        this.isConnected = false;
    }

    handleMessage(data) {
        const buffer = Buffer.isBuffer(data)
            ? data
            : (data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(String(data)));

        this.emit('websocketData', buffer);

        // First, try to parse as JSON (room info is sent as JSON on first message)
        try {
            const text = buffer.toString('utf8');
            if (text.startsWith('{') || text.startsWith('[')) {
                const jsonData = JSON.parse(text);
                // Room info message from Euler WS
                if (jsonData.roomInfo || jsonData.room_id || jsonData.uniqueId) {
                    console.log('[EulerWS] Received room info:', jsonData.uniqueId || jsonData.room_id);
                    this.roomId = jsonData.room_id || jsonData.roomInfo?.roomId || this.roomId;
                    this.emit('roomInfo', jsonData);
                    return;
                }
                // Other JSON messages
                this.emit('jsonMessage', jsonData);
                return;
            }
        } catch (_jsonErr) {
            // Not JSON, continue to protobuf parsing
        }

        // Parse as protobuf - try v2 first, then v1 as fallback
        let decodedFrame = null;
        let parseError = null;
        try {
            decodedFrame = deserializeWebSocketMessage(buffer, SchemaVersion.v2);
        } catch (v2Error) {
            parseError = v2Error;
            // Try v1 schema as fallback
            try {
                decodedFrame = deserializeWebSocketMessage(buffer, SchemaVersion.v1);
                parseError = null; // v1 worked
            } catch (v1Error) {
                // Both failed - log but continue
            }
        }
        if (parseError) {
            // Log but don't emit error - protobuf parse failures on individual messages
            // shouldn't kill the connection. This can happen with new/unknown message types.
            const errMsg = parseError?.message || String(parseError);
            console.warn('[EulerWS] Protobuf parse warning (continuing):', errMsg.slice(0, 100));
            // Don't emit error - just skip this message
            return;
        }

        const messages = decodedFrame?.protoMessageFetchResult?.messages;
        if (!Array.isArray(messages)) {
            return;
        }

        for (const message of messages) {
            const decodedData = message?.decodedData;
            if (!decodedData) continue;

            this.emit('decodedData', decodedData.type, decodedData.data, message.payload);
            this.forwardDecodedData(decodedData);
        }
    }

    forwardDecodedData(decoded) {
        if (!decoded || !decoded.type) return;
        const { type, data } = decoded;

        switch (type) {
            case 'WebcastSocialMessage': {
                const displayType = typeof data?.common?.displayText?.displayType === 'string'
                    ? data.common.displayText.displayType.toLowerCase()
                    : '';
                const displayLabel = typeof data?.common?.displayText?.defaultPattern === 'string'
                    ? data.common.displayText.defaultPattern.toLowerCase()
                    : '';
                if (displayType.includes('follow') || displayLabel.includes('follow')) {
                    this.emit(WebcastEvent.FOLLOW, data);
                    return;
                }
                if (displayType.includes('share') || displayLabel.includes('share')) {
                    this.emit(WebcastEvent.SHARE, data);
                    return;
                }
                if (isLikelySubscribeSignal(displayType) || isLikelySubscribeSignal(displayLabel)) {
                    this.emit('subscribe', data);
                    return;
                }
                this.emit(WebcastEvent.SOCIAL, data);
                return;
            }
            case 'WebcastControlMessage': {
                this.emit(WebcastEvent.CONTROL_MESSAGE, data);
                if (data && (data.action === ControlAction.CONTROL_ACTION_STREAM_ENDED || data.action === ControlAction.CONTROL_ACTION_STREAM_SUSPENDED)) {
                    this.emit(WebcastEvent.STREAM_END, { action: data.action });
                    this.disconnect();
                }
                return;
            }
            case 'WebcastGiftMessage': {
                this.emit(WebcastEvent.GIFT, data);
                return;
            }
            case 'WebcastBarrageMessage': {
                if (data?.content?.displayType?.includes('ttlive_superFan')) {
                    this.emit(WebcastEvent.SUPER_FAN, data);
                }
                this.emit(WebcastEvent.BARRAGE, data);
                return;
            }
            default: {
                const basicEvent = WebcastEventMap[type];
                if (basicEvent) {
                    this.emit(basicEvent, data);
                } else {
                    this.emit('rawData', type, data);
                }
            }
        }
    }

    async sendMessage() {
        throw new Error('Euler WebSocket relay does not support outbound chat sends.');
    }
}

function isLikelySubscribeSignal(value) {
    if (typeof value !== 'string' || !value) return false;
    const lowered = value.toLowerCase();
    if (lowered.includes('subscrib') || lowered.includes('membership')) return true;
    return /(^|[^a-z])sub([^a-z]|$)/.test(lowered);
}

function log(...args) {
    try {
        env.log(...args);
    } catch (_) {
        console.log(...args);
    }
}

function isDevBuild() {
    try {
        return typeof env.isDevMode === 'function' && !!env.isDevMode();
    } catch (_) {
        return false;
    }
}

function shouldLogTikTokDebug() {
    if (process.env.SSAPP_TIKTOK_DEBUG === '1') {
        return true;
    }
    return isDevBuild();
}

function summarizeSignerPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const allCookies = typeof payload.allCookies === 'string' ? payload.allCookies : '';
    const fetchResult = payload.fetchResult && typeof payload.fetchResult === 'object' ? payload.fetchResult : null;
    const fetchBodyBase64 = fetchResult && typeof fetchResult.bodyBase64 === 'string' ? fetchResult.bodyBase64 : '';
    return {
        hasMsToken: !!(payload.msToken || payload.ms_token),
        hasSessionId: !!(payload.sessionid || payload.session_id),
        hasTtTargetIdc: !!(payload.tt_target_idc || payload.ttTargetIdc),
        hasUserAgent: !!(payload.userAgent || payload.user_agent),
        hasPathWithQuery: typeof payload.pathWithQuery === 'string' && payload.pathWithQuery.length > 0,
        allCookiesLength: allCookies ? allCookies.length : 0,
        fetchResult: fetchResult
            ? {
                status: fetchResult.status ?? null,
                statusText: typeof fetchResult.statusText === 'string' ? fetchResult.statusText : null,
                bodyBase64Length: fetchBodyBase64 ? fetchBodyBase64.length : 0,
                hasBodyBase64: !!fetchBodyBase64
            }
            : null,
        hasFetchError: !!payload.fetchError
    };
}

function sleep(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepWithStop(manager, ms) {
    const total = Number(ms);
    if (!Number.isFinite(total) || total <= 0) {
        return;
    }
    const sliceMs = 1000;
    let remaining = total;
    while (remaining > 0) {
        if (manager && manager.isStopped) {
            const stoppedError = new Error('Connection stopped');
            stoppedError.code = 'SSAPP_TIKTOK_STOPPED';
            throw stoppedError;
        }
        const step = Math.min(remaining, sliceMs);
        await sleep(step);
        remaining -= step;
    }
}

const localSignerSessionGate = {
    tail: Promise.resolve(),
    nextAllowedAt: 0,
    cooldownUntil: 0,
    cooldownReason: null,
    perUniqueIdNextAllowedAt: new Map()
};

function getLocalSignerMinAttemptIntervalMs() {
    const raw = Number(CONFIG?.CONNECTION?.LOCAL_SIGNER_MIN_ATTEMPT_INTERVAL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

function setLocalSignerCooldown(untilEpochMs, reason) {
    const until = Number(untilEpochMs);
    if (!Number.isFinite(until) || until <= 0) {
        return;
    }
    if (until > localSignerSessionGate.cooldownUntil) {
        localSignerSessionGate.cooldownUntil = until;
        localSignerSessionGate.cooldownReason = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
    }
}

async function runWithLocalSignerSessionGate(manager, uniqueId, taskName, fn) {
    const previous = localSignerSessionGate.tail;
    let release = null;
    localSignerSessionGate.tail = new Promise((resolve) => { release = resolve; });
    await previous;

    const key = typeof uniqueId === 'string' && uniqueId.trim() ? uniqueId.trim().toLowerCase() : null;
    const minIntervalMs = getLocalSignerMinAttemptIntervalMs();

    try {
        if (manager && manager.isStopped) {
            const stoppedError = new Error('Connection stopped');
            stoppedError.code = 'SSAPP_TIKTOK_STOPPED';
            throw stoppedError;
        }

        const now = Date.now();
        const globalAllowedAt = localSignerSessionGate.nextAllowedAt || 0;
        const perAllowedAt = key ? (localSignerSessionGate.perUniqueIdNextAllowedAt.get(key) || 0) : 0;
        const cooldownUntil = localSignerSessionGate.cooldownUntil || 0;
        const allowedAt = Math.max(globalAllowedAt, perAllowedAt, cooldownUntil);
        const waitMs = allowedAt - now;

        if (waitMs > 0) {
            manager?.logDebug?.('sign.local.throttle_wait', {
                task: taskName || null,
                waitMs,
                cooldownReason: localSignerSessionGate.cooldownReason || null
            });
            await sleepWithStop(manager, waitMs);
        }

        return await fn();
    } finally {
        const nextAt = Date.now() + minIntervalMs;
        localSignerSessionGate.nextAllowedAt = Math.max(localSignerSessionGate.nextAllowedAt || 0, nextAt);
        if (key) {
            const existing = localSignerSessionGate.perUniqueIdNextAllowedAt.get(key) || 0;
            // Prune stale entries to prevent unbounded growth
            if (localSignerSessionGate.perUniqueIdNextAllowedAt.size > 500) {
                const now = Date.now();
                for (const [k, v] of localSignerSessionGate.perUniqueIdNextAllowedAt) {
                    if (v < now) localSignerSessionGate.perUniqueIdNextAllowedAt.delete(k);
                }
            }
            localSignerSessionGate.perUniqueIdNextAllowedAt.set(key, Math.max(existing, nextAt));
        }
        try { release && release(); } catch (_) { /* noop */ }
    }
}

function readHeaderCaseInsensitive(headers, targetName) {
    if (!headers || typeof headers !== 'object') {
        return null;
    }
    const name = typeof targetName === 'string' ? targetName.toLowerCase() : '';
    if (!name) {
        return null;
    }
    if (headers[name] !== undefined) {
        return headers[name];
    }
    for (const [key, value] of Object.entries(headers)) {
        if (typeof key === 'string' && key.toLowerCase() === name) {
            return value;
        }
    }
    return null;
}

function parseRetryAfterSeconds(value) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.floor(value));
    }
    const raw = typeof value === 'string' ? value.trim() : String(value).trim();
    if (!raw) {
        return null;
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
        return Math.max(0, Math.floor(numeric));
    }
    const epoch = Date.parse(raw);
    if (Number.isFinite(epoch)) {
        const deltaMs = epoch - Date.now();
        if (deltaMs <= 0) {
            return 0;
        }
        return Math.ceil(deltaMs / 1000);
    }
    return null;
}

function getMainWindow() {
    try {
        const win = env.getMainWindow ? env.getMainWindow() : null;
        return win || null;
    } catch (_) {
        return null;
    }
}

function normalizeSigningServiceUrlInput(rawValue) {
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

function normalizeSigningConfig(signing) {
    if (!signing || typeof signing !== 'object') {
        return null;
    }
    const apiKey = typeof signing.apiKey === 'string' ? signing.apiKey.trim() : '';
    const serviceUrl = normalizeSigningServiceUrlInput(typeof signing.serviceUrl === 'string' ? signing.serviceUrl : '');
    if (!apiKey && !serviceUrl) {
        return null;
    }
    return {
        apiKey: apiKey || null,
        serviceUrl: serviceUrl || null
    };
}

function parseHostAllowlist(rawValue) {
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
        return new Set();
    }
    return new Set(
        rawValue
            .split(/[,\s]+/)
            .map(value => value.trim().toLowerCase())
            .filter(Boolean)
    );
}

function isLoopbackHostname(hostname) {
    const normalized = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';
    return normalized === 'localhost'
        || normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '[::1]';
}

function resolveSourceIdForPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.sourceId) return payload.sourceId;
    const wssId = typeof payload.wssID === 'number' ? payload.wssID : null;
    if (!wssId) return null;
    try {
        const connections = env.websocketConnections || {};
        const manager = connections[wssId];
        if (manager && manager.sourceId) {
            return manager.sourceId;
        }
    } catch (_) { }
    return null;
}

function normalizeStatusPayload(payload) {
    if (payload && typeof payload === 'object') {
        return payload;
    }
    return { message: payload };
}

function emitStatus(payload) {
    const normalizedPayload = normalizeStatusPayload(payload);
    if (!normalizedPayload.sourceId) {
        const resolvedSourceId = resolveSourceIdForPayload(normalizedPayload);
        if (resolvedSourceId) {
            normalizedPayload.sourceId = resolvedSourceId;
        }
    }

    try {
        env.onStatus(normalizedPayload);
    } catch (error) {
        console.warn('Failed to emit TikTok status update:', error);
    }

    const mainWindow = getMainWindow();
    if (mainWindow && mainWindow.webContents) {
        try {
            mainWindow.webContents.send('tiktokConnectionStatus', normalizedPayload);
        } catch (error) {
            console.warn('Failed to forward TikTok status to renderer:', error);
        }
    }
}

function ensureTikTokLogDir() {
    if (cachedTikTokLogDir) {
        return cachedTikTokLogDir;
    }

    let baseDir = null;
    try {
        if (typeof env.resolveLogDirectory === 'function') {
            baseDir = env.resolveLogDirectory();
        } else if (typeof env.resolveLogDirectory === 'string') {
            baseDir = env.resolveLogDirectory;
        }
    } catch (error) {
        console.warn('Failed to resolve TikTok log directory:', error);
        baseDir = null;
    }

    if (!baseDir) {
        cachedTikTokLogDir = null;
        return null;
    }

    const logDir = path.join(baseDir, TIKTOK_LOG_SUBDIR);
    try {
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

function sanitizeForFilename(input) {
    if (input === null || input === undefined) return 'tiktok';
    return String(input)
        .replace(/[^a-z0-9-_]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || 'tiktok';
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

function createTikTokLogWriter(username, wssID) {
    if (!env.shouldEnableTikTokLogging) {
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

function getCachedSettings() {
    try {
        const settings = env.getCachedSettings();
        return (settings && typeof settings === 'object') ? settings : {};
    } catch (_) {
        return {};
    }
}

function isCaptureEventsEnabled() {
    try {
        return !!env.isCaptureEventsEnabled();
    } catch (_) {
        return false;
    }
}

function isCaptureJoinedEventEnabled() {
    try {
        return !!env.isCaptureJoinedEventEnabled();
    } catch (_) {
        return false;
    }
}

function isCaptureLikedEventEnabled() {
    try {
        return !!env.isCaptureLikedEventEnabled();
    } catch (_) {
        return false;
    }
}

function isViewerUpdateAllowed() {
    try {
        return !!env.isViewerUpdateAllowed();
    } catch (_) {
        return false;
    }
}

function isTextOnlyModeEnabled() {
    try {
        return !!env.isTextOnlyModeEnabled();
    } catch (_) {
        return false;
    }
}

/**
 * Install additional fallback logic into the provided TikTok Live connector module.
 * Mirrors the existing application behaviour so we can share the same logic between
 * the Electron app and standalone test harnesses.
 *
 * @param {object} connector - The tiktok-live-connector module instance.
 */
function installTikTokSignServerFallback(connector) {
    if (!connector || typeof connector !== 'object') {
        return;
    }

    const { TikTokSignClient, errors } = connector;
    if (!TikTokSignClient || typeof TikTokSignClient !== 'function') {
        return;
    }
    if (TikTokSignClient.prototype.__ssappFallbackPatched) {
        return;
    }

    const {
        SignAPIError,
        ErrorReason,
        SignatureRateLimitError,
        PremiumFeatureError
    } = errors || {};

    if (!SignAPIError || !ErrorReason) {
        return;
    }

    const {
        deserializeMessage,
        toBuffer,
        getHeader
    } = connector.utils || {};

    if (typeof deserializeMessage !== 'function' ||
        typeof toBuffer !== 'function' ||
        typeof getHeader !== 'function') {
        return;
    }

    const RouteClass = TikTokSignClient.__routeClass;
    if (!RouteClass) {
        return;
    }

    const originalHandleResponse = RouteClass.prototype.handleResponse;
    if (typeof originalHandleResponse !== 'function') {
        return;
    }

    RouteClass.prototype.handleResponse = async function patchedHandleResponse(response, requestOptions) {
        const clientEnterAttempts = [
            requestOptions?.client_enter !== undefined ? !!requestOptions.client_enter : true,
            false
        ];

        let lastConnectorError = null;
        for (let attemptIndex = 0; attemptIndex < clientEnterAttempts.length; attemptIndex++) {
            const clientEnterFlag = clientEnterAttempts[attemptIndex];
            const nextOptions = {
                ...requestOptions,
                client_enter: clientEnterFlag
            };

            try {
                response = await this.webClient.request({
                    ...nextOptions,
                    client_enter: clientEnterFlag
                });
            } catch (err) {
                lastConnectorError = err;
                continue;
            }

            const status = response?.status;
            if (status === 429) {
                const data = JSON.parse(toBuffer(response.data).toString('utf-8'));
                const message = process.env.SIGN_SERVER_MESSAGE_DISABLED ? null : data?.message;
                const label = data?.limit_label ? `(${data.limit_label}) ` : '';
                throw new SignatureRateLimitError(message, `${label}Too many connections started, try again later.`, response);
            }
            if (status === 402) {
                const data = JSON.parse(toBuffer(response.data).toString('utf-8'));
                const message = process.env.SIGN_SERVER_MESSAGE_DISABLED ? null : data?.message;
                throw new PremiumFeatureError(message, 'Error fetching the signed TikTok WebSocket');
            }
            if (status !== 200) {
                if (clientEnterFlag && status >= 500 && attemptIndex < clientEnterAttempts.length - 1) {
                    continue;
                }
                let payload;
                try {
                    payload = toBuffer(response.data).toString('utf-8');
                } catch {
                    payload = `"${response.statusText}"`;
                }
                const logIdRaw = getHeader(response.headers, 'X-Log-Id');
                const agentId = getHeader(response.headers, 'X-Agent-ID');
                throw new SignAPIError(
                    ErrorReason.SIGN_NOT_200,
                    logIdRaw ? parseInt(logIdRaw) : undefined,
                    agentId,
                    `Unexpected sign server status ${status}. Payload:\n${payload}`
                );
            }

            const dataBuffer = toBuffer(response.data);
            if (!dataBuffer.length && response?.data) {
                console.warn('[TikTok] Euler payload could not be buffered, raw shape:', Object.prototype.toString.call(response.data));
            }
            console.warn(`[TikTok] Euler payload attempt ${attemptIndex + 1}/${clientEnterAttempts.length} (clientEnter=${clientEnterFlag}) length=${dataBuffer.length}`);
            const logIdRaw = getHeader(response.headers, 'X-Log-Id');
            const agentId = getHeader(response.headers, 'X-Agent-ID');
            const setCookieHeader = getHeader(response.headers, 'x-set-tt-cookie');
            if (!setCookieHeader) {
                throw new SignAPIError(ErrorReason.EMPTY_COOKIES, logIdRaw ? parseInt(logIdRaw) : undefined, agentId, 'No cookies received from sign server.');
            }
            this.webClient.cookieJar.processSetCookieHeader(setCookieHeader);
            const nextRoomId = getHeader(response.headers, 'x-room-id');
            if (nextRoomId) {
                this.webClient.roomId = nextRoomId;
            }
            try {
                if (dataBuffer.length < 32) {
                    console.warn('[TikTok] Euler payload preview (hex):', dataBuffer.toString('hex'));
                }
                return deserializeMessage('ProtoMessageFetchResult', dataBuffer);
            } catch (decodeError) {
                if (clientEnterFlag && attemptIndex < clientEnterAttempts.length - 1) {
                    console.warn('[TikTok] Euler payload decode failed, retrying with clientEnter=false:', decodeError?.message || decodeError);
                    decodeError.ssappFallback = true;
                    decodeError.ssappFallbackMode = 'polling';
                    decodeError.code = decodeError.code || 'SSAPP_TIKTOK_FALLBACK';
                    decodeError.payloadLength = dataBuffer.length;
                    decodeError.payloadPreviewHex = dataBuffer.subarray(0, Math.min(dataBuffer.length, 64)).toString('hex');
                    continue;
                }
                console.warn('[TikTok] Euler payload decode failed (no further retries):', decodeError?.message || decodeError);
                decodeError.ssappFallback = true;
                decodeError.ssappFallbackMode = 'polling';
                decodeError.code = decodeError.code || 'SSAPP_TIKTOK_FALLBACK';
                decodeError.payloadLength = dataBuffer.length;
                decodeError.payloadPreviewHex = dataBuffer.subarray(0, Math.min(dataBuffer.length, 64)).toString('hex');
                throw decodeError;
            }
        }
        const args = ['Failed to connect to sign server.'];
        if (lastConnectorError?.message) {
            args.push(lastConnectorError.message);
        }
        throw new SignAPIError(ErrorReason.CONNECT_ERROR, undefined, undefined, ...args);
    };
    RouteClass.prototype.__ssappFallbackPatched = true;
    console.info('[TikTok] Sign server fallback patch installed (clientEnter retry enabled)');
}

function installTikTokProtoFetchTap(connector) {
    if (!connector || typeof connector !== 'object') {
        return;
    }

    const tapClass = (ClassRef) => {
        if (!ClassRef || !ClassRef.prototype || ClassRef.prototype.__ssappProtoFetchPatched) {
            return;
        }
        const original = ClassRef.prototype.processProtoMessageFetchResult;
        if (typeof original !== 'function') {
            return;
        }
        ClassRef.prototype.processProtoMessageFetchResult = async function patchedProtoFetch(result, ...args) {
            try {
                if (result && typeof this.emit === 'function') {
                    this.emit('ssappProtoFetch', result);
                }
            } catch (_) { /* noop */ }
            return original.call(this, result, ...args);
        };
        ClassRef.prototype.__ssappProtoFetchPatched = true;
    };

    tapClass(connector.TikTokLiveConnection);
    tapClass(connector.WebcastPushConnection);
}

/**
 * Build a TikTok connection environment that mirrors the logic used inside the Electron app.
 * This exposes the ConnectionManager class so that other entrypoints (like test harnesses)
 * can share the same behaviour.
 *
 * @param {object} options
 * @param {object} options.connector - The tiktok-live-connector module.
 * @param {boolean} [options.shouldEnableTikTokLogging=false] - Whether per-connection log files are enabled.
 *  * @param {function} [options.onStatus] - Callback invoked with status payloads meant for the UI.
 * @param {function} [options.getCachedSettings] - Returns the current cached settings object.
 * @param {function} [options.isCaptureEventsEnabled] - Indicates whether non-gift events should be forwarded.
 * @param {function} [options.isCaptureJoinedEventEnabled]
 * @param {function} [options.isCaptureLikedEventEnabled]
 * @param {function} [options.isViewerUpdateAllowed]
 * @param {function} [options.isTextOnlyModeEnabled]
 * @param {Map} [options.connectionStates] - Optional shared connection state map.
 * @returns {{
 *   ConnectionManager: typeof ConnectionManager,
 *   connectionStates: Map,
 *   usingLegacyConnector: boolean,
 *   TikTokLiveConnectionClass: any,
 *   TikTokPollingFallbackClass: any
 * }}
 */
function createTikTokEnvironment(options = {}) {
    const {
        connector,
        shouldEnableTikTokLogging: shouldEnableLoggingOption = false,
        onStatus: onStatusOverride = () => { },
        getCachedSettings: getCachedSettingsOverride = () => ({}),
        isCaptureEventsEnabled: captureEventsEnabledFn = () => false,
        isCaptureJoinedEventEnabled: captureJoinedFn = () => false,
        isCaptureLikedEventEnabled: captureLikedFn = () => false,
        isViewerUpdateAllowed: viewerUpdateAllowedFn = () => false,
        isTextOnlyModeEnabled: textOnlyModeFn = () => false,
        connectionStates: sharedConnectionStates,
        isDevMode: isDevModeOverride = () => false,
        resolveLogDirectory,
        getMainWindow: getMainWindowOverride,
        mainWindow: staticMainWindow = null,
        browserViews = null,
        websocketConnections = null,
        log: logFn = null,
        onEvent: onEventOverride = () => { },
        signerHelper: signerHelperOverride = null,
        localSigner: localSignerOverride = null
    } = options;

    env.localSigner = localSignerOverride;

    TikTokPollingFallbackClass = null;
    TikTokLiveConnectionClass = null;
    usingLegacyTikTokConnector = false;

    if (connector && typeof connector === 'object') {
        installTikTokProtoFetchTap(connector);
        if (typeof connector.EulerSigner === 'function') {
            EulerSignerClass = connector.EulerSigner;
        } else if (connector.web && typeof connector.web.EulerSigner === 'function') {
            EulerSignerClass = connector.web.EulerSigner;
        }
        if (typeof connector.WebcastPushConnection === 'function') {
            TikTokPollingFallbackClass = connector.WebcastPushConnection;
        }
        if (typeof connector.TikTokLiveConnection === 'function') {
            TikTokLiveConnectionClass = connector.TikTokLiveConnection;
        } else if (TikTokPollingFallbackClass) {
            TikTokLiveConnectionClass = TikTokPollingFallbackClass;
            usingLegacyTikTokConnector = true;
        }

        if (connector.WebcastDeserializeConfig && Array.isArray(connector.WebcastDeserializeConfig.skipMessageTypes)) {
            const skipTypes = connector.WebcastDeserializeConfig.skipMessageTypes;
            if (!skipTypes.includes('WebcastInRoomBannerMessage')) {
                skipTypes.push('WebcastInRoomBannerMessage');
            }
        }
    }

    if (!TikTokLiveConnectionClass) {
        throw new Error('TikTok connector not available or missing TikTokLiveConnection/WebcastPushConnection exports.');
    }

    env.shouldEnableTikTokLogging = !!shouldEnableLoggingOption;
    env.resolveLogDirectory = resolveLogDirectory !== undefined ? resolveLogDirectory : env.resolveLogDirectory;
    if (typeof getMainWindowOverride === 'function') {
        env.getMainWindow = getMainWindowOverride;
    } else if (staticMainWindow) {
        env.getMainWindow = () => staticMainWindow;
    } else {
        env.getMainWindow = () => null;
    }

    if (browserViews && typeof browserViews === 'object') {
        env.browserViews = browserViews;
    }
    if (websocketConnections && typeof websocketConnections === 'object') {
        env.websocketConnections = websocketConnections;
    }

    env.onStatus = typeof onStatusOverride === 'function' ? onStatusOverride : () => { };
    env.getCachedSettings = typeof getCachedSettingsOverride === 'function' ? getCachedSettingsOverride : () => ({});
    env.isCaptureEventsEnabled = typeof captureEventsEnabledFn === 'function' ? captureEventsEnabledFn : () => false;
    env.isCaptureJoinedEventEnabled = typeof captureJoinedFn === 'function' ? captureJoinedFn : () => false;
    env.isCaptureLikedEventEnabled = typeof captureLikedFn === 'function' ? captureLikedFn : () => false;
    env.isViewerUpdateAllowed = typeof viewerUpdateAllowedFn === 'function' ? viewerUpdateAllowedFn : () => false;
    env.isTextOnlyModeEnabled = typeof textOnlyModeFn === 'function' ? textOnlyModeFn : () => false;
    env.log = typeof logFn === 'function' ? logFn : env.log;
    env.onEvent = typeof onEventOverride === 'function' ? onEventOverride : () => { };
    env.isDevMode = typeof isDevModeOverride === 'function' ? isDevModeOverride : () => false;
    env.signerHelper = signerHelperOverride;

    cachedTikTokLogDir = null;

    if (sharedConnectionStates instanceof Map) {
        connectionStates = sharedConnectionStates;
    } else {
        connectionStates = new Map();
    }

    return {
        ConnectionManager,
        cleanupConnection,
        sendToBackground,
        sendBatchToBackground,
        sendToTikTok,
        logTikTokForwardedMessage,
        connectionStates,
        usingLegacyConnector: usingLegacyTikTokConnector,
        TikTokLiveConnectionClass,
        TikTokPollingFallbackClass
    };
}
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function cleanGenericString(value) {
    if (value === undefined || value === null) return null;
    const str = String(value).trim();
    return str || null;
}

const TIKTOK_EVENT_TYPE_ALIASES = Object.freeze({
    follow: 'followed',
    share: 'shared',
    like: 'liked'
});

const TIKTOK_EVENT_DEDUPE_WINDOWS_MS = Object.freeze({
    followed: 3000,
    shared: 3000,
    poll_message: 60 * 1000,
    room_pin: 10 * 60 * 1000,
    chat: 60 * 60 * 1000,
    gift: 60 * 60 * 1000
});

const TIKTOK_EVENT_DEDUPE_MAX_ENTRIES = 10000;
const TIKTOK_EVENT_DEDUPE_TRIM_TO = 8000;
const TIKTOK_USER_SCOPED_EVENT_DEDUPE_TYPES = new Set(['followed', 'shared']);

function canonicalizeTikTokEventType(eventType) {
    const cleaned = cleanGenericString(eventType);
    if (!cleaned) return null;
    const normalized = cleaned.toLowerCase();
    return TIKTOK_EVENT_TYPE_ALIASES[normalized] || normalized;
}

function getTikTokEventDedupeWindowMs(eventType) {
    if (!eventType) return 0;
    return TIKTOK_EVENT_DEDUPE_WINDOWS_MS[eventType] || 0;
}

function buildTikTokEventDedupeKey(eventType, data = {}, message = null) {
    if (!eventType || !data || typeof data !== 'object') {
        return null;
    }

    const identity = extractTikTokIdentity(data);
    const stableUserKey = firstNonEmptyVisibleString([
        identity?.uniqueId,
        data?.user?.uniqueId,
        data?.user?.userId,
        data?.userId,
        data?.uid
    ]) || '';

    const weakUserKey = firstNonEmptyVisibleString([
        identity?.nickname,
        data?.nickname,
        data?.user?.nickname,
        data?.user?.displayName
    ]) || '';

    const stableDetailKey = firstNonEmptyVisibleString([
        data?.eventId,
        data?.messageId,
        data?.msgId,
        data?.pollId,
        data?.pollBasicInfo?.pollIdStr,
        data?.pinId,
        data?.idStr,
        data?.id,
        data?.timestamp,
        data?.createTime,
        data?.common?.createTime
    ]) || '';

    // Skip dedupe when payload lacks reliable identity and event identifiers.
    if (!stableUserKey && !stableDetailKey) {
        return null;
    }

    if (TIKTOK_USER_SCOPED_EVENT_DEDUPE_TYPES.has(eventType) && stableUserKey) {
        return `${eventType}|${String(stableUserKey).toLowerCase()}`;
    }

    const weakDetailKey = firstNonEmptyVisibleString([
        data?.common?.displayText?.displayType,
        data?.common?.displayText?.defaultPattern,
        data?.displayType,
        data?.label,
        data?.action,
        data?.shareType,
        data?.shareTarget
    ]) || '';

    const messageKey = (typeof message === 'string' && message.trim().length)
        ? message.trim().toLowerCase()
        : '';

    const userKey = stableUserKey || weakUserKey || 'unknown';
    const detailKey = stableDetailKey || weakDetailKey;

    return `${eventType}|${String(userKey).toLowerCase()}|${String(detailKey).toLowerCase()}|${messageKey}`;
}

/**
 * Chat-specific dedupe key.  Prefers the upstream msgId (unique per message),
 * falls back to user + createTime + comment text.  Never dedupes on user alone.
 */
function buildChatDedupeKey(data) {
    if (!data || typeof data !== 'object') return null;

    const msgId = firstNonEmptyVisibleString([
        data?.common?.msgId,
        data?.msgId,
        data?.msg_id,
        data?.idStr
    ]);
    if (msgId) return `chat|${msgId}`;

    const identity = extractTikTokIdentity(data);
    const userId = firstNonEmptyVisibleString([
        identity?.uniqueId,
        data?.user?.uniqueId,
        data?.user?.userId,
        data?.userId
    ]) || '';
    const createTime = firstNonEmptyVisibleString([
        data?.common?.createTime,
        data?.createTime
    ]) || '';
    const comment = typeof data?.comment === 'string' ? data.comment.trim().toLowerCase() : '';

    // Require userId AND at least one distinguishing detail to avoid
    // collapsing different messages from the same user.
    if (!userId || (!createTime && !comment)) return null;
    return `chat|${userId}|${createTime}|${comment}`;
}

/**
 * Gift-specific dedupe key.  Prefers the upstream msgId (unique per message),
 * falls back to user + createTime + giftId + repeat/combo/group counts.
 * Never dedupes on user alone.
 */
function buildGiftDedupeKey(data) {
    if (!data || typeof data !== 'object') return null;

    const msgId = firstNonEmptyVisibleString([
        data?.common?.msgId,
        data?.msgId,
        data?.msg_id,
        data?.idStr
    ]);
    if (msgId) return `gift|${msgId}`;

    const identity = extractTikTokIdentity(data);
    const userId = firstNonEmptyVisibleString([
        identity?.uniqueId,
        data?.user?.uniqueId,
        data?.user?.userId,
        data?.userId
    ]) || '';
    const createTime = firstNonEmptyVisibleString([
        data?.common?.createTime,
        data?.createTime
    ]) || '';
    const giftId = resolveGiftId(data) || '';
    const repeatCount = resolveGiftMetricCount(data, 'repeat') || 0;
    const comboCount = resolveGiftMetricCount(data, 'combo') || 0;
    const groupCount = resolveGiftMetricCount(data, 'group') || 0;

    // Require userId AND at least one distinguishing detail to avoid
    // collapsing different gifts from the same user.
    if (!userId || (!createTime && !giftId)) return null;
    return `gift|${userId}|${createTime}|${giftId}|${repeatCount}|${comboCount}|${groupCount}`;
}


function pickFirstValue(sources, keys, cleaner) {
    for (const source of sources) {
        if (!isPlainObject(source)) continue;
        for (const key of keys) {
            if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
            const cleaned = cleaner(source[key]);
            if (cleaned) {
                return cleaned;
            }
        }
    }
    return null;
}

function extractTikTokIdentity(data = {}) {
    const sources = [];
    if (isPlainObject(data)) {
        sources.push(data);
    }

    const user = isPlainObject(data.user) ? data.user : null;
    if (user) {
        sources.push(user);
        const nestedKeys = ['profile', 'userInfo', 'author', 'userProfile', 'extraInfo'];
        for (const key of nestedKeys) {
            const nested = isPlainObject(user[key]) ? user[key] : null;
            if (nested) {
                sources.push(nested);
            }
        }
    }

    const nickname = pickFirstValue(sources, ['nickname', 'nickName', 'displayName', 'username', 'userName'], cleanVisibleString);
    const uniqueId = pickFirstValue(sources, [
        'uniqueId',
        'uniqueID',
        'unique_id',
        'userId',
        'user_id',
        'userID',
        'userid',
        'id',
        'uid',
        'shortId',
        'displayId',
        'display_id',
        'loginName',
        'login_name',
        'secUid',
        'sec_uid',
        'openId',
        'open_id',
        'publicUserId',
        'public_user_id'
    ], cleanVisibleString);
    const profilePictureUrl = pickFirstValue(
        sources,
        ['profilePictureUrl', 'avatarThumb', 'avatarMedium', 'avatarLarger', 'avatarUrl', 'profilePicture'],
        normalizeTikTokImageUrl
    );

    return {
        nickname: nickname || null,
        uniqueId: uniqueId || null,
        profilePictureUrl: profilePictureUrl || null
    };
}

function resolveTikTokUserId(data = {}, identity = null) {
    const identityObj = identity && typeof identity === 'object' ? identity : null;
    const user = isPlainObject(data.user) ? data.user : null;
    const author = isPlainObject(data.author) ? data.author : null;
    const extraInfo = isPlainObject(data.extraInfo) ? data.extraInfo : null;
    const userProfile = isPlainObject(user?.profile) ? user.profile : null;

    return firstNonEmptyVisibleString([
        identityObj?.uniqueId,
        data.uniqueId,
        data.uniqueID,
        data.unique_id,
        data.userid,
        data.userId,
        data.user_id,
        data.userID,
        data.id,
        data.idStr,
        data.id_str,
        data.uid,
        data.shortId,
        data.short_id,
        data.displayId,
        data.display_id,
        data.secUid,
        data.sec_uid,
        user?.uniqueId,
        user?.uniqueID,
        user?.unique_id,
        user?.userId,
        user?.user_id,
        user?.userID,
        user?.id,
        user?.idStr,
        user?.id_str,
        user?.uid,
        user?.shortId,
        user?.short_id,
        user?.displayId,
        user?.display_id,
        user?.secUid,
        user?.sec_uid,
        userProfile?.uniqueId,
        userProfile?.uniqueID,
        userProfile?.unique_id,
        author?.uniqueId,
        author?.uniqueID,
        author?.unique_id,
        author?.userId,
        author?.user_id,
        author?.userID,
        author?.id,
        author?.idStr,
        author?.id_str,
        author?.uid,
        author?.displayId,
        author?.display_id,
        author?.secUid,
        author?.sec_uid,
        extraInfo?.uniqueId,
        extraInfo?.uniqueID,
        extraInfo?.unique_id
    ]);
}

function resolveTikTokDisplayName(data = {}, identity = null, fallbackUserId = null) {
    const identityObj = identity && typeof identity === 'object' ? identity : null;
    const user = isPlainObject(data.user) ? data.user : null;
    const author = isPlainObject(data.author) ? data.author : null;
    const userProfile = isPlainObject(user?.profile) ? user.profile : null;

    const resolved = firstNonEmptyVisibleString([
        identityObj?.nickname,
        data.nickname,
        data.nickName,
        data.displayName,
        data.display_name,
        data.username,
        data.userName,
        user?.nickname,
        user?.nickName,
        user?.displayName,
        user?.display_name,
        userProfile?.nickname,
        userProfile?.displayName,
        author?.nickname,
        author?.displayName,
        author?.nickName,
        identityObj?.uniqueId,
        data.uniqueId,
        data.uniqueID,
        fallbackUserId
    ]);

    if (resolved) return resolved;
    return fallbackUserId || 'Unknown';
}

const SOCIAL_SUPPRESSED_DISPLAY_TYPES = new Set([
    'pm_main_follow_message_viewer_2',
    'pm_mt_guidance_share',
    'pm_mt_guidance_social_action'
]);

const SOCIAL_GIFT_KEYWORDS = ['gift', 'donat', 'present', 'rose', 'lion', 'whale', 'galaxy', 'jet', 'train', 'castle'];
const SOCIAL_REDUNDANT_KEYWORDS = ['follow', 'follower', 'subscrib', 'member'];

const SOCIAL_EVENT_MATCHERS = [
    {
        event: 'shared',
        message: 'shared the live stream',
        match: (meta) => !!meta.shareTypeLower ||
            /share|forward/.test(meta.displayTypeLower) ||
            /share|forward/.test(meta.labelLower)
    },
    {
        event: 'pinned',
        message: 'pinned the stream',
        match: (meta) => /pin/.test(meta.displayTypeLower) || /pin/.test(meta.labelLower)
    },
    {
        event: 'liked',
        message: 'liked the stream',
        match: (meta) => /like|thumb/.test(meta.displayTypeLower) || /like|thumb/.test(meta.labelLower)
    }
];

function normalizeSocialMeta(data = {}) {
    const displayType = firstNonEmptyVisibleString([
        data.displayType,
        data?.common?.displayText?.displayType,
        data?.publicAreaMessageCommon?.eventDetails?.displayType,
        data?.action
    ]) || '';
    const label = firstNonEmptyVisibleString([
        data.label,
        data?.common?.displayText?.defaultPattern,
        data?.publicAreaMessageCommon?.eventDetails?.label
    ]) || '';
    const shareType = firstNonEmptyVisibleString([
        data.shareType,
        data.shareTarget,
        data.shareDisplayStyle
    ]) || '';

    return {
        baseDisplayType: typeof data.displayType === 'string' ? data.displayType : '',
        displayType,
        displayTypeLower: displayType.toLowerCase(),
        label,
        labelLower: label.toLowerCase(),
        shareType,
        shareTypeLower: shareType.toLowerCase()
    };
}

function isGenericSocialLabel(meta) {
    return !meta.label || /performed a social action/i.test(meta.label);
}

function isRedundantFollowOrSub(meta) {
    return SOCIAL_REDUNDANT_KEYWORDS.some(keyword =>
        meta.displayTypeLower.includes(keyword) || meta.labelLower.includes(keyword)
    );
}

function isSocialGiftEcho(meta) {
    return SOCIAL_GIFT_KEYWORDS.some(keyword =>
        meta.displayTypeLower.includes(keyword) || meta.labelLower.includes(keyword)
    );
}

function classifySocialEvent(meta) {
    for (const matcher of SOCIAL_EVENT_MATCHERS) {
        if (typeof matcher.match === 'function' && matcher.match(meta)) {
            return matcher;
        }
    }
    return null;
}

function coerceTikTokBoolean(value) {
    if (value === true) return true;
    if (value === false) return false;

    if (typeof value === 'number') {
        if (Number.isNaN(value)) return null;
        return value !== 0;
    }

    if (typeof value === 'string') {
        const normalised = value.trim().toLowerCase();
        if (!normalised) return null;
        if (['true', 't', 'yes', 'y', 'on'].includes(normalised)) return true;
        if (['false', 'f', 'no', 'n', 'off'].includes(normalised)) return false;

        const numeric = Number(normalised);
        if (!Number.isNaN(numeric)) {
            return numeric !== 0;
        }
    }

    return null;
}

function resolveTikTokModeratorStatus(data = {}) {
    const userIdentity = isPlainObject(data.userIdentity)
        ? data.userIdentity
        : isPlainObject(data?.user?.userIdentity)
            ? data.user.userIdentity
            : isPlainObject(data?.author?.userIdentity)
                ? data.author.userIdentity
                : null;

    const candidates = [
        data.isModerator,
        data.isModeratorOfAnchor,
        data.moderator,
        data?.user?.isModerator,
        data?.author?.isModerator,
        userIdentity?.isModeratorOfAnchor,
        userIdentity?.isModerator,
        data?.user?.privilege?.isModerator
    ];

    for (const candidate of candidates) {
        const coerced = coerceTikTokBoolean(candidate);
        if (coerced !== null) {
            return coerced;
        }
    }

    return false;
}

function resolveTikTokSubscriberStatus(data = {}) {
    const userIdentity = isPlainObject(data.userIdentity)
        ? data.userIdentity
        : isPlainObject(data?.user?.userIdentity)
            ? data.user.userIdentity
            : isPlainObject(data?.author?.userIdentity)
                ? data.author.userIdentity
                : null;

    const subscribeInfo = isPlainObject(data?.user?.subscribeInfo)
        ? data.user.subscribeInfo
        : null;

    const candidates = [
        data.isSubscriber,
        data.membership,
        data.isSubscriberOfAnchor,
        data?.user?.isSubscriber,
        userIdentity?.isSubscriberOfAnchor,
        subscribeInfo?.status,
        subscribeInfo?.subscribedStatus,
        subscribeInfo?.isSubscribing
    ];

    for (const candidate of candidates) {
        const coerced = coerceTikTokBoolean(candidate);
        if (coerced !== null) {
            return coerced;
        }
    }

    // Some payloads provide numeric status where >0 represents subscribed
    const numericCandidates = [subscribeInfo?.status, subscribeInfo?.subscribedStatus];
    for (const candidate of numericCandidates) {
        if (candidate === undefined || candidate === null) continue;
        const numeric = Number(candidate);
        if (!Number.isNaN(numeric)) {
            return numeric > 0;
        }
    }

	return false;
}

const LIKELY_EMOTE_PLACEHOLDER_HINTS = /\b(?:emoji|emote|sticker|smiley|smile|face|heart|laugh|grin|wink|kiss|sad|cry|angry|fire|rose|love|happy|joy|thumb|clap)\b/i;

function normalizeEmoteLabelForMatching(value) {
	const cleaned = cleanVisibleString(value);
	if (!cleaned) return '';
	return cleaned.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizePlaceInComment(value) {
	if (value === undefined || value === null || value === '') return null;
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return null;
	const floored = Math.floor(numeric);
	if (floored < 0) return null;
	return floored;
}

function normalizeTikTokEmoteEntries(payload = {}) {
	const sourceEmotes = Array.isArray(payload)
		? payload
		: Array.isArray(payload?.emotes)
			? payload.emotes
			: Array.isArray(payload?.emoteList)
				? payload.emoteList
				: [];
	if (!sourceEmotes.length) return [];

	const normalized = [];
	sourceEmotes.forEach((source, sourceIndex) => {
		if (!source || typeof source !== 'object') return;

		const nestedEmote = isPlainObject(source?.emote) ? source.emote : source;
		const emoteId = cleanVisibleString(
			source.emoteId
			|| source.id
			|| source.emote_id
			|| nestedEmote?.emoteId
			|| nestedEmote?.id
			|| nestedEmote?.emote_id
		) || null;
		const emoteLabel = cleanVisibleString(
			source.emoteName
			|| source.name
			|| source.title
			|| source.label
			|| nestedEmote?.emoteName
			|| nestedEmote?.name
			|| nestedEmote?.title
			|| nestedEmote?.label
			|| nestedEmote?.description
		) || emoteId || null;
		const rawUrl = source.emoteImageUrl
			|| source.imageUrl
			|| source.url
			|| source.image?.url
			|| source.image?.imageUrl
			|| source.image
			|| nestedEmote?.emoteImageUrl
			|| nestedEmote?.imageUrl
			|| nestedEmote?.url
			|| nestedEmote?.image?.url
			|| nestedEmote?.image?.imageUrl
			|| nestedEmote?.image;
		const emoteUrl = normalizeTikTokImageUrl(rawUrl) || null;
		const placeInComment = normalizePlaceInComment(
			source.placeInComment
			?? source.place
			?? source.index
			?? nestedEmote?.placeInComment
			?? nestedEmote?.place
			?? nestedEmote?.index
		);

		if (!emoteId && !emoteLabel && !emoteUrl) return;
		normalized.push({
			emoteId,
			emoteLabel,
			emoteUrl,
			placeInComment,
			sourceIndex
		});
	});

	return normalized;
}

function renderTikTokEmoteToken(emote = {}, textOnly = false) {
	const emoteLabel = cleanVisibleString(emote?.emoteLabel);
	if (textOnly) {
		// Text-only output should keep readable labels only; no synthetic sticker marker.
		return emoteLabel || '';
	}

	const emoteUrl = normalizeTikTokImageUrl(emote?.emoteUrl);
	if (emoteUrl) {
		const emoteId = cleanVisibleString(emote?.emoteId) || '';
		let tag = `<img class="sticker" src="${emoteUrl}"`;
		if (emoteLabel) {
			tag += ` alt="${emoteLabel}"`;
		}
		if (emoteId) {
			tag += ` data-emote-id="${emoteId}"`;
		}
		tag += '>';
		return tag;
	}

	return emoteLabel || '[sticker]';
}

function isLikelyEmotePlaceholderContent(rawContent, emoteLabel = null) {
	const normalizedContent = normalizeEmoteLabelForMatching(rawContent);
	if (!normalizedContent) return false;

	if (emoteLabel) {
		const normalizedLabel = normalizeEmoteLabelForMatching(emoteLabel);
		if (normalizedLabel) {
			if (normalizedContent === normalizedLabel) return true;
			if (normalizedContent.includes(normalizedLabel) || normalizedLabel.includes(normalizedContent)) return true;
		}
	}

	return LIKELY_EMOTE_PLACEHOLDER_HINTS.test(normalizedContent);
}

function extractLeadingEmotePlaceholder(text, emoteLabel = null) {
	if (typeof text !== 'string' || !text) return null;
	const match = text.match(/^\[([^\]]{1,80})\]/);
	if (!match) return null;
	if (!isLikelyEmotePlaceholderContent(match[1], emoteLabel)) return null;
	return match[0];
}

function escapeRegex(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceLikelyEmotePlaceholders(chatmessage, emotes, usedIndexes = new Set()) {
	let output = typeof chatmessage === 'string' ? chatmessage : '';
	if (!output || !Array.isArray(emotes) || !emotes.length) {
		return {
			chatmessage: output,
			usedIndexes
		};
	}

	for (const emote of emotes) {
		if (usedIndexes.has(emote.index)) continue;
		const normalizedLabel = normalizeEmoteLabelForMatching(emote.emoteLabel);
		if (!normalizedLabel) continue;

		const pattern = escapeRegex(normalizedLabel).replace(/\s+/g, '\\s+');
		const labelRegex = new RegExp(`\\[\\s*${pattern}\\s*\\]`, 'i');
		if (!labelRegex.test(output)) continue;

		output = output.replace(labelRegex, emote.token);
		usedIndexes.add(emote.index);
	}

	const placeholderRegex = /\[([^\]]{1,80})\]/g;
	let searchFrom = 0;
	for (const emote of emotes) {
		if (usedIndexes.has(emote.index)) continue;
		placeholderRegex.lastIndex = searchFrom;

		let match = null;
		while ((match = placeholderRegex.exec(output)) !== null) {
			if (isLikelyEmotePlaceholderContent(match[1], null)) {
				break;
			}
		}
		if (!match) break;

		output = `${output.slice(0, match.index)}${emote.token}${output.slice(placeholderRegex.lastIndex)}`;
		usedIndexes.add(emote.index);
		searchFrom = match.index + emote.token.length;
	}

	return {
		chatmessage: output,
		usedIndexes
	};
}

function removeResidualEmotePlaceholders(chatmessage) {
	if (typeof chatmessage !== 'string' || !chatmessage) return chatmessage || '';
	return chatmessage
		.replace(/\[([^\]]{1,80})\]/g, (full, inner) => (isLikelyEmotePlaceholderContent(inner) ? '' : full))
		.replace(/\s{2,}/g, ' ')
		.trim();
}

function renderTikTokChatWithEmotes(chatmessage, normalizedEmotes = [], textOnly = false) {
	let output = typeof chatmessage === 'string' ? chatmessage : '';
	if (!Array.isArray(normalizedEmotes) || !normalizedEmotes.length) return output;

	const emotes = normalizedEmotes
		.map((emote, index) => ({
			...emote,
			index,
			token: renderTikTokEmoteToken(emote, textOnly)
		}))
		.filter((emote) => typeof emote.token === 'string' && (textOnly || emote.token.length > 0));
	if (!emotes.length) return output;

	const usedIndexes = new Set();
	const positioned = emotes
		.filter((emote) => Number.isInteger(emote.placeInComment) && emote.placeInComment >= 0)
		.sort((a, b) => (a.placeInComment - b.placeInComment) || (a.index - b.index));

	if (positioned.length && output) {
		const rawText = output;
		const segments = [];
		let cursor = 0;

		positioned.forEach((emote) => {
			let insertAt = emote.placeInComment;
			if (insertAt > rawText.length) insertAt = rawText.length;
			if (insertAt < cursor) insertAt = cursor;

			segments.push(rawText.slice(cursor, insertAt));
			segments.push(emote.token);
			usedIndexes.add(emote.index);
			cursor = insertAt;

			const placeholder = extractLeadingEmotePlaceholder(rawText.slice(cursor), emote.emoteLabel);
			if (placeholder) {
				cursor += placeholder.length;
			}
		});

		segments.push(rawText.slice(cursor));
		output = segments.join('');
	}

	const placeholderReplacement = replaceLikelyEmotePlaceholders(output, emotes, usedIndexes);
	output = placeholderReplacement.chatmessage;

	const remainingTokens = emotes
		.filter((emote) => !usedIndexes.has(emote.index))
		.map((emote) => emote.token);
	if (remainingTokens.length) {
		const suffix = remainingTokens.join(' ');
		output = output ? `${output} ${suffix}` : suffix;
	}

	return removeResidualEmotePlaceholders(output);
}

function composeTikTokChatMessage(data = {}, options = {}) {
	const { includeTopGifterBadgeAlways = false } = options;
	const explicitTextOnly = data && (data.textonly === true || data.textonlymode === true);
	const textOnly = explicitTextOnly || isTextOnlyModeEnabled();

	let chatmessage = typeof data?.comment === 'string' ? data.comment : '';
	const normalizedEmotes = normalizeTikTokEmoteEntries(data);
	if (normalizedEmotes.length) {
		chatmessage = renderTikTokChatWithEmotes(chatmessage, normalizedEmotes, textOnly);
	}

    const message = {
        chatmessage,
        textonly: textOnly,
        textonlymode: textOnly
    };

    // Preserve upstream ids/timestamps for downstream dedupe and debugging
    const upstreamMsgId = data?.common?.msgId || data?.msgId || data?.msg_id;
    if (upstreamMsgId) message.msgId = String(upstreamMsgId);
    const upstreamCreateTime = data?.common?.createTime || data?.createTime;
    if (upstreamCreateTime) message.createTime = String(upstreamCreateTime);

    const badgeSources = collectTikTokBadges(data);
    if (badgeSources.length) {
        const badges = [];
        const seenBadgeUrls = new Set();
        badgeSources.forEach((badge) => {
            const badgeUrl = getBadgeImageUrl(badge);
            if (!badgeUrl) return;
            if (seenBadgeUrls.has(badgeUrl)) return;
            seenBadgeUrls.add(badgeUrl);
            badges.push(badgeUrl);
        });
        if (badges.length) {
            message.chatbadges = badges;
        }
    }

    if (data?.topGifterRank) {
        const existingBadges = Array.isArray(message.chatbadges) ? message.chatbadges : [];
        if (includeTopGifterBadgeAlways || existingBadges.length === 0) {
            if (!Array.isArray(message.chatbadges)) {
                message.chatbadges = [];
            }
            const topGifterBadgeUrl = 'https://p16-webcast.tiktokcdn.com/webcast-sg/new_top_gifter_version_2.png~tplv-obj.image';
            if (!message.chatbadges.includes(topGifterBadgeUrl)) {
                message.chatbadges.push(topGifterBadgeUrl);
            }
        }
    }

    message.moderator = resolveTikTokModeratorStatus(data);
    message.membership = resolveTikTokSubscriberStatus(data);

    const identity = extractTikTokIdentity(data);
    const resolvedUserId = resolveTikTokUserId(data, identity);
    if (resolvedUserId) {
        message.userid = resolvedUserId;
    }
    message.chatname = resolveTikTokDisplayName(data, identity, resolvedUserId);

    const avatarUrl = identity.profilePictureUrl
        || normalizeTikTokImageUrl(data?.profilePictureUrl)
        || normalizeTikTokImageUrl(data?.profilePicture)
        || normalizeTikTokImageUrl(data?.user?.profilePictureUrl)
        || normalizeTikTokImageUrl(data?.user?.profilePicture);
    message.chatimg = avatarUrl || null;

    const nameColor = data?.nameColor || data?.name_color || data?.user?.nameColor;
    const safeColor = normalizeNameColor(nameColor);
    if (safeColor) {
        message.nameColor = safeColor;
    }

    return message;
}

function sendChatMessage(data, virtualTabId) {
    const msg = composeTikTokChatMessage(data, { includeTopGifterBadgeAlways: true });
    if (typeof msg.textonly !== 'boolean') {
        msg.textonly = isTextOnlyModeEnabled();
    }
    if (typeof msg.textonlymode !== 'boolean') {
        msg.textonlymode = msg.textonly;
    }
    msg.type = 'tiktok';
    msg.tid = virtualTabId;
    sendToBackground(msg);
}

let wssID = 0;

// Function to send messages to TikTok chat
async function sendToTikTok(args) {
    try {
        const {
            wssID,
            message
        } = args || {};

        const manager = env.websocketConnections[wssID];
        if (!manager) {
            log(`TikTok connection not found for wssID: ${wssID}`);
            return {
                success: false,
                error: 'Connection not found'
            };
        }

        const result = await manager.sendChatMessage(message);
        if (!result || typeof result.success !== 'boolean') {
            return {
                success: false,
                error: 'Unknown send status'
            };
        }

        if (result.success) {
            log('TikTok message sent via API request.');
        } else if (result.error) {
            log(`TikTok message send blocked: ${result.error}`);
        }

        return result;

    } catch (error) {
        log(`Failed to send TikTok message: ${error.message}`);
        return {
            success: false,
            error: error.message || 'Failed to send message'
        };
    }
}

const CONFIG = {
    CONNECTION: {
        TIMEOUT: 15000,
        CLEANUP_INTERVAL: 60000,
        HEALTH_CHECK_INTERVAL: 60000, // Increased to 60s for better stability
        // Adaptive reconnect windows (active → moderate → idle)
        MESSAGE_TIMEOUT_ACTIVE_MS: 5 * 60 * 1000,
        MESSAGE_TIMEOUT_MODERATE_MS: 10 * 60 * 1000,
        MESSAGE_TIMEOUT_IDLE_MS: 30 * 60 * 1000,
        ACTIVITY_THRESHOLDS: {
            HIGH_PER_MINUTE: 120, // Consider stream "active" if >=120 msgs/min (~2 msg/sec)
            MODERATE_PER_MINUTE: 15 // Moderate traffic if >=15 msgs/min
        },
        ACTIVITY_HISTORY_MS: 30 * 60 * 1000, // Track up to 30 minutes of activity
        MAX_RECONNECT_ATTEMPTS: Infinity, // Retry indefinitely
        RECONNECT_DELAY: 3000,
        // Fixed retry cadence when user is offline / not live
        OFFLINE_RETRY_INTERVAL_MS: 60000, // 1 minute
        OFFLINE_RETRY_SEQUENCE_MS: [15000, 60000, 900000], // 15s, 1m, 15m
        // Cap exponential backoff for transient errors (5 minutes max)
        MAX_RECONNECT_DELAY_MS: 300000, // 5 minutes
	        // Backoff jitter factor (e.g., 0.1 => ±10%)
	        BACKOFF_JITTER: 0.1,
	        // Rate limit retry delay
	        RATE_LIMIT_RETRY_MS: 300000, // 5 minutes
	        // Maximum delay used when backing off after TikTok 429s
	        RATE_LIMIT_RETRY_MAX_MS: 1800000, // 30 minutes
	        // After this many consecutive 429s, fall back to polling/legacy for the session
	        RATE_LIMIT_FALLBACK_THRESHOLD: 2,
	        // Local signer connect throttle (reduces 429s caused by session-start storms)
	        LOCAL_SIGNER_MIN_ATTEMPT_INTERVAL_MS: 10000, // 10 seconds
	        // Maximum time to wait for the Euler sign server before failing fast
	        SIGN_REQUEST_TIMEOUT_MS: 25000,
	        // Increase timeout if the first attempt times out (added incrementally to avoid long hangs)
	        SIGN_REQUEST_TIMEOUT_STEP_MS: 10000,
        // Do not exceed this timeout when boosting sign server calls
        SIGN_REQUEST_TIMEOUT_MAX_MS: 45000,
        // Small pause before immediately retrying after a boosted timeout
        SIGN_REQUEST_IMMEDIATE_RETRY_DELAY_MS: 750,
        // Give TikTok/Euler a brief cooldown before switching a live websocket
        // session into compatibility mode on the same manager.
        POLLING_FALLBACK_HANDOFF_DELAY_MS: 5000,
        // A few rooms emit a transient stream-end control message before
        // the final disconnect. Delay confirmation so AUTO does not bail out
        // while chat traffic is still flowing.
        STREAM_END_CONFIRM_DELAY_MS: 5000,
        // Detect connections that are accepted then immediately killed by TikTok
        RAPID_DISCONNECT_THRESHOLD_MS: 60000, // Connection lasting < 60s counts as rapid
        RAPID_DISCONNECT_STRIKE_LIMIT: 3      // After 3 rapid disconnects, try fallback
    },
    CHAT: {
        PROCESSING_INTERVAL: 100,
        // Hard cap for total queued messages across TikTok chat processing
        MAX_QUEUE_SIZE: 10000,
        // Drop stale messages that fall outside this trailing window
        STALE_MESSAGE_GRACE_MS: 3 * 60 * 1000,
        HIGH_LOAD_THRESHOLD: 5000,
        HIGH_LOAD_INTERVAL: 20,
        // Preferred batch sizes across different load tiers
        STANDARD_BATCH_SIZE: 50,
        HIGH_LOAD_BATCH_SIZE: 120,
        HIGH_WATER_THRESHOLD: 8000,
        HIGH_WATER_BATCH_SIZE: 250,
        HIGH_WATER_INTERVAL: 5
    },
    GIFT: {
        PROCESSING_INTERVAL: 50,
        STREAK_SAFETY_TIMEOUT_MS: 30000  // 30s fallback for orphaned combos
    }
};


const connectionCleanupInterval = setInterval(() => {
    for (const [id, state] of connectionStates.entries()) {
        const manager = env.websocketConnections[id];
        const attemptInProgress = !!state?.attemptInProgress;

        // Do not clean up while a connection attempt is actively running
        if (attemptInProgress) {
            continue;
        }

        // Watchdog: if stuck in reconnecting state without a timer, kick the scheduler
        if (manager && !manager.isStopped) {
            const isConnected = !!(manager.connection && manager.connection.isConnected);
            const hasTimer = !!manager.reconnectTimer;
            if (!isConnected && state.isReconnecting && !hasTimer) {
                const idleMs = Date.now() - (state.lastAttempt || 0);
                if (idleMs > CONFIG.CONNECTION.TIMEOUT) {
                    console.warn(`Reconnect watchdog: restarting attempt for ${id} after ${idleMs}ms idle`);
                    try { manager.attemptReconnect(); } catch (e) { console.error('Watchdog attemptReconnect error:', e); }
                }
            }
        }

        // Existing cleanup: if not connected, not reconnecting, and beyond timeout
        if (!state.isConnected && !state.isReconnecting && Date.now() - state.lastAttempt > CONFIG.CONNECTION.TIMEOUT) {
            console.warn(`Cleaning up failed connection ${id}`);
            cleanupConnection(id);
        }
    }
}, CONFIG.CONNECTION.CLEANUP_INTERVAL);

// Store for cleanup on app quit
if (!global.intervals) global.intervals = [];
global.intervals.push(connectionCleanupInterval);

function cleanupConnection(wssID) {
    try {
        const manager = env.websocketConnections[wssID];
        if (manager) {
            // If it's a ConnectionManager instance
            if (manager.connection) {
                manager.connection.disconnect();
                log("closing TIktok connection and cleaning up");
                manager.connection.removeAllListeners();
            }
            // Clear any intervals and timers
            if (manager.healthCheckInterval) {
                clearInterval(manager.healthCheckInterval);
            }
            if (manager.viewerUpdateInterval) {
                clearInterval(manager.viewerUpdateInterval);
            }
            if (manager.reconnectTimer) {
                clearTimeout(manager.reconnectTimer);
                manager.reconnectTimer = null;
            }
            if (typeof manager.clearPendingStreamEndConfirmation === 'function') {
                manager.clearPendingStreamEndConfirmation('cleanupConnection');
            }
            if (manager.activityBuckets instanceof Map) {
                manager.activityBuckets.clear();
            }
            if (typeof manager.resetGoalAggregates === 'function') {
                try {
                    manager.resetGoalAggregates({ flush: false });
                } catch (_) { /* noop */ }
            }
            // Mark as stopped
            manager.isStopped = true;
            if (typeof manager.logDebug === 'function') {
                manager.logDebug('lifecycle.cleanup', { triggeredBy: 'cleanupConnection' });
            }
            if (typeof manager.closeLogWriter === 'function') {
                manager.closeLogWriter('cleanupConnection');
            }

            // Remove the virtual tab entry
            if (manager.virtualTabId && env.browserViews[manager.virtualTabId]) {
                delete env.browserViews[manager.virtualTabId];
                log("Removed virtual tab: " + manager.virtualTabId);
            }

            delete env.websocketConnections[wssID];
        }
        connectionStates.delete(wssID);
        log("deleting connectionStates: " + wssID);
    } catch (e) {
        console.error('Error during connection cleanup:', e);
    }
}

function normalizeNameColor(raw) {
    if (raw === undefined || raw === null) return null;

    const normalized = String(raw).trim().toLowerCase();
    if (!normalized) return null;

    const compact = normalized.includes('rgb') ? normalized.replace(/\s+/g, '') : null;

    if (
        normalized === 'black' ||
        normalized === '000000' ||
        normalized === '#000' ||
        normalized === '#000000' ||
        normalized === '0x000000' ||
        compact === 'rgb(0,0,0)' ||
        compact === 'rgba(0,0,0,1)'
    ) {
        return null;
    }

    let hex = normalized;
    let hadHash = false;

    if (hex.startsWith('0x') && hex.length === 8) {
        hex = hex.slice(2);
    }

    if (hex.startsWith('#')) {
        hadHash = true;
        hex = hex.slice(1);
    }

    if (hadHash && hex.length === 3 && /^[0-9a-f]{3}$/.test(hex)) {
        hex = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    } else if (hex.length === 3) {
        return null;
    }

    if (hex.length !== 6 || !/^[0-9a-f]{6}$/.test(hex)) {
        // Unsupported format; ignore to avoid injecting invalid CSS
        return null;
    }

    return `#${hex}`;
}

function sanitizeMetaValue(value, depth = 0) {
    if (value === null || value === undefined) {
        return undefined;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return undefined;
        }
        const MAX_LENGTH = 512;
        return trimmed.length > MAX_LENGTH
            ? `${trimmed.slice(0, MAX_LENGTH - 3)}...`
            : trimmed;
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    if (Array.isArray(value)) {
        if (depth >= 2) {
            return undefined;
        }
        const sanitized = [];
        for (const item of value) {
            if (sanitized.length >= 20) break;
            const candidate = sanitizeMetaValue(item, depth + 1);
            if (candidate !== undefined) {
                sanitized.push(candidate);
            }
        }
        return sanitized.length ? sanitized : undefined;
    }

    if (typeof value === 'object') {
        if (depth >= 2) {
            return undefined;
        }
        const sanitized = {};
        for (const [key, val] of Object.entries(value)) {
            const candidate = sanitizeMetaValue(val, depth + 1);
            if (candidate !== undefined) {
                sanitized[key] = candidate;
            }
        }
        return Object.keys(sanitized).length ? sanitized : undefined;
    }

    return undefined;
}

function sanitizeEventMeta(meta) {
    if (!meta || typeof meta !== 'object') {
        return null;
    }
    const sanitized = sanitizeMetaValue(meta, 0);
    return sanitized && typeof sanitized === 'object' ? sanitized : null;
}

function pickFirstNonEmptyString(candidates = []) {
    const list = Array.isArray(candidates) ? candidates : [candidates];
    for (const candidate of list) {
        if (Array.isArray(candidate)) {
            const nested = pickFirstNonEmptyString(candidate);
            if (nested) return nested;
            continue;
        }
        if (candidate === undefined || candidate === null) continue;
        if (typeof candidate === 'string') {
            const cleaned = cleanVisibleString(candidate);
            if (cleaned) return cleaned;
        } else if (typeof candidate === 'number') {
            if (!Number.isNaN(candidate)) {
                return String(candidate);
            }
        }
    }
    return null;
}

function pickFirstPositiveNumber(candidates = []) {
    const list = Array.isArray(candidates) ? candidates : [candidates];
    for (const candidate of list) {
        if (Array.isArray(candidate)) {
            const nested = pickFirstPositiveNumber(candidate);
            if (nested > 0) return nested;
            continue;
        }
        const numeric = Number(candidate);
        if (Number.isFinite(numeric) && numeric > 0) {
            return numeric;
        }
    }
    return 0;
}

function resolveFirstImageUrl(candidates = []) {
    const list = Array.isArray(candidates) ? candidates : [candidates];
    for (const candidate of list) {
        const resolved = normalizeTikTokImageUrl(candidate);
        if (resolved) {
            return resolved;
        }
    }
    return null;
}

function isRenderableTikTokContentImageUrl(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (/^https?:\/\//i.test(trimmed)) return true;
    if (/^data:image\//i.test(trimmed)) return true;
    if (/^data:video\//i.test(trimmed)) return true;
    return false;
}

function resolveFirstRenderableImageUrl(candidates = []) {
    const queue = Array.isArray(candidates) ? [...candidates] : [candidates];
    const seenObjects = new Set();

    while (queue.length) {
        const candidate = queue.shift();
        if (candidate === undefined || candidate === null) continue;

        if (typeof candidate === 'string') {
            const resolved = normalizeTikTokImageUrl(candidate);
            if (resolved && isRenderableTikTokContentImageUrl(resolved)) {
                return resolved;
            }
            continue;
        }

        if (Array.isArray(candidate)) {
            queue.unshift(...candidate);
            continue;
        }

        if (typeof candidate !== 'object') {
            const resolved = normalizeTikTokImageUrl(candidate);
            if (resolved && isRenderableTikTokContentImageUrl(resolved)) {
                return resolved;
            }
            continue;
        }

        if (seenObjects.has(candidate)) {
            continue;
        }
        seenObjects.add(candidate);

        // Prioritize public URL lists before uri/resourceUri fields.
        const publicListKeys = ['urlList', 'urls', 'url_list', 'imageList', 'image_list', 'iconList', 'icon_list'];
        for (const key of publicListKeys) {
            if (Array.isArray(candidate[key]) && candidate[key].length) {
                queue.unshift(...candidate[key]);
            }
        }

        const directKeys = ['url', 'href', 'src', 'imageUrl', 'image_url'];
        for (const key of directKeys) {
            if (candidate[key] !== undefined && candidate[key] !== null) {
                queue.unshift(candidate[key]);
            }
        }

        const nestedPriorityKeys = ['videoUrl', 'resourceModel', 'resourceByteVC1Model', 'image', 'icon', 'picture', 'resource'];
        for (const key of nestedPriorityKeys) {
            if (candidate[key] !== undefined && candidate[key] !== null) {
                queue.push(candidate[key]);
            }
        }

        const uriKeys = ['uri', 'resourceUri', 'mUri'];
        for (const key of uriKeys) {
            if (candidate[key] !== undefined && candidate[key] !== null) {
                queue.push(candidate[key]);
            }
        }

        Object.values(candidate).forEach((value) => {
            if (value === undefined || value === null) return;
            if (typeof value === 'string' || typeof value === 'object') {
                queue.push(value);
            }
        });
    }

    return null;
}

function resolveGiftAssetMediaUrl(asset) {
    if (!asset || typeof asset !== 'object') return null;

    const stickerVariant = Number(asset.stickerAssetVariant || 0);
    const stickerVariantReason = Number(asset.stickerAssetVariantReason || 0);
    const hasVideoResource = Array.isArray(asset.videoResourceList) && asset.videoResourceList.length > 0;
    const hasExplicitStickerSignal = stickerVariant > 0 || stickerVariantReason > 0 || hasVideoResource;
    if (!hasExplicitStickerSignal) return null;

    const mediaCandidates = [
        asset.resourceModel,
        asset.resourceModel?.urlList,
        asset.resourceByteVC1Model,
        asset.resourceByteVC1Model?.urlList,
        asset.resourceUri,
        asset.videoResourceList?.map((entry) => entry?.videoUrl?.urlList || entry?.videoUrl || null),
        asset.videoResourceList?.map((entry) => entry?.videoUrl?.uri || null)
    ];
    return resolveFirstRenderableImageUrl(mediaCandidates);
}

function resolveTikTokGiftContentImage(data = {}, giftData = {}, giftDetails = {}, extendedGiftInfo = {}) {
    const explicitCandidates = [
        data?.contentimg,
        data?.contentImage,
        data?.content_image,
        data?.stickerUrl,
        data?.sticker_url,
        data?.stickerImage,
        data?.sticker_image,
        data?.sticker?.url,
        data?.sticker?.image,
        data?.mediaUrl,
        data?.media_url,
        data?.media?.url,
        giftData?.stickerUrl,
        giftData?.sticker_url,
        giftData?.stickerImage,
        giftData?.sticker_image,
        giftData?.sticker?.url,
        giftData?.sticker?.image,
        giftDetails?.stickerUrl,
        giftDetails?.sticker_url,
        giftDetails?.stickerImage,
        giftDetails?.sticker_image,
        giftDetails?.sticker?.url,
        giftDetails?.sticker?.image,
        extendedGiftInfo?.stickerUrl,
        extendedGiftInfo?.sticker_url,
        extendedGiftInfo?.stickerImage,
        extendedGiftInfo?.sticker_image,
        extendedGiftInfo?.sticker?.url,
        extendedGiftInfo?.sticker?.image,
        data?.mTrayInfo?.mDynamicImg,
        giftData?.mTrayInfo?.mDynamicImg,
        giftDetails?.mTrayInfo?.mDynamicImg,
        extendedGiftInfo?.mTrayInfo?.mDynamicImg
    ];

    for (const candidate of explicitCandidates) {
        const resolved = resolveFirstRenderableImageUrl(candidate);
        if (resolved) {
            return resolved;
        }
    }

    const assetCandidates = [
        data?.asset,
        giftData?.asset,
        giftDetails?.asset,
        extendedGiftInfo?.asset
    ];
    if (Array.isArray(data?.giftsInBox?.gifts)) {
        data.giftsInBox.gifts.forEach((giftEntry) => {
            if (giftEntry?.asset) {
                assetCandidates.push(giftEntry.asset);
            }
        });
    }

    for (const asset of assetCandidates) {
        const resolved = resolveGiftAssetMediaUrl(asset);
        if (resolved) return resolved;
    }

    return null;
}

/**
 * Resolve a display image for a gift.  Prefers sticker/media-style images
 * (the existing resolveTikTokGiftContentImage path), then falls back to the
 * generic gift icon fields (giftPictureUrl, iconUrl, pictureUrl, etc.) that
 * were previously commented out.
 */
function resolveTikTokGiftDisplayImage(data = {}, giftData = {}, giftDetails = {}, extendedGiftInfo = {}) {
    // 1. Sticker / media / asset images (preferred for rich gifts)
    const stickerImage = resolveTikTokGiftContentImage(data, giftData, giftDetails, extendedGiftInfo);
    if (stickerImage) return stickerImage;

    // 2. Generic gift icon fields
    const iconCandidates = [
        data.giftPictureUrl,
        giftData.giftPictureUrl,
        giftData.iconUrl,
        giftData.icon_url,
        giftData.pictureUrl,
        giftData.picture_url,
        giftData.imageUrl,
        giftData.image_url,
        giftData.image,
        giftDetails.icon,
        giftDetails.giftImage,
        extendedGiftInfo.icon,
        extendedGiftInfo.image
    ];
    return resolveFirstRenderableImageUrl(iconCandidates);
}

function resolveGiftMetricCount(data = {}, metric = 'repeat') {
    const camel = `${metric}Count`;
    const snake = `${metric}_count`;
    const giftData = isPlainObject(data?.gift) ? data.gift : {};
    const giftDetails = isPlainObject(data?.giftDetails) ? data.giftDetails : {};
    const extendedGiftInfo = isPlainObject(data?.extendedGiftInfo) ? data.extendedGiftInfo : {};

    let maxValue = 0;
    const candidates = [
        data?.[camel],
        data?.[snake],
        giftData?.[camel],
        giftData?.[snake],
        giftDetails?.[camel],
        giftDetails?.[snake],
        extendedGiftInfo?.[camel],
        extendedGiftInfo?.[snake]
    ];

    for (const candidate of candidates) {
        const numeric = Number(candidate);
        if (Number.isFinite(numeric) && numeric > maxValue) {
            maxValue = numeric;
        }
    }

    return Math.max(0, Math.floor(maxValue));
}

function resolveGiftAggregatedCount(data = {}) {
    const repeatCount = resolveGiftMetricCount(data, 'repeat');
    const comboCount = resolveGiftMetricCount(data, 'combo');
    const groupCount = resolveGiftMetricCount(data, 'group');
    return Math.max(1, repeatCount, comboCount, groupCount);
}

function resolveGiftId(data = {}) {
    const giftData = isPlainObject(data?.gift) ? data.gift : {};
    const giftDetails = isPlainObject(data?.giftDetails) ? data.giftDetails : {};
    const extendedGiftInfo = isPlainObject(data?.extendedGiftInfo) ? data.extendedGiftInfo : {};

    return pickFirstNonEmptyString([
        data.giftId,
        data.gift_id,
        data.giftIdStr,
        data.gift_id_str,
        giftData.giftId,
        giftData.gift_id,
        giftData.id,
        giftData.id_str,
        giftData.giftIdStr,
        giftData.gift_id_str,
        giftDetails.id,
        giftDetails.id_str,
        giftDetails.giftId,
        giftDetails.gift_id,
        giftDetails.giftIdStr,
        giftDetails.gift_id_str,
        extendedGiftInfo.id,
        extendedGiftInfo.id_str,
        extendedGiftInfo.giftId,
        extendedGiftInfo.gift_id,
        extendedGiftInfo.giftIdStr,
        extendedGiftInfo.gift_id_str
    ]);
}

function normalizeGiftStreakKeyFragment(value) {
    const cleaned = cleanVisibleString(value);
    if (!cleaned) {
        return null;
    }
    return cleaned
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9._:-]/g, '')
        .slice(0, 64) || null;
}

function resolveGiftStreakIdentity(data = {}) {
    const giftId = resolveGiftId(data);
    if (giftId) {
        return { giftId, keyFragment: `id:${giftId}` };
    }

    const giftData = isPlainObject(data?.gift) ? data.gift : {};
    const giftDetails = isPlainObject(data?.giftDetails) ? data.giftDetails : {};
    const extendedGiftInfo = isPlainObject(data?.extendedGiftInfo) ? data.extendedGiftInfo : {};

    const giftName = pickFirstNonEmptyString([
        data.giftName,
        giftData.giftName,
        giftData.name,
        giftData.displayName,
        giftData.title,
        giftDetails.giftName,
        giftDetails.describe,
        extendedGiftInfo.name,
        extendedGiftInfo.describe
    ]);

    const normalizedName = normalizeGiftStreakKeyFragment(giftName);
    if (normalizedName) {
        return { giftId: null, keyFragment: `name:${normalizedName}` };
    }

    const diamondHint = pickFirstPositiveNumber([
        data.diamondCount,
        data.diamond_count,
        giftData.diamondCount,
        giftData.diamond_count,
        giftDetails.diamondCount,
        giftDetails.diamond_count,
        extendedGiftInfo.diamondCount,
        extendedGiftInfo.diamond_count
    ]);

    if (diamondHint > 0) {
        return { giftId: null, keyFragment: `value:${diamondHint}` };
    }

    return { giftId: null, keyFragment: 'gift' };
}

function normalizeGiftIgnoreConfigValue(value) {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;

        const numeric = Number(trimmed);
        if (Number.isFinite(numeric)) {
            return numeric;
        }

        const normalized = trimmed.toLowerCase();
        if (normalized.includes('ignore_tray_and_ps_m')) {
            return GIFT_IGNORE_CONFIG_IGNORE_TRAY_AND_PS_M;
        }
        if (normalized.includes('ignore_tray')) {
            return GIFT_IGNORE_CONFIG_IGNORE_TRAY;
        }
        if (normalized.includes('not_ignore')) {
            return GIFT_IGNORE_CONFIG_NOT_IGNORE;
        }
    }

    return null;
}

function resolveInteractiveGiftIgnoreConfig(data = {}) {
    const interactiveGiftInfo = isPlainObject(data?.interactiveGiftInfo) ? data.interactiveGiftInfo : {};
    const candidates = [
        interactiveGiftInfo.ignoreConfig,
        interactiveGiftInfo.ignore_config,
        data.ignoreConfig,
        data.ignore_config
    ];

    for (const candidate of candidates) {
        const normalized = normalizeGiftIgnoreConfigValue(candidate);
        if (normalized !== null) {
            return normalized;
        }
    }

    return null;
}

function isGiftHiddenFromTray(data = {}, resolvedIgnoreConfig = null) {
    const ignoreConfig = resolvedIgnoreConfig !== null
        ? resolvedIgnoreConfig
        : resolveInteractiveGiftIgnoreConfig(data);

    return ignoreConfig !== null && GIFT_IGNORE_CONFIG_HIDE_TRAY_VALUES.has(ignoreConfig);
}

// Load CircularBuffer if available
let CircularBuffer;
try {
    CircularBuffer = require('../circular-buffer.js');
} catch (e) {
    // Fallback to array if CircularBuffer not available
    CircularBuffer = null;
}

class MessageProcessor {
    constructor(manager) {
        this.manager = manager;
        // Use CircularBuffer if available, otherwise fallback to array
        if (CircularBuffer) {
            this.queue = new CircularBuffer(CONFIG.CHAT.MAX_QUEUE_SIZE);
        } else {
            this.queue = [];
        }
        this.isProcessing = false;
        this.pendingBatch = [];
        this.batchTimer = null;
        this.processTimer = null;
        this.pendingProcessInterval = null;
        this.lastSendTime = Date.now();
        this.lastProcessedTimestamp = 0;
        this.highWaterLoggedAt = 0;
        this.droppedSinceHighWater = 0;
    }

    addToQueue(data) {

        // Dedupe: drop chat messages already seen (replay history is seeded
        // upstream in handleProtoFetch so reconnect overlaps are caught here
        // without blanket-dropping live traffic during the replay window).
        if (this.manager?.shouldSuppressDuplicateEvent && this.manager.shouldSuppressDuplicateEvent('chat', data)) {
            return;
        }

        const timestamp = this.extractMessageTimestamp(data);
        const graceWindow = CONFIG.CHAT.STALE_MESSAGE_GRACE_MS || (3 * 60 * 1000);
        if (timestamp !== null && this.lastProcessedTimestamp > 0) {
            const cutoff = this.lastProcessedTimestamp - graceWindow;
            if (timestamp < cutoff) {
                const identifier = data?.msgId || data?.msg_id || 'unknown';
                log(`Dropping stale TikTok message: ${identifier}`);
                return;
            }
        }

        if (timestamp !== null) {
            this.lastProcessedTimestamp = Math.max(this.lastProcessedTimestamp, timestamp);
        }

        // Enforce queue caps (works for CircularBuffer and Array)
        const getSize = () => (this.queue.getSize ? this.queue.getSize() : this.queue.length);
        const capacity = CONFIG.CHAT.MAX_QUEUE_SIZE;
        let qSize = getSize();
        if (qSize >= capacity) {
            const dropsNeeded = Math.max(1, qSize - capacity + 1);
            const dropChunk = Math.max(10, Math.ceil(capacity * 0.01));
            const totalToDrop = dropsNeeded <= dropChunk
                ? dropsNeeded
                : Math.min(qSize, dropsNeeded + dropChunk);
            const droppedEntries = typeof this.queue.splice === 'function'
                ? this.queue.splice(0, Math.min(totalToDrop, qSize))
                : (() => {
                    const removed = [];
                    const limit = Math.min(totalToDrop, qSize);
                    for (let i = 0; i < limit; i++) {
                        const next = typeof this.queue.shift === 'function'
                            ? this.queue.shift()
                            : this.queue.length ? this.queue[i] : undefined;
                        if (typeof next === 'undefined') break;
                        removed.push(next);
                    }
                    if (!this.queue.splice && Array.isArray(this.queue) && removed.length) {
                        this.queue.splice(0, removed.length);
                    }
                    return removed;
                })();

            if (droppedEntries.length > 0) {
                this.droppedSinceHighWater += droppedEntries.length;
                const now = Date.now();
                if (!this.highWaterLoggedAt || (now - this.highWaterLoggedAt) > 5000) {
                    log(`[TikTok] message queue high-water trimmed ${this.droppedSinceHighWater} messages.`);
                    this.highWaterLoggedAt = now;
                    this.droppedSinceHighWater = 0;
                }
            }
            qSize = getSize();
        }

        // Add the new item
        if (this.queue.push) this.queue.push(data);
        else {
            // Extremely unlikely path, but keep safe
            try { this.queue[this.queue.length] = data; } catch (_) { }
        }
        this.startProcessing();
    }

    extractMessageTimestamp(data = {}) {
        const candidates = [
            data?.createTime,
            data?.eventTime,
            data?.timestamp,
            data?.msgTime,
            data?.event?.createTime,
            data?.event?.eventTime
        ];

        for (const value of candidates) {
            if (value === undefined || value === null) {
                continue;
            }

            let numericValue = null;

            if (typeof value === 'number' && Number.isFinite(value)) {
                numericValue = value;
            } else if (typeof value === 'bigint') {
                numericValue = Number(value);
            } else if (typeof value === 'string') {
                const trimmed = value.trim();
                if (!trimmed) continue;
                const numeric = Number(trimmed);
                if (Number.isFinite(numeric)) {
                    numericValue = numeric;
                } else {
                    const parsed = Date.parse(trimmed);
                    if (!Number.isNaN(parsed)) {
                        numericValue = parsed;
                    }
                }
            }

            if (!Number.isFinite(numericValue) || numericValue <= 0) {
                continue;
            }

            if (numericValue < 1e12) {
                return Math.floor(numericValue * 1000);
            }

            if (numericValue > 1e15) {
                return Math.floor(numericValue / 1000);
            }

            return Math.floor(numericValue);
        }

        return null;
    }

    formatChatMessage(data) {
        const msg = composeTikTokChatMessage(data, { includeTopGifterBadgeAlways: false });
        if (typeof msg.textonly !== 'boolean') {
            msg.textonly = isTextOnlyModeEnabled();
        }
        if (typeof msg.textonlymode !== 'boolean') {
            msg.textonlymode = msg.textonly;
        }
        msg.type = 'tiktok';
        return msg;
    }

    scheduleProcessing(interval) {
        if (this.isProcessing) {
            return;
        }
        const delay = Number.isFinite(interval) && interval >= 0 ? interval : 0;
        if (this.processTimer) {
            if (typeof this.pendingProcessInterval === 'number' && delay >= this.pendingProcessInterval) {
                return;
            }
            clearTimeout(this.processTimer);
        }
        this.pendingProcessInterval = delay;
        this.processTimer = setTimeout(() => {
            this.processTimer = null;
            this.pendingProcessInterval = null;
            this.processQueue();
        }, delay);
    }

    startProcessing() {
        if (!this.isProcessing) {
            // Get queue size properly for both CircularBuffer and array
            const queueSize = this.queue.getSize ? this.queue.getSize() : this.queue.length;
            if (queueSize === 0) {
                return;
            }
            // Use faster processing when queue is large
            const interval = queueSize >= CONFIG.CHAT.HIGH_WATER_THRESHOLD
                ? CONFIG.CHAT.HIGH_WATER_INTERVAL
                : (queueSize > CONFIG.CHAT.HIGH_LOAD_THRESHOLD
                    ? CONFIG.CHAT.HIGH_LOAD_INTERVAL
                    : (queueSize < 10
                        ? 20
                        : CONFIG.CHAT.PROCESSING_INTERVAL));
            this.scheduleProcessing(interval);
        }
    }

    processQueue() {
        if (this.processTimer) {
            clearTimeout(this.processTimer);
            this.processTimer = null;
            this.pendingProcessInterval = null;
        }
        // Check if queue is empty properly for both CircularBuffer and array
        const getSize = () => (this.queue.getSize ? this.queue.getSize() : this.queue.length);
        const queueSize = getSize();
        if (queueSize === 0 && this.pendingBatch.length === 0) {
            this.isProcessing = false;
            return;
        }

        this.isProcessing = true;
        const standardBatch = CONFIG.CHAT.STANDARD_BATCH_SIZE || 50;
        const highLoadBatch = CONFIG.CHAT.HIGH_LOAD_BATCH_SIZE || Math.max(standardBatch, 120);
        const highWaterBatch = CONFIG.CHAT.HIGH_WATER_BATCH_SIZE || Math.max(highLoadBatch, 250);

        const isHighWater = queueSize >= CONFIG.CHAT.HIGH_WATER_THRESHOLD;
        const isHighLoad = queueSize >= CONFIG.CHAT.HIGH_LOAD_THRESHOLD;
        const isLowTraffic = queueSize < 10;

        let batchSize;
        if (isHighWater) {
            batchSize = highWaterBatch;
        } else if (isHighLoad) {
            batchSize = highLoadBatch;
        } else if (isLowTraffic) {
            batchSize = queueSize || 1;
        } else {
            batchSize = standardBatch;
        }

        const batch = this.queue.splice(0, Math.min(batchSize, queueSize));

        try {
            if (batch.length > 0) {
                if (isHighWater || isHighLoad) {
                    if (this.pendingBatch.length > 0) {
                        this.flushPendingBatch();
                    }
                    const messages = batch.map(data => {
                        const msg = this.formatChatMessage(data);
                        msg.tid = this.manager.virtualTabId;
                        return msg;
                    });
                    if (messages.length === 1) {
                        sendToBackground(messages[0]);
                    } else {
                        sendBatchToBackground(messages);
                    }
                    this.lastSendTime = Date.now();
                } else if (isLowTraffic) {
                    const messages = batch.map(data => {
                        const msg = this.formatChatMessage(data);
                        msg.tid = this.manager.virtualTabId;
                        return msg;
                    });
                    if (messages.length === 1) {
                        sendToBackground(messages[0]);
                    } else {
                        sendBatchToBackground(messages);
                    }
                    this.lastSendTime = Date.now();
                } else {
                    this.addToPendingBatch(batch);
                }
            }
        } catch (e) {
            console.error('Error processing message batch:', e);
        }

        this.isProcessing = false;
        const remaining = getSize();
        if (remaining > 0) {
            // Dynamic interval based on updated queue size
            const nextInterval = remaining >= CONFIG.CHAT.HIGH_WATER_THRESHOLD
                ? CONFIG.CHAT.HIGH_WATER_INTERVAL
                : (remaining > CONFIG.CHAT.HIGH_LOAD_THRESHOLD
                    ? CONFIG.CHAT.HIGH_LOAD_INTERVAL
                    : (remaining < 10
                        ? 20
                        : CONFIG.CHAT.PROCESSING_INTERVAL));
            this.scheduleProcessing(nextInterval);
        } else if (this.pendingBatch.length > 0) {
            // Ensure pending batch is sent
            this.flushPendingBatch();
        }
    }

    addToPendingBatch(batch) {
        // Add messages to pending batch
        batch.forEach(data => {
            const msg = this.formatChatMessage(data);
            msg.tid = this.manager.virtualTabId;
            this.pendingBatch.push(msg);
        });

        // Clear existing timer
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
        }

        // Set up time-based flushing (max 50ms wait for smooth flow)
        this.batchTimer = setTimeout(() => {
            this.flushPendingBatch();
        }, 50);

        // Also flush if batch gets large enough
        if (this.pendingBatch.length >= 50) {
            this.flushPendingBatch();
        }
    }

    flushPendingBatch() {
        if (this.pendingBatch.length === 0) return;

        // Clear timer
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }

        // Send the batch
        sendBatchToBackground(this.pendingBatch);
        this.pendingBatch = [];
        this.lastSendTime = Date.now();
    }
}

class GiftProcessor {
    constructor(manager) {
        this.manager = manager;
        this.queue = [];
        this.isProcessing = false;
        this.streaks = new Map();
    }

    addToQueue(data) {
        if (!data || typeof data !== 'object') {
            return;
        }

        // Dedupe: drop gifts already seen (replay history is seeded upstream
        // in handleProtoFetch so reconnect overlaps are caught here without
        // blanket-dropping live traffic during the replay window).
        if (this.manager?.shouldSuppressDuplicateEvent && this.manager.shouldSuppressDuplicateEvent('gift', data)) {
            return;
        }

        const repeatCount = resolveGiftMetricCount(data, 'repeat');
        const comboCount = resolveGiftMetricCount(data, 'combo');
        const groupCount = resolveGiftMetricCount(data, 'group');

        let giftType = null;
        const giftTypeCandidates = [
            data.giftType,
            data?.gift?.giftType,
            data?.gift?.type,
            data?.gift?.gift_type,
            data?.giftDetails?.giftType,
            data?.giftDetails?.gift_type
        ];
        for (const candidate of giftTypeCandidates) {
            const numeric = Number(candidate);
            if (Number.isFinite(numeric)) {
                giftType = numeric;
                break;
            }
        }

        const aggregatedCount = resolveGiftAggregatedCount(data);

        const identity = extractTikTokIdentity(data);
        const userKey = resolveTikTokUserId(data, identity) || identity.uniqueId || 'unknown';
        const giftIdentity = resolveGiftStreakIdentity(data);
        const streakKey = `${userKey}:${giftIdentity.keyFragment}`;

        const streakable = !data.repeatEnd && (aggregatedCount > 1 || giftType === 1 || repeatCount > 1 || comboCount > 1 || groupCount > 1);
        const existingStreak = this.streaks.get(streakKey);

        // Flush and emit immediately when repeatEnd arrives, merging any pending streak
        if (data.repeatEnd) {
            const previousTotal = existingStreak ? existingStreak.lastTotal || 0 : 0;
            const increment = aggregatedCount > previousTotal ? aggregatedCount - previousTotal : 0;
            if (existingStreak) {
                clearTimeout(existingStreak.timer);
                this.streaks.delete(streakKey);
                const totalCount = existingStreak.count + Math.max(0, increment);
                this.queue.push({
                    data: data || existingStreak.lastData,
                    count: Math.max(1, totalCount)
                });
                this.startProcessing();
                return;
            }
            this.queue.push({
                data,
                count: aggregatedCount
            });
            this.startProcessing();
            return;
        }

        // Merge ongoing streaks (even if payload lacks repeatEnd)
        // Wait for repeatEnd to flush; only set a long safety timeout once
        if (existingStreak || streakable) {
            const next = existingStreak || { count: 0, lastData: null, lastTotal: 0, timer: null };
            const prevTotal = Number(next.lastTotal) || 0;
            const increment = aggregatedCount > prevTotal ? aggregatedCount - prevTotal : 0;
            const safeIncrement = Math.max(0, increment);
            next.count += safeIncrement;
            next.lastData = data;
            next.lastTotal = Math.max(prevTotal, aggregatedCount);
            // Only set a safety timer once (don't reset on each event)
            // The combo will flush when repeatEnd arrives; this is just a fallback
            if (!next.timer) {
                next.timer = setTimeout(() => {
                    this.flushStreak(streakKey);
                }, CONFIG.GIFT.STREAK_SAFETY_TIMEOUT_MS || 30000);
            }
            this.streaks.set(streakKey, next);
            return;
        }

        // Single, non-streak gift
        this.queue.push({
            data,
            count: aggregatedCount
        });
        this.startProcessing();
    }

    flushStreak(streakKey) {
        const streak = this.streaks.get(streakKey);
        if (!streak) return;
        clearTimeout(streak.timer);
        this.streaks.delete(streakKey);
        const safeCount = Math.max(1, streak.count || 1);
        this.queue.push({
            data: streak.lastData,
            count: safeCount
        });
        this.startProcessing();
    }

    startProcessing() {
        if (!this.isProcessing) {
            this.processQueue();
        }
    }

    async processQueue() {
        if (this.queue.length === 0) {
            this.isProcessing = false;
            return;
        }

        this.isProcessing = true;
        const {
            data,
            count
        } = this.queue.shift();

        try {
            this.sendGiftMessage(data, count);
        } catch (error) {
            console.error('[GiftProcessor] sendGiftMessage failed:', error?.message || error);
        }

        setTimeout(() => this.processQueue(), CONFIG.GIFT.PROCESSING_INTERVAL);
    }

    sendGiftMessage(data, count) {
        const giftData = isPlainObject(data?.gift) ? data.gift : {};
        const giftDetails = isPlainObject(data?.giftDetails) ? data.giftDetails : {};
        const extendedGiftInfo = isPlainObject(data?.extendedGiftInfo) ? data.extendedGiftInfo : {};

        const giftId = resolveGiftId(data);

        const mappedGiftName = giftId && giftMapping && giftMapping[giftId] ? giftMapping[giftId].name : null;
        const giftName = pickFirstNonEmptyString([
            data.giftName,
            giftData.giftName,
            giftData.name,
            giftData.displayName,
            giftData.title,
            giftDetails.giftName,
            giftDetails.describe,
            extendedGiftInfo.name,
            extendedGiftInfo.describe,
            mappedGiftName
        ]) || (giftId ? `Gift ${giftId}` : 'Gift');

        const perGiftDiamonds = pickFirstPositiveNumber([
            data.diamondCount,
            giftData.diamondCount,
            giftData.diamond_count,
            giftData.diamondValue,
            giftData.diamond_value,
            giftData.value,
            giftData.coins,
            giftDetails.diamondCount,
            giftDetails.diamond_count,
            extendedGiftInfo.diamondCount,
            extendedGiftInfo.diamond_count,
            extendedGiftInfo.coins,
            giftId && giftMapping && giftMapping[giftId] ? giftMapping[giftId].coins : 0
        ]);
        const totalDiamonds = perGiftDiamonds * count;
        const donationDisplay = totalDiamonds > 0 ? `${totalDiamonds} 💎` : null;
        const interactiveGiftIgnoreConfig = resolveInteractiveGiftIgnoreConfig(data);
        const hiddenFromTray = isGiftHiddenFromTray(data, interactiveGiftIgnoreConfig);
        const outgoingEventType = hiddenFromTray ? 'reaction' : 'gift';

        const identity = extractTikTokIdentity(data);
        const resolvedUserId = resolveTikTokUserId(data, identity);
        const resolvedChatname = resolveTikTokDisplayName(data, identity, resolvedUserId);
        const explicitTextOnly = data && (data.textonly === true || data.textonlymode === true);
        const textOnly = explicitTextOnly || isTextOnlyModeEnabled();
        const contentImage = textOnly
            ? null
            : resolveTikTokGiftDisplayImage(data, giftData, giftDetails, extendedGiftInfo);

        let chatmessage = `Sent ${giftName} x${count}`;

        const msg = {
            chatmessage,
            type: "tiktok",
            textonly: textOnly,
            textonlymode: textOnly,
            event: outgoingEventType,
            chatname: resolvedChatname,
            chatimg: identity.profilePictureUrl
                || normalizeTikTokImageUrl(data.profilePictureUrl)
                || normalizeTikTokImageUrl(data.profilePicture)
                || normalizeTikTokImageUrl(data?.user?.profilePictureUrl)
                || normalizeTikTokImageUrl(data?.user?.profilePicture)
                || null,
            moderator: resolveTikTokModeratorStatus(data),
            membership: resolveTikTokSubscriberStatus(data),
            tid: this.manager.virtualTabId,
            title: giftName
        };

        // Preserve upstream ids/timestamps for downstream dedupe and debugging
        const upstreamMsgId = data?.common?.msgId || data?.msgId || data?.msg_id;
        if (upstreamMsgId) msg.msgId = String(upstreamMsgId);
        const upstreamCreateTime = data?.common?.createTime || data?.createTime;
        if (upstreamCreateTime) msg.createTime = String(upstreamCreateTime);

        if (resolvedUserId) {
            msg.userid = resolvedUserId;
        }
        if (contentImage) {
            msg.contentimg = contentImage;
        }
        if (donationDisplay && !hiddenFromTray) {
            msg.hasDonation = donationDisplay;
            msg.donoValue = totalDiamonds * 0.005;
        }
        const fanTicketCount = pickFirstPositiveNumber([
            data.fanTicketCount,
            giftDetails.fanTicketCount,
            extendedGiftInfo.fan_ticket_count
        ]) * count;

        const repeatCount = resolveGiftMetricCount(data, 'repeat');
        const comboCount = resolveGiftMetricCount(data, 'combo');
        const groupCount = resolveGiftMetricCount(data, 'group');

        const meta = sanitizeEventMeta({
            giftId,
            count,
            repeatCount: repeatCount > 1 ? repeatCount : undefined,
            comboCount: comboCount > 1 ? comboCount : undefined,
            groupCount: groupCount > 1 ? groupCount : undefined,
            diamondsPerGift: perGiftDiamonds || undefined,
            diamondsTotal: totalDiamonds || undefined,
            fanTickets: fanTicketCount > 0 ? fanTicketCount : undefined,
            interactiveGift: interactiveGiftIgnoreConfig !== null ? {
                ignoreConfig: interactiveGiftIgnoreConfig,
                hiddenFromTray
            } : undefined
        });
        if (meta) {
            msg.meta = meta;
        }

        const rawColor = data.nameColor || data.name_color || data.user?.nameColor;
        const safeColor = normalizeNameColor(rawColor);
        if (safeColor) {
            msg.nameColor = safeColor;
        }

        sendToBackground(msg);
    }
}

class ConnectionManager {
    constructor(username, wssID, sessionId = null, ttTargetIdc = null, options = {}) {
        this.username = username;
        this.wssID = wssID;
        const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : null;
        const normalizedTtTargetIdc = typeof ttTargetIdc === 'string' ? ttTargetIdc.trim() : null;
        this.sessionId = normalizedSessionId || null;
        this.ttTargetIdc = normalizedTtTargetIdc || null;
        const { forceLegacyConnector = false, signing = null, autoActivate = false } = options || {};
        this.preferredStrategy = (usingLegacyTikTokConnector || forceLegacyConnector) ? 'legacy' : 'websocket';
        this.connection = null;
        this.lastMessageTime = Date.now();
        this.healthCheckInterval = null;
        this.viewerUpdateInterval = null;
        this.lastViewerCount = 0;
        this.messageProcessor = new MessageProcessor(this);
        this.giftProcessor = new GiftProcessor(this);
        this.activityBuckets = new Map();
        this.recentShoppingEvents = new Map();
        this.recentEventDedupes = new Map();
        this.nextEventDedupePruneAt = 0;
        // Live shopping events rely on 2.x payloads; the Map sticks around harmlessly until we upgrade.
        this.reconnectAttempts = 0;
        this.isStopped = false;
        this.reconnectTimer = null;
        // When true, we keep retrying at a fixed interval to detect when the user goes live
        this.offlineRetry = false;
        this.offlineReason = null;
        this.offlineRetryCount = 0;
        this.autoActivate = !!autoActivate;
        // Per-connection reply-only flag (skip forwarding captured events)
        this.replyOnly = false;
        this.tiktokLogWriter = createTikTokLogWriter(this.username, this.wssID);
        this.tiktokLogFilePath = this.tiktokLogWriter ? this.tiktokLogWriter.filePath : null;
        this.warnedMissingTtTargetIdc = false;
        this.signingConfig = normalizeSigningConfig(signing);
        this.signingProvider = options.signingProvider || 'auto';
        this.userProvidedSigningApiKey = this.signingConfig?.apiKey || null;
        this.sharedEulerApiKeyPool = this.buildSharedEulerApiKeyPool();
        this.sharedEulerApiKeyAttempts = new Set();
        this.autoEulerProxyFallbackAttempted = false;
        this.autoEulerProxyFallbackActive = false;
        this.autoLocalSignerFallbackAttempted = false;
        this.autoLocalSignerFallbackActive = false;
        this.localSigner = env.localSigner || null;
	        this.signServerFailureCount = 0;
	        this.tiktokRateLimitCount = 0;
	        this.tiktokRateLimitLastAt = 0;
	        this.signRequestTimeoutMs = CONFIG.CONNECTION.SIGN_REQUEST_TIMEOUT_MS || 25000;
	        this.signRequestTimeoutBaseMs = this.signRequestTimeoutMs;
        this.signRequestTimeoutStepMs = CONFIG.CONNECTION.SIGN_REQUEST_TIMEOUT_STEP_MS || 10000;
        if (!Number.isFinite(this.signRequestTimeoutStepMs) || this.signRequestTimeoutStepMs <= 0) {
            this.signRequestTimeoutStepMs = 10000;
        }
        this.signRequestTimeoutMaxMs = CONFIG.CONNECTION.SIGN_REQUEST_TIMEOUT_MAX_MS || Math.max(this.signRequestTimeoutMs, this.signRequestTimeoutStepMs);
        if (!Number.isFinite(this.signRequestTimeoutMaxMs) || this.signRequestTimeoutMaxMs < this.signRequestTimeoutMs) {
            this.signRequestTimeoutMaxMs = Math.max(this.signRequestTimeoutMs, this.signRequestTimeoutStepMs * 2);
        }
        this.signRequestImmediateRetryDelayMs = CONFIG.CONNECTION.SIGN_REQUEST_IMMEDIATE_RETRY_DELAY_MS;
        if (!Number.isFinite(this.signRequestImmediateRetryDelayMs) || this.signRequestImmediateRetryDelayMs < 0) {
            this.signRequestImmediateRetryDelayMs = 750;
        }
        this.lastSignerPayload = null;
        this.eulerChatClient = null;
        if (this.tiktokLogWriter) {
            this.tiktokLogWriter.append({
                timestamp: new Date().toISOString(),
                event: 'log_initialized',
                connection: this.getLogContext(),
                payload: { message: 'TikTok logging started' }
            });
        }
        this.pollingFallbackActivated = false;
        // When both connector classes exist we can fallback from 2.x to legacy 1.x.
        this.pollingFallbackSupported = !usingLegacyTikTokConnector &&
            !!(TikTokLiveConnectionClass &&
                TikTokPollingFallbackClass &&
                TikTokPollingFallbackClass !== TikTokLiveConnectionClass);
        this.connectionStrategy = this.preferredStrategy;
        this.activeConnectPromise = null;
        this.enableDirectChatRoute = isDirectChatRouteSupported && !disableDirectChatRoute;
        this.directChatRoute = null;
        this.directChatRouteClient = null;
        this.pendingRoomIdPromise = null;
        this.resumeCursorState = null;
        this.previousRoomId = null;
        this.replayActive = false;
        this.replayActive = false;
        this.pendingStreamEndTimer = null;
        this.pendingStreamEndReason = null;
        this.authenticatedWsBootstrapHost = null;
        this.streamEndConfirmDelayMs = Number(CONFIG.CONNECTION.STREAM_END_CONFIRM_DELAY_MS) || 5000;
        if (!Number.isFinite(this.streamEndConfirmDelayMs) || this.streamEndConfirmDelayMs < 0) {
            this.streamEndConfirmDelayMs = 5000;
        }
        this.signerHelper = env.signerHelper || null;
        this.websocketFailureCount = 0;
        this.WEBSOCKET_FAILURE_THRESHOLD = 3;
        this.lastConnectTimestamp = 0;
        this.rapidDisconnectCount = 0;
    }

    getLogContext() {
        return {
            username: this.username,
            wssID: this.wssID,
            sessionProvided: !!this.sessionId,
            ttTargetIdcProvided: !!this.ttTargetIdc,
            virtualTabId: this.virtualTabId || null
        };
    }

    getConnectionModeDetails() {
        const usingPolling = this.pollingFallbackActivated
            || this.preferredStrategy === 'legacy'
            || this.connectionStrategy === 'legacy'
            || usingLegacyTikTokConnector;

        const hasApiKey = !!(this.signingConfig && this.signingConfig.apiKey);
        const isAuto = this.signingProvider === 'auto';
        const isCustom = this.signingProvider === 'custom';
        const isEulerWs = this.signingProvider === EULER_WS_PROVIDER;
        const useLocalSigner = this.shouldUseLocalSigner();

        if (usingPolling) {
            const legacySuffix = this.pollingFallbackActivated
                ? ' (legacy fallback)'
                : ((usingLegacyTikTokConnector || this.preferredStrategy === 'legacy' || this.connectionStrategy === 'legacy') ? ' (legacy connector)' : '');
            return {
                effectiveMode: 'Polling/Legacy',
                method: `Polling${legacySuffix}`,
                label: `Connected via polling${legacySuffix}`
            };
        }

        if (useLocalSigner) {
            return {
                effectiveMode: 'Local Signer',
                method: 'Local signer',
                label: 'Websocket connected via local signer'
            };
        }

        if (isEulerWs) {
            const method = hasApiKey ? 'Euler WS relay (API key)' : 'Euler WS relay';
            return {
                effectiveMode: 'Euler WS relay',
                method,
                label: `Websocket connected via ${method}`
            };
        }

        if (isCustom) {
            const method = hasApiKey ? 'Custom signer (API key)' : 'Custom signer';
            const effectiveMode = hasApiKey ? 'API Key' : 'Custom API';
            return {
                effectiveMode,
                method,
                label: `Websocket connected via ${method}`
            };
        }

        if (isAuto) {
            const method = hasApiKey ? 'Euler signing (API key)' : 'Euler signing (auto)';
            const effectiveMode = hasApiKey ? 'Auto (Euler API Key)' : 'Auto (Euler)';
            return {
                effectiveMode,
                method,
                label: `Websocket connected via ${method}`
            };
        }

        return {
            effectiveMode: 'Unknown',
            method: 'Unknown',
            label: 'Websocket connected'
        };
    }

    getConnectionMethodForDisplay() {
        const details = this.getConnectionModeDetails();
        return details.method;
    }

    isReplayActive() {
        return !!this.replayActive;
    }

    logDebug(eventName, payload) {
        if (!this.tiktokLogWriter) {
            return;
        }
        const entry = {
            timestamp: new Date().toISOString(),
            event: eventName,
            connection: this.getLogContext()
        };
        if (payload !== undefined) {
            entry.payload = payload;
        }
        this.tiktokLogWriter.append(entry);
    }

    closeLogWriter(reason) {
        if (!this.tiktokLogWriter) {
            return;
        }
        this.logDebug('log_closed', reason ? { reason } : undefined);
        this.tiktokLogWriter.close();
        this.tiktokLogWriter = null;
        this.tiktokLogFilePath = null;
    }

	    buildConnectionOptions(useLegacyConnector = false) {
	        const forceLegacy = useLegacyConnector || usingLegacyTikTokConnector || this.preferredStrategy === 'legacy';
            this.authenticatedWsBootstrapHost = null;
	        if (forceLegacy) {
	            const legacyOptions = {
	                processInitialData: false,
	                enableExtendedGiftInfo: true,
	                enableWebsocketUpgrade: true,
	                fetchRoomInfoOnConnect: true,
	                requestPollingIntervalMs: 1000,
	                clientParams: {
	                    app_language: "en-US",
	                    device_platform: "web"
	                }
	            };
	            if (this.signingConfig?.apiKey) {
	                legacyOptions.signApiKey = this.signingConfig.apiKey;
	            }
	            return legacyOptions;
	        }

	        const clientParams = {
	            app_language: "en-US",
	            device_platform: "web"
	        };
	        const options = {
	            processInitialData: false,
	            enableExtendedGiftInfo: true,
	            enableRequestPolling: true,
	            requestPollingIntervalMs: 1000,
	            fetchRoomInfoOnConnect: true,
	            enableWebsocketUpgrade: !forceLegacy,
	            webClientParams: { ...clientParams },
	            wsClientParams: { ...clientParams },
	            clientParams: { ...clientParams }
	        };
	        const usingLocalSigner = this.shouldUseLocalSigner();
	        if (usingLocalSigner) {
	            // Local signer connections should be as gentle as possible: avoid extra preflight
	            // calls (room info, gift catalog) and rely on the signing window to resolve room_id.
	            options.fetchRoomInfoOnConnect = false;
	            options.enableExtendedGiftInfo = false;
	            options.connectWithUniqueId = true;
	        }
	        if (this.signingConfig?.apiKey && !usingLocalSigner && this.signingProvider !== 'local') {
	            options.signApiKey = this.signingConfig.apiKey;
	        }
            const authenticatedWsHost = this.resolveAuthenticatedWebsocketBootstrapHost();
            if (authenticatedWsHost) {
                options.authenticateWs = true;
            }

        const localProvider = usingLocalSigner
            ? this.createLocalSignedWebSocketProvider()
            : null;
        if (localProvider) {
            options.signedWebSocketProvider = localProvider;
        }

        return options;
    }

    shouldUseLocalSigner() {
        if (!this.localSigner || typeof this.localSigner.sign !== 'function') {
            return false;
        }
        if (this.signingProvider === 'local') {
            return true;
        }
        return false;
    }

    resolveAuthenticatedWebsocketBootstrapHost() {
        this.authenticatedWsBootstrapHost = null;
        if (!this.sessionId || !this.ttTargetIdc) {
            return null;
        }
        if (this.shouldUseLocalSigner()) {
            return null;
        }

        if (this.signingProvider === 'custom') {
            const serviceUrl = this.signingConfig?.serviceUrl || null;
            if (!serviceUrl) {
                return null;
            }
            let parsed;
            try {
                parsed = new URL(serviceUrl);
            } catch (_) {
                return null;
            }
            const hostname = typeof parsed.hostname === 'string'
                ? parsed.hostname.trim().toLowerCase()
                : '';
            const host = typeof parsed.host === 'string'
                ? parsed.host.trim().toLowerCase()
                : '';
            if (!hostname || !host) {
                return null;
            }
            if (isLoopbackHostname(hostname)) {
                this.authenticatedWsBootstrapHost = host;
                return host;
            }
            const allowlist = parseHostAllowlist(process.env.SSAPP_TIKTOK_AUTH_WS_ALLOWED_HOSTS || '');
            if (allowlist.has(host) || allowlist.has(hostname)) {
                this.authenticatedWsBootstrapHost = host;
                return host;
            }
            return null;
        }

        if (this.signingProvider === 'auto' || this.signingProvider === 'euler-ws') {
            this.authenticatedWsBootstrapHost = EULER_SIGNING_HOST;
            return EULER_SIGNING_HOST;
        }

        return null;
    }

    resolveConnectionAuthenticatedWebsocketBootstrapHost(connection = this.connection) {
        if (!connection || typeof connection !== 'object' || !connection.options || connection.options.authenticateWs !== true) {
            return null;
        }
        try {
            const basePath = connection.webClient?.webSigner?.configuration?.basePath || null;
            if (!basePath) {
                return this.authenticatedWsBootstrapHost || null;
            }
            const parsed = new URL(basePath);
            const host = typeof parsed.host === 'string' ? parsed.host.trim().toLowerCase() : '';
            return host || this.authenticatedWsBootstrapHost || null;
        } catch (_) {
            return this.authenticatedWsBootstrapHost || null;
        }
    }

    prepareAuthenticatedWebsocketBootstrapEnv(connection) {
        const host = this.resolveConnectionAuthenticatedWebsocketBootstrapHost(connection);
        if (!host) {
            return null;
        }

        const isFirst = activeAuthWsHostRef.count === 0;
        const originalEnvHost = isFirst
            ? (typeof process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST === 'string'
                ? process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST
                : null)
            : null;
        activeAuthWsHostRef.count += 1;
        activeAuthWsHostRef.host = host;
        process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST = host;
        this.logDebug('sign.auth_ws.bootstrap', {
            host,
            provider: this.signingProvider || null,
            activeCount: activeAuthWsHostRef.count
        });
        return () => {
            activeAuthWsHostRef.count = Math.max(0, activeAuthWsHostRef.count - 1);
            if (activeAuthWsHostRef.count === 0) {
                if (originalEnvHost) {
                    process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST = originalEnvHost;
                } else {
                    delete process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST;
                }
                activeAuthWsHostRef.host = null;
            }
        };
    }

    createLocalSignedWebSocketProvider() {
        if (!this.shouldUseLocalSigner()) {
            return null;
        }
        return async (requestPayload = {}) => {
            return this.fetchSignedWebSocketViaLocalSigner(requestPayload);
        };
    }

    async fetchSignedWebSocketViaLocalSigner(requestPayload = {}) {
        if (!this.localSigner || typeof this.localSigner.sign !== 'function') {
            throw new Error('Local signer unavailable for TikTok connection.');
        }
        const targetRoomId = requestPayload.roomId || this.connection?.clientParams?.room_id || this.connection?.roomId || null;
        const uniqueId = requestPayload.uniqueId || this.username;
        const liveCenterUrl = 'https://livecenter.tiktok.com/realtime';
        const userLiveUrl = `https://www.tiktok.com/@${uniqueId || this.username}/live`;

        // Prefer the public live URL for the signing window to ensure correct Origin/Referer for chat sending
        const targetUrl = userLiveUrl;

        const signOptions = {
            roomId: targetRoomId,
            uniqueId: uniqueId || this.username,
            activeUrl: targetUrl,
            landingUrl: targetUrl,
            fallbackUrl: userLiveUrl,
            performFetch: true,
            fetchOptions: {
                headers: {
                    'Content-Type': 'application/json; charset=utf-8'
                }
            }
	        };
	        let signerPayload;
	        try {
	            signerPayload = await runWithLocalSignerSessionGate(
	                this,
	                uniqueId || this.username,
	                'local_signer_im_fetch',
	                async () => this.localSigner.sign('https://webcast.tiktok.com/webcast/im/fetch/?identity=anchor', signOptions)
	            );
	        } catch (error) {
	            if (error?.code !== 'SSAPP_TIKTOK_STOPPED') {
	                console.error('[TikTok] Local signer invocation failed:', error);
	            }
	            throw error;
	        }

        if (!signerPayload || typeof signerPayload !== 'object') {
            throw new Error('Local signer returned an invalid payload.');
        }

        if (shouldLogTikTokDebug()) {
            console.log('[TikTok] signerPayload received', summarizeSignerPayload(signerPayload));
        }

	        // Update credentials immediately so we persist the session even if we return early
	        this.updateSessionCredentialsFromSigner(signerPayload);

	        const fetchResult = signerPayload.fetchResult && typeof signerPayload.fetchResult === 'object'
	            ? signerPayload.fetchResult
	            : null;
	        const fetchStatus = fetchResult && Number.isFinite(Number(fetchResult.status)) ? Number(fetchResult.status) : null;

	        // If TikTok responded with a non-200 in the signing window, do not double-hit via node fallback.
	        if (fetchResult && Number.isFinite(fetchStatus) && fetchStatus !== 200) {
	            const retryAfterSeconds = parseRetryAfterSeconds(readHeaderCaseInsensitive(fetchResult.headers, 'retry-after'));
	            const statusText = typeof fetchResult.statusText === 'string' ? fetchResult.statusText : '';
	            if (fetchStatus === 429) {
	                const err = new Error(`TikTok rate limited (429)${retryAfterSeconds ? `; retry after ${retryAfterSeconds}s` : ''}`);
	                err.name = 'TikTokRateLimitError';
	                err.status = 429;
	                err.retryAfterSeconds = retryAfterSeconds;
	                err.source = 'local_signer_fetch';
	                throw err;
	            }
	            const err = new Error(`TikTok fetch failed (${fetchStatus})${statusText ? `: ${statusText}` : ''}`);
	            err.name = 'TikTokFetchError';
	            err.status = fetchStatus;
	            err.source = 'local_signer_fetch';
	            throw err;
	        }

	        // If we have a fetch result body from the window, use it.
	        if (fetchResult && typeof fetchResult.bodyBase64 === 'string' && fetchResult.bodyBase64) {
	            try {
	                if (shouldLogTikTokDebug()) {
	                    console.log('[TikTok] Received fetch result from local signer. Status:', fetchResult.status);
	                }

	                const bytes = Buffer.from(fetchResult.bodyBase64, 'base64');
                if (shouldLogTikTokDebug()) {
                    console.log('[TikTok] Body length:', bytes.length);
                }

                const ensureValidProtoMessageFetchResult = (proto, source = 'unknown') => {
                    const wsUrl = proto && typeof proto.wsUrl === 'string' ? proto.wsUrl.trim() : '';
                    if (!wsUrl) {
                        const err = new Error('TikTok did not return a WebSocket URL (wsUrl) during bootstrap.');
                        err.name = 'TikTokWsUrlError';
                        err.code = 'SSAPP_TIKTOK_WSURL_MISSING';
                        err.source = source;
                        throw err;
                    }
                    try {
                        // ws library requires an absolute URL; allow http(s) since ws will coerce it.
                        new URL(wsUrl);
                    } catch (_) {
                        const err = new Error(`TikTok returned an invalid WebSocket URL (wsUrl): ${wsUrl.slice(0, 120)}`);
                        err.name = 'TikTokWsUrlError';
                        err.code = 'SSAPP_TIKTOK_WSURL_INVALID';
                        err.source = source;
                        throw err;
                    }
                    return proto;
                };

                if (typeof connectorDeserializeMessage === 'function') {
                    try {
                        // Try 'WebcastResponse' first as it is the standard wrapper for im/fetch
                        let proto;
                        try {
                            proto = connectorDeserializeMessage('WebcastResponse', bytes);
                        } catch (e) {
                            proto = connectorDeserializeMessage('ProtoMessageFetchResult', bytes);
                        }

                        this.logDebug('sign.local.fetchResult', {
                            hasCursor: Boolean(proto?.cursor),
                            wsUrl: proto?.wsUrl ? '[present]' : '[missing]',
                            internalExtLength: proto?.internalExt ? String(proto.internalExt).length : 0,
                            wsParamKeys: proto?.wsParams ? Object.keys(proto.wsParams) : null,
                            messageCount: Array.isArray(proto?.messages) ? proto.messages.length : null
                        });
                        return ensureValidProtoMessageFetchResult(proto, 'connector_deserialize');
                    } catch (decodeError) {
                        console.warn('[TikTok] Failed to decode fetch result via connector utilities:', decodeError?.message || decodeError);
                    }
                }

                // Helper to find property recursively
                const findProperty = (obj, key, depth = 0, maxDepth = 3, visited = new Set()) => {
                    if (!obj || depth > maxDepth || visited.has(obj)) return null;
                    visited.add(obj);

                    if (obj[key]) return obj[key];

                    // Check prototype
                    const proto = Object.getPrototypeOf(obj);
                    if (proto && proto !== Object.prototype) {
                        const found = findProperty(proto, key, depth + 1, maxDepth, visited);
                        if (found) return found;
                    }

                    // Check properties
                    for (const prop of Object.keys(obj)) {
                        if (typeof obj[prop] === 'object' && obj[prop] !== null) {
                            const found = findProperty(obj[prop], key, depth + 1, maxDepth, visited);
                            if (found) return found;
                        }
                    }
                    return null;
                };

                // Try to find 'protobuf' or 'deserializeMessage'
                let protobufHandler = this.connection?.webClient?.protobuf || this.connection?.protobuf;

                if (!protobufHandler) {
                    // Try deep search for 'protobuf'
                    protobufHandler = findProperty(this.connection, 'protobuf');
                }

                if (protobufHandler && typeof protobufHandler.deserializeMessage === 'function') {
                    try {
                        const proto = protobufHandler.deserializeMessage('WebcastResponse', bytes);
                        return ensureValidProtoMessageFetchResult(proto, 'protobuf_handler_webcastresponse');
                    } catch (e) {
                        const proto = protobufHandler.deserializeMessage('ProtoMessageFetchResult', bytes);
                        return ensureValidProtoMessageFetchResult(proto, 'protobuf_handler_protomessagefetchresult');
                    }
                }

                // Try to find 'deserializeMessage' directly
                const deserializer = findProperty(this.connection, 'deserializeMessage');
                if (typeof deserializer === 'function') {
                    // We need to bind it to the correct context?
                    // Or maybe it's a method on webClient?
                    // If found on webClient prototype, call it on webClient
                    if (typeof this.connection.webClient.deserializeMessage === 'function') {
                        const proto = this.connection.webClient.deserializeMessage('ProtoMessageFetchResult', bytes);
                        return ensureValidProtoMessageFetchResult(proto, 'webclient_deserialize');
                    }
                }

                // Try requiring internal modules
                try {
                    const { TikTokHttpClient } = require('tiktok-live-connector/dist/lib/web/lib/http-client');
                    if (TikTokHttpClient && TikTokHttpClient.prototype.deserializeMessage) {
                        console.log('[TikTok] Found deserializeMessage on TikTokHttpClient prototype');
                        // Call it using our webClient instance
                        const proto = TikTokHttpClient.prototype.deserializeMessage.call(this.connection.webClient, 'ProtoMessageFetchResult', bytes);
                        return ensureValidProtoMessageFetchResult(proto, 'http_client_deserialize');
                    }
                } catch (e) {
                    console.error('[TikTok] Failed to require TikTokHttpClient:', e);
                }

                console.error('[TikTok] Could not find protobuf handler.');
                throw new Error('Could not find deserialization method on webClient');
            } catch (err) {
                console.error('[TikTok] Failed to deserialize fetch result from local signer:', err);
                // If deserialization fails, we might want to fall through to manual fetch, 
                // but manual fetch is likely to fail too. 
                // However, if the error is just "deserialization failed", maybe the manual fetch 
                // (which uses the library's internal method) might work if it does something special?
                // But we know manual fetch fails with 403.
	                // So we should probably throw here.
	                throw err;
	            }
	        } else {
	            if (!fetchResult) {
	                console.warn('[TikTok] No fetchResult in signer payload. performFetch was requested.');
	            } else if (signerPayload.fetchError) {
	                console.error('[TikTok] Signer reported fetch error:', signerPayload.fetchError);
	            } else if (shouldLogTikTokDebug()) {
	                console.warn('[TikTok] Local signer returned fetch metadata without a body.');
	            }
	        }

        if (!signerPayload.pathWithQuery || typeof signerPayload.pathWithQuery !== 'string') {
            throw new Error('Local signer payload missing path/query information. Make sure the signing window is on a live room.');
        }

        const { params } = this.parseSignedFetchParams(signerPayload.pathWithQuery, targetRoomId);
        const headers = this.buildLocalSignerHeaders(signerPayload);

        try {
            // Fallback to manual fetch if performFetch failed or wasn't supported (though it should be now)
            const proto = await this.connection.webClient.getDeserializedObjectFromWebcastApi(
                'im/fetch/',
                params,
                'ProtoMessageFetchResult',
                false,
                { headers }
            );
            const wsUrl = proto && typeof proto.wsUrl === 'string' ? proto.wsUrl.trim() : '';
            if (!wsUrl) {
                const err = new Error('TikTok did not return a WebSocket URL (wsUrl) during bootstrap.');
                err.name = 'TikTokWsUrlError';
                err.code = 'SSAPP_TIKTOK_WSURL_MISSING';
                err.source = 'local_signer_manual_fetch';
                throw err;
            }
            try {
                new URL(wsUrl);
            } catch (_) {
                const err = new Error(`TikTok returned an invalid WebSocket URL (wsUrl): ${wsUrl.slice(0, 120)}`);
                err.name = 'TikTokWsUrlError';
                err.code = 'SSAPP_TIKTOK_WSURL_INVALID';
                err.source = 'local_signer_manual_fetch';
                throw err;
            }
            return proto;
	        } catch (error) {
	            console.error('[TikTok] Failed to fetch signed WebSocket payload via local signer:', error);
	            throw error;
	        }
	    }

	    applyRoomIdToConnection(roomId, source = 'unknown') {
	        const normalized = (() => {
	            if (typeof roomId === 'string') {
	                const trimmed = roomId.trim();
	                return trimmed ? trimmed : null;
	            }
	            if (roomId === undefined || roomId === null) {
	                return null;
	            }
	            const asString = String(roomId).trim();
	            return asString ? asString : null;
	        })();
	        if (!normalized) {
	            return null;
	        }

	        const connection = this.connection;
	        if (!connection) {
	            return normalized;
	        }

	        let applied = false;
	        const needsUpdate = (current) => {
	            if (!current) {
	                return true;
	            }
	            const currentText = typeof current === 'string' ? current.trim() : String(current).trim();
	            return !currentText || currentText !== normalized;
	        };

	        try {
	            if (connection.clientParams && typeof connection.clientParams === 'object') {
	                if (needsUpdate(connection.clientParams.room_id)) {
	                    connection.clientParams.room_id = normalized;
	                    applied = true;
	                }
	            }
	        } catch (_) { /* noop */ }

	        try {
	            if (connection.webClient) {
	                if (needsUpdate(connection.webClient.roomId)) {
	                    connection.webClient.roomId = normalized;
	                    applied = true;
	                }
	                if (connection.webClient.clientParams && typeof connection.webClient.clientParams === 'object') {
	                    if (needsUpdate(connection.webClient.clientParams.room_id)) {
	                        connection.webClient.clientParams.room_id = normalized;
	                        applied = true;
	                    }
	                }
	            }
	        } catch (_) { /* noop */ }

	        try {
	            if (connection.options && typeof connection.options === 'object') {
	                const targets = [
	                    connection.options.clientParams,
	                    connection.options.webClientParams,
	                    connection.options.wsClientParams
	                ];
	                for (const target of targets) {
	                    if (target && typeof target === 'object' && needsUpdate(target.room_id)) {
	                        target.room_id = normalized;
	                        applied = true;
	                    }
	                }
	            }
	        } catch (_) { /* noop */ }

	        try {
	            if (needsUpdate(connection.roomId)) {
	                connection.roomId = normalized;
	                applied = true;
	            }
	        } catch (_) { /* noop */ }

	        if (applied) {
	            this.logDebug('lifecycle.roomId.applied', { roomId: normalized, source });
	        }

	        return normalized;
	    }

	    updateSessionCredentialsFromSigner(payload) {
	        if (payload && typeof payload === 'object') {
	            this.lastSignerPayload = payload;
	        }
        const nextSessionId = payload?.sessionid || payload?.session_id || null;
        const nextTtTargetIdc = payload?.tt_target_idc || payload?.ttTargetIdc || null;
        if (nextSessionId && !this.sessionId) {
            this.sessionId = nextSessionId;
            if (this.connection && this.connection.options) {
                this.connection.options.sessionId = nextSessionId;
            }
        }
        if (nextTtTargetIdc && !this.ttTargetIdc) {
            this.ttTargetIdc = nextTtTargetIdc;
            if (this.connection && this.connection.options) {
                this.connection.options.ttTargetIdc = nextTtTargetIdc;
            }
        }
        if (this.connection && this.connection.webClient && typeof this.connection.webClient.cookieJar?.setSession === 'function') {
            const sessionToStore = this.sessionId || nextSessionId || null;
            const ttTargetToStore = this.ttTargetIdc || nextTtTargetIdc || null;
            if (sessionToStore) {
                try {
                    this.connection.webClient.cookieJar.setSession(sessionToStore, ttTargetToStore);
                } catch (_) {
                    // ignore cookie jar errors
                }
            }

            const msToken = payload?.msToken || payload?.ms_token || null;
            if (msToken) {
                try {
                    this.connection.webClient.cookieJar.msToken = msToken;
                } catch (_) {
                    // ignore cookie jar assignment issues
                }
            }

            if (payload?.allCookies && typeof payload.allCookies === 'string') {
                const segments = payload.allCookies.split(';');
                for (const segment of segments) {
                    const trimmed = segment.trim();
                    if (!trimmed) continue;
                    const eqIndex = trimmed.indexOf('=');
                    if (eqIndex <= 0) continue;
                    const name = trimmed.slice(0, eqIndex).trim();
                    const value = trimmed.slice(eqIndex + 1);
                    if (!name) continue;
                    // Block prototype pollution and method overwrite via cookie names
                    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) continue;
                    if (name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
                    try {
                        this.connection.webClient.cookieJar[name] = value;
                    } catch (_) {
                        // ignore cookie jar assignment issues
	                }
	            }
	        }

	        const roomId = payload?.room_id || payload?.roomId || payload?.roomIdStr || payload?.room_id_str || null;
	        if (roomId) {
	            this.applyRoomIdToConnection(roomId, 'signer_payload');
	        }
	    }
    }

    parseSignedFetchParams(pathWithQuery, fallbackRoomId) {
        if (typeof pathWithQuery !== 'string' || !pathWithQuery.trim()) {
            throw new Error('Local signer returned malformed fetch URL.');
        }
        let normalized = pathWithQuery.trim();
        // Guard against payloads that only contain the query string
        if (normalized.startsWith('?')) {
            normalized = `/webcast/im/fetch/${normalized}`;
        } else if (!normalized.startsWith('/') && !/^https?:\/\//i.test(normalized)) {
            normalized = `/webcast/im/fetch/${normalized}`;
        }
        let parsed;
        try {
            parsed = new URL(normalized, 'https://webcast.tiktok.com');
        } catch (_) {
            throw new Error('Local signer returned malformed fetch URL.');
        }
        const params = {};
        for (const [key, value] of parsed.searchParams.entries()) {
            params[key] = value;
        }
        if (!params.room_id && fallbackRoomId) {
            params.room_id = String(fallbackRoomId);
        }
        if (!params.resp_content_type) {
            params.resp_content_type = 'protobuf';
        }
        return { params, pathname: parsed.pathname };
    }

    buildLocalSignerHeaders(payload) {
        const headers = {};
        const userAgent = payload?.userAgent
            || payload?.user_agent
            || this.connection?.webClient?.clientParams?.user_agent
            || DEFAULT_TIKTOK_WEB_USER_AGENT;
        headers['User-Agent'] = userAgent;
        const referer = payload?.referer || payload?.activeUrl || `https://www.tiktok.com/@${this.username}/live`;
        headers['Referer'] = referer;
        try {
            const refererUrl = new URL(referer);
            headers['Origin'] = `${refererUrl.protocol}//${refererUrl.host}`;
        } catch {
            headers['Origin'] = 'https://www.tiktok.com';
        }
        const cookieHeader = this.buildLocalSignerCookieHeader(payload);
        if (cookieHeader) {
            headers['Cookie'] = cookieHeader;
        }
        return headers;
    }

    buildLocalSignerCookieHeader(payload) {
        if (payload?.allCookies && typeof payload.allCookies === 'string') {
            const trimmed = payload.allCookies.trim();
            if (trimmed) {
                return trimmed;
            }
        }
        const cookies = [];
        const msToken = payload?.msToken || payload?.ms_token;
        const sessionId = payload?.sessionid || payload?.session_id;
        const ttTargetIdc = payload?.tt_target_idc || payload?.ttTargetIdc;
        if (msToken) {
            cookies.push(`msToken=${msToken}`);
        }
        if (sessionId) {
            cookies.push(`sessionid=${sessionId}`);
        }
        if (ttTargetIdc) {
            cookies.push(`tt_target_idc=${ttTargetIdc}`);
        }
        return cookies.length ? cookies.join('; ') : null;
    }

    getEulerChatClient() {
        if (this.eulerChatClient) {
            return this.eulerChatClient;
        }
        if (!this.signingConfig?.apiKey) {
            return null;
        }
        let TikTokWebClientClass = null;
        try {
            const connector = require('tiktok-live-connector');
            TikTokWebClientClass = connector?.TikTokWebClient || (connector?.web && connector.web.TikTokWebClient);
        } catch (error) {
            console.warn('[TikTok] Euler chat client unavailable:', error?.message || error);
            this.logDebug('chat.euler.client_unavailable', {
                message: error?.message || String(error)
            });
            return null;
        }
        if (!TikTokWebClientClass) {
            return null;
        }
        try {
            const clientParams = {
                app_language: "en-US",
                device_platform: "web"
            };
            this.eulerChatClient = new TikTokWebClientClass({
                clientParams,
                signApiKey: this.signingConfig.apiKey
            });
            return this.eulerChatClient;
        } catch (error) {
            console.warn('[TikTok] Failed to initialize Euler chat client:', error);
            this.logDebug('chat.euler.client_init_failed', {
                message: error?.message || String(error)
            });
            this.eulerChatClient = null;
            return null;
        }
    }

    applySessionToEulerClient(client) {
        if (!client || !client.cookieJar) {
            return;
        }
        if (this.sessionId && this.ttTargetIdc) {
            try {
                client.cookieJar.setSession(this.sessionId, this.ttTargetIdc);
            } catch (_) {
                // ignore
            }
        }
    }

    async resolveEulerChatRoomId(client) {
        const existing = await this.ensureRoomIdForChat();
        if (existing) {
            return existing;
        }
        if (!client || typeof client.fetchRoomId !== 'function') {
            return null;
        }
        try {
            return await client.fetchRoomId(this.username);
        } catch (error) {
            console.warn('[TikTok] Failed to resolve roomId via Euler client:', error?.message || error);
            return null;
        }
    }

    createCustomSigner() {
        if (this.signingProvider === 'local') {
            return null;
        }
        if (!this.signingConfig || (!this.signingConfig.apiKey && !this.signingConfig.serviceUrl)) {
            return null;
        }
        if (!EulerSignerClass || typeof EulerSignerClass !== 'function') {
            this.logDebug('sign.config.custom_signer_unavailable', { reason: 'missing_class' });
            return null;
        }
        const overrides = {};
        if (this.signingConfig.apiKey) {
            overrides.apiKey = this.signingConfig.apiKey;
        }
        if (this.signingConfig.serviceUrl) {
            overrides.basePath = this.signingConfig.serviceUrl;
        }
        if (!Object.keys(overrides).length) {
            return null;
        }
        try {
            return new EulerSignerClass(overrides);
        } catch (error) {
            console.warn('Failed to instantiate custom Euler signer:', error?.message || error);
            this.logDebug('sign.config.custom_signer_failed', {
                error: error?.message || String(error)
            });
            return null;
        }
    }

    initializeConnectionInstance({ forceLegacy = false, context = 'primary' } = {}) {
        if (!forceLegacy && this.signingProvider === EULER_WS_PROVIDER) {
            const rawKey = typeof this.signingConfig?.apiKey === 'string' && this.signingConfig.apiKey.trim()
                ? this.signingConfig.apiKey.trim()
                : null;
            const rawJwtKey = typeof this.signingConfig?.jwtKey === 'string' && this.signingConfig.jwtKey.trim()
                ? this.signingConfig.jwtKey.trim()
                : null;
            const looksLikeJwt = rawKey && rawKey.split('.').length === 3;
            const apiKey = looksLikeJwt ? null : rawKey;
            const jwtKey = looksLikeJwt ? rawKey : rawJwtKey;
            if (!apiKey && !jwtKey) {
                const missingKeyError = new Error('Euler Proxy requires an Euler API key or JWT. Add one in TikTok Signing settings or switch to Auto/Polling.');
                missingKeyError.code = 'SSAPP_TIKTOK_EULER_WS_MISSING_KEY';
                this.logDebug('lifecycle.initialize.euler_ws_missing_key', {
                    provider: this.signingProvider,
                    context
                });
                throw missingKeyError;
            }
            this.connectionStrategy = 'websocket';
            this.connection = new EulerWebsocketServerConnection(this.username, {
                apiKey,
                jwtKey,
                features: { rawMessages: true, bundleEvents: true }
            });
            this.applyResumeCursorToConnection();
            this.logDebug('lifecycle.initialize.euler_ws', {
                provider: this.signingProvider,
                hasApiKey: !!apiKey,
                hasJwtKey: !!jwtKey
            });
            this.setupEventHandlers();
            return;
        }

        const useLegacyConnector = forceLegacy || this.preferredStrategy === 'legacy' || usingLegacyTikTokConnector;
        let ConnectorClass = null;
        if (!useLegacyConnector && TikTokLiveConnectionClass && TikTokLiveConnectionClass !== TikTokPollingFallbackClass) {
            ConnectorClass = TikTokLiveConnectionClass;
        } else if (TikTokPollingFallbackClass) {
            ConnectorClass = TikTokPollingFallbackClass;
        } else if (TikTokLiveConnectionClass) {
            ConnectorClass = TikTokLiveConnectionClass;
        }
        if (!ConnectorClass) {
            throw new Error('TikTok connector missing. Please reinstall tiktok-live-connector.');
        }
        const connectionOptions = this.buildConnectionOptions(useLegacyConnector);
        if (this.sessionId) {
            connectionOptions.sessionId = this.sessionId;
            if (this.ttTargetIdc) {
                connectionOptions.ttTargetIdc = this.ttTargetIdc;
            }
        }
        this.connectionStrategy = useLegacyConnector ? 'legacy' : 'websocket';
        const connectorLabel = ConnectorClass && ConnectorClass.name
            ? ConnectorClass.name
            : (useLegacyConnector ? 'WebcastPushConnection' : 'TikTokLiveConnection');

        const customSigner = this.createCustomSigner();
        if (customSigner) {
            this.connection = new ConnectorClass(this.username, connectionOptions, customSigner);
            this.logDebug('sign.config.custom_signer_applied', {
                hasApiKey: !!this.signingConfig?.apiKey,
                hasServiceUrl: !!this.signingConfig?.serviceUrl
            });
        } else {
            this.connection = new ConnectorClass(this.username, connectionOptions);
        }
        this.applyResumeCursorToConnection();
        this.applySignRequestTimeout(this.signRequestTimeoutMs);
        this.logDebug('lifecycle.initialize.signTimeoutConfigured', {
            timeoutMs: this.signRequestTimeoutMs,
            maxTimeoutMs: this.signRequestTimeoutMaxMs,
            context
        });
        this.logDebug('lifecycle.initialize.connectionCreated', {
            authenticated: !!this.sessionId,
            usingLegacyConnector: usingLegacyTikTokConnector,
            strategy: this.connectionStrategy,
            connector: connectorLabel,
            forceLegacy: useLegacyConnector
        });
        this.setupEventHandlers();
    }

    ensureConnectionInstance(context = 'connect') {
        if (this.connection && typeof this.connection.connect === 'function') {
            return true;
        }
        const forceLegacy = !!(
            this.pollingFallbackActivated
            || this.preferredStrategy === 'legacy'
            || this.connectionStrategy === 'legacy'
            || usingLegacyTikTokConnector
        );
        this.logDebug('lifecycle.initialize.ensureConnection', {
            context,
            forceLegacy,
            signingProvider: this.signingProvider || null,
            preferredStrategy: this.preferredStrategy || null,
            connectionStrategy: this.connectionStrategy || null
        });
        this.initializeConnectionInstance({ forceLegacy, context });
        return !!(this.connection && typeof this.connection.connect === 'function');
    }

    applyResumeCursorToConnection() {
        const state = this.resumeCursorState;
        if (!state || !state.cursor || !this.connection) {
            return;
        }
        if (state.roomId && this.previousRoomId && state.roomId !== this.previousRoomId) {
            return;
        }
        const setCursor = (params) => {
            if (!params || typeof params !== 'object') {
                return;
            }
            params.cursor = state.cursor;
            if (state.internalExt) {
                params.internal_ext = state.internalExt;
            }
        };
        setCursor(this.connection.webClient && this.connection.webClient.clientParams);
        setCursor(this.connection.options && this.connection.options.clientParams);
        setCursor(this.connection.options && this.connection.options.webClientParams);
        setCursor(this.connection.options && this.connection.options.wsClientParams);
        this.logDebug('lifecycle.cursor.resume_applied', {
            roomId: state.roomId || null,
            hasInternalExt: !!state.internalExt
        });
    }

    resetConnectionBootstrapState({ clearRoomId = false, clearResumeCursor = false } = {}) {
        const clearParams = (params) => {
            if (!params || typeof params !== 'object') {
                return;
            }
            params.cursor = '';
            params.internal_ext = '';
            if (clearRoomId) {
                params.room_id = '';
            }
        };

        if (clearResumeCursor) {
            this.resumeCursorState = null;
            if (clearRoomId) {
                this.previousRoomId = null;
            }
        }

        const connection = this.connection;
        if (!connection) {
            return;
        }

        try {
            clearParams(connection.clientParams);
        } catch (_) { /* noop */ }

        try {
            if (connection.webClient) {
                clearParams(connection.webClient.clientParams);
                if (clearRoomId) {
                    connection.webClient.roomId = '';
                }
            }
        } catch (_) { /* noop */ }

        try {
            if (connection.options && typeof connection.options === 'object') {
                clearParams(connection.options.clientParams);
                clearParams(connection.options.webClientParams);
                clearParams(connection.options.wsClientParams);
            }
        } catch (_) { /* noop */ }

        try {
            if (clearRoomId && Object.prototype.hasOwnProperty.call(connection, 'roomId')) {
                connection.roomId = '';
            }
        } catch (_) { /* noop */ }
    }

    async waitForPollingFallbackHandoff(stage = 'connect') {
        const delayMs = Number(CONFIG.CONNECTION.POLLING_FALLBACK_HANDOFF_DELAY_MS) || 0;
        if (!Number.isFinite(delayMs) || delayMs <= 0) {
            return;
        }
        this.logDebug('lifecycle.fallback.polling.cooldown', {
            stage,
            delayMs
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    clearPendingStreamEndConfirmation(reason = null) {
        if (this.pendingStreamEndTimer) {
            clearTimeout(this.pendingStreamEndTimer);
            this.pendingStreamEndTimer = null;
            this.logDebug('control.streamEnd.cancelled', {
                reason: reason || this.pendingStreamEndReason || null
            });
        }
        this.pendingStreamEndReason = null;
    }

    noteConnectionActivity(source = 'activity') {
        this.lastMessageTime = Date.now();
        if (this.pendingStreamEndTimer) {
            this.clearPendingStreamEndConfirmation(`activity:${source}`);
        }
    }

    scheduleStreamEndConfirmation(reason = 'stream_end_signal') {
        if (this.isStopped) {
            return;
        }

        this.clearPendingStreamEndConfirmation('reschedule');
        const delayMs = Number(this.streamEndConfirmDelayMs) || 0;
        if (!Number.isFinite(delayMs) || delayMs <= 0) {
            this.handleStreamEnd();
            return;
        }

        this.pendingStreamEndReason = reason;
        this.logDebug('control.streamEnd.pending', {
            reason,
            delayMs
        });

        this.pendingStreamEndTimer = setTimeout(() => {
            this.pendingStreamEndTimer = null;
            this.pendingStreamEndReason = null;
            if (this.isStopped) {
                return;
            }
            this.handleStreamEnd();
        }, delayMs);
    }

    enterOfflineRetryMode(reason = 'Live stream has ended') {
        this.offlineRetryCount = 0;
        this.offlineRetry = true;
        this.offlineReason = this.buildOfflineReason(reason);
        this.attemptReconnect(CONFIG.CONNECTION.OFFLINE_RETRY_INTERVAL_MS, { fixed: true, offline: true });
    }

    async teardownConnection({ silent = false } = {}) {
        this.directChatRoute = null;
        this.directChatRouteClient = null;
        this.pendingRoomIdPromise = null;
        this.clearPendingStreamEndConfirmation('teardown');
        if (!this.connection) {
            return;
        }
        try {
            if (typeof this.connection.removeAllListeners === 'function') {
                this.connection.removeAllListeners();
            }
        } catch (error) {
            if (!silent) {
                console.warn('Error removing TikTok connection listeners:', error);
            }
        }
        try {
            if (typeof this.connection.disconnect === 'function') {
                const result = this.connection.disconnect();
                if (result && typeof result.then === 'function') {
                    await result.catch(() => { });
                }
            }
        } catch (error) {
            if (!silent) {
                console.warn('Error disconnecting TikTok connection:', error);
            }
        }
        this.connection = null;
    }

    getSanitizedFallbackMessage(primaryError, defaultMessage = 'TikTok WebSocket signer returned unreadable data. Using polling fallback.') {
        if (this.isBrokenSignerBootstrapError(primaryError, primaryError?.message || '')) {
            return 'TikTok returned invalid websocket bootstrap data. Switching to compatibility mode.';
        }
        const rawMessage = typeof primaryError?.ssappFallbackMessage === 'string' && primaryError.ssappFallbackMessage.trim()
            ? primaryError.ssappFallbackMessage.trim()
            : (typeof primaryError?.message === 'string' ? primaryError.message : '');
        const sanitized = rawMessage.replace(/^SSAPP_TIKTOK_FALLBACK:\s*/i, '').trim();
        return sanitized || defaultMessage;
    }

    hasFallbackTransitionStarted(primaryError) {
        return !!(primaryError && typeof primaryError === 'object' && primaryError.__ssappTikTokFallbackTransitionStarted);
    }

    markFallbackTransitionStarted(primaryError, transition = 'fallback') {
        if (!primaryError || typeof primaryError !== 'object') {
            return;
        }
        primaryError.__ssappTikTokFallbackTransitionStarted = transition;
    }

    clearFallbackTransitionStarted(primaryError, transition = null) {
        if (!primaryError || typeof primaryError !== 'object') {
            return;
        }
        if (transition && primaryError.__ssappTikTokFallbackTransitionStarted !== transition) {
            return;
        }
        primaryError.__ssappTikTokFallbackTransitionStarted = null;
        primaryError.__ssappTikTokFallbackReconnectPromise = null;
    }

    getFallbackReconnectPromise(primaryError) {
        if (!primaryError || typeof primaryError !== 'object') {
            return null;
        }
        const reconnectPromise = primaryError.__ssappTikTokFallbackReconnectPromise;
        return reconnectPromise && typeof reconnectPromise.then === 'function'
            ? reconnectPromise
            : null;
    }

    restartConnectionAttempt(primaryError = null, context = 'fallback_restart') {
        const reconnectPromise = (async () => {
            try {
                this.ensureConnectionInstance(context);
            } catch (error) {
                this.logDebug('lifecycle.connect.restart.ensureConnectionFailed', {
                    context,
                    error: error?.message || String(error)
                });
                console.error('[TikTok] Failed to prepare connection before restart:', error);
                return false;
            }
            return this.connect({ bypassActivePromise: !!this.activeConnectPromise });
        })();
        if (primaryError && typeof primaryError === 'object') {
            primaryError.__ssappTikTokFallbackReconnectPromise = reconnectPromise;
        }
        return reconnectPromise;
    }

    async tryFallbackToPolling(primaryError, stage = 'connect') {
        if (!this.pollingFallbackSupported || this.pollingFallbackActivated || this.preferredStrategy === 'legacy') {
            this.logDebug('lifecycle.fallback.polling.skipped', {
                reason: !this.pollingFallbackSupported ? 'unsupported' : (this.preferredStrategy === 'legacy' ? 'legacy_forced' : 'already_activated'),
                stage,
                message: primaryError?.message || null
            });
            return false;
        }
        const fallbackMessage = this.getSanitizedFallbackMessage(primaryError, 'TikTok signer unavailable. Switching to legacy connector.');
        this.pollingFallbackActivated = true;
        this.autoEulerProxyFallbackActive = false;
        this.autoLocalSignerFallbackActive = false;
        this.signServerFailureCount = 0;
        this.markFallbackTransitionStarted(primaryError, 'polling');
        this.logDebug('lifecycle.fallback.polling.begin', {
            stage,
            message: fallbackMessage,
            payloadLength: primaryError?.payloadLength || null
        });
        console.warn(`[TikTok] Legacy fallback activated (${stage}) for ${this.username}: ${fallbackMessage}`);
        this.preferredStrategy = 'legacy';
        this.connectionStrategy = 'legacy';
        try {
            this.resetConnectionBootstrapState({ clearRoomId: true, clearResumeCursor: true });
            await this.teardownConnection({ silent: true });
            await this.waitForPollingFallbackHandoff(stage);
        } catch (error) {
            this.logDebug('lifecycle.fallback.polling.teardownError', normalizeForLogging(error));
        }
        try {
            this.initializeConnectionInstance({ forceLegacy: true, context: 'legacy_fallback' });
        } catch (error) {
            this.pollingFallbackActivated = false;
            this.connectionStrategy = 'websocket';
            this.preferredStrategy = 'websocket';
            this.clearFallbackTransitionStarted(primaryError, 'polling');
            this.logDebug('lifecycle.fallback.polling.instantiateError', normalizeForLogging(error));
            console.error('[TikTok] Failed to instantiate legacy fallback connection:', error);
            return false;
        }
        try {
            emitStatus({
                wssID: this.wssID,
                status: 'fallback_polling',
                error: fallbackMessage,
                payloadLength: primaryError?.payloadLength || null,
                payloadPreviewHex: primaryError?.payloadPreviewHex || null
            });
        } catch (notifyErr) {
            console.warn('Failed to notify renderer about TikTok fallback:', notifyErr);
        }
        return true;
    }

    getAutoEulerProxyFallbackKey() {
        if (this.hasUserProvidedSigningApiKey()) {
            return this.userProvidedSigningApiKey.trim();
        }
        const proxyKey = typeof SHARED_EULER_PROXY_FALLBACK_KEY === 'string'
            ? SHARED_EULER_PROXY_FALLBACK_KEY.trim()
            : '';
        return proxyKey || null;
    }

    getEulerApiKeyLabel(scope = 'signing') {
        if (this.hasUserProvidedSigningApiKey()) {
            return 'configured Euler API key';
        }
        if (scope === 'proxy') {
            return 'shared Euler proxy key';
        }
        return 'shared Euler signing key';
    }

    async tryFallbackToEulerProxy(primaryError, stage = 'connect') {
        const isAutoFlow = this.signingProvider === 'auto'
            || this.autoEulerProxyFallbackActive
            || this.autoLocalSignerFallbackActive;
        const proxyKey = this.getAutoEulerProxyFallbackKey();
        if (!isAutoFlow ||
            this.autoEulerProxyFallbackAttempted ||
            !proxyKey ||
            this.pollingFallbackActivated ||
            this.preferredStrategy === 'legacy' ||
            this.connectionStrategy === 'legacy') {
            this.logDebug('lifecycle.fallback.eulerProxy.skipped', {
                reason: !isAutoFlow
                    ? 'provider_not_auto_flow'
                    : (this.autoEulerProxyFallbackAttempted
                        ? 'already_activated'
                        : (!proxyKey
                            ? 'proxy_key_unavailable'
                            : (this.pollingFallbackActivated || this.preferredStrategy === 'legacy' || this.connectionStrategy === 'legacy'
                                ? 'legacy_active'
                                : 'unknown'))),
                stage,
                message: primaryError?.message || null
            });
            return false;
        }

        const fallbackMessage = this.getSanitizedFallbackMessage(
            primaryError,
            'TikTok signer unavailable. Switching to Euler Proxy.'
        );
        this.autoEulerProxyFallbackAttempted = true;
        this.autoEulerProxyFallbackActive = true;
        this.autoLocalSignerFallbackActive = false;
        this.signServerFailureCount = 0;
        this.markFallbackTransitionStarted(primaryError, 'proxy');
        const proxyKeyLabel = this.getEulerApiKeyLabel('proxy');

        const sharedProxyKey = typeof SHARED_EULER_PROXY_FALLBACK_KEY === 'string'
            ? SHARED_EULER_PROXY_FALLBACK_KEY.trim()
            : '';
        const usingSharedKey = !!(sharedProxyKey && proxyKey === sharedProxyKey && !this.hasUserProvidedSigningApiKey());
        if (usingSharedKey && this.sharedEulerApiKeyAttempts) {
            this.sharedEulerApiKeyAttempts.add(sharedProxyKey);
        }

        this.logDebug('lifecycle.fallback.eulerProxy.begin', {
            stage,
            message: fallbackMessage,
            usingSharedKey,
            keyLabel: proxyKeyLabel
        });
        console.warn(`[TikTok] Euler Proxy fallback activated (${stage}) for ${this.username} using ${proxyKeyLabel}: ${fallbackMessage}`);
        try {
            emitStatus({
                wssID: this.wssID,
                status: 'reconnecting',
                reason: `Sign server unavailable. Trying Euler Proxy with ${proxyKeyLabel}.`,
                signServer: true,
                proxyFallback: true
            });
        } catch (_) { /* renderer may be gone */ }

        const previousProvider = this.signingProvider;
        const previousSigningConfig = this.signingConfig ? { ...this.signingConfig } : null;
        this.signingProvider = EULER_WS_PROVIDER;
        this.signingConfig = {
            apiKey: proxyKey,
            serviceUrl: null
        };

        try {
            await this.teardownConnection({ silent: true });
        } catch (error) {
            this.logDebug('lifecycle.fallback.eulerProxy.teardownError', normalizeForLogging(error));
        }

        try {
            this.initializeConnectionInstance({ forceLegacy: false, context: 'euler_proxy_fallback' });
        } catch (error) {
            this.signingProvider = previousProvider;
            this.signingConfig = previousSigningConfig;
            this.autoEulerProxyFallbackActive = false;
            this.clearFallbackTransitionStarted(primaryError, 'proxy');
            this.logDebug('lifecycle.fallback.eulerProxy.instantiateError', normalizeForLogging(error));
            console.error('[TikTok] Failed to instantiate Euler Proxy fallback connection:', error);
            return false;
        }

        return true;
    }

    async tryFallbackToLocalSigner(primaryError, stage = 'connect') {
        const isAutoFlow = this.signingProvider === 'auto'
            || this.autoEulerProxyFallbackActive
            || this.autoLocalSignerFallbackActive;
        if (!isAutoFlow ||
            this.autoLocalSignerFallbackAttempted ||
            !this.localSigner ||
            typeof this.localSigner.sign !== 'function' ||
            this.pollingFallbackActivated ||
            this.preferredStrategy === 'legacy' ||
            this.connectionStrategy === 'legacy') {
            this.logDebug('lifecycle.fallback.localSigner.skipped', {
                reason: !isAutoFlow
                    ? 'provider_not_auto_flow'
                    : (this.autoLocalSignerFallbackAttempted
                        ? 'already_activated'
                        : (!this.localSigner || typeof this.localSigner.sign !== 'function'
                            ? 'local_signer_unavailable'
                            : (this.pollingFallbackActivated || this.preferredStrategy === 'legacy' || this.connectionStrategy === 'legacy'
                                ? 'legacy_active'
                                : 'unknown'))),
                stage,
                message: primaryError?.message || null
            });
            return false;
        }

        const fallbackMessage = this.getSanitizedFallbackMessage(
            primaryError,
            'TikTok signer unavailable. Switching to local signer.'
        );
        this.autoLocalSignerFallbackAttempted = true;
        this.signServerFailureCount = 0;
        this.markFallbackTransitionStarted(primaryError, 'local');
        this.logDebug('lifecycle.fallback.localSigner.begin', {
            stage,
            message: fallbackMessage
        });
        console.warn(`[TikTok] Local signer fallback activated (${stage}) for ${this.username}: ${fallbackMessage}`);
        try {
            emitStatus({
                wssID: this.wssID,
                status: 'reconnecting',
                reason: 'Sign server unavailable. Trying local signer.',
                signServer: true
            });
        } catch (_) { /* renderer may be gone */ }

        const previousProvider = this.signingProvider;
        const previousAutoEulerProxyFallbackActive = this.autoEulerProxyFallbackActive;
        this.signingProvider = 'local';
        this.autoLocalSignerFallbackActive = true;
        this.autoEulerProxyFallbackActive = false;

        try {
            await this.teardownConnection({ silent: true });
        } catch (error) {
            this.logDebug('lifecycle.fallback.localSigner.teardownError', normalizeForLogging(error));
        }

        try {
            this.initializeConnectionInstance({ forceLegacy: false, context: 'local_signer_fallback' });
        } catch (error) {
            this.signingProvider = previousProvider;
            this.autoEulerProxyFallbackActive = previousAutoEulerProxyFallbackActive;
            this.autoLocalSignerFallbackActive = false;
            this.clearFallbackTransitionStarted(primaryError, 'local');
            this.logDebug('lifecycle.fallback.localSigner.instantiateError', normalizeForLogging(error));
            console.error('[TikTok] Failed to instantiate local signer fallback connection:', error);
            return false;
        }

        return true;
    }

    async tryAutoFallbacksBeforePrompt(primaryError, stage = 'connect_auto', options = {}) {
        const {
            includeLocal = true,
            includeProxy = true,
            includePolling = true
        } = options || {};
        const isAutoFlow = this.signingProvider === 'auto'
            || this.autoEulerProxyFallbackActive
            || this.autoLocalSignerFallbackActive;
        if (!isAutoFlow) {
            return false;
        }

        if (includeLocal) {
            const localFallbackHandled = await this.tryFallbackToLocalSigner(primaryError, `${stage}_local`);
            if (localFallbackHandled) {
                return true;
            }
        }

        if (includeProxy) {
            const proxyFallbackHandled = await this.tryFallbackToEulerProxy(primaryError, `${stage}_proxy`);
            if (proxyFallbackHandled) {
                return true;
            }
        }

        if (includePolling) {
            const pollingFallbackHandled = await this.tryFallbackToPolling(primaryError, `${stage}_polling`);
            if (pollingFallbackHandled) {
                return true;
            }
        }

        return false;
    }

    applySignRequestTimeout(timeoutMs) {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return;
        }

        const previousTimeout = this.signRequestTimeoutMs;
        this.signRequestTimeoutMs = timeoutMs;

        if (!this.connection) {
            return;
        }

        try {
            const webcastApi = this.connection?.webClient?.webSigner?.webcast;
            if (!webcastApi) {
                return;
            }

            if (webcastApi.configuration) {
                webcastApi.configuration.baseOptions = {
                    ...(webcastApi.configuration.baseOptions || {}),
                    timeout: timeoutMs
                };
            }

            if (webcastApi.axios && webcastApi.axios.defaults) {
                webcastApi.axios.defaults.timeout = timeoutMs;
                const defaultMessage = `Sign server request timed out after ${timeoutMs}ms`;
                if (!webcastApi.axios.defaults.timeoutErrorMessage) {
                    webcastApi.axios.defaults.timeoutErrorMessage = defaultMessage;
                } else if (typeof webcastApi.axios.defaults.timeoutErrorMessage === 'string' && webcastApi.axios.defaults.timeoutErrorMessage.startsWith('Sign server request timed out after')) {
                    webcastApi.axios.defaults.timeoutErrorMessage = defaultMessage;
                }
            }

            if (previousTimeout !== timeoutMs) {
                this.logDebug('sign.timeout.applied', {
                    previousTimeoutMs: previousTimeout,
                    timeoutMs
                });
            }
        } catch (timeoutConfigError) {
            console.warn('Failed to configure Euler sign server timeout:', timeoutConfigError);
            this.logDebug('sign.timeout.apply_failed', {
                timeoutMs,
                error: timeoutConfigError?.message || String(timeoutConfigError)
            });
        }
    }

    isSignServerTimeout(primaryError, rawMessage = '') {
        const code = primaryError?.code;
        if (typeof code === 'string') {
            const normalizedCode = code.toUpperCase();
            if (normalizedCode === 'ECONNABORTED' || normalizedCode === 'ETIMEDOUT' || normalizedCode === 'ESOCKETTIMEDOUT') {
                return true;
            }
        }

        const combined = `${rawMessage || ''} ${primaryError?.message || ''}`.toLowerCase();
        if (!combined.trim()) {
            return false;
        }

        if (combined.includes('timeout') || combined.includes('timed out')) {
            return true;
        }

        return false;
    }

    maybeBoostSignRequestTimeout(primaryError, rawMessage = '') {
        if (!this.isSignServerTimeout(primaryError, rawMessage)) {
            return false;
        }

        if (!Number.isFinite(this.signRequestTimeoutMaxMs) || this.signRequestTimeoutMaxMs <= this.signRequestTimeoutMs) {
            return false;
        }

        const step = Number.isFinite(this.signRequestTimeoutStepMs) && this.signRequestTimeoutStepMs > 0
            ? this.signRequestTimeoutStepMs
            : Math.max(5000, this.signRequestTimeoutMs);

        const nextTimeout = Math.min(this.signRequestTimeoutMaxMs, this.signRequestTimeoutMs + step);

        if (!Number.isFinite(nextTimeout) || nextTimeout <= this.signRequestTimeoutMs) {
            return false;
        }

        const previous = this.signRequestTimeoutMs;
        console.info(`[TikTok] Sign server timeout - increasing request timeout from ${previous}ms to ${nextTimeout}ms`);
        this.logDebug('sign.timeout.boost', {
            previousTimeoutMs: previous,
            nextTimeoutMs: nextTimeout,
            maxTimeoutMs: this.signRequestTimeoutMaxMs
        });
        this.applySignRequestTimeout(nextTimeout);
        return true;
    }

    handleSignServerRejection(primaryError) {
        const helpMessage = this.getSigningServiceHelpMessage();
        this.logDebug('sign.error.rejected_session', {
            message: helpMessage,
            attempts: this.signServerFailureCount,
            errorName: primaryError?.name || null,
            reason: primaryError?.reason || null
        });
        this.logConsoleFailure(helpMessage, primaryError instanceof Error ? primaryError : null);
        try {
            connectionStates.set(this.wssID, {
                isConnected: false,
                lastAttempt: Date.now(),
                isReconnecting: false,
                attemptInProgress: false
            });
        } catch (_) { /* noop */ }
        this.offlineRetry = false;
        this.offlineRetryCount = 0;
        this.offlineReason = null;
        try {
            emitStatus({
                wssID: this.wssID,
                status: 'failed',
                error: helpMessage,
                signServer: true,
                sessionRejected: true
            });
        } catch (notifyErr) {
            console.warn('Failed to send TikTok sign-in rejection status:', notifyErr);
        }
    }

    handleSignServerFailure(primaryError, rawMessage = '', userFacingMessage = '') {
        const detail = this.truncateForLog(rawMessage || primaryError?.message || '', 600);
        const displayMessage = (typeof userFacingMessage === 'string' && userFacingMessage.trim())
            ? userFacingMessage.trim()
            : 'Sign server unavailable';

        console.warn(`[TikTok] Sign server issue detected (${displayMessage}). Retrying silently.`);
        this.logDebug('sign.error.retry', {
            message: displayMessage,
            detail: detail || null,
            attempts: this.signServerFailureCount
        });

        // Attempt to notify renderer without surfacing an error banner
        try {
            if (getMainWindow() && getMainWindow().webContents) {
                emitStatus({
                    wssID: this.wssID,
                    status: 'reconnecting',
                    reason: undefined,
                    signServer: true
                });
            }
        } catch (_) { /* renderer may be gone */ }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        try {
            connectionStates.set(this.wssID, {
                isConnected: false,
                lastAttempt: Date.now(),
                isReconnecting: false,
                attemptInProgress: false
            });
        } catch (_) { /* noop */ }

        if (this.isStopped) {
            return;
        }

        this.offlineRetry = false;
        this.offlineRetryCount = 0;
        this.offlineReason = null;
        this.reconnectAttempts = Math.max(0, this.reconnectAttempts - 1);

        const retryDelay = Number.isFinite(this.signRequestImmediateRetryDelayMs) && this.signRequestImmediateRetryDelayMs > 0
            ? this.signRequestImmediateRetryDelayMs
            : 0;

        this.attemptReconnect(retryDelay, {
            fixed: true,
            immediate: retryDelay <= 0,
            silent: true,
            reason: 'sign_server_retry'
        });
    }

    normalizeGoalUpdate(data = {}) {
        if (!data || typeof data !== 'object') {
            return null;
        }

        const pickFirst = (values, fallback = null) => {
            for (const value of values) {
                if (value === undefined || value === null) continue;
                if (typeof value === 'string') {
                    const trimmed = value.trim();
                    if (trimmed.length) {
                        return trimmed;
                    }
                } else {
                    return value;
                }
            }
            return fallback;
        };

        const hasValue = (value) => value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
        const parseNumber = (value) => {
            if (!hasValue(value)) return null;
            const num = Number(value);
            return Number.isFinite(num) ? num : null;
        };

        const goal = data?.goal || {};
        const subGoal = data?.contributeSubgoal || {};

        const contributorName = pickFirst([
            data?.contributorDisplayId,
            data?.contributorIdStr,
            hasValue(data?.contributorId) ? String(data.contributorId) : null,
            data?.nickname,
            data?.user?.displayId,
            data?.user?.uniqueId,
            data?.user?.nickname
        ], 'Viewer') || 'Viewer';

        const giftName = pickFirst([
            subGoal?.gift?.name,
            goal?.title,
            goal?.description,
            data?.giftName
        ], 'Goal') || 'Goal';

        const progressRaw = pickFirst([
            subGoal?.progress,
            goal?.progress,
            data?.progress
        ], null);
        const targetRaw = pickFirst([
            subGoal?.target,
            goal?.target,
            data?.target
        ], null);
        const scoreRaw = pickFirst([
            data?.contributeScore,
            data?.score
        ], null);

        const progressNumber = parseNumber(progressRaw);
        const targetNumber = parseNumber(targetRaw);
        const scoreNumber = parseNumber(scoreRaw);

        const avatarUrl = normalizeTikTokImageUrl(data?.contributorAvatar?.url)
            || normalizeTikTokImageUrl(data?.profilePictureUrl)
            || normalizeTikTokImageUrl(data?.profilePicture)
            || normalizeTikTokImageUrl(data?.user?.profilePictureUrl)
            || normalizeTikTokImageUrl(data?.user?.profilePicture)
            || null;

        const contributorId = hasValue(data?.contributorId) ? data.contributorId : null;
        const contributorIdStr = hasValue(data?.contributorIdStr) ? data.contributorIdStr : null;
        const uniqueId = pickFirst([
            data?.user?.uniqueId,
            data?.user?.displayId,
            contributorIdStr,
            contributorId ? String(contributorId) : null
        ], null);

        const subGoalId = pickFirst([
            subGoal?.id,
            subGoal?.idStr,
            goal?.id,
            goal?.idStr
        ], null);
        const subGoalType = subGoal?.type !== undefined ? subGoal.type : null;

        const eventType = data?.pin ? 'goal_pin' : (data?.unpin ? 'goal_unpin' : 'goal_update');

        const meta = {
            contributorName,
            contributorId,
            contributorIdStr,
            uniqueId,
            giftName,
            progress: progressNumber !== null ? progressNumber : progressRaw ?? null,
            target: targetNumber !== null ? targetNumber : targetRaw ?? null,
            score: scoreNumber !== null ? scoreNumber : scoreRaw ?? null,
            progressRaw: progressRaw ?? undefined,
            targetRaw: targetRaw ?? undefined,
            scoreRaw: scoreRaw ?? undefined,
            avatarUrl: avatarUrl || undefined,
            subGoalId: subGoalId || undefined,
            subGoalType: subGoalType ?? undefined,
            pin: data?.pin ? true : undefined,
            unpin: data?.unpin ? true : undefined,
            timestamp: Date.now()
        };

        if (goal?.title) meta.goalTitle = cleanVisibleString(goal.title);
        if (goal?.description) meta.goalDescription = cleanVisibleString(goal.description);

        return {
            eventType,
            meta
        };
    }

    emitGoalEvent(goalEvent) {
        if (!goalEvent || typeof goalEvent !== 'object') {
            return;
        }

        if (!isCaptureEventsEnabled()) {
            return;
        }

        const { eventType, meta } = goalEvent;
        if (!eventType) {
            return;
        }

        const metaObject = (meta && typeof meta === 'object') ? meta : {};
        const progressPreview = metaObject.progress ?? metaObject.progressRaw ?? null;
        const targetPreview = metaObject.target ?? metaObject.targetRaw ?? null;
        const scorePreview = metaObject.score ?? metaObject.scoreRaw ?? null;

        console.info('[TikTok] Goal event', {
            username: this.username,
            event: eventType,
            contributor: metaObject.contributorName || metaObject.uniqueId || null,
            giftName: metaObject.giftName || null,
            progress: progressPreview,
            target: targetPreview,
            score: scorePreview
        });

        this.sendEventMessage({}, eventType, null, metaObject);
    }

    resetGoalAggregates() {
        // Batching removed; method retained for compatibility.
    }

    static delay(ms) {
        if (!Number.isFinite(ms) || ms <= 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    recordActivity(timestamp = Date.now()) {
        this.lastMessageTime = timestamp;

        const bucketSize = 60 * 1000; // 1 minute buckets
        const bucketKey = Math.floor(timestamp / bucketSize) * bucketSize;
        const current = this.activityBuckets.get(bucketKey) || 0;
        this.activityBuckets.set(bucketKey, current + 1);

        this.pruneActivity(timestamp);
    }

    pruneActivity(now = Date.now()) {
        const historyWindow = CONFIG.CONNECTION.ACTIVITY_HISTORY_MS || (30 * 60 * 1000);
        const cutoff = now - historyWindow;
        for (const key of this.activityBuckets.keys()) {
            if (key < cutoff) {
                this.activityBuckets.delete(key);
            }
        }
    }

    countActivitySince(cutoff) {
        if (!this.activityBuckets.size) {
            return 0;
        }

        let count = 0;
        const bucketSize = 60 * 1000;
        for (const [bucketKey, bucketCount] of this.activityBuckets.entries()) {
            if (bucketKey + bucketSize > cutoff) {
                count += bucketCount;
            }
        }
        return count;
    }

    getAdaptiveMessageTimeout() {
        const now = Date.now();
        this.pruneActivity(now);

        const {
            ACTIVITY_THRESHOLDS = {},
            MESSAGE_TIMEOUT_ACTIVE_MS = 5 * 60 * 1000,
            MESSAGE_TIMEOUT_MODERATE_MS = 10 * 60 * 1000,
            MESSAGE_TIMEOUT_IDLE_MS = 30 * 60 * 1000
        } = CONFIG.CONNECTION;

        const highThreshold = ACTIVITY_THRESHOLDS.HIGH_PER_MINUTE || 120;
        const moderateThreshold = ACTIVITY_THRESHOLDS.MODERATE_PER_MINUTE || 15;

        const perMinute = this.countActivitySince(now - 60 * 1000);
        if (perMinute >= highThreshold) {
            return MESSAGE_TIMEOUT_ACTIVE_MS;
        }

        if (perMinute >= moderateThreshold) {
            return MESSAGE_TIMEOUT_MODERATE_MS;
        }

        const perFiveMinutes = this.countActivitySince(now - 5 * 60 * 1000);
        if (perFiveMinutes >= moderateThreshold * 2) {
            return MESSAGE_TIMEOUT_MODERATE_MS;
        }

        return MESSAGE_TIMEOUT_IDLE_MS;
    }

    async initialize() {
        this.logDebug('lifecycle.initialize.start');
        console.log(`Initializing TikTok connection for user: ${this.username}`);
        if (this.sessionId) {
            console.log('Using authenticated connection');
        } else {
            console.log('Using anonymous connection');
        }
        if (usingLegacyTikTokConnector && !this.pollingFallbackActivated) {
            console.warn('[TikTok] Legacy connector in use; live shopping purchase events are unavailable until the package is upgraded.');
        }
        try {
            this.initializeConnectionInstance({ forceLegacy: this.preferredStrategy === 'legacy', context: 'primary' });
            return this.connect();
        } catch (error) {
            const fallbackHandled = await this.tryFallbackToPolling(error, 'initialize');
            if (fallbackHandled) {
                return this.connect();
            }
            this.logDebug('lifecycle.initialize.error', error);
            console.error('Failed to initialize TikTok connection:', error);
            this.handleFatalError(error);
            throw error;
        }
    }

    handleFatalError(error) {
        this.logDebug('lifecycle.fatalError', error);
        console.error('Fatal connection error:', error);
        this.isStopped = true;

        let errorMessage = this.getUserFriendlyErrorMessage(
            error,
            error instanceof Error ? error.message : (error && error.message ? error.message : '')
        );

        // Handle specific error types
        if (error instanceof Error) {
            if (error.message.includes('LIVE has ended') || error.name === 'UserOfflineError') {
                errorMessage = 'Live stream has ended';
            } else if (error.name === 'AlreadyConnectingError') {
                errorMessage = 'Connection already in progress';
            } else if (!errorMessage || errorMessage === 'Connection failed') {
                errorMessage = error.message;
            }
        }

        emitStatus({
            wssID: this.wssID,
            status: 'fatal_error',
            error: errorMessage
        });

        // Clean up the connection
        cleanupConnection(this.wssID);
    }

    setupEventHandlers() {
        const suppressedDecodedLogTypes = new Set([
            'WebcastLinkLayerMessage',
            'WebcastLinkMessage',
            'WebcastLinkMicFanTicketMethod',
            'WebcastLinkMicMethod'
        ]);
        if (typeof this.connection.on === 'function') {
            this.connection.on('ssappProtoFetch', (result) => this.handleProtoFetch(result));
        }
        this.connection.on('websocketData', (buffer) => {
            // Any raw websocket traffic proves the connection is alive.
            // Without this, quiet rooms with only heartbeat traffic look
            // "stale" to the health check and trigger unnecessary reconnects.
            this.noteConnectionActivity('websocketData');
            let preview = null;
            let length = null;
            try {
                if (buffer && typeof buffer.length === 'number') {
                    length = buffer.length;
                    if (length > 0) {
                        const slice = typeof buffer.slice === 'function'
                            ? buffer.slice(0, Math.min(length, 16))
                            : (Buffer.isBuffer(buffer) ? buffer.subarray(0, Math.min(length, 16)) : null);
                        if (slice) {
                            preview = Buffer.from(slice).toString('hex');
                        }
                    }
                }
            } catch (_) {
                preview = null;
            }
            this.logDebug('control.websocketData', {
                length,
                preview
            });
        });
        this.connection.on('rawData', (messageType) => {
            this.logDebug('control.rawData', {
                messageType
            });
        });
        this.connection.on('decodedData', (messageType, decodedData, rawPayload) => {
            this.noteConnectionActivity(`decodedData:${messageType}`);
            const suppressed = suppressedDecodedLogTypes.has(messageType);
            const logEntry = {
                messageType
            };
            if (!suppressed) {
                logEntry.decodedData = decodedData;
                if (rawPayload && typeof rawPayload === 'object') {
                    const payloadLength = Array.isArray(rawPayload.data) ? rawPayload.data.length : undefined;
                    if (payloadLength !== undefined) {
                        logEntry.rawPayloadLength = payloadLength;
                    }
                }
            }
            this.logDebug('control.decodedData', logEntry);
        });
        this.connection.on('enterRoom', (data) => {
            this.logDebug('control.enterRoom', data);
        });
        this.connection.on('websocketConnected', () => {
            this.logDebug('control.websocketConnected');
            this.handleConnect();
        });
        this.connection.on('disconnect', (disconnectInfo) => {
            // For EulerWS, disconnectInfo contains { code, reason, codeLabel }
            const code = disconnectInfo?.code;
            const codeLabel = disconnectInfo?.codeLabel || '';
            const reason = disconnectInfo?.reason || '';
            this.logDebug('control.disconnect', { code, codeLabel, reason });
            console.info(`[TikTok] Disconnect detected${code ? ` - code=${code} (${codeLabel})` : ''}${reason ? `: ${reason}` : ''}`);
            this.handleDisconnect(disconnectInfo);
        });
        this.connection.on('error', (err) => {
            this.logDebug('control.error', err);
            this.handleError(err).catch((handleErrorErr) => {
                console.warn('[TikTok] Failed to process connection error:', handleErrorErr?.message || handleErrorErr);
            });
        });
        this.connection.on('streamEnd', () => {
            this.logDebug('control.streamEnd');
            this.scheduleStreamEndConfirmation('stream_end_signal');
        });
        this.connection.on('chat', (data) => {
            this.logDebug('event.chat', data);
            this.recordActivity();
            this.messageProcessor.addToQueue(data);
        });
        this.connection.on('gift', (data) => {
            this.logDebug('event.gift', data);
            this.recordActivity();
            this.giftProcessor.addToQueue(data);
        });

        const eventHandlers = {
            follow: (data) => {
                this.recordActivity();
                const identity = extractTikTokIdentity(data);
                const displayName = identity.nickname || identity.uniqueId || 'Viewer';
                if (identity.nickname && !data.nickname) data.nickname = identity.nickname;
                if (identity.uniqueId && !data.uniqueId) data.uniqueId = identity.uniqueId;
                this.sendEventMessage(data, "followed", `${displayName} followed!`);
            },
            share: (data) => {
                this.recordActivity();
                const identity = extractTikTokIdentity(data);
                const displayName = identity.nickname || identity.uniqueId || 'Viewer';
                if (identity.nickname && !data.nickname) data.nickname = identity.nickname;
                if (identity.uniqueId && !data.uniqueId) data.uniqueId = identity.uniqueId;
                this.sendEventMessage(data, "shared", `${displayName} shared the live stream!`);
            },
            like: (data) => {
                this.recordActivity();
                const identity = extractTikTokIdentity(data);
                const displayName = identity.nickname || identity.uniqueId || 'Viewer';
                if (identity.nickname && !data.nickname) data.nickname = identity.nickname;
                if (identity.uniqueId && !data.uniqueId) data.uniqueId = identity.uniqueId;
                this.sendEventMessage(data, "liked", `${displayName} liked the stream!`);
            },
            subscribe: (data) => {
                this.recordActivity();
                const identity = extractTikTokIdentity(data);
                const displayName = identity.nickname || identity.uniqueId || 'Viewer';
                const subscribeInfo = isPlainObject(data?.user?.subscribeInfo) ? data.user.subscribeInfo : {};
                const tenureMonths = Number(subscribeInfo.subMonth || subscribeInfo.subscribedMonth || subscribeInfo.months || data?.subscribeMonth);
                const tier = subscribeInfo?.subscribingStatus || subscribeInfo?.tier || data?.subscribeType;
                const subtitle = Number.isFinite(tenureMonths) && tenureMonths > 0
                    ? `${tenureMonths} month${tenureMonths === 1 ? '' : 's'}`
                    : null;
                // Ensure subscriber flag is present for downstream membership rendering
                data.isSubscriber = true;
                if (identity.nickname && !data.nickname) data.nickname = identity.nickname;
                if (identity.uniqueId && !data.uniqueId) data.uniqueId = identity.uniqueId;
                const meta = {};
                if (Number.isFinite(tenureMonths) && tenureMonths > 0) {
                    meta.tenureMonths = tenureMonths;
                }
                if (tier) {
                    meta.tier = tier;
                }
                if (subtitle) {
                    meta.subtitle = subtitle;
                }
                this.sendEventMessage(data, "subscribe", `${displayName} subscribed!`, meta);
            },
            social: (data = {}) => {
                this.recordActivity();
                const devMode = isDevBuild();
                const meta = normalizeSocialMeta(data);

                if (SOCIAL_SUPPRESSED_DISPLAY_TYPES.has(meta.baseDisplayType)) {
                    if (devMode) {
                        console.debug('[TikTok] suppressed placeholder social event', { meta });
                    }
                    return;
                }
                if (isRedundantFollowOrSub(meta)) {
                    if (devMode) {
                        console.debug('[TikTok] suppressed redundant follow/sub social event', { meta });
                    }
                    return;
                }
                if (isSocialGiftEcho(meta)) {
                    if (devMode) {
                        console.debug('[TikTok] suppressed social gift echo', { meta });
                    }
                    return;
                }
                if (isGenericSocialLabel(meta)) {
                    if (devMode) {
                        console.debug('[TikTok] suppressed generic social label', { meta });
                    }
                    return;
                }

                const classification = classifySocialEvent(meta);
                if (!classification) {
                    if (devMode) {
                        console.debug('[TikTok] unknown social event (dev log only)', { meta, raw: data });
                    }
                    return;
                }

                const identity = extractTikTokIdentity(data);
                const displayName = identity.nickname || identity.uniqueId || 'Viewer';
                if (identity.nickname && !data.nickname) data.nickname = identity.nickname;
                if (identity.uniqueId && !data.uniqueId) data.uniqueId = identity.uniqueId;

                const message = `${displayName} ${classification.message}!`;
                this.sendEventMessage(data, classification.event, message);
            },
            member: (data = {}) => {
                this.recordActivity();
                if (!isCaptureEventsEnabled() || !isCaptureJoinedEventEnabled()) {
                    return;
                }

                const action = data?.action;
                const actionCode = typeof action === 'number' ? action : Number(action);
                const actionIsJoin = actionCode === 1 ||
                    (typeof action === 'string' && action.toLowerCase().trim() === 'join');
                const descriptionMentionsJoin = [
                    data?.actionDescription,
                    data?.displayText?.defaultPattern,
                    data?.anchorDisplayText?.defaultPattern
                ].some(text => typeof text === 'string' && text.toLowerCase().includes('join'));

                if (!actionIsJoin && !descriptionMentionsJoin) {
                    return;
                }

                if (typeof data.nickname === 'string') {
                    const cleaned = data.nickname.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
                    if (cleaned) {
                        data.nickname = cleaned;
                    } else {
                        delete data.nickname;
                    }
                }

                const identity = extractTikTokIdentity(data);
                if (identity.nickname && !data.nickname) data.nickname = identity.nickname;
                if (identity.uniqueId && !data.uniqueId) data.uniqueId = identity.uniqueId;

                this.sendEventMessage(data, 'joined', 'joined');
            },
            questionNew: (data = {}) => {
                this.recordActivity();
                const identity = extractTikTokIdentity(data);
                const questionId = data.questionIdStr || data.questionId || data.id || null;
                const text = data.questionText || data.text || data.question || data.content || null;
                if (!text) {
                    return;
                }
                this.sendEventMessage(data, 'question_new', null, {
                    questionId: questionId || undefined,
                    text,
                    user: identity.uniqueId || identity.nickname || undefined
                });
            },
            linkMicBattle: (data = {}) => {
                this.recordActivity();
                const identity = extractTikTokIdentity(data);
                const battleId = data.battleIdStr || data.battleId || data.id || null;
                const homeScore = Number(data.homeScore || data.scoreHome || data.score1);
                const awayScore = Number(data.awayScore || data.scoreAway || data.score2);
                const meta = {};
                if (battleId) meta.battleId = battleId;
                if (Number.isFinite(homeScore)) meta.homeScore = homeScore;
                if (Number.isFinite(awayScore)) meta.awayScore = awayScore;
                if (identity.uniqueId || identity.nickname) {
                    meta.host = identity.uniqueId || identity.nickname;
                }
                this.sendEventMessage(data, 'link_mic_battle', null, meta);
            },
            linkMicArmies: (data = {}) => {
                this.recordActivity();
                const battleId = data.battleIdStr || data.battleId || data.id || null;
                const meta = {};
                if (battleId) meta.battleId = battleId;
                const armies = Array.isArray(data.armies) ? data.armies : (Array.isArray(data.armyList) ? data.armyList : []);
                const armyNames = armies.map(a => a?.armyName || a?.name || a?.displayName || null).filter(Boolean);
                if (armyNames.length) {
                    meta.armies = armyNames;
                }
                const armyScores = Array.isArray(data.armyScores) ? data.armyScores : (Array.isArray(data.scores) ? data.scores : []);
                const scoreValues = armyScores.map(s => Number(s)).filter(Number.isFinite);
                if (scoreValues.length) {
                    meta.scores = scoreValues;
                }
                this.sendEventMessage(data, 'link_mic_armies', null, meta);
            },
            liveIntro: (data = {}) => {
                this.recordActivity();
                const identity = extractTikTokIdentity(data);
                const meta = {};
                const title = data.title || data.introTitle || data?.displayText || null;
                if (title) meta.title = title;
                if (identity.uniqueId || identity.nickname) {
                    meta.host = identity.uniqueId || identity.nickname;
                }
                if (Number.isFinite(Number(data.duration))) {
                    meta.duration = Number(data.duration);
                }
                if (data.introType) {
                    meta.introType = data.introType;
                }
                this.sendEventMessage(data, 'live_intro', null, meta);
            },
            envelope: (data = {}) => {
                this.recordActivity();
                const identity = extractTikTokIdentity(data);
                const coins = Number(data.coinCount || data.coins || data.diamondCount);
                const meta = {};
                const envelopeId = data.envelopeId || data.id || data.envelope_id || null;
                if (envelopeId) meta.envelopeId = envelopeId;
                if (Number.isFinite(coins)) meta.coins = coins;
                if (identity.uniqueId || identity.nickname) {
                    meta.sender = identity.uniqueId || identity.nickname;
                }
                this.sendEventMessage(data, 'envelope', null, meta);
            },
			emote: (data = {}) => {
				this.recordActivity();
				const emotes = normalizeTikTokEmoteEntries(data);
				const emoteIds = [];
				const emoteLabels = [];
				const emoteUrls = [];
				emotes.forEach((emote) => {
					if (!emote) return;
					const id = cleanVisibleString(emote.emoteId || '') || null;
					const label = cleanVisibleString(emote.emoteLabel || '') || null;
					const url = normalizeTikTokImageUrl(emote.emoteUrl) || null;
					if (id) emoteIds.push(id);
					if (label) emoteLabels.push(label);
					if (url) emoteUrls.push(url);
				});
                if (!emoteIds.length && !emoteLabels.length && !emoteUrls.length) {
                    return;
                }
                const meta = {};
                if (emoteIds.length) meta.emoteIds = emoteIds;
                if (emoteLabels.length) meta.emoteLabels = emoteLabels;
                if (emoteUrls.length) meta.emoteUrls = emoteUrls;
                this.sendEventMessage(data, 'emote', null, meta);
            },
            roomUser: (data) => {
                this.recordActivity();
                if ("viewerCount" in data) {
                    this.lastViewerCount = parseInt(data.viewerCount) || 0;
                    if (isViewerUpdateAllowed()) {
                        sendToBackground({
                            meta: this.lastViewerCount,
                            type: "tiktok",
                            event: "viewer_update",
                            tid: this.virtualTabId
                        });
                    }
                }
            },
            oecLiveShopping: (data = {}) => {
                this.recordActivity();

                const shopData = data?.shopData && typeof data.shopData === 'object' ? data.shopData : {};
                const details = data?.details && typeof data.details === 'object' ? data.details : {};
                const rawTitle = (typeof shopData.title === 'string' && shopData.title.trim()) ? shopData.title.trim() : 'Product';
                const isGenericTitle = !rawTitle || /^product$/i.test(rawTitle);
                const meaningfulTitle = isGenericTitle ? null : rawTitle;
                const title = rawTitle || 'Product';
                const phaseRaw = data?.data1;
                const phaseNumber = Number(phaseRaw);
                const phase = Number.isFinite(phaseNumber) ? phaseNumber : null;
                const detailId = details?.id1 || shopData?.data1 || data?.id1 || null;
                const detailTimestamp = details?.timestamp || details?.data?.timestamp || null;
                const detailDataValueNumber = Number(details?.data?.data);
                const detailDataValue = Number.isFinite(detailDataValueNumber) ? detailDataValueNumber : null;

                const priceText = shopData.priceString ? ` – ${shopData.priceString}` : '';
                const shopText = shopData.shopName ? ` (${shopData.shopName})` : '';
                const identity = extractTikTokIdentity(data);
                const buyerName = identity?.nickname || identity?.uniqueId || null;

                const labelSources = [
                    details?.data?.label,
                    details?.data?.label2,
                    details?.data?.label3,
                    details?.label,
                    details?.describe,
                    data?.describe,
                    data?.label,
                    data?.labels,
                    data?.eventLabel,
                    data?.eventLabels
                ];
                const labelCandidates = [];
                for (const source of labelSources) {
                    if (!source) continue;
                    if (Array.isArray(source)) {
                        source.forEach((item) => {
                            if (typeof item === 'string') {
                                const trimmed = item.trim();
                                if (trimmed) labelCandidates.push(trimmed);
                            }
                        });
                    } else if (typeof source === 'string') {
                        const trimmed = source.trim();
                        if (trimmed) labelCandidates.push(trimmed);
                    }
                }

                const displayLabel = labelCandidates[0] || null;
                const normalizedLabelSignals = labelCandidates.map((label) => label.toLowerCase());
                const purchaseSignal = normalizedLabelSignals.some(label => /purchase|sold\s?out|checkout|order|paid|bayar|beli|soldout/.test(label));
                const likelyPurchase = purchaseSignal || phase === 4 || (detailDataValue !== null && detailDataValue >= 2);

                const eventType = likelyPurchase ? 'shopping_purchase' : 'oec_live_shopping';
                const phaseDescriptions = {
                    1: 'Product preview',
                    2: 'Product spotlight',
                    3: 'Product spotlight',
                    4: 'Purchase event',
                    5: 'Post-purchase update'
                };
                const phaseDescription = (phase !== null && phaseDescriptions[phase]) || null;

                let message = null;
                if (likelyPurchase) {
                    if (buyerName && meaningfulTitle) {
                        message = `${buyerName} purchased ${meaningfulTitle}${priceText}${shopText}`;
                    } else if (buyerName) {
                        message = `${buyerName} made a purchase${priceText}${shopText}`;
                    } else if (meaningfulTitle) {
                        message = `Purchase: ${meaningfulTitle}${priceText}${shopText}`;
                    }
                } else if (meaningfulTitle) {
                    if (displayLabel && !displayLabel.toLowerCase().includes(meaningfulTitle.toLowerCase())) {
                        message = `${displayLabel} — ${meaningfulTitle}${priceText}${shopText}`;
                    } else if (displayLabel) {
                        message = `${displayLabel}${priceText}${shopText}`;
                    } else {
                        message = `Live shopping: ${meaningfulTitle}${priceText}${shopText}`;
                    }
                } else if (displayLabel && /deal|drop|promo|flash|offer|discount/.test(displayLabel.toLowerCase())) {
                    message = displayLabel;
                }

                const summaryParts = [];
                if (phaseDescription) summaryParts.push(phaseDescription);
                if (meaningfulTitle) summaryParts.push(meaningfulTitle);
                else if (displayLabel) summaryParts.push(displayLabel);
                if (shopData.priceString) summaryParts.push(shopData.priceString);
                if (shopData.shopName) summaryParts.push(shopData.shopName);
                if (likelyPurchase && buyerName) summaryParts.push(`Buyer: ${buyerName}`);
                const summary = summaryParts.length ? summaryParts.join(' • ') : null;

                const chatMessage = (typeof message === 'string' && message.trim().length) ? message.trim() : '';
                const chatSuppressed = !chatMessage;

                const now = Date.now();
                const eventKey = detailId || (displayLabel ? `${phase ?? 'phaseX'}:${displayLabel}` : `${phase ?? 'phaseX'}:${meaningfulTitle || title}`);
                if (!this.recentShoppingEvents) {
                    this.recentShoppingEvents = new Map();
                }

                if (eventKey) {
                    const previous = this.recentShoppingEvents.get(eventKey);
                    if (previous && previous.type === eventType && (now - previous.timestamp) < 2000) {
                        this.logDebug('event.oecLiveShopping.suppressedDuplicate', {
                            eventKey,
                            eventType,
                            phase,
                            deltaMs: now - previous.timestamp
                        });
                        return;
                    }
                    this.recentShoppingEvents.set(eventKey, {
                        timestamp: now,
                        type: eventType
                    });
                    for (const [key, info] of [...this.recentShoppingEvents.entries()]) {
                        if (now - info.timestamp > 15000) {
                            this.recentShoppingEvents.delete(key);
                        }
                    }
                }

                this.logDebug('event.oecLiveShopping.classified', {
                    eventKey,
                    eventType,
                    phase,
                    phaseDescription,
                    labels: labelCandidates,
                    detailId,
                    detailDataValue,
                    price: shopData.priceString || null,
                    shopName: shopData.shopName || null,
                    buyer: buyerName || null,
                    likelyPurchase,
                    chatSuppressed
                });

                console.info('[TikTok] Live shopping event', {
                    username: this.username,
                    title: meaningfulTitle || title,
                    price: shopData.priceString || null,
                    shopName: shopData.shopName || null,
                    detailId,
                    phase,
                    likelyPurchase,
                    labels: labelCandidates
                });

                const payload = {
                    ...data,
                    nickname: shopData.shopName || data?.nickname || 'TikTok Shop',
                    profilePictureUrl: normalizeTikTokImageUrl(shopData.imageUrl)
                        || normalizeTikTokImageUrl(data?.profilePictureUrl)
                        || normalizeTikTokImageUrl(data?.profilePicture)
                        || normalizeTikTokImageUrl(data?.user?.profilePictureUrl)
                        || normalizeTikTokImageUrl(data?.user?.profilePicture)
                        || null
                };

                const shoppingMeta = {
                    source: 'oec_live_shopping',
                    productTitle: title,
                    productTitleNormalized: meaningfulTitle || null,
                    phase,
                    eventKey,
                    likelyPurchase,
                    phaseDescription,
                    buyer: buyerName || null,
                    chatSuppressed
                };
                if (shopData.priceString) shoppingMeta.price = shopData.priceString;
                if (shopData.shopName) shoppingMeta.shopName = shopData.shopName;
                const primaryShopUrl = shopData.shopUrl || shopData.shopUrl2;
                if (primaryShopUrl) shoppingMeta.shopUrl = primaryShopUrl;
                if (detailId) shoppingMeta.detailId = detailId;
                if (detailTimestamp) shoppingMeta.detailTimestamp = detailTimestamp;
                if (detailDataValue !== null) shoppingMeta.detailDataValue = detailDataValue;
                if (labelCandidates.length) shoppingMeta.labels = labelCandidates;
                if (data?.shopTimings) shoppingMeta.shopTimings = data.shopTimings;
                if (phase !== null) shoppingMeta.phaseRaw = phaseRaw;
                if (summary) shoppingMeta.summary = summary;

                this.sendEventMessage(payload, eventType, chatMessage, shoppingMeta);
            },
            goalUpdate: (data = {}) => {
                this.recordActivity();
                const normalized = this.normalizeGoalUpdate(data);
                if (!normalized) {
                    return;
                }
                this.emitGoalEvent(normalized);
            },
            pollMessage: (data = {}) => {
                this.recordActivity();
                const basicInfo = data?.pollBasicInfo || {};
                const pollTitle = basicInfo.title || data?.startContent?.Title || 'Poll';

                const summarizeOptions = (optionList) => {
                    if (!Array.isArray(optionList) || !optionList.length) return [];
                    return optionList.map(opt => {
                        const label = opt?.DisplayContent || `Option ${opt?.OptionIdx ?? ''}`;
                        const votes = typeof opt?.Votes === 'number' ? opt.Votes : (opt?.Votes ? Number(opt.Votes) : 0);
                        return {
                            label,
                            votes: Number.isFinite(votes) ? votes : 0
                        };
                    });
                };

                let status = 'update';
                let options = [];
                if (data?.startContent) {
                    status = 'started';
                    options = summarizeOptions(data.startContent.OptionList);
                } else if (data?.endContent) {
                    status = 'ended';
                    options = summarizeOptions(data.endContent.OptionList);
                } else if (data?.updateContent) {
                    status = 'votes';
                    options = summarizeOptions(data.updateContent.OptionList);
                }

                const optionsText = options.length ? options.map(opt => `${opt.label}: ${opt.votes}`).join(', ') : null;
                const message = optionsText ? `Poll ${status}: ${pollTitle} — ${optionsText}` : `Poll ${status}: ${pollTitle}`;

                console.info('[TikTok] Poll message', {
                    username: this.username,
                    title: pollTitle,
                    status,
                    optionCount: options.length,
                    pollId: basicInfo.pollIdStr || null
                });

                const operator = data?.startContent?.Operator || data?.endContent?.Operator;
                const operatorAvatarUrl = normalizeTikTokImageUrl(operator?.profilePicture?.url)
                    || normalizeTikTokImageUrl(operator?.profilePictureUrl)
                    || normalizeTikTokImageUrl(data?.profilePictureUrl)
                    || normalizeTikTokImageUrl(data?.profilePicture)
                    || normalizeTikTokImageUrl(data?.user?.profilePictureUrl)
                    || normalizeTikTokImageUrl(data?.user?.profilePicture);
                const payload = {
                    ...data,
                    nickname: data?.nickname || basicInfo.pollSponsor || pollTitle,
                    profilePictureUrl: operatorAvatarUrl || null
                };

                const pollMeta = { status };
                if (basicInfo.pollIdStr) pollMeta.pollId = basicInfo.pollIdStr;
                if (options.length) pollMeta.options = options;
                if (basicInfo.pollDuration) pollMeta.duration = basicInfo.pollDuration;
                if (basicInfo.timeRemain) pollMeta.remaining = basicInfo.timeRemain;

                this.sendEventMessage(payload, 'poll_message', message, pollMeta);
            },
            roomPin: (data = {}) => {
                this.recordActivity();
                const action = data?.pin ? 'Pinned' : (data?.unpin ? 'Unpinned' : 'Pin updated');
                const operatorName = data?.operator?.nickname || data?.operator?.uniqueId || 'Host';

                let sourceMessage;
                if (data?.chatMessage?.comment) {
                    sourceMessage = {
                        text: data.chatMessage.comment,
                        author: data.chatMessage.user?.nickname || data.chatMessage.user?.uniqueId || 'Viewer',
                        avatar: data.chatMessage.user?.profilePicture?.url
                    };
                } else if (data?.socialMessage?.shareInfo) {
                    sourceMessage = {
                        text: data.socialMessage.shareInfo?.shareText || 'Social action pinned',
                        author: data.socialMessage.user?.nickname || data.socialMessage.user?.uniqueId || 'Viewer',
                        avatar: data.socialMessage.user?.profilePicture?.url
                    };
                }

                const author = sourceMessage?.author || 'Viewer';
                const text = sourceMessage?.text || 'Pinned message';
                const avatarArray = sourceMessage?.avatar;
                const avatarUrl = normalizeTikTokImageUrl(avatarArray)
                    || normalizeTikTokImageUrl(data?.profilePictureUrl)
                    || normalizeTikTokImageUrl(data?.profilePicture)
                    || normalizeTikTokImageUrl(data?.user?.profilePictureUrl)
                    || normalizeTikTokImageUrl(data?.user?.profilePicture);
                const message = `${action} by ${operatorName}: ${author} — ${text}`;

                console.info('[TikTok] Room pin update', {
                    username: this.username,
                    action,
                    operator: operatorName,
                    author,
                    pinId: data?.pinId || null
                });

                const payload = {
                    ...data,
                    nickname: data?.nickname || author,
                    profilePictureUrl: avatarUrl || null
                };

                const pinMeta = { action, operator: operatorName };
                if (data?.pinId) pinMeta.pinId = data.pinId;
                if (data?.displayDuration) pinMeta.displayDuration = data.displayDuration;

                this.sendEventMessage(payload, 'room_pin', message, pinMeta);
            }
        };

        Object.entries(eventHandlers).forEach(([event, handler]) => {
            this.connection.on(event, (data) => {
                this.logDebug(`event.${event}`, data);
                handler(data);
            });
        });
    }

    handleProtoFetch(fetchResult) {
        if (!fetchResult || typeof fetchResult !== 'object') {
            return;
        }
        try {
            const roomId = this.connection?.roomId || this.connection?.webClient?.roomId || null;
            if (roomId) {
                if (this.previousRoomId && roomId !== this.previousRoomId && this.resumeCursorState && this.resumeCursorState.roomId !== roomId) {
                    this.resumeCursorState = null;
                }
                this.previousRoomId = roomId;
            }

            const isFirst = fetchResult.isFirst === true;
            const historyNoMore = fetchResult.historyNoMore === true;

            // Seed the dedupe cache with chat/gift IDs from the initial history
            // batch so that when the library emits these as individual events
            // they are caught by normal dedupe instead of being forwarded twice.
            // This replaces the old blanket-drop approach that also killed live
            // traffic arriving during the replay window.
            if (isFirst && Array.isArray(fetchResult.messages)) {
                const now = Date.now();
                const chatTtl = TIKTOK_EVENT_DEDUPE_WINDOWS_MS.chat || (60 * 60 * 1000);
                const giftTtl = TIKTOK_EVENT_DEDUPE_WINDOWS_MS.gift || (60 * 60 * 1000);
                let seeded = 0;
                for (const msg of fetchResult.messages) {
                    const decoded = msg?.decodedData?.data;
                    if (!decoded) continue;
                    const msgType = msg?.decodedData?.type || msg?.type;
                    let key = null;
                    let ttl = 0;
                    if (msgType === 'WebcastChatMessage') {
                        key = buildChatDedupeKey(decoded);
                        ttl = chatTtl;
                    } else if (msgType === 'WebcastGiftMessage') {
                        key = buildGiftDedupeKey(decoded);
                        ttl = giftTtl;
                    }
                    if (key) {
                        const existing = this.recentEventDedupes.get(key);
                        if (!existing || existing <= now) {
                            this.recentEventDedupes.set(key, now + ttl);
                            seeded++;
                        }
                    }
                }
                if (seeded > 0) {
                    this.logDebug('replay.dedupe.seeded', { count: seeded });
                }
                if (this.recentEventDedupes.size > TIKTOK_EVENT_DEDUPE_MAX_ENTRIES) {
                    this.pruneRecentEventDedupes(now, true);
                }
            }

            if ((!isFirst || historyNoMore) && fetchResult.cursor && roomId) {
                this.resumeCursorState = {
                    cursor: fetchResult.cursor,
                    internalExt: fetchResult.internalExt || null,
                    roomId,
                    capturedAt: Date.now()
                };
                this.logDebug('lifecycle.cursor.captured', {
                    roomId,
                    hasInternalExt: !!fetchResult.internalExt
                });
            }
        } catch (error) {
            console.warn('Failed to process TikTok proto fetch metadata:', error);
        }
    }

    startHealthCheck() {
        if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);

        // Track connection start time for proactive refresh
        if (!this.connectionStartTime) {
            this.connectionStartTime = Date.now();
        }

        this.healthCheckInterval = setInterval(() => {
            const now = Date.now();
            const timeSinceLastMessage = now - this.lastMessageTime;
            const connectionDuration = now - this.connectionStartTime;

            // Proactively reconnect after 1.5 hours to avoid 2-hour timeout
            if (connectionDuration > 90 * 60 * 1000) { // 90 minutes
                console.info('Proactively refreshing connection after 90 minutes');
                this.connectionStartTime = Date.now();
                this.forceReconnect();
            } else if (this.connection && this.connection.isConnected) {
                const adaptiveTimeout = this.getAdaptiveMessageTimeout();
                if (timeSinceLastMessage > adaptiveTimeout) {
                    console.info(`Connection appears stale - no messages for ${Math.round(timeSinceLastMessage / 1000)}s (threshold ${Math.round(adaptiveTimeout / 1000)}s), forcing reconnect`);
                    this.forceReconnect();
                }
            }
        }, CONFIG.CONNECTION.HEALTH_CHECK_INTERVAL);
    }

    startViewerUpdateInterval() {
        // Clear any existing interval
        if (this.viewerUpdateInterval) clearInterval(this.viewerUpdateInterval);

        // Send viewer count every 30 seconds
        this.viewerUpdateInterval = setInterval(() => {
            if (this.connection && this.connection.isConnected) {
                if (isViewerUpdateAllowed()) {
                    sendToBackground({
                        meta: this.lastViewerCount,
                        type: "tiktok",
                        event: "viewer_update",
                        tid: this.virtualTabId
                    });
                }
            }
        }, 30000); // 30 seconds
    }

    async connect(options = {}) {
        const { bypassActivePromise = false } = options || {};
        if (this.isStopped) return false;

        if (this.connection && this.connection.isConnected) {
            console.info('Already connected, skipping reconnect');
            return true;
        }

        if (!bypassActivePromise && this.activeConnectPromise) {
            this.logDebug('lifecycle.connect.pending', { reason: 'promise_in_flight' });
            return this.activeConnectPromise;
        }

        // If this is a manual connect (implied by calling connect() when stopped or failed), 
        // and we are not in a recursive retry loop, we might want to reset the fallback 
        // to give Websocket another chance if the user desires.
        // However, for now, we rely on the fact that `websocketFailureCount` is reset on success.
        // If the user explicitly wants to retry Websocket, they might need to toggle settings or we need a way to know it's a "manual" click.
        // For this implementation, we will assume that if the user calls connect() and we are stopped, it's a fresh attempt.
        if (this.isStopped) {
            // Reset fallback state on fresh start to allow trying preferred strategy again
            this.pollingFallbackActivated = false;
        }

        // 3-Strike Rule: If we've failed Websocket connections too many times, force legacy mode
        if (this.websocketFailureCount >= this.WEBSOCKET_FAILURE_THRESHOLD && !this.pollingFallbackActivated) {
            console.warn(`[TikTok] Websocket failure threshold reached (${this.websocketFailureCount}), forcing Polling Fallback.`);
            this.pollingFallbackActivated = true;
            this.preferredStrategy = 'legacy';
            this.connectionStrategy = 'legacy';
            this.websocketFailureCount = 0;

            // Notify UI of the fallback
            try {
                emitStatus({
                    wssID: this.wssID,
                    status: 'fallback_warning',
                    message: 'Connection unstable. Switched to compatibility mode.'
                });
            } catch (_) { }

            // Tear down websocket connector and reinitialize with legacy
            try {
                this.resetConnectionBootstrapState({ clearRoomId: true, clearResumeCursor: true });
                await this.teardownConnection({ silent: true });
                await this.waitForPollingFallbackHandoff('websocket_strike');
            } catch (teardownErr) {
                console.warn('Failed to teardown websocket before fallback:', teardownErr);
            }
            try {
                this.initializeConnectionInstance({ forceLegacy: true, context: 'websocket_strike' });
            } catch (initErr) {
                console.error('Failed to initialize legacy connector after websocket strikes:', initErr);
            }
        }

        const runConnect = async () => {
            let restoreAuthenticatedWsBootstrapEnv = null;
            try {
                this.logDebug('lifecycle.connect.start');
                const usingLocalSigner = this.shouldUseLocalSigner();

                // Mark connection attempt in progress to prevent cleanup during slow operations
                // (e.g., local signer window navigation and fetch)
                connectionStates.set(this.wssID, {
                    isConnected: false,
                    lastAttempt: Date.now(),
                    isReconnecting: false,
                    attemptInProgress: true
                });

                try {
                    emitStatus({
                        wssID: this.wssID,
                        status: 'connecting',
                        message: usingLocalSigner
                            ? 'Preparing TikTok local signer. This usually takes 10-15 seconds.'
                            : null
                    });
                } catch (_) { /* renderer may be gone */ }

                // Determine signing strategy for logging/cleanup
                const isLocalSignerExplicit = this.signingProvider === 'local';
                const isAuto = this.signingProvider === 'auto';
                const isCustom = this.signingProvider === 'custom';

                if (usingLocalSigner) {
                    this.logDebug('lifecycle.connect.setup_signer', { provider: 'local' });
                } else if (isCustom || (isAuto && this.signingConfig)) {
                    if (isCustom && this.connection?.signedWebSocketProvider) {
                        this.connection.signedWebSocketProvider = null;
                    }
                }

                this.ensureConnectionInstance('connect');
                const activeConnection = this.connection;
                if (!activeConnection || typeof activeConnection.connect !== 'function') {
                    const unavailableError = new Error('TikTok connection instance unavailable after fallback transition.');
                    unavailableError.code = 'SSAPP_TIKTOK_CONNECTION_UNAVAILABLE';
                    throw unavailableError;
                }
                restoreAuthenticatedWsBootstrapEnv = this.prepareAuthenticatedWebsocketBootstrapEnv(activeConnection);

                if (this.pollingFallbackActivated || this.preferredStrategy === 'legacy' || this.connectionStrategy === 'legacy') {
                    this.resetConnectionBootstrapState();
                }

                await activeConnection.connect();
                if (typeof restoreAuthenticatedWsBootstrapEnv === 'function') {
                    restoreAuthenticatedWsBootstrapEnv();
                    restoreAuthenticatedWsBootstrapEnv = null;
                }

                const modeDetails = this.getConnectionModeDetails();
                const effectiveMode = modeDetails.effectiveMode;
                const connectionMethod = modeDetails.method;
                const successLabel = modeDetails.label || `Connected successfully using ${effectiveMode} mode.`;

                console.info(successLabel);
                this.logDebug('lifecycle.connect.success', {
                    effectiveMode,
                    connectionMethod
                });

                // For polling/legacy mode, 'websocketConnected' event won't fire,
                // so we need to manually trigger handleConnect() to update UI status
                const usingPolling = this.pollingFallbackActivated
                    || this.preferredStrategy === 'legacy'
                    || this.connectionStrategy === 'legacy'
                    || usingLegacyTikTokConnector;
                if (usingPolling) {
                    this.handleConnect();
                }

                this.signServerFailureCount = 0;
	                this.websocketFailureCount = 0; // Reset strikes on success
	                this.tiktokRateLimitCount = 0;
	                this.tiktokRateLimitLastAt = 0;

                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }

                this.offlineRetry = false;
                this.offlineReason = null;
                return true;
            } catch (err) {
                if (typeof restoreAuthenticatedWsBootstrapEnv === 'function') {
                    restoreAuthenticatedWsBootstrapEnv();
                    restoreAuthenticatedWsBootstrapEnv = null;
                }
                const primaryError = err instanceof Error ? err : (err && err.exception instanceof Error ? err.exception : err);
                const errorName = primaryError && primaryError.name;
                const errorMessage = primaryError && primaryError.message ? primaryError.message : '';
                const handledReconnectPromise = this.getFallbackReconnectPromise(primaryError);
                if (this.hasFallbackTransitionStarted(primaryError)) {
                    this.logDebug('lifecycle.connect.fallbackTransitionHandled', {
                        transition: primaryError?.__ssappTikTokFallbackTransitionStarted || null,
                        message: errorMessage || null
                    });
                    return handledReconnectPromise || false;
                }
                if (primaryError?.ssappFallback) {
                    const localFallbackHandled = await this.tryFallbackToLocalSigner(primaryError, 'connect_ssapp_local_fallback');
                    if (localFallbackHandled) {
                        return this.restartConnectionAttempt(primaryError);
                    }
                    const proxyFallbackHandled = await this.tryFallbackToEulerProxy(primaryError, 'connect_ssapp_proxy_fallback');
                    if (proxyFallbackHandled) {
                        return this.restartConnectionAttempt(primaryError);
                    }
                    const fallbackHandled = await this.tryFallbackToPolling(primaryError, 'connect');
                    if (fallbackHandled) {
                        return this.restartConnectionAttempt(primaryError);
                    }
                }

                if (errorName === 'AlreadyConnectingError') {
                    console.warn('Connect request ignored because a connection attempt is already in progress');
                    this.logDebug('lifecycle.connect.alreadyConnecting', {
                        message: errorMessage || null
                    });
                    return false;
                }

                const userFacingMessage = this.getUserFriendlyErrorMessage(primaryError, errorMessage);
                const isRateLimited = this.isRateLimitError(primaryError, errorMessage);
                const isSignServerIssue = !isRateLimited && this.isSignServerError(primaryError, errorMessage);
                const offlineMessage = errorMessage || userFacingMessage || (primaryError && primaryError.reason) || '';
                const isOffline = this.isOfflineError(primaryError, offlineMessage);
                if (isRateLimited) {
                    const localFirstHandled = await this.tryAutoFallbacksBeforePrompt(primaryError, 'connect_rate_limit_local_first', {
                        includeLocal: true,
                        includeProxy: false,
                        includePolling: false
                    });
                    if (localFirstHandled) {
                        return this.restartConnectionAttempt(primaryError);
                    }
                }
                const canTrySharedEulerKey = this.shouldTrySharedEulerApiKeyForRateLimit(primaryError, errorMessage);
                if (canTrySharedEulerKey) {
                    const sharedRetryHandled = await this.trySharedEulerApiKeyRetry('connect_rate_limit', {
                        reason: 'rate_limit',
                        primaryError,
                        rawMessage: errorMessage
                    });
                    if (sharedRetryHandled) {
                        return this.restartConnectionAttempt(primaryError);
                    }
                }
                if (isRateLimited) {
                    const proxyThenPollingHandled = await this.tryAutoFallbacksBeforePrompt(primaryError, 'connect_rate_limit_after_shared', {
                        includeLocal: false,
                        includeProxy: true,
                        includePolling: true
                    });
                    if (proxyThenPollingHandled) {
                        return this.restartConnectionAttempt(primaryError);
                    }
                }

                // Increment Websocket failure count only when using websocket mode
                const isWebsocketMode = !usingLegacyTikTokConnector && !this.pollingFallbackActivated && this.connectionStrategy !== 'legacy';
                const isLegacyConnectorInstance = !!(
                    TikTokPollingFallbackClass &&
                    this.connection &&
                    this.connection.constructor === TikTokPollingFallbackClass
                );
                if (!isOffline && isWebsocketMode && !isLegacyConnectorInstance) {
                    this.websocketFailureCount++;
                    this.logDebug('lifecycle.connect.websocket_strike', {
                        count: this.websocketFailureCount,
                        threshold: this.WEBSOCKET_FAILURE_THRESHOLD
                    });
                }

                this.logDebug('lifecycle.connect.error', {
                    errorName: primaryError?.name || null,
                    errorReason: primaryError?.reason || null,
                    rawMessage: errorMessage || null,
                    userMessage: userFacingMessage,
                    offline: isOffline
                });

	                const isLikelyFatal = this.isFatalLookupError(primaryError, errorMessage, userFacingMessage);
	                if (!isRateLimited && (this.tiktokRateLimitCount || 0) > 0) {
	                    this.tiktokRateLimitCount = 0;
	                    this.tiktokRateLimitLastAt = 0;
	                }

                if (isLikelyFatal) {
                    console.error('Fatal error - user might not exist or might be a display name:', this.username);
                    this.handleFatalError(primaryError || err);
                    return false;
                }

                if (isSignServerIssue) {
                    this.signServerFailureCount = (this.signServerFailureCount || 0) + 1;
                    const localFallbackHandled = await this.tryFallbackToLocalSigner(primaryError, 'connect_sign_error_auto');
                    if (localFallbackHandled) {
                        return this.restartConnectionAttempt(primaryError);
                    }
                    const proxyFallbackHandled = await this.tryFallbackToEulerProxy(primaryError, 'connect_sign_error_auto_proxy');
                    if (proxyFallbackHandled) {
                        return this.restartConnectionAttempt(primaryError);
                    }
                    const immediateBootstrapFallback = this.isBrokenSignerBootstrapError(primaryError, errorMessage);
                    const fallbackThresholdReached = immediateBootstrapFallback
                        || this.signServerFailureCount >= SIGN_SERVER_FAILURE_FALLBACK_THRESHOLD;

                    if (this.sessionId || (fallbackThresholdReached && !this.pollingFallbackActivated)) {
                        const fallbackStage = this.sessionId
                            ? 'connect_sign_error_session'
                            : (immediateBootstrapFallback ? 'connect_sign_error_bootstrap' : 'connect_sign_error_threshold');
                        const fallbackHandled = await this.tryFallbackToPolling(primaryError, fallbackStage);
                        if (fallbackHandled) {
                            return this.restartConnectionAttempt(primaryError);
                        }
                        if (this.sessionId) {
                            this.logConsoleFailure('TikTok session was rejected by sign server. Retrying without session credentials.', primaryError instanceof Error ? primaryError : null);
                            this.sessionId = null;
                            this.ttTargetIdc = null;
                            if (this.connection && this.connection.options) {
                                this.connection.options.sessionId = undefined;
                                this.connection.options.ttTargetIdc = undefined;
                                this.connection.options.authenticateWs = undefined;
                            }
                            this.authenticatedWsBootstrapHost = null;
                            this.handleSignServerRejection(primaryError instanceof Error ? primaryError : err);
                            return false;
                        }
                    }

                    if (this.maybeBoostSignRequestTimeout(primaryError, errorMessage)) {
                        this.logDebug('lifecycle.connect.retryImmediate', {
                            reason: 'sign_server_timeout',
                            timeoutMs: this.signRequestTimeoutMs,
                            maxTimeoutMs: this.signRequestTimeoutMaxMs
                        });

                        const retryDelay = this.signRequestImmediateRetryDelayMs || 0;
                        if (retryDelay > 0) {
                            await ConnectionManager.delay(retryDelay);
                        }

                        return this.restartConnectionAttempt(primaryError);
                    }

                    this.handleSignServerFailure(primaryError instanceof Error ? primaryError : err, errorMessage, userFacingMessage);
                    return false;
                } else {
                    this.signServerFailureCount = 0;
                }

                this.logConsoleFailure(userFacingMessage, primaryError instanceof Error ? primaryError : null);

                try {
                    emitStatus({
                        wssID: this.wssID,
                        status: 'failed',
                        error: userFacingMessage
                    });
                } catch (sendErr) {
                    console.warn('Failed to send TikTok connection failure status:', sendErr);
                }

                if (!this.isStopped) {
                    try {
                        connectionStates.set(this.wssID, {
                            isConnected: false,
                            lastAttempt: Date.now(),
                            isReconnecting: false,
                            attemptInProgress: false
                        });
                    } catch (_) { /* noop */ }

	                    if (isRateLimited) {
	                        const rateLimit = this.registerTikTokRateLimit(primaryError, 'connect');
	                        const retryDelayMs = Number.isFinite(rateLimit?.delayMs) && rateLimit.delayMs > 0
	                            ? rateLimit.delayMs
	                            : (Number(CONFIG.CONNECTION.RATE_LIMIT_RETRY_MS) || 300000);

	                        if (this.shouldFallbackAfterRateLimit()) {
	                            const fallbackError = new Error('SSAPP_TIKTOK_FALLBACK: TikTok rate limited. Switching to legacy connector.');
	                            fallbackError.code = 'SSAPP_TIKTOK_RATE_LIMIT_FALLBACK';
	                            fallbackError.ssappFallback = true;
	                            fallbackError.ssappFallbackMode = 'polling';
	                            fallbackError.ssappFallbackMessage = 'TikTok rate limited. Switching to legacy connector.';
	                            const fallbackHandled = await this.tryFallbackToPolling(fallbackError, 'rate_limit');
	                            if (fallbackHandled) {
	                                return this.restartConnectionAttempt(fallbackError);
	                            }
	                        }

	                        this.offlineRetry = false;
	                        this.offlineRetryCount = 0;
	                        this.offlineReason = 'Rate limited by TikTok';
	                        this.attemptReconnect(retryDelayMs, { fixed: true, offline: false, immediate: true, reason: this.offlineReason });
	                    } else if (isOffline) {
	                        if (!this.offlineRetry) {
	                            this.offlineRetryCount = 0;
	                        }
                        this.offlineRetry = true;
                        this.offlineReason = this.buildOfflineReason(userFacingMessage || 'User is not live');
                        this.attemptReconnect(CONFIG.CONNECTION.OFFLINE_RETRY_INTERVAL_MS, { fixed: true, offline: true });
                    } else {
                        this.offlineRetry = false;
                        this.offlineRetryCount = 0;
                        this.offlineReason = null;
                        this.attemptReconnect();
                    }
                }
                return false;
            }
        };

        const connectPromise = runConnect();
        if (!bypassActivePromise) {
            this.activeConnectPromise = connectPromise;
            connectPromise.finally(() => {
                if (this.activeConnectPromise === connectPromise) {
                    this.activeConnectPromise = null;
                }
            }).catch(() => { });
        }
        return connectPromise;
    }

    logConsoleFailure(userMessage, primaryError) {
        if (userMessage) {
            console.error('Connection failed:', userMessage);
        } else {
            console.error('Connection failed');
        }

        if (!primaryError) {
            return;
        }

        const detail = this.truncateForLog(primaryError.message || '', 600);
        if (detail && detail !== userMessage) {
            console.error('Connection failure detail:', detail);
        }

        if (primaryError.stack) {
            const stackSnippet = this.truncateForLog(primaryError.stack, 800);
            if (stackSnippet && stackSnippet !== detail && !/<html/i.test(stackSnippet)) {
                console.error(stackSnippet);
            }
        }
    }

    truncateForLog(text, maxLength = 600) {
        if (!text || typeof text !== 'string') return '';
        const trimmed = text.trim();
        if (!trimmed) return '';
        if (trimmed.length > maxLength) {
            return trimmed.slice(0, maxLength) + '…';
        }
        return trimmed;
    }

    getSigningServiceHelpMessage() {
        const base = 'Sign in failed. Get an API key to use the Euler signing service';
        if (SIGNING_SERVICE_HELP_URL) {
            return `${base}: ${SIGNING_SERVICE_HELP_URL}`;
        }
        return `${base}.`;
    }

    hasUserProvidedSigningApiKey() {
        return typeof this.userProvidedSigningApiKey === 'string' && this.userProvidedSigningApiKey.trim().length > 0;
    }

    buildSharedEulerApiKeyPool() {
        const pool = [];
        const seen = new Set();
        const addCandidate = (rawKey, label, scope) => {
            if (typeof rawKey !== 'string') {
                return;
            }
            const key = rawKey.trim();
            if (!key || seen.has(key)) {
                return;
            }
            seen.add(key);
            pool.push({
                key,
                label,
                scope
            });
        };
        addCandidate(SHARED_EULER_SIGNING_FALLBACK_KEY, 'shared Euler signing key', 'signing');
        addCandidate(SHARED_EULER_PROXY_FALLBACK_KEY, 'shared Euler proxy key', 'proxy');
        return pool;
    }

    resolveSharedEulerScope() {
        if (this.signingProvider === EULER_WS_PROVIDER || this.autoEulerProxyFallbackActive) {
            return 'proxy';
        }
        if (this.signingProvider === 'auto' || this.autoLocalSignerFallbackActive) {
            return 'signing';
        }
        return null;
    }

    getNextSharedEulerApiKeyCandidate(scope = null) {
        if (!Array.isArray(this.sharedEulerApiKeyPool) || !this.sharedEulerApiKeyPool.length) {
            return null;
        }
        for (const candidate of this.sharedEulerApiKeyPool) {
            if (!candidate || typeof candidate.key !== 'string') {
                continue;
            }
            if (scope && candidate.scope !== scope) {
                continue;
            }
            if (!this.sharedEulerApiKeyAttempts || !this.sharedEulerApiKeyAttempts.has(candidate.key)) {
                return candidate;
            }
        }
        return null;
    }

    hasExhaustedSharedEulerApiKeys(scope = null) {
        if (this.hasUserProvidedSigningApiKey()) {
            return false;
        }
        const poolSize = Array.isArray(this.sharedEulerApiKeyPool)
            ? this.sharedEulerApiKeyPool.filter(candidate => !scope || candidate.scope === scope).length
            : 0;
        if (!poolSize) {
            return false;
        }
        const attempts = Array.isArray(this.sharedEulerApiKeyPool) && this.sharedEulerApiKeyAttempts
            ? this.sharedEulerApiKeyPool.filter(candidate => (!scope || candidate.scope === scope) && this.sharedEulerApiKeyAttempts.has(candidate.key)).length
            : 0;
        return attempts >= poolSize;
    }

    isLocalSignerRateLimit(primaryError) {
        const errorName = typeof primaryError?.name === 'string'
            ? primaryError.name.toLowerCase()
            : '';
        if (errorName === 'tiktokratelimiterror') {
            return true;
        }
        const source = typeof primaryError?.source === 'string'
            ? primaryError.source.toLowerCase()
            : '';
        return source.includes('local_signer');
    }

    shouldTrySharedEulerApiKeyForRateLimit(primaryError, rawMessage = '') {
        if (!(this.signingProvider === 'auto' || this.signingProvider === EULER_WS_PROVIDER)) {
            return false;
        }
        if (this.hasUserProvidedSigningApiKey()) {
            return false;
        }
        if (!this.isRateLimitError(primaryError, rawMessage)) {
            return false;
        }
        if (this.isLocalSignerRateLimit(primaryError)) {
            return false;
        }
        const scope = this.resolveSharedEulerScope();
        if (!scope) {
            return false;
        }
        return !!this.getNextSharedEulerApiKeyCandidate(scope);
    }

    shouldTrySharedEulerApiKeyForEulerWsClose(code) {
        if (this.signingProvider !== EULER_WS_PROVIDER) {
            return false;
        }
        if (this.hasUserProvidedSigningApiKey()) {
            return false;
        }
        if (!(code === 4401 || code === 4429)) {
            return false;
        }
        return !!this.getNextSharedEulerApiKeyCandidate('proxy');
    }

    hasPendingAutoFallbackOptions() {
        const isAutoFlow = this.signingProvider === 'auto'
            || this.autoEulerProxyFallbackActive
            || this.autoLocalSignerFallbackActive;
        if (!isAutoFlow) {
            return false;
        }
        const legacyActive = this.pollingFallbackActivated || this.preferredStrategy === 'legacy' || this.connectionStrategy === 'legacy';
        if (legacyActive) {
            return false;
        }
        const canTryEulerProxy = !this.autoEulerProxyFallbackAttempted &&
            !!this.getAutoEulerProxyFallbackKey();
        const canTryLocalSigner = !this.autoLocalSignerFallbackAttempted &&
            !!this.localSigner &&
            typeof this.localSigner.sign === 'function';
        const canTryPolling = !!this.pollingFallbackSupported && !this.pollingFallbackActivated;
        return canTryEulerProxy || canTryLocalSigner || canTryPolling;
    }

    buildSharedEulerRetryNotice(candidate, reason = 'rate_limit', scope = 'signing') {
        const label = candidate?.label || 'shared key';
        if (scope === 'proxy' && reason === 'auth') {
            return `Euler proxy auth failed. Retrying once with ${label}. Add your own free key at ${EULER_DASHBOARD_URL}.`;
        }
        if (scope === 'proxy') {
            return `Euler proxy rate-limited. Retrying once with ${label}. Add your own free key at ${EULER_DASHBOARD_URL}.`;
        }
        return `Euler signing rate-limited. Retrying once with ${label}. Add your own free key at ${EULER_DASHBOARD_URL}.`;
    }

    getEulerApiKeyPromptMessage() {
        if (this.signingProvider === EULER_WS_PROVIDER) {
            return `Euler Proxy retries were exhausted. Options: add a free Euler API key (${EULER_DASHBOARD_URL}), switch to Polling, or use Standard mode. Limits: ${EULER_RATE_LIMITS_URL}.`;
        }
        return `AUTO retries were exhausted. Options: switch to Local Signer, add a free Euler API key (${EULER_DASHBOARD_URL}), use Euler Proxy, switch to Polling, or use Standard mode. Limits: ${EULER_RATE_LIMITS_URL}.`;
    }

    shouldPromptForEulerApiKey(primaryError, rawMessage = '') {
        if (this.hasUserProvidedSigningApiKey()) {
            return false;
        }
        if (!(this.signingProvider === 'auto' || this.signingProvider === EULER_WS_PROVIDER)) {
            return false;
        }
        const scope = this.resolveSharedEulerScope();
        if (!scope) {
            return false;
        }
        if (!this.hasExhaustedSharedEulerApiKeys(scope)) {
            return false;
        }
        if (this.isLocalSignerRateLimit(primaryError)) {
            return false;
        }
        if (this.hasPendingAutoFallbackOptions()) {
            return false;
        }
        const combined = `${rawMessage || ''} ${primaryError?.message || ''}`.toLowerCase();
        if (this.isRateLimitError(primaryError, combined)) {
            return true;
        }
        if (this.signingProvider === EULER_WS_PROVIDER) {
            const statusCode = Number(
                primaryError?.status
                ?? primaryError?.statusCode
                ?? primaryError?.response?.status
                ?? primaryError?.response?.statusCode
                ?? NaN
            );
            if ([401, 403].includes(statusCode)) {
                return true;
            }
            if (combined.includes('4401') || combined.includes('invalid auth') || combined.includes('invalid api key')) {
                return true;
            }
        }
        return false;
    }

    async trySharedEulerApiKeyRetry(stage = 'connect', options = {}) {
        const {
            reason = 'rate_limit',
            primaryError = null,
            rawMessage = '',
            force = false,
            scope = this.resolveSharedEulerScope()
        } = options || {};

        if (!force && !this.shouldTrySharedEulerApiKeyForRateLimit(primaryError, rawMessage)) {
            return false;
        }

        if (!scope) {
            return false;
        }

        const candidate = this.getNextSharedEulerApiKeyCandidate(scope);
        if (!candidate) {
            return false;
        }

        if (!this.sharedEulerApiKeyAttempts) {
            this.sharedEulerApiKeyAttempts = new Set();
        }
        this.sharedEulerApiKeyAttempts.add(candidate.key);

        const serviceUrl = this.signingConfig?.serviceUrl || null;
        this.signingConfig = {
            apiKey: candidate.key,
            serviceUrl
        };

        const retryNotice = this.buildSharedEulerRetryNotice(candidate, reason, scope);
        this.logDebug('lifecycle.signing.sharedEulerRetry.begin', {
            stage,
            reason,
            label: candidate.label || null,
            scope,
            attempt: this.sharedEulerApiKeyAttempts.size
        });
        console.warn(`[TikTok] ${retryNotice}`);
        try {
            emitStatus({
                wssID: this.wssID,
                status: 'reconnecting',
                reason: retryNotice,
                signServer: true,
                sharedKeyRetry: true
            });
        } catch (_) { /* renderer may be gone */ }

        try {
            await this.teardownConnection({ silent: true });
        } catch (error) {
            this.logDebug('lifecycle.signing.sharedEulerRetry.teardownError', normalizeForLogging(error));
        }

        try {
            this.initializeConnectionInstance({ forceLegacy: false, context: `shared_euler_key_${stage}` });
        } catch (error) {
            this.logDebug('lifecycle.signing.sharedEulerRetry.instantiateError', normalizeForLogging(error));
            console.error('[TikTok] Failed to initialize connection for shared Euler key retry:', error);
            return false;
        }

        return true;
    }

    isSignServerError(primaryError, rawMessage = '') {
        if (primaryError?.code === 'SSAPP_TIKTOK_EULER_WS_MISSING_KEY') {
            return false;
        }

        const statusCode = Number(
            primaryError?.status
            ?? primaryError?.statusCode
            ?? primaryError?.response?.status
            ?? primaryError?.response?.statusCode
            ?? NaN
        );
        if ([401, 402, 403, 500, 502, 503, 504, 520, 521, 522, 524].includes(statusCode)) {
            return true;
        }

        if (this.isBrokenSignerBootstrapError(primaryError, rawMessage)) {
            return true;
        }

        const reason = typeof primaryError?.reason === 'string'
            ? primaryError.reason.toLowerCase()
            : '';
        if (reason && (
            reason.includes('sign') ||
            reason.includes('premium') ||
            reason.includes('authenticated') ||
            reason.includes('connect error') ||
            reason.includes('empty payload') ||
            reason.includes('empty cookies')
        )) {
            return true;
        }

        const name = typeof primaryError?.name === 'string'
            ? primaryError.name.toLowerCase()
            : '';
        if (name === 'signapierror' ||
            name === 'premiumfeatureerror' ||
            name === 'schemadecodeerror' ||
            name === 'signaturemissingtokenserror' ||
            name === 'authenticatedwebsocketconnectionerror') {
            return true;
        }

        const combined = `${rawMessage || ''} ${primaryError?.message || ''}`.toLowerCase();
        return combined.includes('sign server')
            || combined.includes('signapi')
            || combined.includes('proto messagefetchresult')
            || combined.includes('schema decode')
            || combined.includes('premature eof')
            || combined.includes('forbidden')
            || combined.includes('not authorized')
            || combined.includes('unauthorized')
            || combined.includes('payment required')
            || combined.includes('euler')
            || combined.includes('403')
            || combined.includes('401')
            || combined.includes('connect error')
            || combined.includes('empty payload')
            || combined.includes('empty cookies');
    }

    isBrokenSignerBootstrapError(primaryError, rawMessage = '') {
        const code = typeof primaryError?.code === 'string'
            ? primaryError.code
            : '';
        if (code === 'SSAPP_TIKTOK_WSURL_INVALID' || code === 'SSAPP_TIKTOK_WSURL_MISSING') {
            return true;
        }

        const name = typeof primaryError?.name === 'string'
            ? primaryError.name.toLowerCase()
            : '';
        if (name === 'tiktokwsurlerror') {
            return true;
        }

        const combined = [
            rawMessage,
            primaryError?.message,
            primaryError?.reason,
            ...this.collectNestedErrorMessages(primaryError)
        ]
            .filter(value => typeof value === 'string' && value.trim().length)
            .join('\n')
            .toLowerCase();

        return combined.includes('tiktok returned an invalid websocket url')
            || combined.includes('did not return a websocket url')
            || combined.includes('invalid url: ?version_code=')
            || combined.includes('invalid url: ?aid=')
            || combined.includes('invalid url: ?live_id=')
            || (combined.includes('invalid url: ?') && combined.includes('room_id='));
    }

    collectNestedErrorMessages(primaryError, depth = 0, seen = new Set(), messages = []) {
        if (!primaryError || typeof primaryError !== 'object' || depth > 3 || seen.has(primaryError)) {
            return messages;
        }
        seen.add(primaryError);

        for (const candidate of [primaryError.message, primaryError.info, primaryError.reason]) {
            if (typeof candidate === 'string' && candidate.trim().length) {
                messages.push(candidate.trim());
            }
        }

        if (Array.isArray(primaryError.errors)) {
            for (const nestedError of primaryError.errors) {
                this.collectNestedErrorMessages(nestedError, depth + 1, seen, messages);
            }
        }

        return messages;
    }

    deriveNestedUserFriendlyErrorMessage(primaryError) {
        const nestedMessages = this.collectNestedErrorMessages(primaryError);
        if (!nestedMessages.length) {
            return '';
        }

        const combined = nestedMessages.join('\n').toLowerCase();
        if (combined.includes('user_not_found') || combined.includes("user doesn't exist")) {
            return 'TikTok user not found. Check the username and try again.';
        }

        if (combined.includes("isn't online") || combined.includes('not currently live') || combined.includes('stream ended')) {
            return 'The requested user is not live right now.';
        }

        if (combined.includes('failed to retrieve room id') ||
            combined.includes('failed to extract room id') ||
            combined.includes('liveroomuserinfo')) {
            return 'Unable to resolve the TikTok room. The username may be wrong, the stream may be offline, or TikTok blocked the lookup.';
        }

        return nestedMessages[0];
    }

    getUserFriendlyErrorMessage(primaryError, fallbackMessage = '') {
        const candidates = [
            fallbackMessage,
            primaryError?.message,
            primaryError?.info,
            this.deriveNestedUserFriendlyErrorMessage(primaryError)
        ];
        let message = '';
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim().length) {
                message = candidate.trim();
                break;
            }
        }

        if (!message) {
            return 'Connection failed';
        }

        const firstLine = message.split(/\r?\n/).find(line => line.trim().length) || message;
        const normalized = firstLine.toLowerCase();

        const isPremiumError = primaryError && primaryError.name === 'PremiumFeatureError';
        const isSignRateLimited = primaryError && primaryError.name === 'SignatureRateLimitError';
        const mentionsPaywall = normalized.includes('payment required') || normalized.includes('premium feature');

        if (this.sessionId && (isPremiumError || isSignRateLimited || mentionsPaywall)) {
            return this.getSigningServiceHelpMessage();
        }

        if (this.shouldPromptForEulerApiKey(primaryError, normalized)) {
            return this.getEulerApiKeyPromptMessage();
        }

        if (this.isBrokenSignerBootstrapError(primaryError, message)) {
            return 'TikTok returned invalid websocket bootstrap data. Trying another mode may help.';
        }

        if (normalized.includes('unexpected sign server status 524') || normalized.includes('524: a timeout occurred')) {
            return 'Euler sign server timed out (524). Please try again later or switch TikTok to standard mode.';
        }

        if (normalized.includes('failed to connect to sign server') || normalized.includes('connect error')) {
            return 'Unable to reach the Euler sign server. Please try again shortly.';
        }

        if (normalized.includes('403') || normalized.includes('forbidden') || normalized.includes('unauthorized')) {
            return 'Euler signing was rejected (403). Try Local Signer, Polling, or Standard mode.';
        }

        if (normalized.includes('timeout') || primaryError?.code === 'ECONNABORTED') {
            return 'Sign server request timed out. Please try again shortly.';
        }

        if (/<html/i.test(message)) {
            return 'Sign server returned an HTML error page. Please try again in a moment.';
        }

        if (firstLine.length > 320) {
            return firstLine.slice(0, 320) + '…';
        }

        return firstLine;
    }

    isFatalLookupError(primaryError, rawMessage = '', userFacingMessage = '') {
        const combined = [
            rawMessage,
            userFacingMessage,
            primaryError?.message,
            primaryError?.info,
            primaryError?.reason,
            this.deriveNestedUserFriendlyErrorMessage(primaryError)
        ]
            .filter(value => typeof value === 'string' && value.trim().length)
            .join('\n')
            .toLowerCase();

        if (!combined) {
            return false;
        }

        return combined.includes('user_not_found')
            || combined.includes("user doesn't exist")
            || combined.includes('tiktok user not found')
            || combined.includes('failed to retrieve room_id')
            || combined.includes('failed to retrieve room id');
    }

    handleConnect() {
        const existingState = connectionStates.get(this.wssID);
        if (existingState?.isConnected && !existingState?.attemptInProgress) {
            this.logDebug('control.connected.duplicateIgnored', {
                connectionMethod: this.getConnectionModeDetails().method
            });
            return;
        }
        const modeDetails = this.getConnectionModeDetails();
        const connectionLabel = modeDetails.label || 'Websocket connected';
        console.info(`${connectionLabel}, starting health check`);
        connectionStates.set(this.wssID, {
            isConnected: true,
            lastAttempt: Date.now(),
            isReconnecting: false,
            attemptInProgress: false
        });
        this.clearPendingStreamEndConfirmation('connected');
        this.lastMessageTime = Date.now();
        this.startHealthCheck();
        this.startViewerUpdateInterval();
        this.reconnectAttempts = 0;
        this.lastConnectTimestamp = Date.now();
        this.offlineRetry = false;
        this.offlineRetryCount = 0;
        this.offlineReason = null;

        if (Number.isFinite(this.signRequestTimeoutBaseMs) && this.signRequestTimeoutBaseMs > 0 && this.signRequestTimeoutMs !== this.signRequestTimeoutBaseMs) {
            const previousTimeout = this.signRequestTimeoutMs;
            this.applySignRequestTimeout(this.signRequestTimeoutBaseMs);
            this.logDebug('sign.timeout.reset', {
                previousTimeoutMs: previousTimeout,
                baseTimeoutMs: this.signRequestTimeoutBaseMs
            });
        }

        emitStatus({
            wssID: this.wssID,
            status: 'connected',
            hasSession: !!this.sessionId,
            effectiveMode: modeDetails.effectiveMode,
            connectionLabel,
            connectionMethod: modeDetails.method
        });
    }

    handleDisconnect(disconnectInfo = null) {
        const code = disconnectInfo?.code;
        const codeLabel = disconnectInfo?.codeLabel || '';
        
        // For EulerWS close codes, provide actionable guidance
        const isEulerWs = this.signingProvider === EULER_WS_PROVIDER;
        if (isEulerWs && code) {
            const guidance = {
                4404: 'The streamer is not currently live.',
                4401: 'Invalid API key or JWT. Check your Euler credentials.',
                4429: 'Too many connections or connecting too quickly. Check rate limits.',
                4403: 'JWT does not have permission for this creator.',
                4400: 'Invalid uniqueId or connection options.',
                4556: 'Euler failed to fetch TikTok webcast data.',
                4557: 'Euler failed to fetch room info for this streamer.',
                4005: 'The TikTok stream ended normally.',
                4006: 'No messages received - connection timed out.',
                4500: 'TikTok closed the connection unexpectedly.',
                4555: 'WebSocket exceeded 8-hour lifetime limit.',
                1011: 'Internal server error on Euler side.'
            };
            if (guidance[code]) {
                console.warn(`[EulerWS] ${guidance[code]}`);
            }
            // Report actionable/unexpected close codes (skip normal terminations)
            const SKIP_CODES = new Set([1000, 4005, 4006, 4404, 4555]);
            if (code && !SKIP_CODES.has(code)) {
                reporter.report('tiktok_ws_close', `TikTok WebSocket closed: ${code} (${codeLabel})`, {
                    code,
                    codeLabel,
                    reason: disconnectInfo?.reason || '',
                    signingProvider: this.signingProvider,
                });
            }
        }

        this.replayActive = false;
        connectionStates.set(this.wssID, {
            isConnected: false,
            lastAttempt: Date.now(),
            isReconnecting: false,
            attemptInProgress: false
        });
        if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
        if (this.viewerUpdateInterval) clearInterval(this.viewerUpdateInterval);

        if (!this.isStopped) {
            const canTrySharedEulerWsKey = this.shouldTrySharedEulerApiKeyForEulerWsClose(code);
            if (canTrySharedEulerWsKey) {
                const retryReason = code === 4401 ? 'auth' : 'rate_limit';
                const syntheticError = {
                    status: code === 4429 ? 429 : 401,
                    message: codeLabel || ''
                };
                this.trySharedEulerApiKeyRetry(`disconnect_${code}`, {
                    reason: retryReason,
                    primaryError: syntheticError,
                    rawMessage: codeLabel || '',
                    force: true,
                    scope: 'proxy'
                })
                    .then((handled) => {
                        if (handled) {
                            return this.restartConnectionAttempt(syntheticError);
                        }
                        return null;
                    })
                    .catch(() => null);
                return;
            }
            const shouldTryAutoFallback = this.autoEulerProxyFallbackActive && (code === 4401 || code === 4429);
            if (shouldTryAutoFallback) {
                this.tryAutoFallbacksBeforePrompt(
                    { message: codeLabel || disconnectInfo?.reason || 'Euler proxy connection failed.' },
                    `disconnect_${code}_auto`
                )
                    .then((handled) => {
                        if (handled) {
                            return this.restartConnectionAttempt();
                        }
                        return null;
                    })
                    .catch(() => null);
                return;
            }

            // For certain codes, don't auto-reconnect (no point)
            const noReconnectCodes = [4401, 4403];
            const shouldSkipReconnect = isEulerWs && code && noReconnectCodes.includes(code);
            const shouldRetryAsOffline = isEulerWs && (code === 4404 || code === 4005);
            
            emitStatus({
                wssID: this.wssID,
                status: 'disconnected',
                disconnectCode: code || null,
                disconnectReason: codeLabel || null
            });

            if (shouldRetryAsOffline) {
                const offlineMessage = code === 4404
                    ? 'The requested user is not live right now.'
                    : 'Live stream has ended';
                console.info(`[EulerWS] ${offlineMessage} Scheduling offline retry.`);
                this.enterOfflineRetryMode(offlineMessage);
            } else if (shouldSkipReconnect) {
                console.warn(`[EulerWS] Skipping auto-reconnect due to terminal close code ${code} (${codeLabel})`);
                // Emit error so UI shows the issue
                emitStatus({
                    wssID: this.wssID,
                    status: 'error',
                    error: `Euler WS: ${codeLabel}${code === 4404 ? ' - streamer is offline' : ''}`
                });
            } else {
                // Detect rapid connect/disconnect cycles (TikTok accepting then killing connection)
                const rapidThreshold = CONFIG.CONNECTION.RAPID_DISCONNECT_THRESHOLD_MS || 60000;
                const rapidLimit = CONFIG.CONNECTION.RAPID_DISCONNECT_STRIKE_LIMIT || 3;
                const connectionDuration = this.lastConnectTimestamp ? (Date.now() - this.lastConnectTimestamp) : Infinity;

                if (connectionDuration < rapidThreshold) {
                    this.rapidDisconnectCount = (this.rapidDisconnectCount || 0) + 1;
                } else {
                    this.rapidDisconnectCount = 0;
                }

                if (this.rapidDisconnectCount >= rapidLimit) {
                    console.warn(`[TikTok] Connection dropped ${this.rapidDisconnectCount} times within ${Math.round(rapidThreshold / 1000)}s each. Trying alternative mode.`);
                    this.rapidDisconnectCount = 0;
                    const syntheticError = { message: 'Connection repeatedly dropped. Trying alternative mode.' };
                    this.tryAutoFallbacksBeforePrompt(syntheticError, 'disconnect_rapid_cycle')
                        .then((handled) => {
                            if (handled) {
                                return this.restartConnectionAttempt();
                            }
                            if (!this.pollingFallbackActivated) {
                                return this.tryFallbackToPolling(syntheticError, 'disconnect_rapid_cycle_polling')
                                    .then((pollingHandled) => {
                                        if (pollingHandled) {
                                            return this.restartConnectionAttempt();
                                        }
                                        this.attemptReconnect();
                                        return null;
                                    });
                            }
                            this.attemptReconnect();
                            return null;
                        })
                        .catch(() => {
                            this.attemptReconnect();
                        });
                    return;
                }

                this.attemptReconnect();
            }
        }
    }

    async handleError(err) {
        if (this.isStopped) return;

        const infoText = typeof err?.info === 'string' ? err.info : '';
        const primaryError = err instanceof Error ? err : (err?.exception instanceof Error ? err.exception : err);
        const errorName = primaryError && primaryError.name;
        const msg = primaryError && primaryError.message ? primaryError.message : '';
        const connectionState = connectionStates.get(this.wssID);
        const connectAttemptInProgress = !!connectionState?.attemptInProgress;
        if (connectAttemptInProgress && !connectionState?.isConnected) {
            this.logDebug('control.error.deferredToConnect', {
                errorName: primaryError?.name || null,
                message: msg || null,
                info: infoText || null
            });
            return null;
        }
        const handledReconnectPromise = this.getFallbackReconnectPromise(primaryError);
        if (this.hasFallbackTransitionStarted(primaryError)) {
            this.logDebug('control.error.fallbackTransitionHandled', {
                transition: primaryError?.__ssappTikTokFallbackTransitionStarted || null,
                message: msg || null
            });
            return handledReconnectPromise || null;
        }
        const errorMessageCandidates = [
            msg,
            infoText,
            typeof err?.message === 'string' ? err.message : '',
            typeof primaryError?.cause?.message === 'string' ? primaryError.cause.message : ''
        ];
        const rawErrorMessage = errorMessageCandidates.find(value => typeof value === 'string' && value.trim().length) || '';

        if (rawErrorMessage && /failed to decode message type/i.test(rawErrorMessage)) {
            const truncatedDetail = this.truncateForLog(rawErrorMessage, 400);
            const messageTypeMatch = rawErrorMessage.match(/Failed to decode message type:\s*([^:\s]+)/i);
            const messageType = messageTypeMatch ? messageTypeMatch[1] : null;

            const logPieces = ['[TikTok] Ignoring decode error'];
            if (messageType) logPieces.push(`(${messageType})`);
            logPieces.push(truncatedDetail);
            console.warn(logPieces.join(' '));
            this.logDebug('control.error.ignoredDecode', {
                info: infoText || null,
                errorName: primaryError?.name || null,
                messageType: messageType || null,
                detail: truncatedDetail
            });
            return;
        }

        if (infoText) {
            const normalizedInfo = infoText.toLowerCase();
            if (normalizedInfo.includes('falling back')) {
                console.info('TikTok connection fallback:', infoText);
                this.logDebug('control.error.fallbackNotice', {
                    info: infoText,
                    message: msg || null
                });
                return;
            }
        }

        if (errorName === 'AlreadyConnectingError') {
            console.warn('TikTok connection already in progress; ignoring duplicate error event');
            this.logDebug('control.error.alreadyConnecting', {
                info: infoText || null,
                message: msg || null
            });
            return;
        }

        const combinedMessage = msg || infoText || '';
        const userFacingMessage = this.getUserFriendlyErrorMessage(primaryError, combinedMessage);
        const isRateLimited = this.isRateLimitError(primaryError, combinedMessage);
        const isSignServerIssue = !isRateLimited && this.isSignServerError(primaryError, combinedMessage);
        const offlineMessage = combinedMessage || userFacingMessage || (primaryError && primaryError.reason) || '';
        const isOffline = this.isOfflineError(primaryError, offlineMessage);
        if (isRateLimited) {
            const localFirstHandled = await this.tryAutoFallbacksBeforePrompt(primaryError, 'error_rate_limit_local_first', {
                includeLocal: true,
                includeProxy: false,
                includePolling: false
            });
            if (localFirstHandled) {
                return this.restartConnectionAttempt(primaryError);
            }
        }
        const canTrySharedEulerKey = this.shouldTrySharedEulerApiKeyForRateLimit(primaryError, combinedMessage);
        if (canTrySharedEulerKey) {
            const sharedRetryHandled = await this.trySharedEulerApiKeyRetry('error_rate_limit', {
                reason: 'rate_limit',
                primaryError,
                rawMessage: combinedMessage
            });
            if (sharedRetryHandled) {
                return this.restartConnectionAttempt(primaryError);
            }
        }
        if (isRateLimited) {
            const proxyThenPollingHandled = await this.tryAutoFallbacksBeforePrompt(primaryError, 'error_rate_limit_after_shared', {
                includeLocal: false,
                includeProxy: true,
                includePolling: true
            });
            if (proxyThenPollingHandled) {
                return this.restartConnectionAttempt(primaryError);
            }
        }

        // Sign server errors (403, unauthorized, etc.) - try auto fallback chain
        // Mirrors the fallback logic in connect() for mid-session sign server failures
        if (isSignServerIssue) {
            this.signServerFailureCount = (this.signServerFailureCount || 0) + 1;
            const localFallbackHandled = await this.tryFallbackToLocalSigner(primaryError, 'error_sign_server_local');
            if (localFallbackHandled) {
                return this.restartConnectionAttempt(primaryError);
            }
            const proxyFallbackHandled = await this.tryFallbackToEulerProxy(primaryError, 'error_sign_server_proxy');
            if (proxyFallbackHandled) {
                return this.restartConnectionAttempt(primaryError);
            }
            const immediateBootstrapFallback = this.isBrokenSignerBootstrapError(primaryError, combinedMessage);
            const fallbackThresholdReached = immediateBootstrapFallback
                || this.signServerFailureCount >= SIGN_SERVER_FAILURE_FALLBACK_THRESHOLD;
            if (fallbackThresholdReached && !this.pollingFallbackActivated) {
                const fallbackStage = immediateBootstrapFallback
                    ? 'error_sign_server_bootstrap'
                    : 'error_sign_server_threshold';
                const pollingHandled = await this.tryFallbackToPolling(primaryError, fallbackStage);
                if (pollingHandled) {
                    return this.restartConnectionAttempt(primaryError);
                }
            }
        }

        this.logDebug('control.error.processed', {
            info: infoText || null,
            errorName: primaryError?.name || null,
            errorReason: primaryError?.reason || null,
            rawMessage: msg || null,
            userMessage: userFacingMessage,
            offline: isOffline
        });

        this.logConsoleFailure(userFacingMessage, primaryError instanceof Error ? primaryError : null);

	        // Check if error is fatal
	        const isLikelyFatal = msg && (
	            msg.includes("User doesn't exist") ||
	            msg.includes('Failed to retrieve room_id')
	        );
	        if (!isRateLimited && (this.tiktokRateLimitCount || 0) > 0) {
	            this.tiktokRateLimitCount = 0;
	            this.tiktokRateLimitLastAt = 0;
	        }
	        if (isLikelyFatal) {
	            this.handleFatalError(primaryError || err);
	            return;
	        }

        connectionStates.set(this.wssID, {
            isConnected: false,
            lastAttempt: Date.now(),
            isReconnecting: false,
            attemptInProgress: false
        });

        try {
            emitStatus({
                wssID: this.wssID,
                status: 'error',
                error: userFacingMessage
            });
        } catch (sendErr) {
            console.warn('Failed to send TikTok error status to renderer:', sendErr);
        }

	        if (!this.isStopped) {
	            if (isRateLimited) {
	                const rateLimit = this.registerTikTokRateLimit(primaryError, 'error');
	                const retryDelayMs = Number.isFinite(rateLimit?.delayMs) && rateLimit.delayMs > 0
	                    ? rateLimit.delayMs
	                    : (Number(CONFIG.CONNECTION.RATE_LIMIT_RETRY_MS) || 300000);

	                if (!this.activeConnectPromise && this.shouldFallbackAfterRateLimit()) {
	                    const fallbackError = new Error('SSAPP_TIKTOK_FALLBACK: TikTok rate limited. Switching to legacy connector.');
	                    fallbackError.code = 'SSAPP_TIKTOK_RATE_LIMIT_FALLBACK';
	                    fallbackError.ssappFallback = true;
	                    fallbackError.ssappFallbackMode = 'polling';
	                    fallbackError.ssappFallbackMessage = 'TikTok rate limited. Switching to legacy connector.';
	                    this.tryFallbackToPolling(fallbackError, 'rate_limit')
	                        .then((handled) => {
	                            if (handled) {
	                                return this.restartConnectionAttempt(fallbackError);
	                            }
	                            return null;
	                        })
	                        .catch(() => null);
	                    return;
	                }

	                this.offlineRetry = false;
	                this.offlineRetryCount = 0;
	                this.offlineReason = 'Rate limited by TikTok';
	                this.attemptReconnect(retryDelayMs, { fixed: true, offline: false, immediate: true, reason: this.offlineReason });
	            } else if (isOffline) {
	                if (!this.offlineRetry) {
	                    this.offlineRetryCount = 0;
	                }
                this.offlineRetry = true;
                this.offlineReason = this.buildOfflineReason(userFacingMessage || 'User is not live');
                this.attemptReconnect(CONFIG.CONNECTION.OFFLINE_RETRY_INTERVAL_MS, { fixed: true, offline: true });
            } else {
                this.offlineRetry = false;
                this.offlineRetryCount = 0;
                this.offlineReason = isSignServerIssue ? userFacingMessage : null;
                this.attemptReconnect();
            }
        }
    }

    handleStreamEnd() {
        console.info('Stream ended');
        this.clearPendingStreamEndConfirmation('confirmed');
        this.replayActive = false;
        this.resumeCursorState = null;
        this.previousRoomId = null;
        // Broadcast zero viewers when the stream ends so overlays reset
        this.lastViewerCount = 0;
        if (isViewerUpdateAllowed()) {
            try {
                sendToBackground({
                    meta: 0,
                    type: "tiktok",
                    event: "viewer_update",
                    tid: this.virtualTabId
                });
            } catch (error) {
                console.error('Failed to send final TikTok viewer update:', error);
            }
        }
        // Treat stream end as offline and keep retrying periodically
        if (!this.isStopped) {
            this.enterOfflineRetryMode('Live stream has ended');
        }
    }

    disconnect() {
        this.isStopped = true;
        this.clearPendingStreamEndConfirmation('disconnect');
        if (this.connection) {
            this.connection.disconnect();
            this.connection.removeAllListeners();
        }
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        if (this.viewerUpdateInterval) {
            clearInterval(this.viewerUpdateInterval);
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        // Clear orphaned gift streak timers to prevent ghost data after disconnect
        if (this.giftProcessor && this.giftProcessor.streaks instanceof Map) {
            for (const [, streak] of this.giftProcessor.streaks) {
                if (streak.timer) clearTimeout(streak.timer);
            }
            this.giftProcessor.streaks.clear();
        }
        if (this.recentEventDedupes instanceof Map) {
            this.recentEventDedupes.clear();
        }
        this.nextEventDedupePruneAt = 0;
        this.offlineRetry = false;
        this.offlineRetryCount = 0;
        this.offlineReason = null;
        this.resetGoalAggregates({ flush: false });
        this.logDebug('lifecycle.disconnect', { method: 'disconnect()' });
        this.closeLogWriter('disconnect');
    }

    forceReconnect() {
        console.info('Force reconnecting...');
        try {
            this.connection.disconnect();
        } catch (e) {
            console.error('Error during disconnect:', e);
        }
        this.attemptReconnect();
    }

    getOfflineRetrySequence() {
        const sequence = CONFIG.CONNECTION.OFFLINE_RETRY_SEQUENCE_MS;
        if (Array.isArray(sequence) && sequence.length > 0) {
            const normalized = sequence
                .map(value => Number(value))
                .filter(value => Number.isFinite(value) && value > 0);
            if (normalized.length > 0) {
                return normalized;
            }
        }
        const fallback = Number(CONFIG.CONNECTION.OFFLINE_RETRY_INTERVAL_MS);
        return [Number.isFinite(fallback) && fallback > 0 ? fallback : 60000];
    }

	    resolveOfflineReconnectPlan() {
	        const sequence = this.getOfflineRetrySequence();
	        const attemptIndex = Math.max(0, this.offlineRetryCount || 0);
	        const autoActivateEnabled = !!this.autoActivate;
	        const maxAttempts = autoActivateEnabled ? null : sequence.length;

        if (!autoActivateEnabled && attemptIndex >= sequence.length) {
            return {
                shouldRetry: false,
                delay: null,
                attempt: attemptIndex,
                maxAttempts
            };
        }

        const delay = sequence[Math.min(attemptIndex, sequence.length - 1)];
	        return {
	            shouldRetry: true,
	            delay,
	            attempt: attemptIndex + 1,
	            maxAttempts
	        };
	    }

	    isRateLimitError(primaryError, rawMessage = '') {
	        const errorName = typeof primaryError?.name === 'string'
	            ? primaryError.name.toLowerCase()
	            : '';
	        if (errorName === 'tiktokratelimiterror' || errorName === 'signatureratelimiterror') {
	            return true;
	        }

	        const status = primaryError?.status ?? primaryError?.response?.status ?? null;
	        if (Number(status) === 429) {
	            return true;
	        }

	        const combined = `${rawMessage || ''} ${primaryError?.message || ''}`.toLowerCase();
	        if (!combined.trim()) {
	            return false;
	        }

	        return combined.includes('429') ||
	            combined.includes('too many requests') ||
	            combined.includes('too many connections started') ||
	            combined.includes('rate limit') ||
	            combined.includes('rate limited');
	    }

	    getRetryAfterSeconds(primaryError) {
	        const direct = parseRetryAfterSeconds(primaryError?.retryAfterSeconds ?? primaryError?.retryAfter ?? null);
	        if (direct !== null) {
	            return direct;
	        }

	        const headers = primaryError?.headers || primaryError?.response?.headers || primaryError?.fetchResult?.headers || null;
	        return parseRetryAfterSeconds(readHeaderCaseInsensitive(headers, 'retry-after'));
	    }

	    registerTikTokRateLimit(primaryError, context = 'unknown') {
	        const now = Date.now();
	        if (primaryError && typeof primaryError === 'object') {
	            if (primaryError.__ssappTikTokRateLimitHandled) {
	                const existingDelay = Number(primaryError.__ssappTikTokRateLimitDelayMs);
	                return {
	                    count: this.tiktokRateLimitCount || 0,
	                    delayMs: Number.isFinite(existingDelay) ? existingDelay : null,
	                    retryAfterSeconds: this.getRetryAfterSeconds(primaryError)
	                };
	            }
	            primaryError.__ssappTikTokRateLimitHandled = true;
	        }

	        const lastAt = Number(this.tiktokRateLimitLastAt);
	        if (Number.isFinite(lastAt) && lastAt > 0) {
	            const staleWindowMs = 30 * 60 * 1000;
	            if (now - lastAt > staleWindowMs) {
	                this.tiktokRateLimitCount = 0;
	            }
	        }

	        this.tiktokRateLimitCount = Math.max(0, Number(this.tiktokRateLimitCount) || 0) + 1;
	        this.tiktokRateLimitLastAt = now;

	        const retryAfterSeconds = this.getRetryAfterSeconds(primaryError);
	        const defaultBase = 300000;
	        let baseDelayMs = Number(CONFIG.CONNECTION.RATE_LIMIT_RETRY_MS);
	        if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
	            baseDelayMs = defaultBase;
	        }
	        if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
	            baseDelayMs = Math.max(1000, Math.floor((retryAfterSeconds + 2) * 1000));
	        }

	        const minDelayMs = 30000;
	        const exponent = Math.max(0, this.tiktokRateLimitCount - 1);
	        let delayMs = Math.max(minDelayMs, baseDelayMs) * Math.pow(2, exponent);

	        const maxDelayMs = Number(CONFIG.CONNECTION.RATE_LIMIT_RETRY_MAX_MS);
	        if (Number.isFinite(maxDelayMs) && maxDelayMs > 0) {
	            delayMs = Math.min(delayMs, maxDelayMs);
	        }

	        if (primaryError && typeof primaryError === 'object') {
	            primaryError.__ssappTikTokRateLimitDelayMs = delayMs;
	        }

	        this.logDebug('lifecycle.rate_limit.detected', {
	            context,
	            provider: this.signingProvider || null,
	            count: this.tiktokRateLimitCount,
	            retryAfterSeconds: retryAfterSeconds ?? null,
	            delayMs
	        });

	        if (this.shouldUseLocalSigner()) {
	            setLocalSignerCooldown(now + delayMs, 'tiktok_rate_limit');
	        }

	        return {
	            count: this.tiktokRateLimitCount,
	            delayMs,
	            retryAfterSeconds
	        };
	    }

	    shouldFallbackAfterRateLimit() {
	        const thresholdRaw = Number(CONFIG.CONNECTION.RATE_LIMIT_FALLBACK_THRESHOLD);
	        const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? thresholdRaw : 0;
	        if (!threshold) {
	            return false;
	        }
	        const supportsRateLimitFallback = this.shouldUseLocalSigner()
	            || this.signingProvider === 'auto'
	            || this.signingProvider === 'custom'
	            || this.signingProvider === EULER_WS_PROVIDER;
	        if (!supportsRateLimitFallback) {
	            return false;
	        }
	        if ((this.tiktokRateLimitCount || 0) < threshold) {
	            return false;
	        }
	        if (!this.pollingFallbackSupported ||
	            this.pollingFallbackActivated ||
	            this.preferredStrategy === 'legacy' ||
	            this.connectionStrategy === 'legacy') {
	            return false;
	        }
	        return true;
	    }

	    isOfflineError(primaryError, rawMessage = '') {
	        if (primaryError && primaryError.name === 'UserOfflineError') {
	            return true;
	        }
        const message = typeof rawMessage === 'string' ? rawMessage : '';
        if (!message) return false;
        const normalized = message.toLowerCase();
        const offlineIndicators = [
            "isn't online",
            'isnt online',
            'is not online',
            'not online',
            'not currently live',
            'not live',
            'user is not live',
            'user is offline',
            'user offline',
            'offline',
            'live stream has ended',
            'live has ended',
            'live ended',
            'stream has ended'
        ];
        return offlineIndicators.some(token => normalized.includes(token));
    }

    buildOfflineReason(baseMessage = 'User is not live') {
        const method = this.getConnectionMethodForDisplay();
        const normalized = typeof baseMessage === 'string' && baseMessage.trim()
            ? baseMessage.trim()
            : 'User is not live';
        if (method && method !== 'Unknown') {
            return `${normalized} (${method})`;
        }
        return normalized;
    }

    attemptReconnect(delay = CONFIG.CONNECTION.RECONNECT_DELAY, options = {}) {
        const {
            fixed = false,
            offline = false,
            immediate = false,
            silent = false,
            reason = undefined
        } = options || {};

        const isOfflineFlow = !!(offline || this.offlineRetry);

        if (this.isStopped) return;

        // Guard: avoid scheduling duplicate reconnect timers
        const st = connectionStates.get(this.wssID);
        if (this.reconnectTimer || (st && st.isReconnecting)) {
            if (!silent) {
                console.info('Reconnect already scheduled; skipping');
            }
            return;
        }

        // Do not stop on max attempts; retry indefinitely

        this.reconnectAttempts++;

        // Update connection state to prevent cleanup during reconnection
        connectionStates.set(this.wssID, {
            isConnected: false,
            lastAttempt: Date.now(),
            isReconnecting: true,
            attemptInProgress: false
        });

        const reasonForLog = (reason !== undefined) ? reason : (this.offlineReason || null);
        const connectionMethod = this.getConnectionMethodForDisplay();

        // Delay calculation
        let backoffDelay;
        let attemptForStatus = this.reconnectAttempts;
        let maxAttemptsForStatus = undefined;

        if (immediate) {
            backoffDelay = Number.isFinite(delay) ? Math.max(0, delay) : 0;
        } else if (isOfflineFlow) {
            const plan = this.resolveOfflineReconnectPlan();
            if (!plan || !plan.shouldRetry) {
                const exhaustedMessage = reasonForLog
                    ? `${reasonForLog} (offline retries exhausted)`
                    : 'Offline retries exhausted';
                this.logDebug('lifecycle.reconnect.offline_exhausted', {
                    attempt: this.reconnectAttempts,
                    offlineAttempt: this.offlineRetryCount,
                    autoActivate: !!this.autoActivate,
                    reason: reasonForLog || null
                });
                console.warn(`[TikTok] Offline retries exhausted${this.autoActivate ? ' (auto-activate enabled; unexpected path)' : ''}.`);
                connectionStates.set(this.wssID, {
                    isConnected: false,
                    lastAttempt: Date.now(),
                    isReconnecting: false,
                    attemptInProgress: false
                });
                this.offlineRetry = false;
                this.offlineRetryCount = 0;
                this.offlineReason = reasonForLog || this.offlineReason || null;
                try {
                    emitStatus({
                        wssID: this.wssID,
                        status: 'failed',
                        error: exhaustedMessage,
                        offline: true,
                        connectionMethod
                    });
                } catch (_) { /* renderer might be gone */ }
                return;
            }
            backoffDelay = plan.delay;
            attemptForStatus = plan.attempt;
            maxAttemptsForStatus = plan.maxAttempts || undefined;
            this.offlineRetryCount = plan.attempt;
        } else if (fixed) {
            backoffDelay = (typeof delay === 'number' ? delay : CONFIG.CONNECTION.OFFLINE_RETRY_INTERVAL_MS) || CONFIG.CONNECTION.OFFLINE_RETRY_INTERVAL_MS;
        } else {
            // Exponential backoff for transient errors, capped by config
            const base = (typeof delay === 'number' ? delay : CONFIG.CONNECTION.RECONNECT_DELAY) || CONFIG.CONNECTION.RECONNECT_DELAY;
            backoffDelay = Math.min(base * Math.pow(2, this.reconnectAttempts - 1), CONFIG.CONNECTION.MAX_RECONNECT_DELAY_MS);
        }
        // Add jitter to reduce thundering herd when we're not doing an immediate retry
        if (!immediate && !isOfflineFlow) {
            const jitter = CONFIG.CONNECTION.BACKOFF_JITTER || 0;
            if (jitter > 0) {
                const delta = backoffDelay * jitter;
                const min = backoffDelay - delta;
                const max = backoffDelay + delta;
                backoffDelay = Math.max(0, Math.floor(min + Math.random() * (max - min)));
            }
        }

        // Safety: ensure a positive, non-zero delay to avoid edge cases
        if (!Number.isFinite(backoffDelay) || backoffDelay < 0 || (!immediate && backoffDelay <= 0)) {
            backoffDelay = immediate ? 0 : Math.max(1000, CONFIG.CONNECTION.RECONNECT_DELAY);
        }

        const attemptLabel = isOfflineFlow ? `offline-${attemptForStatus}` : `${this.reconnectAttempts}`;
        this.logDebug('lifecycle.reconnect.scheduled', {
            attempt: attemptForStatus,
            totalAttempts: this.reconnectAttempts,
            delayMs: backoffDelay,
            offline: isOfflineFlow,
            reason: reasonForLog,
            silent: !!silent,
            maxAttempts: maxAttemptsForStatus || null
        });
        if (!silent) {
            const seconds = Math.round(backoffDelay / 1000);
            const reasonSuffix = reasonForLog ? ` (reason: ${reasonForLog})` : '';
            const attemptInfo = maxAttemptsForStatus ? `${attemptLabel}/${maxAttemptsForStatus}` : attemptLabel;
            const prefix = isOfflineFlow ? 'Offline retry' : 'Reconnect attempt';
            console.info(`${prefix} ${attemptInfo} - waiting ${seconds}s${reasonSuffix}`);

            // Send reconnection status to the renderer
            try {
                if (getMainWindow() && getMainWindow().webContents) {
                    emitStatus({
                        wssID: this.wssID,
                        status: 'reconnecting',
                        attempt: attemptForStatus,
                        maxAttempts: maxAttemptsForStatus,
                        nextAttemptIn: backoffDelay,
                        reason: reasonForLog || undefined,
                        offline: isOfflineFlow,
                        connectionMethod
                    });
                }
            } catch (sendErr) {
                console.warn('Failed to send reconnect status update:', sendErr);
            }
        }

        // Clear any existing reconnect timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            // Mark the active attempt so cleanup logic does not dispose the manager mid-connect.
            try {
                connectionStates.set(this.wssID, {
                    isConnected: false,
                    lastAttempt: Date.now(),
                    isReconnecting: true,
                    attemptInProgress: true
                });
            } catch (_) { /* noop */ }
            if (!this.isStopped) {
                try {
                    this.logDebug('lifecycle.reconnect.attempt', {
                        attempt: this.reconnectAttempts,
                        offlineAttempt: isOfflineFlow ? attemptForStatus : null,
                        offline: !!this.offlineRetry,
                        reason: this.offlineReason || null
                    });
                    this.connect();
                } catch (e) {
                    console.error('Reconnect attempt threw before promise handling:', e);
                    // If an immediate error occurs synchronously, queue another attempt with base delay
                    this.attemptReconnect(CONFIG.CONNECTION.RECONNECT_DELAY);
                }
            }
        }, backoffDelay);
    }

    pruneRecentEventDedupes(now = Date.now(), force = false) {
        if (!force && this.nextEventDedupePruneAt && now < this.nextEventDedupePruneAt && this.recentEventDedupes.size < TIKTOK_EVENT_DEDUPE_MAX_ENTRIES) {
            return;
        }

        for (const [key, expiresAt] of this.recentEventDedupes.entries()) {
            if (!Number.isFinite(expiresAt) || expiresAt <= now) {
                this.recentEventDedupes.delete(key);
            }
        }

        if (this.recentEventDedupes.size > TIKTOK_EVENT_DEDUPE_MAX_ENTRIES) {
            const trimCount = this.recentEventDedupes.size - TIKTOK_EVENT_DEDUPE_TRIM_TO;
            if (trimCount > 0) {
                const keys = this.recentEventDedupes.keys();
                for (let i = 0; i < trimCount; i += 1) {
                    const next = keys.next();
                    if (next.done) break;
                    this.recentEventDedupes.delete(next.value);
                }
            }
        }

        this.nextEventDedupePruneAt = now + 1000;
    }

    shouldSuppressDuplicateEvent(eventType, data = {}, message = null) {
        const ttlMs = getTikTokEventDedupeWindowMs(eventType);
        if (!ttlMs) {
            return false;
        }

        // Use specialized key builders for chat/gift; generic for everything else
        let dedupeKey;
        if (eventType === 'chat') {
            dedupeKey = buildChatDedupeKey(data);
        } else if (eventType === 'gift') {
            dedupeKey = buildGiftDedupeKey(data);
        } else {
            dedupeKey = buildTikTokEventDedupeKey(eventType, data, message);
        }
        if (!dedupeKey) {
            return false;
        }

        const now = Date.now();
        this.pruneRecentEventDedupes(now);

        const expiresAt = this.recentEventDedupes.get(dedupeKey);
        if (Number.isFinite(expiresAt) && expiresAt > now) {
            this.logDebug('event.suppressed.duplicate', {
                event: eventType,
                key: dedupeKey,
                ttlRemainingMs: Math.max(0, Math.round(expiresAt - now))
            });
            return true;
        }

        this.recentEventDedupes.set(dedupeKey, now + ttlMs);
        if (this.recentEventDedupes.size > TIKTOK_EVENT_DEDUPE_MAX_ENTRIES) {
            this.pruneRecentEventDedupes(now, true);
        }

        return false;
    }

    sendEventMessage(data, eventType, message, extraMeta = {}) {
        // Per-connection reply-only guard
        if (this.replyOnly) {
            return; // do not forward captured events from this connection
        }
        // Gifts are handled separately and always forwarded.
        // For other event types, respect the app-level events capture gate.
        if (!isCaptureEventsEnabled()) {
            return; // drop non-gift events when events capture is disabled
        }

        const canonicalEventType = canonicalizeTikTokEventType(eventType);
        if (!canonicalEventType) {
            return;
        }
        if (canonicalEventType === 'liked' && !isCaptureLikedEventEnabled()) {
            return;
        }
        if (this.shouldSuppressDuplicateEvent(canonicalEventType, data, message)) {
            return;
        }

        const includeChatPayload = typeof message === 'string' && message.trim().length > 0;
        const payload = {
            type: "tiktok",
            event: canonicalEventType,
            tid: this.virtualTabId
        };

        if (includeChatPayload) {
            const identity = extractTikTokIdentity(data);
            const displayName = identity.nickname || identity.uniqueId;
            const avatarUrl = identity.profilePictureUrl
                || normalizeTikTokImageUrl(data?.profilePictureUrl)
                || normalizeTikTokImageUrl(data?.profilePicture)
                || normalizeTikTokImageUrl(data?.user?.profilePictureUrl)
                || normalizeTikTokImageUrl(data?.user?.profilePicture);

            payload.chatmessage = message.trim();
            payload.chatname = displayName || "System";
            payload.chatimg = avatarUrl || null;
            payload.moderator = resolveTikTokModeratorStatus(data);
            payload.membership = resolveTikTokSubscriberStatus(data);
            payload.textonly = isTextOnlyModeEnabled();

            if (identity.uniqueId) {
                payload.userid = identity.uniqueId;
            }

            const rawColor = data?.nameColor || data?.name_color || data?.user?.nameColor;
            if (rawColor) {
                const safeColor = normalizeNameColor(rawColor);
                if (safeColor) {
                    payload.nameColor = safeColor;
                }
            }
        }

        const metaPayload = sanitizeEventMeta({
            eventType: canonicalEventType,
            ...extraMeta
        });
        if (metaPayload) {
            payload.meta = metaPayload;
        }

        sendToBackground(payload);
    }

    shouldAllowEulerChatEndpoint() {
        if (this.shouldUseLocalSigner()) {
            return false;
        }
        const hasApiKey = !!(this.signingConfig && this.signingConfig.apiKey);
        if (this.signingProvider === EULER_WS_PROVIDER && hasApiKey) {
            return true;
        }
        if ((this.signingProvider === 'auto' || this.signingProvider === 'custom') && hasApiKey) {
            return true;
        }
        return false;
    }

    shouldUseDirectChatRoute() {
        if (!this.enableDirectChatRoute) {
            return false;
        }
        if (!(this.connection && this.connection.webClient)) {
            return false;
        }
        if (!this.shouldAllowEulerChatEndpoint() || this.shouldUseLocalSigner()) {
            return true;
        }
        return !!SendRoomChatRoute;
    }

    canUseConnectionChatFallback() {
        return !!(this.connection &&
            typeof this.connection.sendMessage === 'function' &&
            !(this.connection instanceof EulerWebsocketServerConnection));
    }

    ensureDirectChatRoute() {
        if (!this.shouldUseDirectChatRoute()) {
            return null;
        }
        const connection = this.connection;
        if (!connection || !connection.webClient) {
            return null;
        }
        const webClient = connection.webClient;
        if (this.directChatRoute && this.directChatRouteClient === webClient) {
            return this.directChatRoute;
        }
        try {
            this.directChatRoute = new SendRoomChatRoute(webClient);
            this.directChatRouteClient = webClient;
            this.logDebug('chat.send.direct.route_ready', {
                roomId: webClient.roomId || null
            });
            return this.directChatRoute;
        } catch (error) {
            console.warn('Failed to initialize TikTok direct chat route:', error);
            this.logDebug('chat.send.direct.route_error', {
                message: error?.message || String(error)
            });
            this.directChatRoute = null;
            this.directChatRouteClient = null;
            return null;
        }
    }

    async ensureRoomIdForChat() {
        const connectionForFetch = this.connection;
        if (!connectionForFetch) {
            return null;
        }
        if (connectionForFetch.roomId) {
            return connectionForFetch.roomId;
        }
        if (this.pendingRoomIdPromise) {
            try {
                await this.pendingRoomIdPromise;
            } catch (_) {
                return null;
            }
            return this.connection ? this.connection.roomId : null;
        }
        if (typeof connectionForFetch.fetchRoomId !== 'function') {
            return null;
        }
        this.pendingRoomIdPromise = connectionForFetch.fetchRoomId()
            .then((resolvedRoomId) => {
                const normalizedId = resolvedRoomId ? String(resolvedRoomId) : null;
                if (!normalizedId) {
                    return null;
                }
                if (this.connection !== connectionForFetch) {
                    return null;
                }
                connectionForFetch.roomId = normalizedId;
                if (connectionForFetch.webClient) {
                    connectionForFetch.webClient.roomId = normalizedId;
                }
                return normalizedId;
            })
            .catch((error) => {
                console.warn('Failed to fetch TikTok roomId for chat send:', error);
                return null;
            })
            .finally(() => {
                this.pendingRoomIdPromise = null;
            });
        try {
            const resolved = await this.pendingRoomIdPromise;
            if (resolved) {
                return resolved;
            }
        } catch (_) {
            return null;
        }
        return this.connection ? this.connection.roomId : null;
    }

    async sendChatMessageViaWebcastApi(roomId, content) {
        if (shouldLogTikTokDebug()) {
            console.log('[TikTok] sendChatMessageViaWebcastApi called', {
                roomId,
                contentLength: typeof content === 'string' ? content.length : null
            });
        }
        if (!this.connection || !this.connection.webClient || typeof this.connection.webClient.postJsonObjectToWebcastApi !== 'function') {
            console.warn('[TikTok] Direct chat route unavailable: webClient missing or invalid');
            const err = new Error('Direct TikTok chat route unavailable');
            err.routeUnavailable = true;
            throw err;
        }

        const paramsSource = this.connection.webClient.clientParams || {};
        const { room_id: rId, cursor, internal_ext, ...rest } = paramsSource;
        const resolvedRoomId = roomId || rId;
        if (!resolvedRoomId) {
            throw new Error('Unable to resolve TikTok room for chat send');
        }

        const clientTimestamp = Date.now();
        const livePageUrl = `https://www.tiktok.com/@${this.username}/live`;
        const refererUrl = this.lastSignerPayload?.referer
            || this.lastSignerPayload?.activeUrl
            || this.lastSignerPayload?.landingUrl
            || this.lastSignerPayload?.fallbackUrl
            || livePageUrl;
        const rootReferer = this.lastSignerPayload?.rootReferer || 'https://www.tiktok.com/';
        const userAgentHeader = (this.lastSignerPayload && this.buildLocalSignerHeaders(this.lastSignerPayload)['User-Agent'])
            || DEFAULT_TIKTOK_WEB_USER_AGENT;
        const screenHeight = this.lastSignerPayload?.screen_height || rest?.screen_height;
        const screenWidth = this.lastSignerPayload?.screen_width || rest?.screen_width;
        const tzName = this.lastSignerPayload?.tz_name || rest?.tz_name;

        // Build params to mirror browser request as closely as possible
        let requestParams = {
            ...rest,
            channel: 'tiktok_web',
            device_platform: 'web_pc',
            os: 'windows',
            priority_region: this.ttTargetIdc || rest?.priority_region || undefined,
            region: this.ttTargetIdc || rest?.region || undefined,
            browser_name: 'Mozilla',
            browser_platform: 'Win32',
            browser_version: userAgentHeader,
            cookie_enabled: true,
            data_collection_enabled: true,
            focus_state: true,
            is_fullscreen: false,
            is_page_visible: true,
            client_start_timestamp_millisecond: clientTimestamp,
            webcast_language: rest?.webcast_language || rest?.app_language || 'en',
            app_language: rest?.app_language || 'en',
            browser_language: rest?.browser_language || 'en',
            user_is_login: true,
            from_page: rest?.from_page || '',
            history_len: Number.isFinite(rest?.history_len) ? rest.history_len : 5,
            referer: refererUrl,
            root_referer: rest?.root_referer || rootReferer,
            screen_height: screenHeight,
            screen_width: screenWidth,
            tz_name: tzName,
            room_id: resolvedRoomId,
            content
        };
        let requestBody = {
            room_id: resolvedRoomId,
            content,
            emotes_with_index: '',
            input_type: 0,
            client_start_timestamp_millisecond: clientTimestamp
        };
        let headers = this.lastSignerPayload ? this.buildLocalSignerHeaders(this.lastSignerPayload) : {};
        if (!headers['Referer']) headers['Referer'] = livePageUrl;
        if (!headers['Origin']) headers['Origin'] = 'https://www.tiktok.com';
        const cookieSource = headers?.Cookie || this.lastSignerPayload?.allCookies || null;
        const getCookie = (name) => {
            if (!cookieSource || typeof cookieSource !== 'string') return null;
            const match = cookieSource.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
            return match && match[1] ? decodeURIComponent(match[1]) : null;
        };

        if (this.shouldUseLocalSigner()) {
            if (shouldLogTikTokDebug()) {
                console.log('[TikTok] Signing chat message via local signer');
            }
            try {
                const signOptions = {
                    roomId: resolvedRoomId,
                    uniqueId: this.username,
                    sessionId: this.sessionId || undefined,
                    ttTargetIdc: this.ttTargetIdc || undefined,
                    method: 'POST',
                    activeUrl: livePageUrl,
                    landingUrl: livePageUrl
                };

                // Construct the URL to sign
                const baseUrl = 'https://webcast.tiktok.com/webcast/room/chat/';
                const urlObj = new URL(baseUrl);
                Object.entries(requestParams).forEach(([k, v]) => {
                    if (v !== undefined && v !== null) {
                        urlObj.searchParams.append(k, String(v));
                    }
                });

                const signerPayload = await this.localSigner.sign(urlObj.toString(), signOptions);

                if (signerPayload) {
                    if (shouldLogTikTokDebug()) {
                        console.log('[TikTok] Local signer returned payload', summarizeSignerPayload(signerPayload));
                    }
                    if (signerPayload['X-Bogus']) requestParams['X-Bogus'] = signerPayload['X-Bogus'];
                    if (signerPayload['_signature']) requestParams['_signature'] = signerPayload['_signature'];
                    if (signerPayload['msToken']) requestParams['msToken'] = signerPayload['msToken'];
                    if (signerPayload['ms_token']) requestParams['msToken'] = signerPayload['ms_token'];

                    // If using local signer, we MUST send the request from the browser window to avoid
                    // "Premium Feature" errors or empty bodies caused by missing browser context.
                    if (this.shouldUseLocalSigner()) {
                        if (shouldLogTikTokDebug()) {
                            console.log('[TikTok] Executing chat send via local signer window fetch...');
                        }

                        // Reconstruct the full URL with the signed parameters
                        const signedUrlObj = new URL(baseUrl);
                        Object.entries(requestParams).forEach(([k, v]) => {
                            if (v !== undefined && v !== null) {
                                signedUrlObj.searchParams.append(k, String(v));
                            }
                        });

                        const fetchOptions = {
                            url: signedUrlObj.toString(),
                            method: 'POST',
                            body: JSON.stringify(requestBody),
                            headers: {
                                'Content-Type': 'application/json; charset=utf-8',
                                'Referer': livePageUrl, // Explicitly set Referer to the public live page
                                'Origin': 'https://www.tiktok.com'
                            },
                            params: {} // Params are already in the URL
                        };

                        const fetchResult = await this.localSigner.sign(signedUrlObj.toString(), {
                            ...signOptions,
                            performFetch: true,
                            fetchOptions
                        });

                        if (fetchResult && fetchResult.fetchResult) {
                            const { status, bodyBase64, bodyError } = fetchResult.fetchResult;
                            let decodedBody = null;
                            if (bodyBase64) {
                                try {
                                    decodedBody = Buffer.from(bodyBase64, 'base64').toString('utf8');
                                } catch (e) { decodedBody = '[Failed to decode]'; }
                            }

                            let parsedBody = null;
                            if (decodedBody && typeof decodedBody === 'string') {
                                try {
                                    parsedBody = JSON.parse(decodedBody);
                                    if (parsedBody && parsedBody.data && typeof parsedBody.data.message === 'string' && !parsedBody.message) {
                                        parsedBody.message = parsedBody.data.message;
                                    }
                                } catch (e) {
                                    console.warn('[TikTok] Failed to parse chat response JSON:', e?.message || e);
                                }
                            }

                            if (shouldLogTikTokDebug()) {
                                console.log('[TikTok] Local signer fetch completed', {
                                    status,
                                    bodyError,
                                    decodedBodyLength: typeof decodedBody === 'string' ? decodedBody.length : null
                                });
                            }

                            if (status === 200 && parsedBody && typeof parsedBody === 'object') {
                                // Surface the real TikTok payload so callers can detect failures (e.g., not logged in)
                                return parsedBody;
                            }
                            // Empty or unparseable body is treated as failure
                            const errMsg = status === 200
                                ? 'empty_response_body'
                                : `Local signer fetch failed with status ${status}`;
                            throw new Error(errMsg);
                        }
                        throw new Error('Local signer fetch returned no result');
                    }

                    if (signerPayload['X-Gnarly']) requestParams['X-Gnarly'] = signerPayload['X-Gnarly'];

                    // Update headers with fresh signer data
                    const signedHeaders = this.buildLocalSignerHeaders(signerPayload);
                    headers = { ...headers, ...signedHeaders };
                } else {
                    console.warn('[TikTok] Local signer returned empty payload');
                }
            } catch (error) {
                console.warn('[TikTok] Failed to sign chat message via local signer:', error);
                // Fallback to proceeding without fresh signature, though it will likely fail
            }
        } else {
            if (shouldLogTikTokDebug()) {
                console.log('[TikTok] Not using local signer for chat message');
            }
        }

        // Extract verifyFp from cookies if available (matches browser request shape)
        if (!requestParams.verifyFp) {
            const vfp = getCookie('s_v_web_id') || getCookie('verifyFp');
            if (vfp) {
                requestParams.verifyFp = vfp;
            }
        }

        // Pass CSRF token when available (mirrors browser headers)
        const csrfToken = getCookie('csrfToken') || getCookie('tt_csrf_token') || getCookie('tt_csrf_token_v2');
        if (csrfToken && !headers['x-secsdk-csrf-token']) {
            headers['x-secsdk-csrf-token'] = csrfToken;
        }

        const options = headers ? { headers } : undefined;

        // Use axios directly to avoid tiktok-live-connector's wrapper which might be swallowing the response
        try {
            // First, try using the webClient wrapper so we mimic its defaults (cookies, agents, etc.)
            try {
                const wrapped = await this.connection.webClient.postJsonObjectToWebcastApi(
                    'room/chat/',
                    requestParams,
                    requestBody,
                    false,
                    options
                );
                if (wrapped && typeof wrapped === 'object') {
                    return wrapped;
                }
            } catch (wrappedErr) {
                console.warn('[TikTok] webClient room/chat send failed, falling back to direct axios:', wrappedErr?.message || wrappedErr);
            }

            const axios = require('axios');
            if (shouldLogTikTokDebug()) {
                console.log('[TikTok] Sending direct axios request to room/chat/');
            }
            const directResponse = await axios({
                method: 'POST',
                url: 'https://webcast.tiktok.com/webcast/room/chat/',
                params: requestParams,
                headers: {
                    ...headers,
                    'Content-Type': 'application/json'
                },
                data: requestBody,
                withCredentials: true
            });

            if (shouldLogTikTokDebug()) {
                console.log('[TikTok] Direct axios response status:', directResponse.status);
                console.log('[TikTok] Direct axios response type:', typeof directResponse.data);
                console.log('[TikTok] Direct axios content-type:', directResponse.headers ? directResponse.headers['content-type'] : null);
            }
            if (directResponse.data === '' || directResponse.data === null || typeof directResponse.data === 'undefined') {
                console.warn('[TikTok] Direct chat API returned empty body');
                return {
                    status_code: directResponse.status,
                    err_code: -1,
                    status: 'error',
                    message: 'empty_response_body',
                    raw: directResponse.data
                };
            }
            if (directResponse && typeof directResponse.data === 'object' && directResponse.data !== null) {
                return directResponse.data;
            }
            return {
                status_code: directResponse.status,
                err_code: -2,
                status: 'error',
                message: 'unexpected_response_shape',
                raw: directResponse.data
            };

        } catch (err) {
            console.error('[TikTok] Direct axios request failed:', err.message);
            if (err.response) {
                if (shouldLogTikTokDebug()) {
                    console.error('[TikTok] Error response status:', err.response.status);
                    console.error('[TikTok] Error response type:', typeof err.response.data);
                }
            }
            throw err;
        }
    }

    async sendChatMessageViaDirectRoute(content) {
        if (shouldLogTikTokDebug()) {
            console.log('[TikTok] sendChatMessageViaDirectRoute called');
        }
        const allowEulerChat = this.shouldAllowEulerChatEndpoint();
        const preferLocalHttp = !allowEulerChat || this.shouldUseLocalSigner();
        if (shouldLogTikTokDebug()) {
            console.log('[TikTok] Route decision:', {
                allowEulerChat,
                preferLocalHttp,
                shouldUseLocalSigner: this.shouldUseLocalSigner()
            });
        }

        const route = preferLocalHttp ? null : this.ensureDirectChatRoute();
        if (!preferLocalHttp && !route) {
            return {
                success: false,
                error: 'Direct TikTok chat route unavailable',
                routeUnavailable: true
            };
        }
        const roomId = await this.ensureRoomIdForChat();
        if (!roomId) {
            console.warn('Unable to resolve TikTok roomId for direct chat send.');
            this.logDebug('chat.send.direct.missing_room');
            return {
                success: false,
                error: 'Unable to resolve TikTok room for chat send'
            };
        }
        const normalizedRoomId = typeof roomId === 'string' ? roomId : String(roomId);
        try {
            const response = preferLocalHttp
                ? await this.sendChatMessageViaWebcastApi(normalizedRoomId, content)
                : await route.call({
                    roomId: normalizedRoomId,
                    content
                });
            const statusCode = Number.isFinite(response?.status_code) ? response.status_code
                : Number.isFinite(response?.statusCode) ? response.statusCode
                    : null;
            const errCode = Number.isFinite(response?.err_code) ? response.err_code : null;
            const statusFlag = typeof response?.status === 'string' ? response.status.toLowerCase() : null;
            const statusMessage = typeof response?.status_msg === 'string' && response.status_msg.trim()
                ? response.status_msg.trim()
                : typeof response?.statusMessage === 'string' && response.statusMessage.trim()
                    ? response.statusMessage.trim()
                    : typeof response?.message === 'string' && response.message.trim()
                        ? response.message.trim()
                        : null;
            const emptyResponseBody = response?.message === 'empty_response_body' || response?.raw === '' || response === '';
            const hasStructuredResponse = response && typeof response === 'object';
            const isSuccess = preferLocalHttp
                ? hasStructuredResponse &&
                (statusCode === 200 || statusCode === 0 || statusCode === null) &&
                (errCode === null || errCode === 0) &&
                !emptyResponseBody
                : hasStructuredResponse &&
                (statusCode === null || statusCode === 0) &&
                (errCode === null || errCode === 0) &&
                (statusFlag === null || statusFlag === 'success');
            if (!isSuccess) {
                const detail = statusMessage || (emptyResponseBody ? 'empty_response_body' : `TikTok chat API returned status ${statusCode ?? errCode ?? statusFlag ?? 'unknown'}`);
                this.logDebug('chat.send.direct.rejected', {
                    statusCode,
                    errCode,
                    statusFlag,
                    detail,
                    path: preferLocalHttp ? 'webcast_api' : 'connector_route'
                });
                console.warn('TikTok direct chat send rejected:', detail);
                return {
                    success: false,
                    error: detail
                };
            }
            console.log('Message sent to TikTok chat via direct room/chat endpoint.');
            this.logDebug('chat.send.direct.success', {
                roomId: normalizedRoomId,
                path: preferLocalHttp ? 'webcast_api' : 'connector_route'
            });
            return {
                success: true
            };
        } catch (error) {
            const status = typeof error?.response?.status === 'number' ? error.response.status : null;
            const detail = typeof error?.message === 'string' && error.message.trim()
                ? error.message.trim()
                : 'TikTok direct chat send failed';
            const routeUnavailable = !!error?.routeUnavailable;
            this.logDebug('chat.send.direct.error', {
                statusCode: status,
                message: detail,
                path: preferLocalHttp ? 'webcast_api' : 'connector_route',
                routeUnavailable
            });
            console.error('Direct TikTok chat send failed:', error);
            if (status === 401 || status === 403) {
                return {
                    success: false,
                    error: 'TikTok rejected the provided session for chat send',
                    routeUnavailable
                };
            }
            return {
                success: false,
                error: detail,
                routeUnavailable
            };
        }
    }

    async sendChatMessageViaEuler(content) {
        if (this.shouldUseLocalSigner()) {
            return {
                success: false,
                error: 'Euler chat endpoint is disabled while using the local signer'
            };
        }
        const canUseConnectionSend = this.canUseConnectionChatFallback();

        if (canUseConnectionSend) {
            try {
                await this.connection.sendMessage(content);
                console.log('Message sent to TikTok chat via Euler endpoint.');
                return {
                    success: true
                };
            } catch (error) {
                console.error('Failed to send TikTok message via connection:', error);
            }
        }

        const eulerClient = this.getEulerChatClient();
        if (eulerClient) {
            this.applySessionToEulerClient(eulerClient);
            const resolvedRoomId = await this.resolveEulerChatRoomId(eulerClient);
            if (resolvedRoomId) {
                try {
                    await eulerClient.sendRoomChatFromEuler.call({
                        roomId: typeof resolvedRoomId === 'string' ? resolvedRoomId : String(resolvedRoomId),
                        content,
                        sessionId: this.sessionId || undefined,
                        ttTargetIdc: this.ttTargetIdc || undefined
                    });
                    console.log('Message sent to TikTok chat via Euler endpoint.');
                    return { success: true };
                } catch (error) {
                    console.error('Failed to send TikTok message via Euler API:', error);
                    const detail = typeof error?.message === 'string' && error.message.trim()
                        ? error.message.trim()
                        : 'Failed to send message';
                    return {
                        success: false,
                        error: detail
                    };
                }
            }
        }

        if (!this.connection || typeof this.connection.sendMessage !== 'function') {
            return {
                success: false,
                error: 'Euler chat endpoint unavailable for current mode'
            };
        }

        try {
            await this.connection.sendMessage(content);
            console.log('Message sent to TikTok chat via Euler endpoint.');
            return { success: true };
        } catch (error) {
            console.error('Failed to send TikTok message:', error);
            const detail = typeof error?.message === 'string' && error.message.trim()
                ? error.message.trim()
                : 'Failed to send message';
            return {
                success: false,
                error: detail
            };
        }
    }

    async sendChatMessage(message) {
        if (shouldLogTikTokDebug()) {
            console.log('[TikTok] sendChatMessage called', {
                messageLength: typeof message === 'string' ? message.length : null
            });
        }
        if (typeof message !== 'string' || !message.trim()) {
            return {
                success: false,
                error: 'Message must be a non-empty string'
            };
        }

        if (!this.sessionId) {
            console.warn('Skipping TikTok chat send: sessionid cookie missing');
            return {
                success: false,
                error: 'TikTok chat sending requires the sessionid cookie'
            };
        }

        if (!this.ttTargetIdc && !this.warnedMissingTtTargetIdc) {
            console.warn('TikTok chat send proceeding without tt-target-idc cookie');
            this.warnedMissingTtTargetIdc = true;
        }

        if (!this.connection || this.isStopped || !this.connection.isConnected) {
            console.warn('Cannot send TikTok message: Connection not active');
            return {
                success: false,
                error: 'Connection not active'
            };
        }

        const trimmedMessage = message.trim();
        const usingLocalSigner = this.shouldUseLocalSigner();
        const allowEulerChat = usingLocalSigner ? false : this.shouldAllowEulerChatEndpoint();
        const allowConnectionFallback = this.canUseConnectionChatFallback();
        const allowAnyFallback = allowEulerChat || allowConnectionFallback;
        let lastDirectResult = null;
        let lastDirectError = null;
        if (shouldLogTikTokDebug()) {
            console.log('[TikTok] Checking direct chat route', { shouldUseDirectChatRoute: this.shouldUseDirectChatRoute() });
        }
        if (this.shouldUseDirectChatRoute()) {
            const directResult = await this.sendChatMessageViaDirectRoute(trimmedMessage);
            lastDirectResult = directResult;
            if (directResult?.success) {
                return directResult;
            }

            const routeUnavailable = !!directResult?.routeUnavailable;
            const fallbackReason = directResult?.error || (routeUnavailable ? 'route_unavailable' : 'direct_route_failed');
            const fallbackTarget = allowEulerChat ? 'Euler endpoint' : 'websocket connection';
            lastDirectError = fallbackReason || null;

            if (!allowAnyFallback) {
                this.logDebug('chat.send.direct.fallback_blocked', {
                    reason: fallbackReason || null,
                    routeUnavailable
                });
                return {
                    success: false,
                    error: fallbackReason || 'Direct chat send failed and no fallback transport is available for this signing mode'
                };
            }

            if (routeUnavailable) {
                console.info(`Direct TikTok chat route unavailable, falling back to ${fallbackTarget}.`);
            } else {
                console.warn(`Direct TikTok chat send failed, falling back to ${fallbackTarget}:`, fallbackReason);
            }

            this.logDebug('chat.send.direct.fallback', {
                reason: fallbackReason || null,
                routeUnavailable,
                target: fallbackTarget
            });
        }

        if (!allowAnyFallback) {
            return {
                success: false,
                error: lastDirectError || 'No chat fallback transport available for current connection'
            };
        }

        // Prefer the active connection send when available; Euler is blocked under local signer
        if (usingLocalSigner && allowConnectionFallback) {
            try {
                await this.connection.sendMessage(trimmedMessage);
                console.log('Message sent to TikTok chat via websocket connection.');
                return { success: true };
            } catch (error) {
                console.error('Failed to send TikTok message via websocket connection:', error);
                return {
                    success: false,
                    error: typeof error?.message === 'string' && error.message.trim()
                        ? error.message.trim()
                        : 'Failed to send message via websocket connection'
                };
            }
        }

        if (usingLocalSigner) {
            return {
                success: false,
                error: 'Chat send failed and Euler fallback is disabled for local signer'
            };
        }

        return this.sendChatMessageViaEuler(trimmedMessage);
    }
}

function normalizeSourceAccountRole(role) {
    const value = String(role || 'normal').trim().toLowerCase();
    return ['host', 'bot', 'relay'].includes(value) ? value : 'normal';
}

function getConnectionForTikTokMessage(msg) {
    try {
        if (!msg || typeof msg.tid !== 'number' || msg.tid < 900001) return null;
        const wssID = msg.tid - 900000;
        return env.websocketConnections ? env.websocketConnections[wssID] : null;
    } catch (_) {
        return null;
    }
}

function attachSourceAccountMeta(msg) {
    const conn = getConnectionForTikTokMessage(msg);
    if (!conn) return msg;
    const role = normalizeSourceAccountRole(conn.accountRole);
    if (role === 'normal') return msg;
    if (!msg || typeof msg !== 'object') return msg;
    if (msg.meta === undefined || msg.meta === null) {
        msg.meta = {};
    }
    if (typeof msg.meta !== 'object' || Array.isArray(msg.meta)) {
        return msg;
    }
    msg.meta.ssnAccountRole = role;
    if (conn.sourceId) msg.meta.ssnSourceId = conn.sourceId;
    if (conn.customSession && conn.customSession !== 'AUTO') msg.meta.ssnSession = conn.customSession;
    return msg;
}

function logTikTokForwardedMessage(msg, context = 'single', meta = {}) {
    try {
        if (!msg || msg.type !== 'tiktok') return;
        const tid = typeof msg.tid === 'number' ? msg.tid : null;
        if (!tid || tid < 900001) return;
        const wssID = tid - 900000;
        const manager = env.websocketConnections ? env.websocketConnections[wssID] : null;
        if (!manager || typeof manager.logDebug !== 'function') return;
        const summary = {
            context,
            event: msg.event || (msg.hasDonation ? 'gift' : 'chat'),
            chatmessage: msg.chatmessage || null,
            chatname: msg.chatname || null,
            userid: msg.userid || null,
            moderator: !!msg.moderator,
            membership: !!msg.membership,
            hasDonation: (typeof msg.hasDonation === 'string' && msg.hasDonation) ? msg.hasDonation : null,
            batchSize: meta.batchSize || null,
            itemIndex: meta.itemIndex || null
        };
        if (msg.meta !== undefined) summary.meta = msg.meta;
        manager.logDebug('event.forwarded', summary);
    } catch (error) {
        console.error('Failed to record TikTok forwarded message:', error);
    }
}

function sendToBackground(msg) {
    try {
        if (msg && typeof msg === 'object' && typeof msg.tid === 'number') {
            const tid = msg.tid;
            if (tid >= 900001) {
                const wssID = tid - 900000;
                const conn = env.websocketConnections ? env.websocketConnections[wssID] : null;
                if (conn && conn.replyOnly) {
                    if (typeof conn.logDebug === 'function') {
                        conn.logDebug('event.forwarded.skipped', {
                            reason: 'reply_only',
                            context: 'single'
                        });
                    }
                    return;
                }
            }
        }
    } catch (_) { /* noop */ }

    msg = attachSourceAccountMeta(msg);
    logTikTokForwardedMessage(msg);
    try { env.onEvent(msg); } catch (error) { console.warn('onEvent callback failed:', error); }

    const mainWindow = getMainWindow();
    if (mainWindow && mainWindow.webContents && mainWindow.webContents.mainFrame) {
        try {
            mainWindow.webContents.mainFrame.frames.forEach((frame) => {
                if (frame.url.split('?')[0].endsWith('background.html')) {
                    frame.postMessage('fromMain', {
                        message: msg
                    });
                }
            });
        } catch (error) {
            console.warn('Failed to forward TikTok message to background:', error);
        }
    }
}

function sendBatchToBackground(messages) {
    try {
        if (Array.isArray(messages)) {
            messages = messages.filter(m => {
                try {
                    if (!m || typeof m.tid !== 'number') return true;
                    const tid = m.tid;
                    if (tid >= 900001) {
                        const wssID = tid - 900000;
                        const conn = env.websocketConnections ? env.websocketConnections[wssID] : null;
                        if (conn && conn.replyOnly) {
                            if (typeof conn.logDebug === 'function' && m && m.type === 'tiktok') {
                                conn.logDebug('event.forwarded.skipped', {
                                    reason: 'reply_only',
                                    context: 'batch'
                                });
                            }
                            return false;
                        }
                    }
                } catch (_) { }
                return true;
            });
        }
    } catch (_) { }

    if (Array.isArray(messages)) {
        messages = messages.map(attachSourceAccountMeta);
        messages.forEach((m, idx) => {
            logTikTokForwardedMessage(m, 'batch', {
                batchSize: messages.length,
                itemIndex: idx
            });
            try { env.onEvent(m); } catch (error) { console.warn('onEvent callback failed:', error); }
        });
    }

    const mainWindow = getMainWindow();
    if (mainWindow && mainWindow.webContents && mainWindow.webContents.mainFrame) {
        try {
            mainWindow.webContents.mainFrame.frames.forEach((frame) => {
                if (frame.url.split('?')[0].endsWith('background.html')) {
                    frame.postMessage('fromMain', {
                        messages
                    });
                }
            });
        } catch (error) {
            console.warn('Failed to forward TikTok batch to background:', error);
        }
    }
}

module.exports = {
    installTikTokSignServerFallback,
    createTikTokEnvironment,
    giftMapping,
	__test: {
		EulerWebsocketServerConnection,
		isLikelySubscribeSignal,
		composeTikTokChatMessage,
		normalizeTikTokEmoteEntries,
		renderTikTokChatWithEmotes,
		resolveTikTokGiftContentImage,
		resolveTikTokGiftDisplayImage,
		resolveGiftMetricCount,
		resolveGiftAggregatedCount,
		resolveGiftId,
        resolveGiftStreakIdentity,
        GiftProcessor,
        MessageProcessor,
        ConnectionManager,
        buildChatDedupeKey,
        buildGiftDedupeKey
    }
};
