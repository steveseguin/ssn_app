'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { fetch } = require('undici');

const API_BASE = 'https://api.shareplay.tv';
const EVENTSUB_URL = 'wss://events.shareplay.tv/eventsub/ws';
const SCOPES = ['openid', 'profile', 'chat:read', 'events:read'];

function createProof(privateKey, method, endpoint, accessToken) {
	const key = crypto.createPrivateKey({ key: privateKey, format: 'jwk' });
	const jwk = crypto.createPublicKey(key).export({ format: 'jwk' });
	const url = new URL(endpoint);
	url.search = '';
	url.hash = '';
	const header = Buffer.from(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk })).toString('base64url');
	const payload = {
		jti: crypto.randomUUID(), htm: method, htu: url.toString(), iat: Math.floor(Date.now() / 1000),
	};
	if (accessToken) payload.ath = crypto.createHash('sha256').update(accessToken).digest('base64url');
	const claims = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const signingInput = `${header}.${claims}`;
	const signature = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
	return `${signingInput}.${signature.toString('base64url')}`;
}

async function requestJson(endpoint, { method = 'GET', body, token, privateKey } = {}) {
	const headers = { Accept: 'application/json', DPoP: createProof(privateKey, method, endpoint, token) };
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body) headers['Content-Type'] = body instanceof URLSearchParams
		? 'application/x-www-form-urlencoded' : 'application/json';
	const response = await fetch(endpoint, {
		method, headers, body: body ? (body instanceof URLSearchParams ? body.toString() : JSON.stringify(body)) : undefined,
		signal: AbortSignal.timeout(20000), redirect: 'error',
	});
	const data = await response.json();
	if (!response.ok) {
		const error = new Error(data.error_description || data.message || data.error || `SharePlay returned HTTP ${response.status}.`);
		error.status = response.status;
		error.code = data.error || 'SHAREPLAY_REQUEST_FAILED';
		error.retryAfter = Number(response.headers.get('retry-after')) || 0;
		throw error;
	}
	return data;
}

function tokenRecord(response) {
	if (!response.access_token || !response.refresh_token) throw new Error('SharePlay did not return the required tokens.');
	return {
		access_token: response.access_token, refresh_token: response.refresh_token,
		expires_at: Date.now() + Number(response.expires_in || 3600) * 1000,
		scope: String(response.scope || ''),
	};
}

