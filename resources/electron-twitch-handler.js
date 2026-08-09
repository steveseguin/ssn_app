const crypto = require('crypto');
const http = require('http');
const { BrowserWindow, ipcMain, shell } = require('electron');

function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_PORTS = [8181, 8080];
const CALLBACK_PATH = '/sources/websocket/twitch.html';
const DEFAULT_HOSTED_AUTH_BASE = 'https://sso.socialstream.ninja/auth/twitch';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const BOT_AUTH_WINDOW_TITLE = 'Connect Twitch bot account';

let activeSession = null;

function buildTwitchAuthUrl({ clientId, scopes, redirectUri, state }) {
    const scopeString = Array.isArray(scopes) ? scopes.join(' ') : String(scopes || '');
    return 'https://id.twitch.tv/oauth2/authorize' +
        `?response_type=token` +
        `&client_id=${encodeURIComponent(clientId || '')}` +
        `&redirect_uri=${encodeURIComponent(redirectUri || '')}` +
        `&scope=${encodeURIComponent(scopeString)}` +
        `&state=${encodeURIComponent(state || '')}`;
}

function buildHostedTwitchAuthUrl({ authBase, returnTo, purpose }) {
    const base = String(authBase || DEFAULT_HOSTED_AUTH_BASE).replace(/\/+$/, '');
    const url = new URL(`${base}/start`);
    url.searchParams.set('return_to', returnTo || '');
    if (purpose) {
        url.searchParams.set('purpose', purpose);
    }
    return url.toString();
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
            console.log(`[Twitch OAuth] Server started on port ${port}`);
            return port;
        } catch (err) {
            if (err.code === 'EADDRINUSE') {
                console.log(`[Twitch OAuth] Port ${port} in use, trying next...`);
                continue;
            }
            throw err;
        }
    }
    const error = new Error('PORTS_UNAVAILABLE');
    error.code = 'PORTS_UNAVAILABLE';
    throw error;
}

