#!/usr/bin/env node
'use strict';

// Real Electron workflow against a local OAuth/EventSub fixture; no live account needed.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { WebSocketServer, WebSocket } = require('ws');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const root = path.resolve(__dirname, '../..');
const sourceRoot = path.resolve(process.env.SOCIAL_STREAM_SOURCE_DIR || path.join(root, '../social_stream'));
const testClientId = 'social_stream_ninja_test_bf18ab';
const testClientSecret = 'fixture-test-client-secret';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(100); }
	throw new Error(`Timed out: ${label}`);
}
const listen = (server, port = 0) => new Promise((resolve, reject) => {
	server.once('error', reject);
	server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
});
const stop = server => new Promise(resolve => server.close(resolve));

async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-shareplay-'));
	console.log(`Artifacts: ${profile}`);
	const fixtureErrors = [];
	const authorizations = [];
	const proofs = new Set();
	const sockets = new Map();
	const subscriptions = [];
	let publicKey;
	let origin;
	let eventOrigin;
	let eventUrl;
	let serial = 0;
	let refreshCount = 0;
	let refreshAttempts = 0;
	let accessToken;
	let refreshToken;
	let activeClientId;
	let app;
	let log;
	let occupied;
	function verifyProof(request, endpoint) {
		const parts = String(request.headers.dpop).split('.');
		assert.strictEqual(parts.length, 3);
		const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
		const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
		assert.strictEqual(header.typ, 'dpop+jwt');
		assert.strictEqual(header.alg, 'ES256');
		assert.ok(!header.jwk.d);
		if (publicKey) assert.deepStrictEqual(header.jwk, publicKey, 'Device key survives restart');
		publicKey = header.jwk;
		assert.strictEqual(claims.htm, request.method);
		assert.strictEqual(claims.htu, endpoint);
		if (request.headers.authorization) {
			assert.strictEqual(claims.ath, crypto.createHash('sha256').update(accessToken).digest('base64url'), 'Access-token proofs bind the current token');
		} else assert.ok(!Object.hasOwn(claims, 'ath'), 'Token requests omit ath');
		assert.ok(Math.abs(Date.now() / 1000 - claims.iat) < 30);
		assert.ok(!proofs.has(claims.jti), 'Each request has a fresh proof');
		proofs.add(claims.jti);
		assert.ok(crypto.verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), {
			key: crypto.createPublicKey({ key: header.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
		}, Buffer.from(parts[2], 'base64url')));
	}
	function tokens(expiresIn) {
		accessToken = `fixture-access-${++serial}`;
		refreshToken = `fixture-refresh-${serial}`;
		return { access_token: accessToken, refresh_token: refreshToken, token_type: 'DPoP', expires_in: expiresIn,
			scope: 'openid profile chat:read events:read' };
	}
	async function handleRequest(request, response, eventService) {
		try {
			const base = eventService ? eventOrigin : origin;
			const url = new URL(request.url, base);
			if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
			if (url.pathname === '/oauth/authorize') {
				const auth = Object.fromEntries(url.searchParams);
				assert.ok(['ssn-public-fixture', testClientId].includes(auth.client_id));
				assert.strictEqual(auth.code_challenge_method, 'S256');
				assert.strictEqual(auth.scope, 'openid profile chat:read events:read');
				assert.ok(!auth.client_secret);
				authorizations.push(auth);
				const callback = new URL(auth.redirect_uri);
				assert.strictEqual(callback.protocol, 'http:');
				assert.strictEqual(callback.hostname, '127.0.0.1');
				assert.strictEqual(callback.pathname, '/sources/websocket/shareplay.html');
				assert.ok(['8181', '8080'].includes(callback.port));
				callback.searchParams.set('code', `code-${authorizations.length}`);
				callback.searchParams.set('state', auth.state);
				response.writeHead(302, { Location: callback.href }); response.end(); return;
			}
			assert.strictEqual(eventService, url.pathname === '/eventsub/subscriptions', 'Subscriptions use the events service, not the OAuth API');
			verifyProof(request, base + url.pathname);
			let raw = '';
			for await (const chunk of request) raw += chunk;
			let result;
			if (url.pathname === '/oauth/token') {
				const form = new URLSearchParams(raw);
				assert.ok(['ssn-public-fixture', testClientId].includes(form.get('client_id')));
				if (form.get('client_id') === testClientId) assert.strictEqual(form.get('client_secret'), testClientSecret);
				else assert.ok(!form.has('client_secret'));
				if (form.get('grant_type') === 'authorization_code') {
					const auth = authorizations[Number(form.get('code').split('-')[1]) - 1];
					assert.strictEqual(form.get('client_id'), auth.client_id);
					activeClientId = auth.client_id;
					assert.strictEqual(form.get('redirect_uri'), auth.redirect_uri);
					assert.strictEqual(crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url'), auth.code_challenge);
					result = tokens(65);
				} else {
					assert.strictEqual(form.get('client_id'), activeClientId);
					assert.strictEqual(form.get('grant_type'), 'refresh_token');
					assert.strictEqual(form.get('refresh_token'), refreshToken, 'Refresh rotation uses the latest token');
					refreshAttempts++;
					if (refreshAttempts === 1) {
						response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
						response.end(JSON.stringify({ error: 'temporarily_unavailable' })); return;
					}
					refreshCount++;
					result = tokens(3600);
				}
			} else {
				assert.strictEqual(request.headers.authorization, `Bearer ${accessToken}`);
				if (url.pathname === '/api/v1/me') result = { user_id: 'fixture-user', playtag: 'fixturecaster' };
				else {
					assert.strictEqual(url.pathname, '/eventsub/subscriptions');
					const subscription = JSON.parse(raw);
					assert.strictEqual(subscription.condition.channel_user_id, 'fixture-user');
					assert.strictEqual(subscription.version, '1');
					assert.strictEqual(subscription.transport.method, 'websocket');
					assert.ok(sockets.has(subscription.transport.session_id));
					subscriptions.push(subscription);
					result = { data: [{ id: crypto.randomUUID(), status: 'enabled', ...subscription }] };
				}
			}
			response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
		} catch (error) {
			fixtureErrors.push(error.stack);
			response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message }));
		}
	}
	const fixture = http.createServer((request, response) => handleRequest(request, response, false));
	const eventFixture = http.createServer((request, response) => handleRequest(request, response, true));
	await listen(fixture);
	await listen(eventFixture);
	origin = `http://127.0.0.1:${fixture.address().port}`;
	eventOrigin = `http://127.0.0.1:${eventFixture.address().port}`;
	eventUrl = `ws://127.0.0.1:${eventFixture.address().port}/eventsub/ws`;
	const events = new WebSocketServer({ server: eventFixture });
	events.on('connection', (socket, request) => {
		try {
			verifyProof(request, eventUrl);
			assert.strictEqual(request.headers.authorization, `Bearer ${accessToken}`);
			const id = crypto.randomUUID();
			sockets.set(id, socket);
			socket.send(JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id } } }));
			const timer = setInterval(() => socket.send(JSON.stringify({ metadata: { message_type: 'session_keepalive' } })), 5000);
			socket.on('close', () => { clearInterval(timer); sockets.delete(id); });
		} catch (error) { fixtureErrors.push(error.stack); socket.terminate(); }
	});
	function notify(type, event, id = crypto.randomUUID()) {
		for (const socket of sockets.values()) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
			metadata: { message_type: 'notification', message_id: id, subscription_type: type }, payload: { event },
		}));
	}
	const chat = (id, extra = {}) => ({ message_id: id, channel_user_id: 'fixture-user', sender_id: 'viewer-1',
		sender_playtag: 'Viewer', content: `Hello ${id}`, emotes: [], message_type: 'chat', ...extra });
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
		streamID: 'shareplay_fixture', password: 'false', state: false, settings: { showviewercount: true },
	}));
	async function launch(phase) {
		const env = { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_DEBUG_LOGS: '0',
			SSAPP_SHAREPLAY_TEST_MODE: '1', SSAPP_SHAREPLAY_TEST_API_BASE: origin, SSAPP_SHAREPLAY_TEST_EVENTS_URL: eventUrl };
		delete env.ELECTRON_RUN_AS_NODE;
		delete env.SSAPP_SHAREPLAY_CLIENT_ID;
		app = await _electron.launch({ executablePath: require('electron'), cwd: root, env, timeout: 60000,
			args: ['.', '--multiinstance', '--running-from-source', '--disable-logs',
				`--filesource=${pathToFileURL(sourceRoot + path.sep).href}`, `--savefolder=${profile}${path.sep}`, ...linuxLaunchArgs()] });
		log = fs.createWriteStream(path.join(profile, `${phase}.log`));
		app.process().stdout.pipe(log, { end: false }); app.process().stderr.pipe(log, { end: false });
		const main = await app.firstWindow();
		// Use a real browser window for the local fixture's redirect to the app listener.
		// Live authorization opens in the user's system browser.
		await app.evaluate(({ shell, BrowserWindow }, fixtureOrigin) => {
			const load = process.getBuiltinModule('node:module').createRequire(process.cwd() + '/package.json');
			const { SharePlayClient } = load('./resources/shareplay-client');
			const connect = SharePlayClient.prototype.connect;
			SharePlayClient.prototype.connect = function (...args) {
				global.__shareplayFixtureClient = this;
				return connect.apply(this, args);
			};
			const original = shell.openExternal;
			shell.openExternal = async function (url, options) {
				if (!String(url).startsWith(fixtureOrigin + '/oauth/authorize?')) return original.call(shell, url, options);
				const browser = new BrowserWindow({ show: true, width: 800, height: 600,
					webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
				browser.webContents.on('did-finish-load', () => {
					const current = new URL(browser.webContents.getURL());
					if (current.pathname === '/sources/websocket/shareplay.html') browser.destroy();
				});
				browser.loadURL(String(url)).catch(() => {});
			};
		}, origin);
		main.on('pageerror', error => console.error('Renderer:', error.message));
		await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady && window.stateManager);
		return main;
	}
	async function capture(main) {
		await main.waitForFunction(() => typeof document.getElementById('frame2')?.contentWindow.processIncomingMessage === 'function');
		await main.evaluate(() => {
			const background = document.getElementById('frame2').contentWindow;
			background.__shareplayCaptured = [];
			const original = background.processIncomingMessage;
			background.processIncomingMessage = async function (message, sender) {
				if (message?.type === 'shareplay') background.__shareplayCaptured.push(JSON.parse(JSON.stringify(message)));
				return original.call(this, message, sender);
			};
		});
	}
	const captured = main => main.evaluate(() => document.getElementById('frame2').contentWindow.__shareplayCaptured);
	const source = main => main.evaluate(() => stateManager.getSources().find(item => item.shareplayNative));
	async function active(main) { return waitFor(async () => { const s = await source(main); return s?.status === 'active' && s; }, 'active SharePlay source'); }
	try {
		let main = await launch('initial');
		await main.locator('[data-source-type="shareplay"]').click();
		await main.waitForFunction(() => document.getElementById('shareplayClientId').value === 'social_stream_ninja_prod_5f96ea');
		assert.ok(await main.locator('#shareplayClientSecret').isHidden());
		await main.screenshot({ path: path.join(profile, 'setup-dark.png') });
		await main.evaluate(() => document.documentElement.dataset.ssappTheme = 'light');
		await main.screenshot({ path: path.join(profile, 'setup-light.png') });
		await main.evaluate(() => delete document.documentElement.dataset.ssappTheme);
		await main.locator('#shareplayDeveloperSetup summary').click();
		await main.locator('#shareplayClientId').fill('ssn-public-fixture');
		assert.ok(await main.locator('#shareplayClientSecret').isHidden());
		await main.locator('#shareplaySignIn').click();
		await main.waitForFunction(() => document.getElementById('shareplayStatus').textContent.includes('Signed in as'));
		assert.strictEqual(new URL(authorizations[0].redirect_uri).port, '8181', 'Public client primary callback port');
		// Occupy the preferred port to exercise the existing 8080 fallback flow.
		occupied = http.createServer((_request, response) => response.end());
		await listen(occupied, 8181);
		await main.locator('#shareplaySignIn').click();
		await waitFor(() => authorizations.length === 2, 'second authorization');
		await main.waitForFunction(() => document.getElementById('shareplayStatus').textContent.includes('Signed in as'));
		assert.strictEqual(new URL(authorizations[1].redirect_uri).port, '8080', 'Public client fallback callback port');
		await stop(occupied); occupied = null;
		main.once('dialog', dialog => dialog.accept());
		await main.locator('#shareplayForget').click();
		await main.waitForFunction(() => document.getElementById('shareplayStatus').textContent === 'Saved sign-in removed.');
		await main.locator('#shareplayDeveloperSetup summary').click();
		await main.locator('#shareplayClientId').fill(testClientId);
		await main.locator('#shareplayClientSecret').fill(testClientSecret);
		await main.locator('#shareplaySignIn').click();
		await main.waitForFunction(() => document.getElementById('shareplayStatus').textContent.includes('Signed in as'));
		assert.strictEqual(new URL(authorizations[2].redirect_uri).port, '8181', 'Test client uses direct HTTP on 8181');
		assert.strictEqual(await main.locator('#shareplayClientSecret').inputValue(), '');
		occupied = http.createServer((_request, response) => response.end());
		await listen(occupied, 8181);
		await main.locator('#shareplayClientSecret').fill(testClientSecret);
		await main.locator('#shareplaySignIn').click();
		await main.waitForFunction(() => document.getElementById('shareplayStatus').textContent.includes('Signed in as'));
		assert.strictEqual(new URL(authorizations[3].redirect_uri).port, '8080', 'Test client falls back to direct HTTP on 8080');
		assert.ok(!JSON.stringify(await main.evaluate(() => window.ninjafy.shareplay.accounts())).includes(testClientSecret));
		await stop(occupied); occupied = null;
		await main.locator('#shareplayAdd').click();
		const initial = await source(main);
		assert.ok(initial.shareplayAuthRef);
		const card = `[data-source-id="${initial.id}"]`;
		await capture(main);
		// The existing connect button pulses continuously; skip Playwright's stability wait.
		await main.locator(`${card} [data-activatehtml]`).click({ force: true });
		let running = await active(main);
		assert.ok(running.vid >= 1100000);
		assert.strictEqual(await main.locator(`${card} [data-session-badge]`).textContent(), 'SharePlay API');
		assert.ok(await main.locator(`${card} [data-togglehtml]`).isHidden());
		await waitFor(() => refreshCount === 1 && subscriptions.length >= 6 && sockets.size === 1, 'rotating refresh and resubscribe');
		assert.strictEqual(refreshAttempts, 2, '503 preserves the refresh token and retries with a fresh proof');
		assert.deepStrictEqual([...new Set(subscriptions.map(item => item.type))].sort(), ['channel.blitz', 'chat.message', 'stream.viewers']);
		notify('chat.message', chat('parent', { content: 'Hello <friends> :Wave:', emotes: [{ name: 'Wave', url: 'https://example.com/wave.png' }] }), 'same-delivery');
		notify('chat.message', chat('parent'), 'same-delivery');
		notify('chat.message', chat('reply', { parent_message_id: 'parent', content: 'Reply' }));
		notify('chat.message', chat('shoutout', { message_type: 'shoutout', content: 'Go visit Friend!' }));
		notify('channel.blitz', { status: 'initiated', source_playtag: 'Friend', viewer_count: 9 });
		notify('channel.blitz', { status: 'completed', source_playtag: 'Friend', viewer_count: 9 });
		notify('stream.viewers', { viewers: 42 });
		await waitFor(async () => (await captured(main)).length >= 5, 'chat arriving in SSN background');
		let messages = await captured(main);
		assert.strictEqual(messages.length, 5);
		assert.ok(messages[0].chatmessage.includes('&lt;friends&gt;'));
		assert.ok(messages[0].chatmessage.includes('<img class="emote"'));
		assert.strictEqual(messages[0].tid, running.vid);
		assert.strictEqual(messages[1].meta.reply.author, 'Viewer');
		assert.strictEqual(messages[2].event, 'shoutout');
		assert.strictEqual(messages[3].event, 'raid');
		assert.strictEqual(messages[4].meta, 42);
		await main.evaluate(() => {
			const bg = document.getElementById('frame2').contentWindow;
			bg.settings.textonlymode = true; bg.chrome.storage.sync.set({ settings: bg.settings });
		});
		await pause(300);
		notify('chat.message', chat('plain', { content: '<literal> :Wave:', emotes: [{ name: 'Wave', url: 'https://example.com/wave.png' }] }));
		await waitFor(async () => (await captured(main)).some(item => item.id === 'plain'), 'text-only chat');
		messages = await captured(main);
		assert.strictEqual(messages.find(item => item.id === 'plain').chatmessage, '<literal> :Wave:');
		assert.strictEqual(messages.find(item => item.id === 'plain').textonly, true);
		const beforeReconnect = subscriptions.length;
		for (const socket of sockets.values()) socket.terminate();
		await waitFor(() => subscriptions.length === beforeReconnect + 3, 'reconnect subscriptions');
		await active(main);
		notify('chat.message', chat('after-reconnect'));
		await waitFor(async () => (await captured(main)).some(item => item.id === 'after-reconnect'), 'capture after reconnect');
		await main.reload();
		await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady && window.stateManager);
		running = await active(main);
		assert.strictEqual(running.vid, initial.vid || messages[0].tid, 'Reload reuses the native source handle');
		assert.strictEqual(sockets.size, 1);
		await main.locator(`${card} [data-stophtml]`).click();
		await waitFor(() => sockets.size === 0, 'stop closes socket');
		await pause(1500);
		assert.strictEqual(sockets.size, 0);
		await main.locator(`${card} [data-activatehtml]`).click({ force: true });
		await active(main);
		await main.evaluate(id => stateManager.updateSource(id, { autoActivate: true }), initial.id);
		const saved = fs.readFileSync(path.join(profile, 'shareplay-auth.json'), 'utf8');
		assert.ok(!saved.includes('fixture-access-') && !saved.includes('fixture-refresh-'));
		assert.ok(!saved.includes(testClientSecret), 'Saved client secret is encrypted');
		assert.ok(!fs.readFileSync(path.join(profile, 'savedSync.json'), 'utf8').includes('fixture-refresh-'));
		assert.ok(!fs.readFileSync(path.join(profile, 'savedSync.json'), 'utf8').includes(testClientSecret));
		await app.close(); app = null; log.end();
		main = await launch('restart');
		await active(main);
		assert.strictEqual(authorizations.length, 4, 'Saved account reconnects without another sign-in');
		await app.evaluate(async () => {
			await global.__shareplayFixtureClient.refresh();
			global.__shareplayFixtureClient.socket.close();
		});
		await waitFor(() => refreshCount === 2 && sockets.size === 1, 'saved Test secret renews tokens after restart');
		await active(main);
		await capture(main);
		notify('chat.message', chat('after-restart'));
		await waitFor(async () => (await captured(main)).some(item => item.id === 'after-restart'), 'capture after restart');
		await main.locator(`${card} [data-showtips]`).click();
		main.once('dialog', dialog => dialog.accept());
		await main.locator('#shareplayForget').click();
		await waitFor(() => sockets.size === 0, 'forget disconnects');
		await main.waitForFunction(() => document.getElementById('shareplayStatus').textContent === 'Saved sign-in removed.');
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(profile, 'shareplay-auth.json'))).accounts, {});
		assert.deepStrictEqual(fixtureErrors, []);
		console.log('PASS: Electron setup, public/Test HTTP callbacks on both ports, encrypted Test secret, PKCE/DPoP ath, separate events service, 503 refresh recovery, rotation before and after restart, capture, reconnect, reload, stop and forget.');
	} finally {
		if (app) await app.close().catch(() => {});
		if (log) log.end();
		if (occupied) await stop(occupied);
		for (const socket of sockets.values()) socket.terminate();
		await new Promise(resolve => events.close(resolve));
		await stop(fixture);
		await stop(eventFixture);
		if (fixtureErrors.length) console.error(fixtureErrors.join('\n'));
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
