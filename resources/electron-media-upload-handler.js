'use strict';

const crypto = require("crypto");
const http = require("http");
const { URL } = require("url");
const { ipcMain, shell } = require("electron");

const LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/media-upload-callback";
const DEFAULT_UPLOAD_URL = "https://fileuploads.socialstream.ninja/popup/upload";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const ALLOWED_MEDIA_HOSTS = new Set([
    "fileuploads.socialstream.ninja",
    "fileuploads.vdo.ninja"
]);

let activeSession = null;

function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function createRandomId() {
    return crypto.randomBytes(16).toString("hex");
}

function isAllowedUploadedUrl(value) {
    let parsed;
    try {
        parsed = new URL(String(value || ""));
    } catch (_) {
        return false;
    }

    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    if (!ALLOWED_MEDIA_HOSTS.has(parsed.hostname.toLowerCase())) return false;
    if (!/^\/media\/[a-zA-Z0-9_-]+$/.test(parsed.pathname)) return false;
    return true;
}

function writeHtml(res, title, heading, message, isError = false) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html><head><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#111827;color:#f9fafb}.container{text-align:center;max-width:520px;padding:32px}h1{color:${isError ? "#f87171" : "#34d399"}}</style></head>
<body><div class="container"><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p></div>
<script>setTimeout(function(){ window.close(); }, ${isError ? 3000 : 1500});</script></body></html>`);
}

function buildUploadUrl(callbackUrl, callbackId, callbackState) {
    const uploadUrl = new URL(DEFAULT_UPLOAD_URL);
    uploadUrl.searchParams.set("callback_url", callbackUrl);
    uploadUrl.searchParams.set("callback_id", callbackId);
    uploadUrl.searchParams.set("callback_state", callbackState);
    return uploadUrl.toString();
}

function runMediaUploadSession(payload = {}) {
    return new Promise((resolve, reject) => {
        let timeoutId = null;
        let settled = false;
        let server = null;
        let session = null;
        const callbackId = createRandomId();
        const callbackState = createRandomId();

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
            let parsed;
            try {
                parsed = new URL(req.url || "/", `http://${LOOPBACK_HOST}`);
            } catch (_) {
                res.writeHead(400, { "Content-Type": "text/plain" });
                res.end("Bad request");
                return;
            }

            if (req.method !== "GET" || parsed.pathname !== CALLBACK_PATH) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not found");
                return;
            }

            const returnedId = parsed.searchParams.get("callback_id") || "";
            const returnedState = parsed.searchParams.get("state") || parsed.searchParams.get("callback_state") || "";
            const uploadedUrl = parsed.searchParams.get("url") || "";

            if (returnedId !== callbackId || returnedState !== callbackState) {
                writeHtml(res, "Upload Failed", "Upload callback rejected", "The upload callback did not match this upload request.", true);
                fail(new Error("Media upload callback validation failed."));
                return;
            }

            if (!isAllowedUploadedUrl(uploadedUrl)) {
                writeHtml(res, "Upload Failed", "Upload URL rejected", "The uploaded media URL was not from an allowed host.", true);
                fail(new Error("Media upload returned an invalid URL."));
                return;
            }

            writeHtml(res, "Upload Complete", "Upload complete", "You can close this window and return to Social Stream.");
            complete({
                success: true,
                url: uploadedUrl,
                filename: parsed.searchParams.get("filename") || null,
                contentType: parsed.searchParams.get("content_type") || parsed.searchParams.get("contentType") || null
            });
        });

        server.once("error", fail);
        server.listen(0, LOOPBACK_HOST, async () => {
            try {
                const address = server.address();
                const port = address && typeof address === "object" ? address.port : 0;
                if (!port) throw new Error("Unable to determine media upload callback port.");

                const callbackUrl = `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`;
                const uploadUrl = buildUploadUrl(callbackUrl, callbackId, callbackState);

                await shell.openExternal(uploadUrl, { activate: true });
                console.log("[Media Upload] Opening upload page in default browser");
            } catch (error) {
                fail(error);
            }
        });

        const timeoutMs = Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : DEFAULT_TIMEOUT_MS;
        timeoutId = setTimeout(() => {
            fail(new Error("Media upload timeout"));
        }, timeoutMs);
    });
}

function setupMediaUploadHandler() {
    if (ipcMain.listenerCount("media-upload") > 0) {
        return;
    }

    ipcMain.handle("media-upload", async (_event, payload = {}) => {
        if (activeSession && typeof activeSession.fail === "function") {
            console.warn("[Media Upload] Aborting previous pending upload in favor of the new request.");
            activeSession.fail(new Error("Previous media upload was interrupted by a new request."));
        }
        return runMediaUploadSession(payload);
    });
}

module.exports = {
    setupMediaUploadHandler
};
