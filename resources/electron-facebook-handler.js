'use strict';

const http = require("http");
const url = require("url");
const { dialog, ipcMain, shell } = require("electron");

const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_PORTS = [8181, 8080];
const CALLBACK_PATH = "/sources/websocket/facebook.html";
const RESULT_ENDPOINT = "/__facebook_oauth_result__";
const DEFAULT_AUTH_BASE = "https://auth.socialstream.ninja/auth/facebook/pages";
const DEFAULT_API_VERSION = "v25.0";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const AUTH_MESSAGE_SUCCESS = "ssn-facebook-auth-success";
const AUTH_MESSAGE_ERROR = "ssn-facebook-auth-error";
const AUTH_RESULT_KEY = "facebook_auth_result";
const AUTH_ERROR_KEY = "facebook_auth_error";

let activeSession = null;

function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str.replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function normalizeAuthBase(value) {
    return String(value || DEFAULT_AUTH_BASE).trim().replace(/\/+$/, "");
}

function buildFacebookStartUrl({ authBase, returnTo, origin }) {
    const target = new URL(`${normalizeAuthBase(authBase)}/start`);
    target.searchParams.set("return_to", returnTo || "");
    if (origin) {
        target.searchParams.set("origin", origin);
    }
    return target.toString();
}

function decodeBase64UrlJson(value) {
    if (!value) return null;
    try {
        const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized + "===".slice((normalized.length + 3) % 4);
        const decoded = Buffer.from(padded, "base64").toString("utf8");
        return JSON.parse(decoded);
    } catch (_) {
        return null;
    }
}

function createFacebookAuthErrorPayload(message) {
    return {
        type: AUTH_MESSAGE_ERROR,
        message: String(message || "Facebook sign-in failed.")
    };
}

function extractFacebookAuthPayload(payload = {}) {
    if (payload && payload.payload && typeof payload.payload === "object") {
        return payload.payload;
    }
    if (payload && typeof payload.result === "string") {
        const decodedResult = decodeBase64UrlJson(payload.result);
        if (decodedResult) {
            return decodedResult;
        }
    }
    if (payload && typeof payload.error === "string") {
        const decodedError = decodeBase64UrlJson(payload.error);
        if (decodedError) {
            return decodedError;
        }
    }
    if (payload && (payload.queryError || payload.errorDescription)) {
        return createFacebookAuthErrorPayload(payload.errorDescription || payload.queryError);
    }
    return null;
}

function buildLoopbackHtml() {
    return `<!DOCTYPE html>
<html>
<head>
    <title>Facebook Authorization</title>
    <style>
        body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0b1018; color: #fff; }
        .container { text-align: center; padding: 32px; }
        .spinner { width: 40px; height: 40px; border: 4px solid #1e2a3d; border-top: 4px solid #4fe3a1; border-radius: 50%; animation: spin 1s linear infinite; margin: 20px auto; }
        .success { color: #4fe3a1; }
        .error { color: #ff6b7c; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <h1>Facebook Authorization</h1>
        <div class="spinner" id="spinner"></div>
        <p id="status">Processing authorization...</p>
    </div>
    <script>
        (function () {
            var spinner = document.getElementById('spinner');
            var status = document.getElementById('status');
            var hash = new URLSearchParams(window.location.hash.substring(1));
            var search = new URLSearchParams(window.location.search.substring(1));
            var result = hash.get('${AUTH_RESULT_KEY}') || search.get('${AUTH_RESULT_KEY}') || '';
            var error = hash.get('${AUTH_ERROR_KEY}') || search.get('${AUTH_ERROR_KEY}') || '';
            var queryError = search.get('error') || '';
            var errorDescription = search.get('error_description') || '';
            var hasSuccess = !!result;
            var hasFailure = !!error || !!queryError;

            if (!hasSuccess && !hasFailure) {
                status.textContent = 'Complete authorization in the browser.';
                return;
            }

            fetch('${RESULT_ENDPOINT}', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    result: result,
                    error: error,
                    queryError: queryError,
                    errorDescription: errorDescription
                })
            }).then(function () {
                spinner.style.display = 'none';
                status.className = hasSuccess ? 'success' : 'error';
                status.textContent = hasSuccess
                    ? 'Success! You can close this window and return to Social Stream.'
                    : 'Facebook sign-in did not complete.';
                setTimeout(function () { window.close(); }, hasSuccess ? 1500 : 3000);
            }).catch(function (fetchError) {
                spinner.style.display = 'none';
                status.className = 'error';
                status.textContent = 'Failed to complete authorization: ' + (fetchError && fetchError.message ? fetchError.message : fetchError);
            });
        })();
    </script>
</body>
</html>`;
}

function tryListenOnPort(server, port) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.removeListener("listening", onListening);
            reject(err);
        };
        const onListening = () => {
            server.removeListener("error", onError);
            resolve(port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, LOOPBACK_HOST);
    });
}

async function tryStartServer(server) {
    for (const port of LOOPBACK_PORTS) {
        try {
            await tryListenOnPort(server, port);
            console.log(`[Facebook OAuth] Server started on port ${port}`);
            return port;
        } catch (error) {
            if (error && error.code === "EADDRINUSE") {
                console.log(`[Facebook OAuth] Port ${port} in use, trying next...`);
                continue;
            }
            throw error;
        }
    }
    const error = new Error("PORTS_UNAVAILABLE");
    error.code = "PORTS_UNAVAILABLE";
    throw error;
}

