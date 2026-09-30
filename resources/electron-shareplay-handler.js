'use strict';

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { fileURLToPath } = require('url');
const { app, ipcMain, safeStorage, shell } = require('electron');
const Store = require('electron-store');
const { API_BASE, EVENTSUB_URL, SCOPES, SharePlayClient, requestJson, tokenRecord } = require('./shareplay-client');

const LOOPBACK_PORTS = [8181, 8080];
const CALLBACK_PATH = '/sources/websocket/shareplay.html';
const TEST_CLIENT_ID = 'social_stream_ninja_test_bf18ab';
const DEFAULT_CLIENT_ID = 'social_stream_ninja_prod_5f96ea';
const authStore = new Store({ name: 'shareplay-auth' });
let integration;

function protect(value) {
	if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable. SharePlay sign-in cannot be saved on this computer.');
	return safeStorage.encryptString(JSON.stringify(value)).toString('base64');
}

function reveal(value) {
	if (!value || !safeStorage.isEncryptionAvailable()) throw new Error('SharePlay credentials are unavailable. Sign in again.');
	try { return JSON.parse(safeStorage.decryptString(Buffer.from(value, 'base64'))); }
	catch (_) { throw new Error('The saved SharePlay credentials could not be opened. Sign in again.'); }
}

function deviceKey() {
	const saved = authStore.get('deviceKey');
	if (saved) return reveal(saved);
	const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const key = privateKey.export({ format: 'jwk' });
	authStore.set('deviceKey', protect(key));
	return key;
}

function publicAccount(authRef, account) {
	return { authRef, clientId: account.clientId, userId: account.userId, username: account.username };
}

function assertAppCaller(event) {
	const url = event.senderFrame?.url || event.sender.getURL();
	try {
		if (path.resolve(fileURLToPath(url)).toLowerCase() === path.resolve(__dirname, '..', 'index.html').toLowerCase()) return;
	} catch (_) {}
	throw new Error('SharePlay account controls are available only in the SSApp main window.');
}

function testEndpoints() {
	if (app.isPackaged || process.env.SSAPP_SHAREPLAY_TEST_MODE !== '1') return {};
	const api = new URL(process.env.SSAPP_SHAREPLAY_TEST_API_BASE);
	const events = new URL(process.env.SSAPP_SHAREPLAY_TEST_EVENTS_URL);
	if (api.hostname !== '127.0.0.1' || events.hostname !== '127.0.0.1' || api.protocol !== 'http:' || events.protocol !== 'ws:') {
		throw new Error('SharePlay test endpoints must use local loopback servers.');
	}
	return { apiBase: api.origin, eventsubUrl: events.toString() };
}

async function listen(server) {
	for (const port of LOOPBACK_PORTS) {
		try {
			await new Promise((resolve, reject) => {
				const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
				const onListening = () => { server.removeListener('error', onError); resolve(); };
				server.once('error', onError);
				server.once('listening', onListening);
				server.listen(port, '127.0.0.1');
			});
			return port;
		} catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
	}
	throw new Error('Ports 8181 and 8080 are both in use. Close the application using either port, then try signing in again.');
}

class SharePlayIntegration {
	constructor(options) {
		Object.assign(this, options);
		this.endpoints = testEndpoints();
		this.apiBase = this.endpoints.apiBase || API_BASE;
		this.eventsubUrl = this.endpoints.eventsubUrl || EVENTSUB_URL;
		this.bindings = new Map();
		this.clients = new Map();
		this.nextTabId = 1100000;
		this.pendingAuth = null;
	}

	listAccounts() {
		return {
			accounts: Object.entries(authStore.get('accounts', {})).map(([ref, account]) => publicAccount(ref, account)),
			clientId: process.env.SSAPP_SHAREPLAY_CLIENT_ID || authStore.get('clientId', '') || DEFAULT_CLIENT_ID,
		};
	}

