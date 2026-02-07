const { ipcMain, shell } = require('electron');
const http = require('http');
const url = require('url');
const crypto = require('crypto');

function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_PORTS = [8181, 8080];
const CALLBACK_PATH = '/sources/websocket/kick.html';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

let activeSession = null;

// PKCE helper functions
function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let result = '';
    const randomBytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        result += chars[randomBytes[i] % chars.length];
    }
    return result;
}

async function createCodeChallenge(verifier) {
    const hash = crypto.createHash('sha256').update(verifier).digest();
    return hash.toString('base64url');
}

function buildKickAuthUrl({ clientId, scopes, redirectUri, codeChallenge, state }) {
    const scopeString = Array.isArray(scopes) ? scopes.join(' ') : String(scopes || '');
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId || '',
        redirect_uri: redirectUri || '',
        scope: scopeString,
        code_challenge: codeChallenge || '',
        code_challenge_method: 'S256',
        state: state || ''
    });
    return `https://id.kick.com/oauth/authorize?${params.toString()}`;
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
            console.log(`[Kick OAuth] Server started on port ${port}`);
            return port;
        } catch (err) {
            if (err.code === 'EADDRINUSE') {
                console.log(`[Kick OAuth] Port ${port} in use, trying next...`);
                continue;
            }
            throw err;
        }
    }
    const error = new Error('PORTS_UNAVAILABLE');
    error.code = 'PORTS_UNAVAILABLE';
    throw error;
}

function runKickLoopbackOAuthSession(payload = {}) {
    return new Promise((resolve, reject) => {
        (async () => {
        let timeoutId = null;
        let settled = false;
        let server = null;
        let session = null;

        // Generate PKCE values
        const codeVerifier = generateRandomString(64);
        const codeChallenge = await createCodeChallenge(codeVerifier);
        const stateParam = payload.state || generateRandomString(32);

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
            const parsed = url.parse(req.url, true);
            const query = parsed.query || {};

            // Handle the callback path
            if (parsed.pathname === CALLBACK_PATH || parsed.pathname === '/callback' || parsed.pathname === '/') {
                if (query.code) {
                    // Verify state
                    if (query.state !== stateParam) {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(`<!DOCTYPE html>
<html><head><title>Authorization Failed</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a1a;color:#fff}
.container{text-align:center}h1{color:#53fc18}</style></head>
<body><div class="container"><h1>State Mismatch</h1><p>Possible CSRF attack detected. Please try again.</p></div>
<script>setTimeout(()=>window.close(),3000);</script></body></html>`);
                        fail(new Error('State mismatch - possible CSRF attack'));
                        return;
                    }

                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`<!DOCTYPE html>
<html><head><title>Kick Authorization</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a1a;color:#fff}
.container{text-align:center}h1{color:#53fc18}.success{color:#53fc18}</style></head>
<body><div class="container"><h1>Success!</h1><p class="success">You can close this window and return to Social Stream.</p></div>
<script>setTimeout(()=>window.close(),1500);</script></body></html>`);
                    complete({
                        success: true,
                        code: query.code,
                        state: query.state || stateParam,
                        codeVerifier: codeVerifier,
                        redirectUri: payload.redirectUri || null
                    });
                    return;
                }

                if (query.error) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`<!DOCTYPE html>
<html><head><title>Authorization Failed</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a1a;color:#fff}
.container{text-align:center}h1{color:#ff4444}</style></head>
<body><div class="container"><h1>Authorization Failed</h1><p>Error: ${escapeHtml(query.error)}</p><p>${escapeHtml(query.error_description || '')}</p></div>
<script>setTimeout(()=>window.close(),3000);</script></body></html>`);
                    fail(new Error(query.error_description || query.error));
                    return;
                }

                // No code or error - show waiting page
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`<!DOCTYPE html>
<html><head><title>Kick Authorization</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a1a;color:#fff}
.container{text-align:center}h1{color:#53fc18}</style></head>
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
                const authUrl = buildKickAuthUrl({
                    clientId: payload.clientId,
                    scopes: payload.scopes || ['user:read', 'channel:read', 'chat:write', 'events:subscribe'],
                    redirectUri,
                    codeChallenge,
                    state: stateParam
                });

                payload.redirectUri = redirectUri;

                try {
                    await shell.openExternal(authUrl, { activate: true });
                    console.log('[Kick OAuth] Opening auth URL in default browser');
                } catch (shellError) {
                    console.error('[Kick OAuth] Failed to launch default browser:', shellError);
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
        })().catch(reject);
    });
}

function setupKickOAuthHandler() {
    if (ipcMain.listenerCount('kick-oauth') > 0) {
        return;
    }
    ipcMain.handle('kick-oauth', async (_event, payload = {}) => {
        if (activeSession && typeof activeSession.fail === 'function') {
            console.warn('[Kick OAuth] Aborting previous pending session in favor of the new request.');
            activeSession.fail(new Error('Previous Kick authentication was interrupted by a new request.'));
        }
        return runKickLoopbackOAuthSession(payload);
    });
}

module.exports = {
    setupKickOAuthHandler
};