function runFacebookLoopbackOAuthSession(payload = {}) {
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

            if (req.method === "POST" && parsed.pathname === RESULT_ENDPOINT) {
                let body = "";
                let bodySize = 0;
                req.on("data", (chunk) => {
                    bodySize += chunk.length;
                    if (bodySize > 65536) {
                        req.destroy();
                        return;
                    }
                    body += chunk;
                });
                req.on("end", () => {
                    try {
                        const incoming = body ? JSON.parse(body) : {};
                        const authPayload = extractFacebookAuthPayload(incoming);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: true }));
                        if (!authPayload || typeof authPayload !== "object") {
                            fail(new Error("Facebook sign-in returned an unexpected response."));
                            return;
                        }
                        complete(authPayload);
                    } catch (error) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: false, error: "invalid_payload" }));
                        fail(error);
                    }
                });
                return;
            }

            if (parsed.pathname === CALLBACK_PATH || parsed.pathname === "/callback" || parsed.pathname === "/") {
                if (query.error) {
                    const authPayload = createFacebookAuthErrorPayload(query.error_description || query.error);
                    res.writeHead(200, { "Content-Type": "text/html" });
                    res.end(`<!DOCTYPE html>
<html><head><title>Facebook Authorization Failed</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0b1018;color:#fff}.container{text-align:center}h1{color:#ff6b7c}</style></head>
<body><div class="container"><h1>Authorization Failed</h1><p>${escapeHtml(authPayload.message)}</p></div>
<script>setTimeout(function(){ window.close(); }, 3000);</script></body></html>`);
                    complete(authPayload);
                    return;
                }

                res.writeHead(200, { "Content-Type": "text/html" });
                res.end(buildLoopbackHtml());
                return;
            }

            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not found");
        });

        (async () => {
            try {
                const port = await tryStartServer(server);
                const redirectUri = `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`;
                const authUrl = buildFacebookStartUrl({
                    authBase: payload.authBase,
                    returnTo: redirectUri,
                    origin: `http://${LOOPBACK_HOST}:${port}`
                });

                payload.redirectUri = redirectUri;

                try {
                    await shell.openExternal(authUrl, { activate: true });
                    console.log("[Facebook OAuth] Opening auth URL in default browser");
                } catch (shellError) {
                    console.error("[Facebook OAuth] Failed to launch default browser:", shellError);
                    fail(shellError);
                }
            } catch (error) {
                if (error && error.code === "PORTS_UNAVAILABLE") {
                    dialog.showMessageBox({
                        type: "error",
                        title: "Unable to Sign In",
                        message: "Port Conflict Detected",
                        detail: "Both ports 8080 and 8181 are in use by other applications.\n\n" +
                                "Common causes:\n" +
                                "- Streamer.bot (uses port 8080 by default)\n" +
                                "- Other streaming software\n\n" +
                                "To fix this:\n" +
                                "1. Stop applications using these ports, OR\n" +
                                "2. Configure Streamer.bot to use a different port (for example 9000)\n\n" +
                                "Then try signing in again.",
                        buttons: ["OK"]
                    });
                }
                fail(error);
            }
        })();

        const timeoutMs = Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : DEFAULT_TIMEOUT_MS;
        timeoutId = setTimeout(() => {
            fail(new Error("OAuth timeout"));
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

function createFacebookExchangeError(prefix, response, payload) {
    const message = payload && (payload.message || payload.error) ? (payload.message || payload.error) : `${prefix}: HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload || null;
    return error;
}

async function exchangeFacebookOAuthCode(payload = {}) {
    const code = String(payload.code || "").trim();
    const redirectUri = String(payload.redirectUri || payload.redirect_uri || "").trim();
    const authBase = normalizeAuthBase(payload.authBase);

    if (!code) throw new Error("Missing Facebook OAuth authorization code.");
    if (!redirectUri) throw new Error("Missing Facebook OAuth redirect URI.");

    const response = await fetch(`${authBase}/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            code,
            redirectUri,
            apiVersion: payload.apiVersion || DEFAULT_API_VERSION
        })
    });
    const body = await readJsonResponse(response);
    if (!response.ok) {
        throw createFacebookExchangeError("Facebook token exchange failed", response, body);
    }
    return body;
}

function setupFacebookOAuthHandler() {
    if (ipcMain.listenerCount("facebook-oauth") === 0) {
        ipcMain.handle("facebook-oauth", async (_event, payload = {}) => {
            if (activeSession && typeof activeSession.fail === "function") {
                console.warn("[Facebook OAuth] Aborting previous pending session in favor of the new request.");
                activeSession.fail(new Error("Previous Facebook authentication was interrupted by a new request."));
            }
            return runFacebookLoopbackOAuthSession(payload);
        });
    }
    if (ipcMain.listenerCount("facebook-oauth-exchange") === 0) {
        ipcMain.handle("facebook-oauth-exchange", async (_event, payload = {}) => {
            return exchangeFacebookOAuthCode(payload);
        });
    }
}

module.exports = {
    setupFacebookOAuthHandler,
    AUTH_MESSAGE_SUCCESS,
    AUTH_MESSAGE_ERROR
};
