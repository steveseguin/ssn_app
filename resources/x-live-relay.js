'use strict';

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const { createInterface } = require("node:readline");
const { Readable } = require("node:stream");
const { WebSocketServer, WebSocket } = require("ws");

const EVENT_TYPES = ["broadcast.start", "broadcast.end", "broadcast.chat", "broadcast.chat.remove"];
const LOCAL_ORIGIN = "http://127.0.0.1:38178";
const API = "https://api.x.com/2";
const randomKey = () => crypto.randomBytes(32).toString("base64url");

function readXConfig(filename) {
	let values = {};
	if (filename && fs.existsSync(filename)) {
		values = require("node:util").parseEnv(fs.readFileSync(filename, "utf8"));
	}
	const get = key => process.env[key] || values[key] || "";
	return {
		clientId: get("X_OAUTH_CLIENT_ID"),
		clientSecret: get("X_OAUTH_CLIENT_SECRET"),
		appToken: get("X_APP_BEARER_TOKEN"),
		relayUrl: get("SSAPP_X_RELAY_URL")
	};
}

// Each desktop receives only events for the broadcaster who linked that source.
async function startXRelay(config, options = {}) {
	if (!config.clientId || !config.appToken) {
		throw new Error("Set X_OAUTH_CLIENT_ID and X_APP_BEARER_TOKEN in .secret or the environment.");
	}
	const origin = options.origin || LOCAL_ORIGIN;
	const useWebhook = options.webhook === true;
	if (useWebhook && (!config.clientSecret || new URL(origin).protocol !== "https:")) {
		throw new Error("Webhook delivery needs X_OAUTH_CLIENT_SECRET and an HTTPS X_RELAY_PUBLIC_ORIGIN.");
	}
	const redirect = origin + "/x/callback";
	const key = crypto.createHmac("sha256", config.appToken).update("ssn-x-session:" + config.clientId).digest();
	const fetchApi = options.fetch || fetch;
	const clients = new Set();
	const logins = new Map();
	let stream, retry, streamIssue = "", interruptedAt = 0, backoff = 1000;
	let webhookRegistration, lastWebhookId, webhookRefreshAt = 0, nextEnrollmentLog = 0;

	function signInError(message) {
		return Object.assign(new Error(message), { requiresLogin: true });
	}

	// Only the creator's source holds this ticket. It can survive a relay restart.
	function ticket(tokens, owner) {
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
		const data = Buffer.concat([cipher.update(JSON.stringify({ tokens, owner })), cipher.final()]);
		return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
	}
	function unpack(value) {
		try {
			const buf = Buffer.from(value, "base64url");
			const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
			decipher.setAuthTag(buf.subarray(12, 28));
			return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]));
		} catch (_) { throw signInError("Sign in to X again."); }
	}
	async function request(path, init) {
		const res = await fetchApi(API + path, { ...init, redirect: "error", signal: AbortSignal.timeout(15000) });
		if (!res.ok) {
			throw await apiError(res, path.split("?")[0]);
		}
		if (res.status === 204) return null;
		return res.json();
	}
	async function apiError(res, path) {
		const detail = await res.json().catch(() => ({}));
		let message = "X rejected " + path + " (HTTP " + res.status + ").";
		if (detail?.reason === "client-not-enrolled") {
			message += " Check this app's API access in the X Developer Console (client-not-enrolled).";
			if (origin !== LOCAL_ORIGIN) {
				if (Date.now() >= nextEnrollmentLog) {
					console.warn("[X Live] " + message);
					nextEnrollmentLog = Date.now() + 3600000;
				}
				message = "X has not enabled live chat for this relay. Open your broadcast on X to follow chat for now.";
			}
		}
		const error = new Error(message);
		error.status = res.status;
		error.requiresLogin = detail?.reason !== "client-not-enrolled" && (res.status === 401 || detail?.error === "invalid_grant");
		if (res.status === 429) {
			const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000 - Date.now();
			const after = Number(res.headers.get("retry-after")) * 1000;
			error.retryMs = Math.max(after || 0, reset || 0, 1000);
		}
		return error;
	}
	async function exchange(params) {
		const headers = {};
		if (config.clientSecret) headers.Authorization = "Basic " + Buffer.from(config.clientId + ":" + config.clientSecret).toString("base64");
		const tokens = await request("/oauth2/token", { method: "POST", headers,
			body: new URLSearchParams({ client_id: config.clientId, ...params }) });
		if (!tokens.access_token) throw new Error("X did not return an access token.");
		return { access: tokens.access_token, refresh: tokens.refresh_token || params.refresh_token,
			expires: Date.now() + Number(tokens.expires_in || 7200) * 1000 };
	}
	function send(c, message) {
		if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(message));
	}
	async function token(c) {
		if (c.tokens.expires > Date.now() + 60000) return c.tokens.access;
		if (!c.tokens.refresh) throw signInError("Sign in to X again.");
		if (!c.refreshing) c.refreshing = exchange({ grant_type: "refresh_token", refresh_token: c.tokens.refresh })
			.then(tokens => {
				c.tokens = tokens;
				send(c, { ticket: ticket(tokens, c.owner) });
				return tokens.access;
			}).finally(() => { c.refreshing = null; });
		return c.refreshing;
	}
	async function userApi(c, path, body, method, broadcast) {
		const headers = { Authorization: "Bearer " + await token(c) };
		if (broadcast && (!c.listening || c.broadcast !== broadcast || c.ws.readyState !== WebSocket.OPEN)) {
			throw new Error("The X broadcast connection changed.");
		}
		if (!body) return request(path, { method: method || "GET", headers });
		headers["Content-Type"] = "application/json";
		return request(path, { headers, method: method || "POST", body: JSON.stringify(body) });
	}
	async function registerWebhook() {
		const url = origin + "/x/webhook";
		const headers = { Authorization: "Bearer " + config.appToken };
		const hooks = await request("/webhooks", { headers });
		const existing = (hooks.data || []).find(hook => hook.url === url);
		if (existing?.valid === true) return existing.id;
		if (existing) {
			await request("/webhooks/" + encodeURIComponent(existing.id), { method: "PUT", headers });
			const checked = await request("/webhooks", { headers });
			if (checked.data?.some(hook => hook.id === existing.id && hook.valid === true)) return existing.id;
		} else {
			const registered = await request("/webhooks", { method: "POST",
				headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
			if (registered.data?.id && registered.data.valid === true) return registered.data.id;
		}
		throw new Error("X could not verify " + url + ".");
	}
	function ensureWebhook() {
		// Every account on this relay uses the same webhook. Share both the lookup and its result.
		if (!webhookRegistration || Date.now() >= webhookRefreshAt) {
			webhookRefreshAt = Infinity;
			webhookRegistration = registerWebhook().then(id => {
				lastWebhookId = id;
				webhookRefreshAt = Date.now() + 6 * 3600000;
				return id;
			}, error => {
				// This check uses the relay's credentials, not the broadcaster's.
				error.requiresLogin = false;
				const retryMs = Math.max(error.retryMs || 0, 60000);
				webhookRefreshAt = Date.now() + retryMs;
				if (lastWebhookId && (error.retryMs || error.status >= 500 || ["TypeError", "TimeoutError"].includes(error.name))) return lastWebhookId;
				lastWebhookId = null;
				error.retryMs = retryMs;
				throw error;
			});
		}
		return webhookRegistration;
	}
	async function subscribe(c) {
		const registration = useWebhook ? ensureWebhook() : null;
		const webhookId = await registration;
		try {
			await subscribeEvents(c, webhookId);
		} catch (error) {
			if (!registration || ![400, 404, 410, 422].includes(error.status)) throw error;
			// X may have disabled or replaced the saved hook. Recheck once across all clients.
			if (registration === webhookRegistration) {
				lastWebhookId = null;
				webhookRefreshAt = 0;
			}
			await subscribeEvents(c, await ensureWebhook());
		}
	}
	async function subscribeEvents(c, webhookId) {
		const expires = new Date(Date.now() + 2 * 3600000).toISOString();
		for (const event_type of EVENT_TYPES) {
			if (c.ws.readyState !== WebSocket.OPEN) return;
			const body = { event_type, filter: { user_id: c.owner.id }, expires_at: expires };
			if (webhookId) body.webhook_id = webhookId;
			const response = await userApi(c, "/activity/subscriptions", body);
			if (webhookId) {
				const sub = response?.data?.subscription || response?.data;
				if (!sub?.subscription_id) {
					throw Object.assign(new Error("X did not confirm the " + event_type + " subscription."), { retryMs: 60000 });
				}
				if (sub.webhook_id !== webhookId) {
					await userApi(c, "/activity/subscriptions/" + encodeURIComponent(sub.subscription_id), { webhook_id: webhookId }, "PUT");
				}
			}
		}
	}
	function queueChat(c, message) {
		if (!c.listening || !c.broadcast || message.broadcast !== c.broadcast) throw new Error("There is no matching live X broadcast.");
		if (typeof message.text !== "string" || !message.text.trim() || Array.from(message.text).length > 140) throw new Error("X chat accepts 1 to 140 characters.");
		if (c.pendingWrites >= 16) throw new Error("Too many X messages are waiting to send.");
		const queuedAt = Date.now();
		c.pendingWrites++;
		c.writes = c.writes.then(async () => {
			if (c.ws.readyState !== WebSocket.OPEN) return;
			if (message.broadcast !== c.broadcast || !c.listening) throw new Error("The X broadcast has ended.");
			// Leave time for the 15-second API request before the source's 20-second send timeout.
			if (Date.now() - queuedAt > 4000) throw new Error("X chat is busy. Your message was not sent.");
			await userApi(c, "/broadcasts/" + encodeURIComponent(c.broadcast) + "/chat", { text: message.text }, "POST", message.broadcast);
			send(c, { sent: message.id });
		}).catch(error => send(c, { warning: error.message, failed: message.id }))
			.finally(() => { c.pendingWrites--; });
	}
	function syncViewerPoll(c) {
		const broadcast = c.watchViewers && c.listening && c.ws.readyState === WebSocket.OPEN ? c.broadcast : "";
		if (c.viewerPoll?.broadcast === broadcast) return;
		clearInterval(c.viewerPoll?.timer);
		c.viewerPoll = null;
		if (!broadcast) return;
		const poll = { broadcast, pending: false };
		c.viewerPoll = poll;
		async function readCount() {
			if (poll.pending) return;
			poll.pending = true;
			try {
				const response = await userApi(c, "/broadcasts/" + encodeURIComponent(broadcast) + "?broadcast.fields=total_watching");
				const raw = response.data?.total_watching;
				if (c.viewerPoll !== poll || !/^\d+$/.test(String(raw))) return;
				const count = Number(raw);
				if (Number.isSafeInteger(count)) send(c, { viewerCount: count, viewerBroadcast: broadcast });
			} catch (_) {
				// The next poll retries without interrupting live chat.
			} finally { poll.pending = false; }
		}
		poll.timer = setInterval(readCount, 30000);
		readCount();
	}
	async function currentBroadcast(c) {
		const revision = c.revision;
		let cursor;
		do {
			const params = new URLSearchParams({ "broadcast.fields": "id,state", max_results: "100" });
			if (cursor) params.set("pagination_token", cursor);
			const page = await userApi(c, "/broadcasts?" + params);
			if (revision !== c.revision || c.ws.readyState !== WebSocket.OPEN) return;
			const live = (page.data || []).find(item => String(item.state).toUpperCase() === "RUNNING");
			if (live) { c.broadcast = live.id || live.broadcast_id; break; }
			cursor = page.meta?.next_token;
			if (!cursor) c.broadcast = "";
		} while (cursor);
		send(c, { broadcast: c.broadcast });
		syncViewerPoll(c);
	}
	function dispatch(event) {
		if (!EVENT_TYPES.includes(event?.event_type) || !event.payload?.broadcast_id || !event.filter?.user_id) return;
		for (const c of clients) {
			if (!c.owner || c.owner.id !== event.filter.user_id || !c.listening) continue;
			const created = Date.parse(event.created_at);
			if (created < c.startedAt) continue;
			const p = event.payload;
			if (event.event_type === "broadcast.start" || event.event_type === "broadcast.end") {
				if (Number.isFinite(created)) {
					if (created < c.lifecycleAt) continue;
					c.lifecycleAt = created;
				}
				c.revision++;
				if (event.event_type === "broadcast.start") c.broadcast = p.broadcast_id;
				else if (c.broadcast === p.broadcast_id) c.broadcast = "";
				send(c, { broadcast: c.broadcast });
				syncViewerPoll(c);
			} else {
				send(c, { event: event.event_type, payload: p, createdAt: event.created_at });
			}
		}
	}
	function hasListeners() { return [...clients].some(c => c.listening); }
	async function readStream() {
		if (stream || retry || !hasListeners()) return;
		const control = new AbortController();
		stream = control;
		const connecting = setTimeout(() => {
			streamIssue = "X did not respond to the activity stream connection.";
			control.abort();
		}, 30000);
		let permanentError = false;
		let retryMs = 0;
		try {
			const minutes = Math.min(5, Math.ceil((Date.now() - interruptedAt) / 60000));
			const path = interruptedAt ? "/activity/stream?backfill_minutes=" + Math.max(1, minutes) : "/activity/stream";
			const res = await fetchApi(API + path, {
				headers: { Authorization: "Bearer " + config.appToken }, signal: control.signal, redirect: "error"
			});
			clearTimeout(connecting);
			if (!res.ok) {
				const retryWithoutBackfill = interruptedAt && [400, 403].includes(res.status);
				if (retryWithoutBackfill) interruptedAt = 0;
				permanentError = !retryWithoutBackfill && [400, 401, 403].includes(res.status);
				throw await apiError(res, "/activity/stream");
			}
			control.connected = true;
			streamIssue = "";
			for (const c of clients) if (c.listening) {
				send(c, { stream: true });
				if (interruptedAt) currentBroadcast(c).catch(error => send(c, { warning: error.message }));
			}
			interruptedAt = 0;
			const lines = createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
			for await (const line of lines) {
				if (!line.trim()) continue;
				const msg = JSON.parse(line);
				if (msg.errors?.length && !msg.data) throw new Error("X reported an activity stream error.");
				backoff = 1000;
				dispatch(msg.data);
			}
		} catch (error) {
			if (!control.signal.aborted) streamIssue = error.message;
			retryMs = error.retryMs || 0;
		} finally {
			clearTimeout(connecting);
			control.abort();
			stream = null;
			if (hasListeners()) {
				if (control.connected && !interruptedAt) interruptedAt = Date.now();
				for (const c of clients) if (c.listening) send(c, { stream: false, warning: streamIssue });
				if (!permanentError) {
					retry = setTimeout(() => { retry = null; readStream(); }, Math.max(retryMs, backoff));
					backoff = Math.min(backoff * 2, 60000);
				}
			} else { interruptedAt = 0; backoff = 1000; streamIssue = ""; }
		}
	}
	async function attach(c, saved) {
		if (c.owner) throw new Error("This source is already linked.");
		c.tokens = saved.tokens;
		c.owner = saved.owner;
		try {
			const me = (await userApi(c, "/users/me?user.fields=profile_image_url")).data;
			if (!me?.id || !me.username || (saved.owner && saved.owner.id !== me.id) ||
				(c.channel && c.channel !== me.username.toLowerCase())) throw signInError("Sign in with the X account selected for this source.");
			c.owner = { id: me.id, username: me.username };
			send(c, { ticket: ticket(c.tokens, c.owner), sourceName: me.name || me.username, sourceImg: me.profile_image_url || "" });
			c.startedAt = Date.now();
			c.listening = true;
			if (!useWebhook) readStream();
			await subscribe(c);
			await currentBroadcast(c);
			if (!clients.has(c)) return;
			send(c, { account: me.username, stream: useWebhook || !!stream?.connected, warning: streamIssue });
			let retryDelay = 60000;
			const renew = async () => {
				let next = 3600000;
				try {
					await subscribe(c);
					if (retryDelay !== 60000) send(c, { stream: useWebhook || !!stream?.connected, warning: streamIssue });
					retryDelay = 60000;
				} catch (error) {
					if (c.ws.readyState !== WebSocket.OPEN) return;
					send(c, { warning: error.message });
					if (!useWebhook || error.requiresLogin) {
						c.ws.close(1011, "X subscription renewal failed.");
						return;
					}
					// Existing subscriptions can still deliver while renewal is unavailable.
					next = Math.max(error.retryMs || 0, retryDelay);
					retryDelay = Math.min(retryDelay * 2, 15 * 60000);
				}
				if (c.ws.readyState === WebSocket.OPEN) c.renew = setTimeout(renew, next);
			};
			c.renew = setTimeout(renew, 3600000);
		} catch (error) {
			c.listening = false;
			syncViewerPoll(c);
			c.owner = null;
			c.tokens = null;
			if (!hasListeners()) stream?.abort();
			throw error;
		}
	}
	function signWebhook(input) {
		return "sha256=" + crypto.createHmac("sha256", config.clientSecret).update(input).digest("base64");
	}
	async function receiveWebhook(req, res, url) {
		if (req.method === "GET") {
			const challenge = url.searchParams.get("crc_token");
			// A challenge must never double as a signed JSON event.
			if (!challenge || challenge.length > 1024 || challenge.trimStart().startsWith("{")) {
				res.writeHead(400); res.end(); return;
			}
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ response_token: signWebhook(challenge) }));
			return;
		}
		if (req.method !== "POST") { res.writeHead(405, { Allow: "GET, POST" }); res.end(); return; }
		const header = req.headers["x-twitter-webhooks-signature-oauth2"];
		if (typeof header !== "string" || !/^sha256=[A-Za-z0-9+/]{43}=$/.test(header)) { res.writeHead(401); res.end(); return; }
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > 1024 * 1024) { res.writeHead(413); res.end(); return; }
			chunks.push(chunk);
		}
		const raw = Buffer.concat(chunks, size);
		if (!crypto.timingSafeEqual(Buffer.from(header), Buffer.from(signWebhook(raw)))) { res.writeHead(401); res.end(); return; }
		let event;
		try { event = JSON.parse(raw).data; } catch (_) { res.writeHead(400); res.end(); return; }
		dispatch(event);
		res.writeHead(200);
		res.end();
	}
	const server = http.createServer(async (req, res) => {
		let url;
		try { url = new URL(req.url, LOCAL_ORIGIN); } catch (_) { res.writeHead(400); res.end(); return; }
		const state = url.searchParams.get("state");
		const login = logins.get(state);
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		if (useWebhook && url.pathname === "/x/webhook") {
			try { await receiveWebhook(req, res, url); } catch (_) { if (!res.headersSent) res.writeHead(500); res.end(); }
			return;
		}
		if (req.method !== "GET" || url.pathname !== "/x/callback" || !login) {
			res.writeHead(404); res.end("No pending X sign-in."); return;
		}
		logins.delete(state);
		try {
			if (!url.searchParams.get("code")) throw new Error("X sign-in was canceled.");
			const tokens = await exchange({ grant_type: "authorization_code", code: url.searchParams.get("code"),
				code_verifier: login.verifier, redirect_uri: redirect });
			if (!clients.has(login.c)) throw new Error("Reopen the X source and sign in again.");
			const code = crypto.randomBytes(6).toString("hex");
			login.c.pairing = { code, tokens, until: Date.now() + 120000 };
			res.end("Enter this code in your Social Stream Ninja X source: " + code);
		} catch (error) { res.writeHead(400); res.end(error.message); send(login.c, { warning: error.message }); }
	});
	const wss = new WebSocketServer({ server, path: "/x/live", maxPayload: 8192 });
	wss.on("connection", (ws, req) => {
		const site = req.headers.origin;
		if (site && !["null", "file://", "https://socialstream.ninja", "https://beta.socialstream.ninja", "https://cache.socialstream.ninja"].includes(site) &&
			!/^chrome-extension:\/\/[a-p]{32}$/.test(site)) { ws.close(1008); return; }
		const c = { ws, channel: "", broadcast: "", revision: 0, lifecycleAt: 0, writes: Promise.resolve(), pendingWrites: 0 };
		clients.add(c);
		let awaitingPong = false;
		ws.on("pong", () => { awaitingPong = false; });
		const heartbeat = setInterval(() => {
			if (awaitingPong || ws.readyState !== WebSocket.OPEN) { ws.terminate(); return; }
			awaitingPong = true;
			ws.ping();
		}, 30000);
		ws.on("error", () => ws.terminate());
		ws.on("close", () => {
			clients.delete(c);
			clearInterval(heartbeat);
			clearInterval(c.viewerPoll?.timer);
			c.viewerPoll = null;
			clearTimeout(c.renew);
			clearTimeout(c.loginTimer);
			logins.delete(c.state);
			if (!hasListeners()) { clearTimeout(retry); retry = null; stream?.abort(); }
		});
		ws.on("message", async raw => {
			let m;
			try {
				m = JSON.parse(raw);
				if (m.op === "watchViewers") {
					c.watchViewers = m.enabled === true;
					syncViewerPoll(c);
					return;
				}
				if (m.op === "send") {
					queueChat(c, m);
					return;
				}
				if (m.op === "delete") {
					if (!c.listening || !c.broadcast || c.broadcast !== m.broadcast || typeof m.messageId !== "string" || !/^\d{1,19}$/.test(m.messageId)) {
						throw new Error("This message does not belong to the active X broadcast.");
					}
					await userApi(c, "/broadcasts/" + encodeURIComponent(c.broadcast) + "/chat/" + m.messageId, null, "DELETE", m.broadcast);
					send(c, { sent: m.id });
					return;
				}
				if (c.busy) throw new Error("Another X request is in progress.");
				c.busy = true;
				try {
					if (m.op === "login" || m.op === "resume") {
						c.channel = String(m.channel || "").replace(/^@/, "").toLowerCase();
						if (!/^[a-z0-9_]{1,15}$/.test(c.channel)) throw new Error("Choose an X source by its account handle.");
					}
					if (m.op === "login" && !c.owner) {
						logins.delete(c.state);
						clearTimeout(c.loginTimer);
						c.pairing = null;
						c.state = randomKey();
						const verifier = randomKey();
						logins.set(c.state, { c, verifier });
						c.loginTimer = setTimeout(() => logins.delete(c.state), 300000);
						const params = new URLSearchParams({ response_type: "code", client_id: config.clientId,
							redirect_uri: redirect, scope: "users.read tweet.read broadcast.read broadcast.write offline.access",
							state: c.state, code_challenge_method: "S256",
							code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url") });
						send(c, { authorize: "https://x.com/i/oauth2/authorize?" + params });
					} else if (m.op === "pair") {
						const pairing = c.pairing;
						c.pairing = null;
						if (!pairing || pairing.until < Date.now() || pairing.code !== m.code) throw signInError("Invalid or expired code. Start sign-in again.");
						await attach(c, { tokens: pairing.tokens, owner: null });
					} else if (m.op === "resume") {
						await attach(c, unpack(m.ticket));
					}
				} finally { c.busy = false; }
			} catch (error) {
				const attaching = m?.op === "pair" || m?.op === "resume";
				const temporary = attaching && (error.retryMs || error.status >= 500 || ["TypeError", "TimeoutError"].includes(error.name));
				send(c, { warning: error.message, failed: m?.id, retryMs: temporary ? error.retryMs : undefined,
					signIn: !temporary && !c.owner && error.requiresLogin === true });
				if (temporary) ws.close(1013, "Retry X connection");
			}
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 38178, "127.0.0.1", resolve);
	});
	// X immediately calls the public route during registration. Listen first.
	if (useWebhook) ensureWebhook().catch(error => console.warn("[X Live] " + error.message));
	return { url: "ws://127.0.0.1:" + server.address().port + "/x/live",
		close() { for (const c of clients) c.ws.terminate(); wss.close(); server.close(); } };
}

module.exports = { startXRelay, readXConfig };

// A shared relay runs behind an HTTPS reverse proxy. Desktop installations
// then need only its public WebSocket URL.
if (require.main === module) {
	(async () => {
		const origin = new URL(process.env.X_RELAY_PUBLIC_ORIGIN || LOCAL_ORIGIN);
		if (origin.origin !== LOCAL_ORIGIN && origin.protocol !== "https:") throw new Error("Use an HTTPS relay origin.");
		const relay = await startXRelay(readXConfig(), { origin: origin.origin, port: Number(process.env.X_RELAY_PORT || 38178),
			webhook: process.argv.includes("--webhook") });
		console.log("X Live listening at " + relay.url);
		process.once("SIGTERM", relay.close);
		process.once("SIGINT", relay.close);
	})().catch(error => { console.error(error.message); process.exitCode = 1; });
}
