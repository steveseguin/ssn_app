'use strict';

const crypto = require("crypto");
const http = require("http");
const { ipcMain, shell } = require("electron");

const AUTH_START = "https://sso.socialstream.ninja/auth/instagram/start";
const CALLBACK_PATH = "/sources/websocket/instagram.html";
const RESULT_PATH = "/__instagram_oauth_result__";
const TIMEOUT_MS = 5 * 60 * 1000;
let activeSession = null;
let registered = false;

function isInstagramSource(event) {
    try {
        const url = new URL(event.senderFrame.url);
        const trustedOrigin = url.protocol === "file:" ||
            (url.protocol === "https:" && url.hostname === "socialstream.ninja") ||
            (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
        return trustedOrigin && /\/sources\/websocket\/instagram\.html$/.test(url.pathname);
    } catch (_) {
        return false;
    }
}

function decodeResult(value) {
    const result = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
    if (result.type === "ssn-instagram-auth-error") {
        return { type: result.type, message: String(result.message || "Instagram sign-in was not completed.") };
    }
    if (result.type !== "ssn-instagram-auth-success" || result.login !== "facebook" ||
        typeof result.accessToken !== "string" || !result.accessToken.trim()) {
        throw new Error("Instagram sign-in returned an unexpected response.");
    }
    return {
        type: result.type,
        login: "facebook",
        accessToken: result.accessToken.trim(),
        user: result.user && typeof result.user === "object" ? {
            id: String(result.user.id || ""), name: String(result.user.name || "")
        } : null
    };
}

function callbackHtml(nonce) {
    return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="referrer" content="no-referrer"><title>Instagram sign-in</title>
<body><h1>Instagram sign-in</h1><p id="status">Returning your sign-in to Social Stream...</p>
<script nonce="${nonce}">
(function () {
    var hash = new URLSearchParams(location.hash.slice(1));
    var result = hash.get('instagram_auth_result') || hash.get('instagram_auth_error');
    history.replaceState(null, '', location.pathname);
    if (!result) { document.getElementById('status').textContent = 'No sign-in result was received. Return to Social Stream and try again.'; return; }
    fetch('${RESULT_PATH}', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: '${nonce}', result: result })
    }).then(function (response) {
        if (!response.ok) throw new Error('Sign-in could not be returned to Social Stream.');
        document.getElementById('status').textContent = 'Social Stream received the sign-in result. You can close this tab.';
        setTimeout(function () { window.close(); }, 1200);
    }).catch(function (error) { document.getElementById('status').textContent = error.message; });
})();
</script></body></html>`;
}

function listen(server, port) {
    return new Promise((resolve, reject) => {
        const failed = (error) => { server.removeListener("listening", ready); reject(error); };
        const ready = () => { server.removeListener("error", failed); resolve(port); };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(port, "127.0.0.1");
    });
}

function startInstagramSession(sender) {
    return new Promise((resolve, reject) => {
        const nonce = crypto.randomBytes(24).toString("hex");
        let origin = "";
        let settled = false;
        let timeout = null;
        let session;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            sender.removeListener("destroyed", onDestroyed);
            sender.removeListener("did-start-navigation", onNavigation);
            server.close();
            if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
            if (activeSession === session) activeSession = null;
            if (error) reject(error); else resolve(result);
        };
        const onDestroyed = () => finish(new Error("Instagram source closed."));
        const onNavigation = (_event, _url, _inPlace, isMainFrame) => {
            if (isMainFrame) finish(new Error("Instagram source navigated away."));
        };
        const server = http.createServer((request, response) => {
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Referrer-Policy", "no-referrer");
            response.setHeader("X-Content-Type-Options", "nosniff");
            response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
            if (!origin || request.headers.host !== new URL(origin).host) {
                response.writeHead(403); response.end(); return;
            }
            const url = new URL(request.url || "/", origin);
            if (request.method === "GET" && url.pathname === CALLBACK_PATH && url.searchParams.get("ssn_instagram_state") === nonce) {
                response.setHeader("Content-Type", "text/html; charset=utf-8");
                response.end(callbackHtml(nonce));
                return;
            }
            if (request.method !== "POST" || url.pathname !== RESULT_PATH || request.headers.origin !== origin) {
                response.writeHead(403); response.end(); return;
            }
            let body = "";
            let size = 0;
            request.on("data", (chunk) => {
                size += chunk.length;
                if (size > 65536) { request.destroy(); return; }
                body += chunk;
            });
            request.on("end", () => {
                if (settled) { response.writeHead(410); response.end(); return; }
                try {
                    const incoming = JSON.parse(body);
                    if (incoming.nonce !== nonce) { response.writeHead(403); response.end(); return; }
                    const result = decodeResult(incoming.result);
                    response.writeHead(200, { "Content-Type": "application/json" });
                    response.end('{"ok":true}', () => finish(null, result));
                } catch (_) {
                    response.writeHead(400); response.end();
                }
            });
        });
        server.requestTimeout = 10000;
        server.headersTimeout = 10000;
        session = { senderId: sender.id, cancel: () => finish(new Error("Instagram sign-in cancelled.")) };
        activeSession = session;
        sender.once("destroyed", onDestroyed);
        sender.on("did-start-navigation", onNavigation);
        timeout = setTimeout(() => finish(new Error("Instagram sign-in timed out. Please try again.")), TIMEOUT_MS);
        (async () => {
            try {
                let port;
                for (const candidate of [8181, 8080]) {
                    try { port = await listen(server, candidate); break; }
                    catch (error) { if (error.code !== "EADDRINUSE") throw error; }
                }
                if (!port) throw new Error("Ports 8181 and 8080 are busy. Free one of them and try signing in again.");
                if (settled) { server.close(); return; }
                origin = `http://127.0.0.1:${port}`;
                const returnTo = new URL(CALLBACK_PATH, origin);
                returnTo.searchParams.set("ssn_instagram_state", nonce);
                const startUrl = new URL(AUTH_START);
                startUrl.searchParams.set("return_to", returnTo.toString());
                await shell.openExternal(startUrl.toString(), { activate: true });
            } catch (error) { finish(error); }
        })();
    });
}

function setupInstagramOAuthHandler() {
    if (registered) return;
    registered = true;
    ipcMain.handle("instagram-oauth", async (event) => {
        if (!isInstagramSource(event)) throw new Error("Open the Instagram API source to sign in.");
        if (activeSession) throw new Error("An Instagram sign-in is already open. Complete it or clear sign-in in that source first.");
        return startInstagramSession(event.sender);
    });
    ipcMain.handle("instagram-oauth-cancel", async (event) => {
        if (isInstagramSource(event) && activeSession && activeSession.senderId === event.sender.id) activeSession.cancel();
        return { ok: true };
    });
}

module.exports = { setupInstagramOAuthHandler };
