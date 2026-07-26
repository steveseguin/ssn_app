'use strict';

const crypto = require("crypto");
const http = require("http");
const path = require("path");
const { BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require("electron");
const Store = require("electron-store");

function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_PORTS = [8181, 8080];
const CALLBACK_PATH = "/sources/websocket/youtube.html";
const HOSTED_AUTH_BASE = "https://sso.socialstream.ninja/youtube";
const LEGACY_AUTH_BASE = "https://ytauth.socialstream.ninja";
const DEFAULT_AUTH_BASE = LEGACY_AUTH_BASE;
const GOOGLE_AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_YT_CLIENT_ID = "689627108309-isbjas8fmbc7sucmbm7gkqjapk7btbsi.apps.googleusercontent.com";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const YT_READONLY_SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube.channel-memberships.creator"
];
const OWNER_AUTH_STORE_KEY = "youtubeOwnerAuth";
const OWNER_BROADCAST_PARTS = "id,snippet,status,contentDetails";
const OWNER_BROADCAST_STATUSES = ["active", "upcoming"];
const YOUTUBE_API_TIMEOUT_MS = 15000;
const YOUTUBE_WSS_TOKEN_STORE_TIMEOUT_MS = 15000;
const pendingOwnerAuth = new Map();
const ownerAuthStore = new Store({ name: "youtube-owner-auth" });

let activeSession = null;

function getSenderFrameUrl(event) {
    try {
        if (event?.senderFrame?.url) return String(event.senderFrame.url);
    } catch (_) { }
    try {
        if (event?.sender && typeof event.sender.getURL === "function") {
            return String(event.sender.getURL() || "");
        }
    } catch (_) { }
    return "";
}

function isMainAppFrameUrl(frameUrl) {
    if (!frameUrl || typeof frameUrl !== "string") return false;
    try {
        const parsed = new URL(frameUrl);
        if (parsed.protocol !== "file:") return false;
        const senderPath = path.normalize(decodeURIComponent(parsed.pathname || "").replace(/^\/([A-Za-z]:)/, "$1"));
        const indexPath = path.normalize(path.join(__dirname, "..", "index.html"));
        return senderPath.toLowerCase() === indexPath.toLowerCase();
    } catch (_) {
        return false;
    }
}

function assertMainAppOwnerAuthCaller(event) {
    const frameUrl = getSenderFrameUrl(event);
    if (isMainAppFrameUrl(frameUrl)) return;
    const error = new Error("YouTube owner auth IPC is only available to the main app UI.");
    error.code = "SSAPP_YOUTUBE_OWNER_FORBIDDEN";
    console.warn("[YouTube Owner] Blocked owner-auth IPC from non-app frame:", frameUrl || "unknown");
    throw error;
}

function buildHostedAuthUrl({ authBase, clientId, scopes, redirectUri, state }) {
    const base = authBase || DEFAULT_AUTH_BASE;
    const scopeString = Array.isArray(scopes) ? scopes.join(' ') : String(scopes || '');
    return `${base}/auth` +
        `?client_id=${encodeURIComponent(clientId || '')}` +
        `&redirect_uri=${encodeURIComponent(redirectUri || '')}` +
        `&scope=${encodeURIComponent(scopeString)}` +
        `&state=${encodeURIComponent(state || '')}`;
}

function buildGoogleAuthUrl({ clientId, scopes, redirectUri, state }) {
    const scopeString = Array.isArray(scopes) ? scopes.join(" ") : String(scopes || "");
    return `${GOOGLE_AUTH_BASE}` +
        `?client_id=${encodeURIComponent(clientId || "")}` +
        `&redirect_uri=${encodeURIComponent(redirectUri || "")}` +
        `&response_type=code` +
        `&access_type=offline` +
        `&prompt=consent` +
        `&scope=${encodeURIComponent(scopeString)}` +
        `&state=${encodeURIComponent(state || "")}`;
}

function buildAuthUrl(payload = {}) {
    if (payload.authMode === "custom_google") {
        return buildGoogleAuthUrl(payload);
    }
    return buildHostedAuthUrl(payload);
}

function tryListenOnPort(server, port) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.removeListener('listening', onListening);
            reject(err);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve(port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, LOOPBACK_HOST);
    });
}