function escapeHtml(value) {
	return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderChat(content, emotes, textonly) {
	if (textonly) return String(content || '');
	const images = new Map();
	for (const emote of Array.isArray(emotes) ? emotes : []) {
		if (!emote.name || !/^https?:\/\//i.test(emote.url || '')) continue;
		const name = `:${String(emote.name).replace(/^:|:$/g, '')}:`;
		images.set(name, `<img class="emote" src="${escapeHtml(emote.url)}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}">`);
	}
	return String(content || '').split(/(:[^:\s]+:)/g).map((part) => images.get(part) || escapeHtml(part)).join('');
}

class SharePlayClient extends EventEmitter {
	constructor({ credential, privateKey, saveTokens, getSettings, apiBase = API_BASE, eventsubUrl = EVENTSUB_URL }) {
		super();
		this.credential = credential;
		this.privateKey = privateKey;
		this.saveTokens = saveTokens;
		this.getSettings = getSettings || (() => ({}));
		this.apiBase = apiBase;
		this.eventsubUrl = eventsubUrl;
		this.subscriptionsUrl = new URL('/eventsub/subscriptions', eventsubUrl.replace(/^ws/, 'http')).href;
		this.active = false;
		this.socket = null;
		this.retryTimer = null;
		this.refreshTimer = null;
		this.refreshPromise = null;
		this.retryCount = 0;
		this.generation = 0;
		this.seen = new Map();
		this.messages = new Map();
	}

	async refresh() {
		if (this.refreshPromise) return this.refreshPromise;
		this.refreshPromise = (async () => {
			const body = new URLSearchParams({
				grant_type: 'refresh_token', client_id: this.credential.clientId,
				refresh_token: this.credential.tokens.refresh_token,
			});
			if (this.credential.clientSecret) body.set('client_secret', this.credential.clientSecret);
			const response = await requestJson(`${this.apiBase}/oauth/token`, {
				method: 'POST', privateKey: this.privateKey, body,
			});
			const tokens = tokenRecord(response);
			// SharePlay invalidates the old refresh token immediately. Persist first.
			this.saveTokens(tokens);
			this.credential.tokens = tokens;
		})();
		try { await this.refreshPromise; } finally { this.refreshPromise = null; }
	}

	async connect() {
		const generation = ++this.generation;
		this.active = true;
		try { await this.open(generation); }
		catch (error) { if (this.generation === generation) this.close(); throw error; }
	}

	async open(generation = this.generation) {
		if (this.refreshPromise) await this.refreshPromise;
		if (this.credential.tokens.expires_at <= Date.now() + 60000) await this.refresh();
		if (!this.active || this.generation !== generation) throw new Error('SharePlay connection canceled.');
		const scopes = new Set(this.credential.tokens.scope.split(' '));
		if (!scopes.has('chat:read')) {
			const error = new Error('SharePlay chat access is missing. Sign in again after the client is granted chat:read.');
			error.status = 403;
			throw error;
		}
		this.emit('status', { status: 'connecting', message: 'Connecting to SharePlay...' });
		return new Promise((resolve, reject) => {
			let ready = false;
			let settled = false;
			let lastFrameAt = Date.now();
			let welcomed = false;
			let failure = null;
			let refreshTimer = null;
			const socket = new WebSocket(this.eventsubUrl, {
				headers: {
					Authorization: `Bearer ${this.credential.tokens.access_token}`,
					DPoP: createProof(this.privateKey, 'GET', this.eventsubUrl, this.credential.tokens.access_token),
				}, handshakeTimeout: 10000,
			});
			this.socket = socket;
			const welcomeTimer = setTimeout(() => {
				if (!welcomed) { failure = new Error('SharePlay did not send its welcome message.'); socket.terminate(); }
			}, 10000);
			const heartbeat = setInterval(() => {
				if (Date.now() - lastFrameAt > 30000) socket.terminate();
			}, 5000);
			const finish = (error) => {
				if (settled) return;
				settled = true;
				if (error) reject(error); else resolve();
			};
			socket.on('message', async (raw) => {
				if (!this.active || this.socket !== socket) return;
				lastFrameAt = Date.now();
				try {
					const frame = JSON.parse(String(raw));
					const type = frame.metadata?.message_type;
					if (type === 'session_welcome' && !welcomed) {
						welcomed = true;
						clearTimeout(welcomeTimer);
						const sessionId = frame.payload?.session?.id;
						if (!sessionId) throw new Error('SharePlay returned no EventSub session ID.');
						const topics = ['chat.message'];
						if (scopes.has('events:read')) topics.push('channel.blitz', 'stream.viewers');
						for (const topic of topics) {
							if (!this.active || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
							await requestJson(this.subscriptionsUrl, {
								method: 'POST', token: this.credential.tokens.access_token, privateKey: this.privateKey,
								body: { type: topic, version: '1', condition: { channel_user_id: this.credential.userId }, transport: { method: 'websocket', session_id: sessionId } },
							});
						}
						if (!this.active || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
						ready = true;
						this.retryCount = 0;
						this.emit('status', { status: 'connected', message: `Connected to ${this.credential.username}.` });
						clearTimeout(this.refreshTimer);
						refreshTimer = this.refreshTimer = setTimeout(() => {
							this.refresh().then(() => { if (this.active && this.socket === socket) socket.close(); })
								.catch((error) => { failure = error; socket.terminate(); });
						}, Math.max(1000, this.credential.tokens.expires_at - Date.now() - 60000));
						finish();
					} else if (type === 'notification') {
						this.handleEvent(frame);
					} else if (type === 'revocation') {
						const reason = frame.payload?.reason;
						if (reason === 'token_invalid') {
							await this.refresh();
							if (this.socket === socket) socket.close();
						} else {
							failure = new Error('SharePlay authorization was withdrawn or changed. Sign in again to reconnect.');
							failure.code = 'authorization_revoked';
							socket.terminate();
						}
					}
				} catch (error) { failure = error; socket.terminate(); }
			});
			socket.on('unexpected-response', (_request, response) => {
				failure = new Error(`SharePlay refused the EventSub connection (HTTP ${response.statusCode}).`);
				failure.status = response.statusCode;
				failure.retryAfter = Number(response.headers['retry-after']) || 0;
				response.resume();
				socket.terminate();
			});
			socket.on('error', (error) => { if (!failure) failure = error; });
			socket.on('close', () => {
				clearTimeout(welcomeTimer);
				clearInterval(heartbeat);
				clearTimeout(refreshTimer);
				if (this.socket === socket) this.socket = null;
				if (!ready) finish(failure || new Error('SharePlay disconnected before chat was ready.'));
				else if (this.active && this.generation === generation) this.reconnect(failure);
			});
		});
	}

	reconnect(error) {
		if (!this.active) return;
		if (error && ([400, 401, 403].includes(error.status) || error.code === 'authorization_revoked')) {
			this.close();
			this.emit('status', { status: 'error', fatal: true, message: error.message });
			return;
		}
		this.emit('status', { status: 'reconnecting', message: error?.message || 'Reconnecting to SharePlay...' });
		const delay = Math.max(Math.min(30000, 1000 * 2 ** Math.min(this.retryCount++, 5)), (error?.retryAfter || 0) * 1000);
		clearTimeout(this.retryTimer);
		const generation = this.generation;
		this.retryTimer = setTimeout(() => {
			if (this.active && this.generation === generation) this.open(generation).catch((nextError) => {
				if (this.generation === generation) this.reconnect(nextError);
			});
		}, delay);
	}

	handleEvent(frame) {
		const event = frame.payload?.event;
		if (!event) return;
		const id = frame.metadata?.message_id;
		if (id && this.seen.has(id)) return;
		if (id) {
			this.seen.set(id, true);
			if (this.seen.size > 1000) this.seen.delete(this.seen.keys().next().value);
		}
		const settings = this.getSettings();
		const type = frame.metadata?.subscription_type;
		let data;
		if (type === 'stream.viewers') {
			if (!(settings.showviewercount || settings.hypemode) || !Number.isFinite(event.viewers)) return;
			data = { type: 'shareplay', event: 'viewer_update', meta: event.viewers };
		} else if (type === 'channel.blitz') {
			if (event.status !== 'completed') return;
			data = this.baseMessage();
			data.event = 'raid';
			data.chatname = event.source_playtag || '';
			data.chatmessage = `Blitz from ${event.source_playtag || 'another channel'}${Number.isFinite(event.viewer_count) ? ` with ${event.viewer_count} viewers` : ''}`;
			data.textonly = true;
			data.meta = { cardType: 'blitz', fromLogin: event.source_playtag || '' };
			if (Number.isFinite(event.viewer_count)) data.meta.viewers = event.viewer_count;
		} else if (type === 'chat.message') {
			data = this.baseMessage();
			data.id = event.message_id;
			data.userid = event.sender_id;
			data.chatname = event.sender_playtag || '';
			data.textonly = !!settings.textonlymode;
			data.chatmessage = renderChat(event.content, event.emotes, data.textonly);
			const parent = this.messages.get(event.parent_message_id);
			if (parent) {
				data.initial = parent.text;
				data.reply = String(event.content || '');
				data.meta = { reply: { author: parent.author, text: parent.text } };
				const prefix = `@${parent.author}: `;
				data.chatmessage = data.textonly ? prefix + data.chatmessage : `<i><small>${escapeHtml(prefix)}</small></i> ${data.chatmessage}`;
			}
			if (event.message_type === 'shoutout') data.event = 'shoutout';
			if (event.message_id) {
				this.messages.set(event.message_id, { author: data.chatname, text: String(event.content || '') });
				if (this.messages.size > 200) this.messages.delete(this.messages.keys().next().value);
			}
		} else return;
		if (event.is_synthetic && data.event !== 'viewer_update') data.meta = { ...data.meta, is_synthetic: true };
		this.emit('message', data);
	}

	baseMessage() {
		return { type: 'shareplay', platform: 'shareplay', chatname: '', chatmessage: '', chatimg: '', chatbadges: '', backgroundColor: '', textColor: '', hasDonation: '', membership: '', contentimg: '', textonly: false };
	}

	close() {
		this.active = false;
		this.generation++;
		this.connectionPromise = null;
		clearTimeout(this.retryTimer);
		clearTimeout(this.refreshTimer);
		if (this.socket) this.socket.terminate();
	}
}

module.exports = { API_BASE, EVENTSUB_URL, SCOPES, SharePlayClient, createProof, requestJson, tokenRecord };