function runTwitchLoopbackOAuthSession(payload = {}) {
    return new Promise((resolve, reject) => {
        let timeoutId = null;
        let settled = false;
        let server = null;
        let session = null;
        let redirectUri = null;
        let authWindow = null;
        let authWindowCloseExpected = false;
        const stateParam = payload.state || crypto.randomBytes(16).toString('hex');
        const useHostedAuth = payload.authMode === 'hosted' || (!payload.authMode && !!payload.authBase);

        const cleanup = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            if (server) {
                try { server.close(); } catch (_) { }
                server = null;
            }
            if (authWindow && !authWindow.isDestroyed()) {
                authWindowCloseExpected = true;
                try { authWindow.destroy(); } catch (_) { }
            }
            authWindow = null;
            if (activeSession === session) {
                activeSession = null;
            }
        };

        const complete = (result) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
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
            const parsed = new URL(req.url || '/', `http://${LOOPBACK_HOST}`);
            const query = Object.fromEntries(parsed.searchParams);

            // Handle POST request with token data from the landing page JavaScript
            if (req.method === 'POST' && parsed.pathname === '/token') {
                let body = '';
                let bodySize = 0;
                req.on('data', chunk => {
                    bodySize += chunk.length;
                    if (bodySize > 65536) { req.destroy(); return; }
                    body += chunk;
                });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);

                        if (data.state && data.state !== stateParam) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: 'state_mismatch' }));
                            fail(new Error('State mismatch - possible CSRF attack'));
                            return;
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true }));

                        if (data.access_token) {
                            complete({
                                success: true,
                                access_token: data.access_token,
                                refresh_token: data.refresh_token || null,
                                expires_in: data.expires_in || null,
                                token_type: data.token_type || 'bearer',
                                state: data.state || payload.state || null,
                                scope: data.scope || null,
                                client_id: data.client_id || null,
                                purpose: data.purpose || payload.purpose || null
                            });
                        } else if (data.error) {
                            fail(new Error(data.error_description || data.error));
                        }
                    } catch (e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
                    }
                });
                return;
            }

            // Serve landing page that extracts hash fragment and POSTs to /token
            if (parsed.pathname === CALLBACK_PATH || parsed.pathname === '/callback' || parsed.pathname === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`<!DOCTYPE html>
<html>
<head>
    <title>Twitch Authorization</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
               display: flex; justify-content: center; align-items: center; height: 100vh;
               margin: 0; background: #0e0e10; color: #efeff1; }
        .container { text-align: center; padding: 40px; }
        h1 { color: #9146ff; }
        .spinner { width: 40px; height: 40px; border: 4px solid #2c2c2e;
                   border-top: 4px solid #9146ff; border-radius: 50%;
                   animation: spin 1s linear infinite; margin: 20px auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .error { color: #eb0400; }
        .success { color: #00f593; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Twitch Authorization</h1>
        <div class="spinner" id="spinner"></div>
        <p id="status">Processing authorization...</p>
    </div>
    <script>
        (function() {
            const status = document.getElementById('status');
            const spinner = document.getElementById('spinner');

            // Parse the hash fragment
            const hash = window.location.hash.substring(1);
            const params = new URLSearchParams(hash);
            const base64UrlToJson = function(value) {
                try {
                    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
                    const padded = normalized + '==='.slice((normalized.length + 3) % 4);
                    return JSON.parse(decodeURIComponent(Array.prototype.map.call(atob(padded), function(char) {
                        return '%' + ('00' + char.charCodeAt(0).toString(16)).slice(-2);
                    }).join('')));
                } catch (e) {
                    return null;
                }
            };

            const hostedResult = base64UrlToJson(params.get('twitch_auth_result'));
            const hostedError = base64UrlToJson(params.get('twitch_auth_error'));
            const hostedTokens = hostedResult && (hostedResult.tokens || hostedResult);

            const data = {
                access_token: (hostedTokens && hostedTokens.access_token) || params.get('access_token'),
                refresh_token: hostedTokens && hostedTokens.refresh_token,
                expires_in: hostedTokens && hostedTokens.expires_in,
                token_type: (hostedTokens && hostedTokens.token_type) || params.get('token_type'),
                state: params.get('state') || new URLSearchParams(window.location.search).get('state'),
                scope: (hostedTokens && hostedTokens.scope) || params.get('scope'),
                client_id: hostedTokens && hostedTokens.client_id,
                purpose: (hostedResult && hostedResult.purpose) || params.get('purpose'),
                error: (hostedError && (hostedError.error || hostedError.message)) || params.get('error'),
                error_description: (hostedError && hostedError.message) || params.get('error_description')
            };

            if (data.error) {
                spinner.style.display = 'none';
                status.className = 'error';
                status.textContent = 'Authorization failed: ' + (data.error_description || data.error);
                fetch('/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: data.error, error_description: data.error_description })
                });
                return;
            }

            if (data.access_token) {
                fetch('/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                })
                .then(() => {
                    spinner.style.display = 'none';
                    status.className = 'success';
                    status.textContent = 'Success! You can close this window and return to Social Stream.';
                    setTimeout(() => window.close(), 1500);
                })
                .catch(err => {
                    spinner.style.display = 'none';
                    status.className = 'error';
                    status.textContent = 'Failed to complete authorization: ' + err.message;
                });
            } else {
                spinner.style.display = 'none';
                status.className = 'error';
                status.textContent = 'No access token received. Please try again.';
            }
        })();
    </script>
</body>
</html>`);
                return;
            }

            // Handle errors in query params (some OAuth errors come this way)
            if (query.error) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`<!DOCTYPE html>
<html>
<head><title>Authorization Failed</title>
<style>body { font-family: sans-serif; text-align: center; padding: 50px; background: #0e0e10; color: #efeff1; }
h1 { color: #eb0400; }</style></head>
<body><h1>Authorization Failed</h1><p>${escapeHtml(query.error_description || query.error)}</p>
<script>setTimeout(() => window.close(), 3000);</script></body></html>`);
                fail(new Error(query.error_description || query.error));
                return;
            }

            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
        });

        (async () => {
            try {
                const port = await tryStartServer(server);
                redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
                const returnTo = `${redirectUri}?ssapp=1&state=${encodeURIComponent(stateParam)}`;

                const authUrl = useHostedAuth
                    ? buildHostedTwitchAuthUrl({
                        authBase: payload.authBase,
                        returnTo,
                        purpose: payload.purpose
                    })
                    : buildTwitchAuthUrl({
                        clientId: payload.clientId,
                        scopes: payload.scopes,
                        redirectUri,
                        state: stateParam
                    });

                payload.redirectUri = redirectUri;

                try {
                    if (payload.purpose === 'bot') {
                        const authPartition = `twitch-bot-oauth-${crypto.randomBytes(8).toString('hex')}`;
                        authWindow = new BrowserWindow({
                            title: BOT_AUTH_WINDOW_TITLE,
                            show: true,
                            width: 680,
                            height: 760,
                            minWidth: 500,
                            minHeight: 600,
                            autoHideMenuBar: true,
                            backgroundColor: '#0e0e10',
                            webPreferences: {
                                partition: authPartition,
                                nodeIntegration: false,
                                contextIsolation: true,
                                sandbox: true
                            }
                        });
                        authWindow.setMenuBarVisibility(false);
                        authWindow.on('page-title-updated', (event) => {
                            event.preventDefault();
                            if (authWindow && !authWindow.isDestroyed()) {
                                authWindow.setTitle(BOT_AUTH_WINDOW_TITLE);
                            }
                        });
                        authWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
                        const openedWindow = authWindow;
                        openedWindow.on('closed', () => {
                            if (authWindow === openedWindow) {
                                authWindow = null;
                            }
                            if (!authWindowCloseExpected && !settled) {
                                fail(new Error('Twitch bot account sign-in was closed.'));
                            }
                        });
                        await openedWindow.loadURL(authUrl);
                        if (!openedWindow.isDestroyed()) {
                            openedWindow.show();
                            openedWindow.focus();
                        }
                        console.log('[Twitch OAuth] Opened bot sign-in in an isolated SSApp window');
                    } else {
                        await shell.openExternal(authUrl, { activate: true });
                        console.log('[Twitch OAuth] Opening auth URL in default browser');
                    }
                } catch (shellError) {
                    console.error('[Twitch OAuth] Failed to launch authorization:', shellError);
                    fail(shellError);
                }
            } catch (err) {
                if (err.code === 'PORTS_UNAVAILABLE') {
                    const { dialog } = require('electron');
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

function setupTwitchOAuthHandler() {
    if (ipcMain.listenerCount('twitch-oauth') > 0) {
        return;
    }
    ipcMain.handle('twitch-oauth', async (_event, payload = {}) => {
        if (activeSession && typeof activeSession.fail === 'function') {
            console.warn('[Twitch OAuth] Aborting previous pending session in favor of the new request.');
            activeSession.fail(new Error('Previous Twitch authentication was interrupted by a new request.'));
        }
        return runTwitchLoopbackOAuthSession(payload);
    });
}

module.exports = {
    setupTwitchOAuthHandler
};
