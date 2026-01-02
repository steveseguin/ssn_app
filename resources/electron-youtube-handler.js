const { ipcMain, shell } = require('electron');
const http = require('http');
const url = require('url');

const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_PORT = 8080;  // Same port as Twitch - authorized origin
const CALLBACK_PATH = '/sources/websocket/youtube.html';
const DEFAULT_AUTH_BASE = 'https://ytauth.socialstream.ninja';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

let activeSession = null;

function buildAuthUrl({ authBase, clientId, scopes, redirectUri, state }) {
    const base = authBase || DEFAULT_AUTH_BASE;
    const scopeString = Array.isArray(scopes) ? scopes.join(' ') : String(scopes || '');
    return `${base}/auth` +
        `?client_id=${encodeURIComponent(clientId || '')}` +
        `&redirect_uri=${encodeURIComponent(redirectUri || '')}` +
        `&scope=${encodeURIComponent(scopeString)}` +
        `&state=${encodeURIComponent(state || '')}`;
}

function runLoopbackOAuthSession(payload = {}) {
    return new Promise((resolve, reject) => {
        let timeoutId = null;
        let settled = false;
        let server = null;
        let session = null;

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
<body><div class="container"><h1>Authorization Failed</h1><p>Error: ${query.error}</p></div>
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

        server.on('error', (err) => {
            console.error('[YouTube OAuth] Local server error:', err);
            fail(err);
        });

        server.listen(LOOPBACK_PORT, LOOPBACK_HOST, () => {
            const redirectUri = `http://localhost:${LOOPBACK_PORT}${CALLBACK_PATH}`;
            const authUrl = buildAuthUrl({
                authBase: payload.authBase,
                clientId: payload.clientId,
                scopes: payload.scopes,
                redirectUri,
                state: payload.state
            });

            payload.redirectUri = redirectUri;

            Promise.resolve(shell.openExternal(authUrl, { activate: true }))
                .then(() => {
                    console.log('[YouTube OAuth] Opening auth URL in default browser');
                })
                .catch((shellError) => {
                    console.error('[YouTube OAuth] Failed to launch default browser:', shellError);
                    fail(shellError);
                });
        });

        const timeoutMs = Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : DEFAULT_TIMEOUT_MS;
        timeoutId = setTimeout(() => {
            fail(new Error('OAuth timeout'));
        }, timeoutMs);
    });
}

function setupYouTubeOAuthHandler() {
    if (ipcMain.listenerCount('youtube-oauth') > 0) {
        return;
    }
    ipcMain.handle('youtube-oauth', async (_event, payload = {}) => {
        if (activeSession && typeof activeSession.fail === 'function') {
            console.warn('[YouTube OAuth] Aborting previous pending session in favor of the new request.');
            activeSession.fail(new Error('Previous YouTube authentication was interrupted by a new request.'));
        }
        return runLoopbackOAuthSession(payload);
    });
}

module.exports = {
    setupYouTubeOAuthHandler
};
