"use strict";

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const url = require("url");
const { dialog, ipcMain, shell } = require("electron");

const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_PORTS = [8181, 8080];
const CALLBACK_PATH = "/sources/websocket/vpzone.html";
const AUTH_BASE = "https://vpzone.tv/oauth/authorize";
const TOKEN_URL = "https://vpzone.tv/api/oauth/token";
const DEFAULT_SCOPES = ["profile:read", "channel:read", "chat:read"];
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

let activeSession = null;

function escapeHtml(str) {
	if (typeof str !== "string") return "";
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function base64Url(buffer) {
	return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generateRandomString(length) {
	return base64Url(crypto.randomBytes(length)).slice(0, length);
}

function createCodeChallenge(verifier) {
	return base64Url(crypto.createHash("sha256").update(verifier).digest());
}

function buildVpzoneAuthUrl({ clientId, scopes, redirectUri, codeChallenge, state }) {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: clientId || "",
		redirect_uri: redirectUri || "",
		scope: Array.isArray(scopes) ? scopes.join(" ") : String(scopes || ""),
		state: state || "",
		code_challenge: codeChallenge || "",
		code_challenge_method: "S256"
	});
	return `${AUTH_BASE}?${params.toString()}`;
}

function postForm(endpoint, params) {
	return new Promise((resolve, reject) => {
		const target = new URL(endpoint);
		const body = new URLSearchParams();
		Object.keys(params || {}).forEach((key) => {
			if (params[key] !== undefined && params[key] !== null && params[key] !== "") body.set(key, params[key]);
		});
		const request = https.request({
			method: "POST",
			hostname: target.hostname,
			path: target.pathname + target.search,
			headers: {
				"Accept": "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
				"Content-Length": Buffer.byteLength(body.toString())
			}
		}, (response) => {
			let text = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => { text += chunk; });
			response.on("end", () => {
				let json = {};
				try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { error: text || "Invalid JSON response" }; }
				if (response.statusCode < 200 || response.statusCode >= 300) {
					reject(new Error(json.error_description || json.error || json.message || `HTTP ${response.statusCode}`));
					return;
				}
				resolve(json);
			});
		});
		request.on("error", reject);
		request.write(body.toString());
		request.end();
	});
}

function exchangeVpzoneCode({ clientId, code, redirectUri, codeVerifier }) {
	return postForm(TOKEN_URL, {
		grant_type: "authorization_code",
		client_id: clientId,
		code,
		redirect_uri: redirectUri,
		code_verifier: codeVerifier
	});
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
			console.log(`[VPZONE OAuth] Server started on port ${port}`);
			return port;
		} catch (error) {
			if (error && error.code === "EADDRINUSE") {
				console.log(`[VPZONE OAuth] Port ${port} in use, trying next...`);
				continue;
			}
			throw error;
		}
	}
	const error = new Error("PORTS_UNAVAILABLE");
	error.code = "PORTS_UNAVAILABLE";
	throw error;
}

function sendHtml(res, title, message, ok) {
	res.writeHead(200, { "Content-Type": "text/html" });
	res.end(`<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#071018;color:#eef6ff}.box{text-align:center;padding:32px}.ok{color:#68f0b7}.err{color:#ff8898}</style></head><body><div class="box"><h1 class="${ok ? "ok" : "err"}">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div><script>setTimeout(function(){window.close();},${ok ? 1500 : 3500});</script></body></html>`);
}

function runVpzoneLoopbackOAuthSession(payload = {}) {
	return new Promise((resolve, reject) => {
		let timeoutId = null;
		let settled = false;
		let server = null;
		let session = null;
		let redirectUri = null;
		const clientId = payload.clientId || "";
		const scopes = payload.scopes || DEFAULT_SCOPES;
		const codeVerifier = generateRandomString(64);
		const codeChallenge = createCodeChallenge(codeVerifier);
		const stateParam = payload.state || generateRandomString(32);

		const cleanup = () => {
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = null;
			}
			if (server) {
				try { server.close(); } catch (_) {}
				server = null;
			}
			if (activeSession === session) activeSession = null;
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
			(async () => {
				const parsed = url.parse(req.url, true);
				const query = parsed.query || {};

				if (parsed.pathname !== CALLBACK_PATH && parsed.pathname !== "/callback" && parsed.pathname !== "/") {
					res.writeHead(404, { "Content-Type": "text/plain" });
					res.end("Not found");
					return;
				}

				if (query.error) {
					sendHtml(res, "Authorization Failed", query.error_description || query.error, false);
					fail(new Error(query.error_description || query.error));
					return;
				}

				if (!query.code) {
					sendHtml(res, "VPZONE Authorization", "Complete authorization in the browser.", true);
					return;
				}

				if (query.state !== stateParam) {
					sendHtml(res, "Authorization Failed", "State mismatch. Please try again.", false);
					fail(new Error("State mismatch"));
					return;
				}

				try {
					const token = await exchangeVpzoneCode({
						clientId,
						code: query.code,
						redirectUri,
						codeVerifier
					});
					sendHtml(res, "Success", "You can close this window and return to Social Stream.", true);
					complete(Object.assign({ success: true, redirectUri }, token));
				} catch (error) {
					sendHtml(res, "Authorization Failed", error && error.message ? error.message : String(error), false);
					fail(error);
				}
			})().catch((error) => {
				try { sendHtml(res, "Authorization Failed", error && error.message ? error.message : String(error), false); } catch (_) {}
				fail(error);
			});
		});

		(async () => {
			try {
				const port = await tryStartServer(server);
				redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
				const authUrl = buildVpzoneAuthUrl({ clientId, scopes, redirectUri, codeChallenge, state: stateParam });
				await shell.openExternal(authUrl, { activate: true });
				console.log("[VPZONE OAuth] Opening auth URL in default browser");
			} catch (error) {
				if (error && error.code === "PORTS_UNAVAILABLE") {
					dialog.showMessageBox({
						type: "error",
						title: "Unable to Sign In",
						message: "Port Conflict Detected",
						detail: "Both ports 8181 and 8080 are in use. Close the app using one of those ports, then try again.",
						buttons: ["OK"]
					});
				}
				fail(error);
			}
		})();

		const timeoutMs = Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : DEFAULT_TIMEOUT_MS;
		timeoutId = setTimeout(() => fail(new Error("OAuth timeout")), timeoutMs);
	});
}

function setupVpzoneOAuthHandler() {
	if (ipcMain.listenerCount("vpzone-oauth") > 0) return;
	ipcMain.handle("vpzone-oauth", async (_event, payload = {}) => {
		if (activeSession && typeof activeSession.fail === "function") {
			console.warn("[VPZONE OAuth] Aborting previous pending session in favor of the new request.");
			activeSession.fail(new Error("Previous VPZONE authentication was interrupted by a new request."));
		}
		return runVpzoneLoopbackOAuthSession(payload);
	});
}

module.exports = {
	setupVpzoneOAuthHandler
};