	async signIn(payload = {}) {
		const clientId = String(payload.clientId || process.env.SSAPP_SHAREPLAY_CLIENT_ID || authStore.get('clientId', '') || DEFAULT_CLIENT_ID).trim();
		if (!clientId) throw new Error('Enter the public OAuth client ID issued by SharePlay for SSN. Developer account access alone does not create a client.');
		const clientSecret = clientId === TEST_CLIENT_ID ? String(payload.clientSecret || '').trim() : '';
		if (this.pendingAuth) this.pendingAuth.cancel();
		const privateKey = deviceKey();
		const verifier = crypto.randomBytes(48).toString('base64url');
		const state = crypto.randomBytes(24).toString('base64url');
		let redirectUri;
		let timer;
		let processing = false;
		let settled = false;
		let session;
		let server;
		const tokens = await new Promise((resolve, reject) => {
			const finish = (error, result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				server.close();
				if (this.pendingAuth === session) this.pendingAuth = null;
				if (error) reject(error); else resolve(result);
			};
			session = { cancel: () => finish(new Error('SharePlay sign-in canceled.')) };
			this.pendingAuth = session;
			server = http.createServer(async (request, response) => {
				const url = new URL(request.url || '/', 'http://127.0.0.1');
				response.setHeader('Content-Type', 'text/plain; charset=utf-8');
				response.setHeader('Cache-Control', 'no-store');
				if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) { response.writeHead(404); response.end('Not found'); return; }
				if (url.searchParams.get('state') !== state) { response.writeHead(400); response.end('Sign-in state did not match. Return to the SharePlay authorization page.'); return; }
				if (settled || processing) { response.writeHead(409); response.end('Sign-in is already being processed.'); return; }
				if (url.searchParams.has('error')) {
					response.end('SharePlay sign-in was declined. Return to Social Stream Ninja.');
					finish(new Error('SharePlay sign-in was declined.'));
					return;
				}
				if (!url.searchParams.get('code')) { response.writeHead(400); response.end('No authorization code received.'); return; }
				processing = true;
				try {
					const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri,
						code: url.searchParams.get('code'), code_verifier: verifier });
					if (clientSecret) body.set('client_secret', clientSecret);
					const result = await requestJson(`${this.apiBase}/oauth/token`, {
						method: 'POST', privateKey, body,
					});
					response.end('SharePlay sign-in completed. You can close this page and return to Social Stream Ninja.');
					finish(null, tokenRecord(result));
				} catch (error) {
					response.writeHead(400);
					response.end('SharePlay sign-in failed. Return to Social Stream Ninja for details.');
					finish(error);
				}
			});
			timer = setTimeout(() => finish(new Error('SharePlay sign-in timed out. Try again.')), 5 * 60 * 1000);
			(async () => {
				try {
					const port = await listen(server);
					if (settled) { server.close(); return; }
					redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
					const authUrl = new URL(`${this.apiBase}/oauth/authorize`);
					authUrl.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
						scope: SCOPES.join(' '), state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
					await shell.openExternal(authUrl.toString(), { activate: true });
				} catch (error) { finish(error); }
			})();
		});
		const profile = await requestJson(`${this.apiBase}/api/v1/me`, { token: tokens.access_token, privateKey });
		if (!profile.user_id) throw new Error('SharePlay did not return an account ID.');
		if (!tokens.scope.split(' ').includes('chat:read')) throw new Error('SharePlay did not grant chat:read. Ask SharePlay to provision it for this client, then sign in again.');
		const authRef = crypto.createHash('sha256').update(`${clientId}:${profile.user_id}`).digest('hex').slice(0, 32);
		const affectedSourceIds = this.disconnectAccount(authRef);
		this.clients.delete(authRef);
		const account = { clientId, userId: profile.user_id, username: profile.playtag || profile.display_name || profile.user_id, protectedTokens: protect(tokens) };
		if (clientSecret) account.protectedClientSecret = protect(clientSecret);
		authStore.set(`accounts.${authRef}`, account);
		authStore.set('clientId', clientId);
		return { account: publicAccount(authRef, account), affectedSourceIds };
	}

	forget(authRef) {
		const affectedSourceIds = this.disconnectAccount(authRef);
		this.clients.delete(authRef);
		authStore.delete(`accounts.${authRef}`);
		return { affectedSourceIds };
	}

	disconnectAccount(authRef) {
		const ids = [...this.bindings.values()].filter((binding) => binding.authRef === authRef).map((binding) => binding.sourceId);
		for (const id of ids) this.disconnectSource(id);
		return ids;
	}

	getClient(authRef) {
		if (this.clients.has(authRef)) return this.clients.get(authRef);
		const account = authStore.get(`accounts.${authRef}`);
		if (!account) throw new Error('The saved SharePlay sign-in is missing. Sign in again from Setup.');
		const client = new SharePlayClient({
			credential: { ...account, tokens: reveal(account.protectedTokens), clientSecret: account.protectedClientSecret ? reveal(account.protectedClientSecret) : '' }, privateKey: deviceKey(),
			getSettings: this.getSettings, ...this.endpoints,
			saveTokens: (tokens) => {
				if (this.clients.get(authRef) !== client || !authStore.has(`accounts.${authRef}`)) throw new Error('SharePlay sign-in changed during refresh.');
				authStore.set(`accounts.${authRef}.protectedTokens`, protect(tokens));
			},
		});
		client.on('message', (data) => {
			for (const binding of this.bindings.values()) {
				if (binding.authRef !== authRef || binding.replyOnly) continue;
				const message = { ...data, tid: binding.virtualTabId };
				const payload = { message };
				this.recordCapture(payload, { sourceId: binding.sourceId, tabId: binding.virtualTabId });
				this.forwardMessage(payload);
			}
		});
		client.on('status', (status) => {
			client.lastStatus = status;
			for (const binding of this.bindings.values()) {
				if (binding.authRef === authRef) this.sendStatus(binding, status);
			}
		});
		this.clients.set(authRef, client);
		return client;
	}

	sendStatus(binding, status) {
		const payload = { ...status, sourceId: binding.sourceId, virtualTabId: binding.virtualTabId };
		this.recordStatus(payload, { sourceId: binding.sourceId, tabId: binding.virtualTabId });
		const win = this.getMainWindow();
		if (win && !win.isDestroyed()) win.webContents.send('shareplayConnectionStatus', payload);
	}

	async connectSource(payload = {}) {
		const sourceId = String(payload.sourceId || '');
		const authRef = String(payload.authRef || '');
		if (!sourceId || !/^[a-f0-9]{32}$/.test(authRef)) throw new Error('Select a saved SharePlay account first.');
		if (this.bindings.has(sourceId)) this.disconnectSource(sourceId);
		const client = this.getClient(authRef);
		const views = this.getBrowserViews();
		while (views[this.nextTabId]) this.nextTabId++;
		const virtualTabId = this.nextTabId++;
		const binding = { sourceId, authRef, virtualTabId, replyOnly: !!payload.replyOnly };
		const url = `https://www.shareplay.tv/${encodeURIComponent(client.credential.username)}`;
		this.bindings.set(sourceId, binding);
		views[virtualTabId] = {
			isVirtualSource: true, virtualSourceTarget: 'shareplay', sourceId, tabID: virtualTabId,
			args: { sourceId, url },
			webContents: { getURL: () => url, isDestroyed: () => false, send: () => {} },
			close: () => this.disconnectSource(sourceId),
		};
		try {
			// Multiple source cards share one token-rotation owner and EventSub connection.
			if (!client.connectionPromise) client.connectionPromise = client.connect();
			await client.connectionPromise;
			if (this.bindings.get(sourceId) !== binding) throw new Error('SharePlay connection canceled.');
			this.sendStatus(binding, client.lastStatus || { status: 'connecting', message: 'Connecting to SharePlay...' });
		} catch (error) {
			if (this.bindings.get(sourceId) === binding) this.disconnectSource(sourceId);
			throw error;
		}
		return { virtualTabId };
	}

	disconnectSource(sourceId) {
		const binding = this.bindings.get(sourceId);
		if (!binding) return false;
		this.bindings.delete(sourceId);
		delete this.getBrowserViews()[binding.virtualTabId];
		if (![...this.bindings.values()].some((item) => item.authRef === binding.authRef)) {
			this.clients.get(binding.authRef)?.close();
		}
		return true;
	}

	closeAll() {
		this.pendingAuth?.cancel();
		for (const id of [...this.bindings.keys()]) this.disconnectSource(id);
		this.clients.clear();
	}
}

function setupSharePlayHandler(options) {
	if (integration) return integration;
	integration = new SharePlayIntegration(options);
	const handlers = {
		'shareplay-accounts': () => integration.listAccounts(),
		'shareplay-signin': (payload) => integration.signIn(payload),
		'shareplay-cancel-signin': () => { integration.pendingAuth?.cancel(); return {}; },
		'shareplay-forget': (authRef) => {
			if (!/^[a-f0-9]{32}$/.test(authRef)) throw new Error('Invalid SharePlay account.');
			return integration.forget(authRef);
		},
		'shareplay-connect': (payload) => integration.connectSource(payload),
		'shareplay-disconnect': (sourceId) => ({ disconnected: integration.disconnectSource(sourceId) }),
	};
	for (const [channel, handler] of Object.entries(handlers)) {
		ipcMain.handle(channel, async (event, payload) => {
			try { assertAppCaller(event); return { success: true, ...await handler(payload) }; }
			catch (error) { return { success: false, error: { message: error.message } }; }
		});
	}
	return integration;
}

function clearSharePlayAuthStore() {
	integration?.closeAll();
	authStore.clear();
}

module.exports = { setupSharePlayHandler, clearSharePlayAuthStore };