async function tryStartServer(server) {
    for (const port of LOOPBACK_PORTS) {
        try {
            await tryListenOnPort(server, port);
            console.log(`[YouTube OAuth] Server started on port ${port}`);
            return port;
        } catch (err) {
            if (err.code === 'EADDRINUSE') {
                console.log(`[YouTube OAuth] Port ${port} in use, trying next...`);
                continue;
            }
            throw err;
        }
    }
    const error = new Error('PORTS_UNAVAILABLE');
    error.code = 'PORTS_UNAVAILABLE';
    throw error;
}

function runLoopbackOAuthSession(payload = {}, dependencies = {}) {
    return new Promise((resolve, reject) => {
        let timeoutId = null;
        let settled = false;
        let server = null;
        let session = null;
        const stateParam = payload.state || crypto.randomBytes(16).toString("hex");
        const openExternal = dependencies.openExternal || ((...args) => shell.openExternal(...args));

        const cleanup = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            if (server) {
                try { server.close(); } catch (_) { }
                server = null;
            }
            if (activeSession === session) {
                activeSession = null;
            }
        };

        const complete = (payload) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(payload);
        };

        const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        session = { fail };
        activeSession = session;

        server = http.createServer((req, res) => {
            const parsed = new URL(req.url || "/", `http://${LOOPBACK_HOST}`);
            const query = Object.fromEntries(parsed.searchParams);

            // Handle the callback path
            if (parsed.pathname === CALLBACK_PATH || parsed.pathname === '/callback' || parsed.pathname === '/') {
                if ((query.code || query.error) && query.state !== stateParam) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`<!DOCTYPE html>
<html><head><title>Authorization Failed</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f0f0f;color:#fff}
.container{text-align:center}h1{color:#ff0000}</style></head>
<body><div class="container"><h1>State Mismatch</h1><p>Possible CSRF attack detected. Please try again.</p></div>
<script>setTimeout(()=>window.close(),3000);</script></body></html>`);
                    const stateError = new Error('State mismatch - possible CSRF attack');
                    stateError.code = 'SSAPP_YOUTUBE_OAUTH_STATE_MISMATCH';
                    fail(stateError);
                    return;
                }
                if (query.code) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`<!DOCTYPE html>
<html><head><title>YouTube Authorization</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f0f0f;color:#fff}
.container{text-align:center}h1{color:#ff0000}.success{color:#0f0}</style></head>
<body><div class="container"><h1>Success!</h1><p class="success">You can close this window and return to Social Stream.</p></div>
<script>setTimeout(()=>window.close(),1500);</script></body></html>`);
                    complete({
                        success: true,
                        code: query.code,
                        state: query.state,
                        redirectUri: payload.redirectUri || null
                    });
                    return;
                }

                if (query.error) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`<!DOCTYPE html>
<html><head><title>Authorization Failed</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f0f0f;color:#fff}
.container{text-align:center}h1{color:#ff0000}</style></head>
<body><div class="container"><h1>Authorization Failed</h1><p>Error: ${escapeHtml(query.error)}</p></div>
<script>setTimeout(()=>window.close(),3000);</script></body></html>`);
                    fail(new Error(query.error));
                    return;
                }

                // No code or error - show waiting page
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`<!DOCTYPE html>
<html><head><title>YouTube Authorization</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f0f0f;color:#fff}
.container{text-align:center}h1{color:#ff0000}</style></head>
<body><div class="container"><h1>Waiting...</h1><p>Complete authorization in the browser.</p></div></body></html>`);
                return;
            }

            // Unknown path
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
        });

        (async () => {
            try {
                const port = await tryStartServer(server);
                const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
                const authUrl = buildAuthUrl({
                    authBase: payload.authBase,
                    clientId: payload.clientId,
                    scopes: payload.scopes,
                    redirectUri,
                    state: stateParam
                });

                payload.redirectUri = redirectUri;

                try {
                    await openExternal(authUrl, { activate: true });
                    console.log('[YouTube OAuth] Opening auth URL in default browser');
                } catch (shellError) {
                    console.error('[YouTube OAuth] Failed to launch default browser:', shellError);
                    fail(shellError);
                }
            } catch (err) {
                if (err.code === 'PORTS_UNAVAILABLE') {
                    dialog.showMessageBox({
                        type: 'error',
                        title: 'Unable to Sign In',
                        message: 'Port Conflict Detected',
                        detail: 'Both ports 8080 and 8181 are in use by other applications.\n\n' +
                                'Common causes:\n' +
                                '• Streamer.bot (uses port 8080 by default)\n' +
                                '• Other streaming software\n\n' +
                                'To fix this:\n' +
                                '1. Stop applications using these ports, OR\n' +
                                '2. Configure Streamer.bot to use a different port (e.g., 9000)\n\n' +
                                'Then try signing in again.',
                        buttons: ['OK']
                    });
                }
                fail(err);
            }
        })();

        const timeoutMs = Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : DEFAULT_TIMEOUT_MS;
        timeoutId = setTimeout(() => {
            fail(new Error('OAuth timeout'));
        }, timeoutMs);
    });
}

