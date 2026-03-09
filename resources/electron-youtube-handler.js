'use strict';

const crypto = require("crypto");
const http = require("http");
const url = require("url");
const { dialog, ipcMain, shell } = require("electron");

function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_PORTS = [8181, 8080];
const CALLBACK_PATH = "/sources/websocket/youtube.html";
const DEFAULT_AUTH_BASE = "https://ytauth.socialstream.ninja";
const GOOGLE_AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

let activeSession = null;

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

function runLoopbackOAuthSession(payload = {}) {
    return new Promise((resolve, reject) => {
        let timeoutId = null;
        let settled = false;
        let server = null;
        let session = null;
        const stateParam = payload.state || crypto.randomBytes(16).toString("hex");

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
            const parsed = url.parse(req.url, true);
            const query = parsed.query || {};

            // Handle the callback path
            if (parsed.pathname === CALLBACK_PATH || parsed.pathname === '/callback' || parsed.pathname === '/') {
                if (query.code) {
                    if (query.state && query.state !== stateParam) {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(`<!DOCTYPE html>
<html><head><title>Authorization Failed</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f0f0f;color:#fff}
.container{text-align:center}h1{color:#ff0000}</style></head>
<body><div class="container"><h1>State Mismatch</h1><p>Possible CSRF attack detected. Please try again.</p></div>
<script>setTimeout(()=>window.close(),3000);</script></body></html>`);
                        fail(new Error('State mismatch - possible CSRF attack'));
                        return;
                    }

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
                        state: query.state || payload.state || null,
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
                    await shell.openExternal(authUrl, { activate: true });
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
}

module.exports = {
    setupYouTubeOAuthHandler
};