async function readJsonResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (_) {
        return { raw: text };
    }
}

function createTokenExchangeError(prefix, response, payload) {
    const message = payload?.error_description || payload?.error || `${prefix}: HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload || null;
    return error;
}

async function postGoogleTokenRequest(params) {
    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString()
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
        throw createTokenExchangeError("Google token request failed", response, payload);
    }
    return payload;
}

function shouldFallbackToLegacyYouTubeAuth(error) {
    const status = Number(error && error.status);
    return !status || status === 401 || status === 403 || status === 405 || status >= 500;
}

async function postHostedYouTubeAuthJson(path, payload) {
    async function postToBase(baseUrl) {
        const response = await fetch(baseUrl + path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await readJsonResponse(response);
        if (!response.ok) {
            const message = data?.error_description || data?.error || `HTTP error! status: ${response.status}`;
            const error = new Error(message);
            error.status = response.status;
            error.payload = data;
            throw error;
        }
        return data;
    }

    try {
        return await postToBase(HOSTED_AUTH_BASE);
    } catch (error) {
        if (shouldFallbackToLegacyYouTubeAuth(error)) {
            console.warn("[YouTube Owner] Hosted SSO failed; falling back to legacy auth bridge.", error?.message || error);
            return postToBase(LEGACY_AUTH_BASE);
        }
        throw error;
    }
}

function hasSafeStorage() {
    try {
        return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === "function" && safeStorage.isEncryptionAvailable());
    } catch (_) {
        return false;
    }
}

function getSecureStorageUnavailableError() {
    const error = new Error("Secure token storage is unavailable on this system, so YouTube account sign-in cannot be saved.");
    error.code = "SSAPP_YOUTUBE_OWNER_SECURE_STORAGE_UNAVAILABLE";
    return error;
}

function ensureOwnerTokenStorageAvailable() {
    if (hasSafeStorage()) return;
    throw getSecureStorageUnavailableError();
}

function protectSecret(value) {
    const text = typeof value === "string" ? value : "";
    if (!text) return null;
    ensureOwnerTokenStorageAvailable();
    return {
        method: "safeStorage",
        value: safeStorage.encryptString(text).toString("base64")
    };
}

function revealSecret(secret) {
    if (!secret || typeof secret !== "object") return "";
    if (secret.method === "safeStorage" && secret.value) {
        try {
            return safeStorage.decryptString(Buffer.from(secret.value, "base64"));
        } catch (error) {
            console.warn("[YouTube Owner] Failed to decrypt stored token.", error?.message || error);
            return "";
        }
    }
    if (secret.method === "plain") {
        console.warn("[YouTube Owner] Refusing to use plaintext stored token. Please sign in again.");
        return "";
    }
    return "";
}

function getStoredOwnerAuths() {
    const value = ownerAuthStore.get(OWNER_AUTH_STORE_KEY);
    return value && typeof value === "object" ? value : {};
}

function setStoredOwnerAuths(auths) {
    ownerAuthStore.set(OWNER_AUTH_STORE_KEY, auths && typeof auths === "object" ? auths : {});
}

function clearYouTubeOwnerAuthStore() {
    ownerAuthStore.clear();
}

function normalizeYouTubeSessionPartition(customSession) {
    const normalizedSession = String(customSession || "").trim();
    if (normalizedSession && normalizedSession !== "AUTO") {
        if (normalizedSession.startsWith("default-")) {
            const explicitPlatform = normalizedSession.replace("default-", "").trim();
            return `persist:${explicitPlatform || "youtube"}`;
        }
        if (normalizedSession === "default") {
            return "persist:custom-default";
        }
        return `persist:custom-${normalizedSession}`;
    }
    return "persist:youtube";
}

function isYouTubeWebSocketTokenStoreUrl(value) {
    if (!value || typeof value !== "string") return false;
    try {
        const parsed = new URL(value);
        if (!["file:", "https:"].includes(parsed.protocol)) return false;
        const normalizedPath = decodeURIComponent(parsed.pathname || "").replace(/\\/g, "/").toLowerCase();
        return normalizedPath.endsWith("/sources/websocket/youtube.html") ||
            normalizedPath.endsWith("/sources/websocket/youtube_auth.html");
    } catch (_) {
        return false;
    }
}

function waitForWebContentsLoad(webContents, loadUrl, timeoutMs = YOUTUBE_WSS_TOKEN_STORE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            clearTimeout(timeout);
            try { webContents.removeListener("did-finish-load", onFinish); } catch (_) { }
            try { webContents.removeListener("did-fail-load", onFail); } catch (_) { }
        };
        const finish = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const onFinish = () => finish(true);
        const onFail = (_event, errorCode, errorDescription) => {
            if (Number(errorCode) === -3) return;
            fail(new Error(errorDescription || `Failed to load YouTube token store page (${errorCode}).`));
        };
        const timeout = setTimeout(() => {
            fail(new Error("Timed out loading YouTube token store page."));
        }, timeoutMs);

        webContents.once("did-finish-load", onFinish);
        webContents.once("did-fail-load", onFail);
        webContents.loadURL(loadUrl).catch(fail);
    });
}

async function seedYouTubeWebSocketTokenStore(options = {}) {
    const tokenStoreUrl = String(options.tokenStoreUrl || "").trim();
    if (!isYouTubeWebSocketTokenStoreUrl(tokenStoreUrl)) {
        return { success: false, skipped: true, reason: "missing_or_invalid_token_store_url" };
    }
    const accessToken = String(options.accessToken || "").trim();
    const refreshToken = String(options.refreshToken || "").trim();
    if (!accessToken) {
        return { success: false, skipped: true, reason: "missing_access_token" };
    }

    const partition = normalizeYouTubeSessionPartition(options.customSession || "AUTO");
    const expiresIn = Math.max(60, Number(options.expiresIn || 3600));
    const accessLevel = String(options.accessLevel || "readonly").toLowerCase() === "admin" ? "admin" : "readonly";
    const authSource = String(options.authSource || "default_hosted");
    const ses = session.fromPartition(partition);
    const tokenWindow = new BrowserWindow({
        show: false,
        webPreferences: {
            session: ses,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            backgroundThrottling: false
        }
    });

    try {
        await waitForWebContentsLoad(tokenWindow.webContents, tokenStoreUrl);
        const script = `
            (() => {
                const payload = {
                    accessToken: ${JSON.stringify(accessToken)},
                    refreshToken: ${JSON.stringify(refreshToken)},
                    expiresIn: ${JSON.stringify(expiresIn)},
                    accessLevel: ${JSON.stringify(accessLevel)},
                    authSource: ${JSON.stringify(authSource)}
                };
                if (window.SSYouTubeAuthStore && typeof window.SSYouTubeAuthStore.seed === 'function') {
                    const seeded = window.SSYouTubeAuthStore.seed(payload);
                    return {
                        hasToken: !!seeded.hasToken,
                        hasRefreshToken: !!seeded.hasRefreshToken,
                        accessLevel: seeded.accessLevel || payload.accessLevel,
                        storageHelper: 'SSYouTubeAuthStore'
                    };
                }
                const expiryTime = Date.now() + (payload.expiresIn * 1000);
                localStorage.setItem('youtubeOAuthToken', payload.accessToken);
                localStorage.setItem('youtubeOAuthExpiry', String(expiryTime));
                if (payload.refreshToken) {
                    localStorage.setItem('youtubeRefreshToken', payload.refreshToken);
                }
                localStorage.setItem('youtubeOAuthAccessLevel', payload.accessLevel);
                localStorage.setItem('youtubeOAuthSource', payload.authSource);
                return {
                    hasToken: !!localStorage.getItem('youtubeOAuthToken'),
                    hasRefreshToken: !!localStorage.getItem('youtubeRefreshToken'),
                    accessLevel: localStorage.getItem('youtubeOAuthAccessLevel') || '',
                    storageHelper: 'localStorageFallback'
                };
            })();
        `;
        const result = await tokenWindow.webContents.executeJavaScript(script, true);
        return {
            success: !!result?.hasToken,
            partition,
            hasRefreshToken: !!result?.hasRefreshToken,
            accessLevel: result?.accessLevel || accessLevel
        };
    } finally {
        try {
            if (!tokenWindow.isDestroyed()) tokenWindow.destroy();
        } catch (_) { }
    }
}

function normalizeYouTubeChannelItem(item) {
    if (!item || typeof item !== "object") return null;
    const snippet = item.snippet || {};
    const channelId = String(item.id || "").trim();
    if (!channelId) return null;
    return {
        channelId,
        channelTitle: String(snippet.title || channelId),
        description: typeof snippet.description === "string" ? snippet.description : "",
        customUrl: typeof snippet.customUrl === "string" ? snippet.customUrl : "",
        thumbnails: snippet.thumbnails || null
    };
}

function sanitizeOwnerAuthRecord(record) {
    if (!record || typeof record !== "object") return null;
    return {
        authRef: record.authRef || "",
        channelId: record.channelId || "",
        channelTitle: record.channelTitle || "",
        thumbnails: record.thumbnails || null,
        authSource: record.authSource || "hosted",
        expiresAt: record.expiresAt || 0
    };
}

function prunePendingOwnerAuth() {
    const cutoff = Date.now() - (10 * 60 * 1000);
    for (const [id, pending] of pendingOwnerAuth.entries()) {
        if (!pending || pending.createdAt < cutoff) {
            pendingOwnerAuth.delete(id);
        }
    }
}

async function fetchYouTubeApiJson(apiUrl, accessToken) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), YOUTUBE_API_TIMEOUT_MS);
    try {
        const response = await fetch(apiUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: controller.signal
        });
        const data = await readJsonResponse(response);
        if (!response.ok) {
            const message = data?.error?.message || data?.error_description || data?.error || `YouTube API HTTP ${response.status}`;
            const error = new Error(message);
            error.status = response.status;
            error.payload = data;
            throw error;
        }
        return data;
    } catch (error) {
        if (error?.name === "AbortError") {
            const timeoutError = new Error("YouTube API request timed out.");
            timeoutError.code = "SSAPP_YOUTUBE_API_TIMEOUT";
            throw timeoutError;
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchOwnerChannels(accessToken) {
    const data = await fetchYouTubeApiJson(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50",
        accessToken
    );
    return Array.isArray(data.items) ? data.items.map(normalizeYouTubeChannelItem).filter(Boolean) : [];
}

async function startYouTubeOwnerAuth(payload = {}) {
    prunePendingOwnerAuth();
    ensureOwnerTokenStorageAvailable();
    const state = crypto.randomBytes(16).toString("hex");
    const authResult = await runLoopbackOAuthSession({
        authBase: HOSTED_AUTH_BASE,
        clientId: DEFAULT_YT_CLIENT_ID,
        scopes: YT_READONLY_SCOPES,
        state
    });
    const tokens = await postHostedYouTubeAuthJson("/token", {
        code: authResult.code,
        redirect_uri: authResult.redirectUri,
        client_id: DEFAULT_YT_CLIENT_ID
    });
    if (!tokens || !tokens.access_token) {
        throw new Error("YouTube owner sign-in did not return an access token.");
    }
    const channels = await fetchOwnerChannels(tokens.access_token);
    if (!channels.length) {
        throw new Error("No YouTube channels were returned for the signed-in account.");
    }
    const pendingAuthId = crypto.randomBytes(16).toString("hex");
    pendingOwnerAuth.set(pendingAuthId, {
        createdAt: Date.now(),
        tokens,
        channels,
        customSession: String(payload.customSession || "AUTO"),
        tokenStoreUrl: String(payload.tokenStoreUrl || "")
    });
    return {
        success: true,
        pendingAuthId,
        channels
    };
}

async function confirmYouTubeOwnerAuth(payload = {}) {
    prunePendingOwnerAuth();
    ensureOwnerTokenStorageAvailable();
    const pendingAuthId = String(payload.pendingAuthId || "").trim();
    const channelId = String(payload.channelId || "").trim();
    const pending = pendingOwnerAuth.get(pendingAuthId);
    if (!pending) throw new Error("YouTube sign-in confirmation expired. Please sign in again.");
    const selectedChannel = pending.channels.find(channel => channel.channelId === channelId) || pending.channels[0];
    if (!selectedChannel) throw new Error("No YouTube channel was selected.");

    const tokens = pending.tokens || {};
    const authRef = `youtube-owner:${selectedChannel.channelId}`;
    const auths = getStoredOwnerAuths();
    const existingRecord = auths[authRef];
    const refreshTokenValue = typeof tokens.refresh_token === "string" && tokens.refresh_token
        ? tokens.refresh_token
        : revealSecret(existingRecord?.refreshToken);
    const refreshToken = typeof tokens.refresh_token === "string" && tokens.refresh_token
        ? protectSecret(tokens.refresh_token)
        : existingRecord?.refreshToken || null;
    if (!refreshToken) {
        throw new Error("YouTube did not return a refresh token. Please try signing in again and approve offline access.");
    }
    const expiresIn = Number(tokens.expires_in || 3600);
    const authRecord = {
        authRef,
        channelId: selectedChannel.channelId,
        channelTitle: selectedChannel.channelTitle,
        thumbnails: selectedChannel.thumbnails || null,
        authSource: "hosted",
        scopes: YT_READONLY_SCOPES,
        accessToken: protectSecret(tokens.access_token),
        refreshToken,
        expiresAt: Date.now() + (expiresIn * 1000)
    };
    auths[authRef] = authRecord;
    setStoredOwnerAuths(auths);
    pendingOwnerAuth.delete(pendingAuthId);
    let websocketTokenStore = null;
    try {
        websocketTokenStore = await seedYouTubeWebSocketTokenStore({
            tokenStoreUrl: pending.tokenStoreUrl,
            customSession: pending.customSession,
            accessToken: tokens.access_token,
            refreshToken: refreshTokenValue,
            expiresIn,
            accessLevel: "readonly",
            authSource: "default_hosted"
        });
    } catch (error) {
        console.warn("[YouTube Owner] Failed to seed YouTube websocket token store:", error?.message || error);
        websocketTokenStore = {
            success: false,
            error: error?.message || String(error || "Unknown error")
        };
    }
    return {
        success: true,
        profile: sanitizeOwnerAuthRecord(authRecord),
        websocketTokenStore
    };
}

async function refreshStoredOwnerAuth(record) {
    const refreshToken = revealSecret(record.refreshToken);
    if (!refreshToken) {
        throw new Error("YouTube owner sign-in expired. Please sign in again.");
    }
    const tokens = await postHostedYouTubeAuthJson("/refresh", {
        refresh_token: refreshToken,
        client_id: DEFAULT_YT_CLIENT_ID
    });
    if (!tokens || !tokens.access_token) {
        throw new Error("YouTube owner token refresh did not return an access token.");
    }
    const expiresIn = Number(tokens.expires_in || 3600);
    record.accessToken = protectSecret(tokens.access_token);
    record.refreshToken = protectSecret(tokens.refresh_token || refreshToken);
    record.expiresAt = Date.now() + (expiresIn * 1000);
    const auths = getStoredOwnerAuths();
    auths[record.authRef] = record;
    setStoredOwnerAuths(auths);
    return record;
}

async function getOwnerAccessToken(authRef) {
    const auths = getStoredOwnerAuths();
    let record = auths[authRef];
    if (!record) throw new Error("YouTube owner sign-in was not found. Please sign in again.");
    if (!record.expiresAt || record.expiresAt <= Date.now() + 60000) {
        record = await refreshStoredOwnerAuth(record);
    }
    const accessToken = revealSecret(record.accessToken);
    if (!accessToken) throw new Error("YouTube owner access token is unavailable. Please sign in again.");
    return { accessToken, record };
}

function mapOwnerBroadcast(item, fallbackStatus, channelTitle) {
    if (!item || typeof item !== "object") return null;
    const snippet = item.snippet || {};
    const status = item.status || {};
    const contentDetails = item.contentDetails || {};
    const videoId = String(item.id || "").trim();
    if (!videoId) return null;
    const lifeCycleStatus = String(status.lifeCycleStatus || "").toLowerCase();
    const actualEndTime = contentDetails.actualEndTime || snippet.actualEndTime || null;
    const actualStartTime = contentDetails.actualStartTime || snippet.actualStartTime || null;
    const scheduledStartTime = snippet.scheduledStartTime || null;
    let streamStatus = fallbackStatus === "active" ? "live" : "upcoming";
    if (actualEndTime || lifeCycleStatus === "complete") {
        streamStatus = "ended";
    } else if (lifeCycleStatus === "live" || fallbackStatus === "active") {
        streamStatus = "live";
    }
    const liveChatId = snippet.liveChatId || contentDetails.liveChatId || "";
    return {
        videoId,
        broadcastId: videoId,
        title: snippet.title || "YouTube Live",
        description: snippet.description || "",
        thumbnails: snippet.thumbnails || null,
        channelId: snippet.channelId || "",
        channelTitle: snippet.channelTitle || channelTitle || "",
        status: streamStatus,
        statusDisplay: streamStatus,
        privacyStatus: status.privacyStatus || "",
        lifeCycleStatus: status.lifeCycleStatus || "",
        liveChatId,
        youtubeChatStatus: liveChatId ? "ready" : (streamStatus === "ended" ? "ended" : "waiting"),
        scheduledStartTime,
        actualStartTime,
        actualEndTime,
        isShort: false,
        viewers: null,
        ownerDiscovered: true
    };
}

async function fetchYouTubeOwnerBroadcasts(payload = {}) {
    const authRef = String(payload.authRef || "").trim();
    const channelId = String(payload.channelId || "").trim();
    if (!authRef) throw new Error("Missing YouTube owner auth reference.");
    const { accessToken, record } = await getOwnerAccessToken(authRef);
    const statuses = Array.isArray(payload.statuses) && payload.statuses.length
        ? payload.statuses
        : OWNER_BROADCAST_STATUSES;
    const broadcasts = [];
    const seen = new Set();
    for (const status of statuses) {
        const safeStatus = String(status || "").trim().toLowerCase();
        if (!safeStatus) continue;
        let pageToken = "";
        do {
            // liveBroadcasts.list accepts exactly one filter; broadcastStatus already scopes
            // the authenticated channel's live broadcasts, so do not combine it with mine=true.
            const pageTokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
            const apiUrl = "https://www.googleapis.com/youtube/v3/liveBroadcasts" +
                `?part=${encodeURIComponent(OWNER_BROADCAST_PARTS)}` +
                `&broadcastStatus=${encodeURIComponent(safeStatus)}` +
                `&broadcastType=all&maxResults=50${pageTokenParam}`;
            const data = await fetchYouTubeApiJson(apiUrl, accessToken);
            const items = Array.isArray(data.items) ? data.items : [];
            for (const item of items) {
                const mapped = mapOwnerBroadcast(item, safeStatus, record.channelTitle);
                if (!mapped || seen.has(mapped.videoId)) continue;
                if (channelId && mapped.channelId && mapped.channelId !== channelId) continue;
                seen.add(mapped.videoId);
                broadcasts.push(mapped);
            }
            pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
        } while (pageToken);
    }
    return {
        success: true,
        profile: sanitizeOwnerAuthRecord(record),
        broadcasts
    };
}

function normalizeYouTubeOwnerDiscoveryError(error) {
    const message = String(error?.message || error || "YouTube owner discovery failed.");
    const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : null;
    const reasons = Array.isArray(error?.payload?.error?.errors)
        ? error.payload.error.errors.map(item => String(item?.reason || "").toLowerCase())
        : [];
    const searchable = [message, error?.code, error?.name, ...reasons].filter(Boolean).join(" ").toLowerCase();
    const networkTokens = [
        "fetch failed", "network", "timed out", "timeout", "enotfound", "eai_again",
        "econnreset", "econnrefused", "socket hang up", "err_name_not_resolved"
    ];
    const authTokens = [
        "invalid_grant", "invalid credentials", "login required", "sign in again", "sign-in",
        "access token", "refresh token", "autherror", "insufficientpermissions"
    ];

    let code = "SSAPP_YOUTUBE_OWNER_DISCOVERY_FAILED";
    if (error?.code === "SSAPP_YOUTUBE_API_TIMEOUT" || networkTokens.some(token => searchable.includes(token))) {
        code = "SSAPP_YOUTUBE_DISCOVERY_NETWORK";
    } else if (status === 401 || authTokens.some(token => searchable.includes(token))) {
        code = "SSAPP_YOUTUBE_OWNER_AUTH_REQUIRED";
    }

    return { code, message, status };
}

function listYouTubeOwnerAuths() {
    const auths = getStoredOwnerAuths();
    return {
        success: true,
        profiles: Object.keys(auths).map(key => sanitizeOwnerAuthRecord(auths[key])).filter(Boolean)
    };
}

function clearYouTubeOwnerAuth(payload = {}) {
    const authRef = String(payload.authRef || "").trim();
    if (!authRef) throw new Error("Missing YouTube owner auth reference.");
    const auths = getStoredOwnerAuths();
    delete auths[authRef];
    setStoredOwnerAuths(auths);
    return { success: true };
}

async function exchangeYouTubeOAuthCode(payload = {}) {
    const code = String(payload.code || "").trim();
    const clientId = String(payload.clientId || "").trim();
    const clientSecret = String(payload.clientSecret || "").trim();
    const redirectUri = String(payload.redirectUri || "").trim();

    if (!code) throw new Error("Missing YouTube OAuth authorization code.");
    if (!clientId) throw new Error("Missing YouTube OAuth client ID.");
    if (!clientSecret) throw new Error("Missing YouTube OAuth client secret.");
    if (!redirectUri) throw new Error("Missing YouTube OAuth redirect URI.");

    return postGoogleTokenRequest({
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
    });
}

async function refreshYouTubeOAuthToken(payload = {}) {
    const refreshToken = String(payload.refreshToken || payload.refresh_token || "").trim();
    const clientId = String(payload.clientId || "").trim();
    const clientSecret = String(payload.clientSecret || "").trim();

    if (!refreshToken) throw new Error("Missing YouTube OAuth refresh token.");
    if (!clientId) throw new Error("Missing YouTube OAuth client ID.");
    if (!clientSecret) throw new Error("Missing YouTube OAuth client secret.");

    return postGoogleTokenRequest({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token"
    });
}

function setupYouTubeOAuthHandler() {
    if (ipcMain.listenerCount("youtube-oauth") === 0) {
        ipcMain.handle('youtube-oauth', async (_event, payload = {}) => {
            if (activeSession && typeof activeSession.fail === 'function') {
                console.warn('[YouTube OAuth] Aborting previous pending session in favor of the new request.');
                activeSession.fail(new Error('Previous YouTube authentication was interrupted by a new request.'));
            }
            return runLoopbackOAuthSession(payload);
        });
    }
    if (ipcMain.listenerCount("youtube-oauth-exchange") === 0) {
        ipcMain.handle("youtube-oauth-exchange", async (_event, payload = {}) => {
            return exchangeYouTubeOAuthCode(payload);
        });
    }
    if (ipcMain.listenerCount("youtube-oauth-refresh") === 0) {
        ipcMain.handle("youtube-oauth-refresh", async (_event, payload = {}) => {
            return refreshYouTubeOAuthToken(payload);
        });
    }
    if (ipcMain.listenerCount("youtube-owner-auth-start") === 0) {
        ipcMain.handle("youtube-owner-auth-start", async (event, payload = {}) => {
            assertMainAppOwnerAuthCaller(event);
            if (activeSession && typeof activeSession.fail === "function") {
                console.warn("[YouTube Owner] Aborting previous pending YouTube OAuth session.");
                activeSession.fail(new Error("Previous YouTube authentication was interrupted by a new request."));
            }
            return startYouTubeOwnerAuth(payload);
        });
    }
    if (ipcMain.listenerCount("youtube-owner-auth-confirm") === 0) {
        ipcMain.handle("youtube-owner-auth-confirm", async (event, payload = {}) => {
            assertMainAppOwnerAuthCaller(event);
            return confirmYouTubeOwnerAuth(payload);
        });
    }
    if (ipcMain.listenerCount("youtube-owner-auth-list") === 0) {
        ipcMain.handle("youtube-owner-auth-list", async (event) => {
            assertMainAppOwnerAuthCaller(event);
            return listYouTubeOwnerAuths();
        });
    }
    if (ipcMain.listenerCount("youtube-owner-auth-clear") === 0) {
        ipcMain.handle("youtube-owner-auth-clear", async (event, payload = {}) => {
            assertMainAppOwnerAuthCaller(event);
            return clearYouTubeOwnerAuth(payload);
        });
    }
    if (ipcMain.listenerCount("youtube-owner-broadcasts") === 0) {
        ipcMain.handle("youtube-owner-broadcasts", async (event, payload = {}) => {
            assertMainAppOwnerAuthCaller(event);
            try {
                return await fetchYouTubeOwnerBroadcasts(payload);
            } catch (error) {
                return {
                    success: false,
                    error: normalizeYouTubeOwnerDiscoveryError(error)
                };
            }
        });
    }
}

module.exports = {
    setupYouTubeOAuthHandler,
    clearYouTubeOwnerAuthStore,
    __test: {
        normalizeYouTubeOwnerDiscoveryError,
        runLoopbackOAuthSession
    }
};
