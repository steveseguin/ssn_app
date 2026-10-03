'use strict';

// Real Electron UI, source IPC, installed TikTok connector and capture scripts.
// Only external discovery/signing/chat transport is replaced with local fixtures.
// Run with the sibling social_stream checkout available (or SSAPP_CORE_DIR set).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const WebSocket = require('ws');
const connector = require('tiktok-live-connector');
const { chatFrame, freePort, waitFor } = require('./tiktok-disconnect-validation-e2e');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const root = path.resolve(__dirname, '../..');
const core = process.env.SSAPP_CORE_DIR || path.resolve(root, '../social_stream');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/hidden-capture.html'), 'utf8');

async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-platform-activation-'));
	const relayPort = await freePort();
	const room = `activation_${Date.now()}`;
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
		streamID: room, password: 'false', state: true, settings: { server2: { setting: true },
			capturelikeevent: { setting: true }, showviewercount: { setting: true }, capturejoinedevent: { setting: true } }, wsServer: true,
	}));
	const server = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise(resolve => server.once('listening', resolve));
	let sequence = 10000;
	let pauseChat = false;
	let socketConnections = 0;
	server.on('connection', () => { socketConnections++; });
	const sendTimer = setInterval(() => {
		if (pauseChat) return;
		for (const socket of server.clients) if (socket.readyState === WebSocket.OPEN) socket.send(chatFrame(++sequence));
	}, 500);
	const report = { profile, checks: [] };
	const received = [];
	const allTikTokEvents = [];
	let app, page, relay;
	let output = '';
	async function check(name, action) {
		if (process.env.SSAPP_ACTIVATION_CASE && !name.includes(process.env.SSAPP_ACTIVATION_CASE)) return;
		try {
			await action();
			report.checks.push({ name, passed: true });
			console.log(`PASS ${name}`);
		} catch (error) {
			report.checks.push({ name, passed: false, error: error.message });
			console.error(`FAIL ${name}: ${error.message}`);
		} finally {
			fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
		}
	}
	try {
		app = await _electron.launch({
			executablePath: require('electron'), cwd: root,
			args: ['.', '--running-from-source', '--multiinstance',
				`--filesource=${pathToFileURL(core + path.sep).href}`,
				`--ssapp-local-server-port=${relayPort}`, ...linuxLaunchArgs()],
			env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000,
		});
		for (const stream of [app.process().stdout, app.process().stderr]) {
			stream.on('data', chunk => { output = (output + chunk).slice(-100000); });
		}
		page = await app.firstWindow();
		await page.waitForFunction(() => window.stateManager?.initialized && configReady);
		await page.waitForTimeout(6000);
		await page.context().route('**www.tiktok.com/@activation_fixture/live**', route => route.fulfill({
			contentType: 'text/html', body: fixture.replace('var platform = query.get("platform") || "youtube";', 'var platform = "tiktok";'),
		}));
		await page.context().route('**youtube.com/live_chat?**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
		await app.evaluate((_electron, { root, port }) => {
			const req = process.getBuiltinModule('module').createRequire(root + '/package.json');
			const connector = req('tiktok-live-connector');
			const { ConnectionManager } = req('./tiktok/connection-manager').__test;
			global.__activationFixture = { failBootstrap: false, managers: [], signingCalls: 0 };
			connector.RouteConfig.fetchRoomIdComposite = async () => '123456';
			connector.RouteConfig.fetchSignedWebSocketFromProvider = async () => {
				global.__activationFixture.signingCalls++;
				if (global.__activationFixture.failBootstrap) throw new Error('Fixture connection unavailable');
				return {
					fetchResult: { messages: [], cursor: '0', internalExt: '', pushServer: `ws://127.0.0.1:${port}/`, routeParams: {} },
					fetchResultCookieHeader: [], fetchResultRoomId: '123456',
				};
			};
			const initialize = ConnectionManager.prototype.initializeConnectionInstance;
			ConnectionManager.prototype.initializeConnectionInstance = function (...args) {
				const result = initialize.apply(this, args);
				global.__activationFixture.managers.push(this);
				this.connection.fetchRoomInfo = async () => ({ data: { status: 2 } });
				this.connection.fetchAvailableGifts = async () => [];
				return result;
			};
		}, { root, port: server.address().port });
		relay = new WebSocket(`ws://127.0.0.1:${relayPort}`);
		await new Promise((resolve, reject) => { relay.once('open', resolve); relay.once('error', reject); });
		relay.send(JSON.stringify({ join: room, out: 3, in: 4 }));
		relay.on('message', raw => {
			try {
				const message = JSON.parse(raw.toString());
				if (message.type === 'tiktok') allTikTokEvents.push(message);
				if (/^(disconnect fixture|hidden-capture message)/.test(message.chatmessage)) received.push(message);
			} catch (_) { }
		});
		const sourceState = id => page.evaluate(id => stateManager.getSource(id), id);
		const nativeWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
			.filter(w => /activation_fixture\/live|youtube\.com\/live_chat/.test(w.webContents.getURL()))
			.map(w => ({ id: w.id, url: w.webContents.getURL() })));
		async function clear() {
			await page.evaluate(async () => {
				for (const s of stateManager.getSources()) {
					const button = document.querySelector(`[data-source-id="${s.id}"] [data-stophtml]`);
					if (button) await stopThis(button);
				}
				stateManager.clearAllSourcesAndGroups();
			});
			await waitFor(() => server.clients.size === 0, 'all native connectors stopped');
		}
		async function addTikTok(autoActivate = false) {
			return page.evaluate(autoActivate => {
				const id = stateManager.addSource({ target: 'tiktok', username: 'activation_fixture',
					url: 'https://www.tiktok.com/@activation_fixture/live', connectionMode: 'tiktok-websocket',
					tiktokSigningProvider: 'auto', autoActivate: false });
				stateManager.getSource(id).autoActivate = autoActivate;
				stateManager.persist();
				return id;
			}, autoActivate);
		}
		async function reloadFor(selector) {
			await page.reload();
			await page.waitForFunction(selector => window.stateManager?.initialized && configReady && document.querySelector(selector), selector);
		}
		await check('TikFinity dropdown opens its guide without changing the source mode', async () => {
			const id = await addTikTok();
			const select = page.locator(`[data-source-id="${id}"] .tiktok-connection-select`);
			await select.selectOption('local');
			const before = await sourceState(id);
			await page.evaluate(() => {
				window.originalGuideOpen = window.open;
				window.guideUrls = [];
				window.open = url => window.guideUrls.push(url);
			});
			try {
				await select.selectOption('tikfinity-guide');
				assert.deepStrictEqual(await page.evaluate(() => window.guideUrls), ['https://socialstream.ninja/docs/tikfinity-setup.html']);
				assert.deepStrictEqual(await sourceState(id), before);
				assert.strictEqual(await select.inputValue(), 'local');
			} finally {
				await page.evaluate(() => { window.open = window.originalGuideOpen; });
			}
		});
		await clear();
		if (process.env.SSAPP_TIKFINITY_EXECUTABLE) await check('TikFinity real Desktop API forwards into SSApp and stops', async () => {
			const desktop = await _electron.launch({ executablePath: process.env.SSAPP_TIKFINITY_EXECUTABLE,
				args: ['--user-data-dir=' + path.join(profile, 'tikfinity')], timeout: 60000 });
			try {
				const dashboard = await desktop.firstWindow();
				await dashboard.waitForFunction(() => window.API && typeof window.API.toMain === 'function');
				await dashboard.waitForTimeout(10000);
				const id = await addTikTok();
				const entry = page.locator(`[data-source-id="${id}"]`);
				await entry.locator('.tiktok-connection-select').selectOption('tikfinity');
				await entry.locator('[data-activatehtml]').press('Enter');
				await waitFor(async () => (await sourceState(id)).status === 'active', 'real TikFinity socket');
				const payload = { event: 'chat', data: { nickname: 'Real Desktop fixture', uniqueId: 'desktop_fixture',
					comment: 'hidden-capture message real Desktop API', msgId: '820001' } };
				// The real Desktop app broadcasts through its official renderer-to-main
				// path. This checks local integration, not account-authenticated LIVE.
				await dashboard.evaluate(payload => window.API.toMain({ action: 'emitWs', payload }), payload);
				await waitFor(() => received.some(m => m.chatname === 'Real Desktop fixture'), 'real Desktop chat at relay');
				await entry.screenshot({ path: path.join(profile, 'tikfinity-source.png') });
				await entry.locator('[data-stophtml]').press('Enter');
				const before = received.length;
				payload.data.msgId = '820002';
				await dashboard.evaluate(payload => window.API.toMain({ action: 'emitWs', payload }), payload);
				await page.waitForTimeout(1500);
				assert.strictEqual(received.length, before, 'real Desktop forwarded after Stop');
			} finally {
				await clear();
				await desktop.close();
			}
		});
		await clear();
		await check('TikFinity Desktop local API captures, deduplicates, recovers, persists and stops', async () => {
			const desktop = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 21213 });
			await new Promise((resolve, reject) => { desktop.once('listening', resolve); desktop.once('error', reject); });
			let count = 0;
			desktop.on('connection', () => count++);
			const send = packet => {
				for (const socket of desktop.clients) socket.send(typeof packet === 'string' ? packet : JSON.stringify(packet));
			};
			try {
				const id = await addTikTok();
				const entry = page.locator(`[data-source-id="${id}"]`);
				await entry.locator('.tiktok-connection-select').selectOption('tikfinity');
				await reloadFor(`[data-source-id="${id}"]`);
				await page.waitForTimeout(6000);
				assert.strictEqual(await entry.locator('.tiktok-connection-select').inputValue(), 'tikfinity');
				const signingCalls = await app.evaluate(() => global.__activationFixture.signingCalls);
				await entry.locator('[data-activatehtml]').press('Enter');
				await waitFor(async () => (await sourceState(id)).status === 'active', 'Desktop API connected');
				await waitFor(() => desktop.clients.size === 1, 'one Desktop socket');
				assert.match(await entry.innerText(), /waiting for LIVE events/);
				send('invalid json');
				send({ event: 'chat', data: null });
				send({ event: 'unknown', data: { comment: 'must not forward' } });
				const message = { event: 'chat', data: { msgId: '810001', userId: '123', uniqueId: 'local_api_viewer',
					nickname: 'Desktop fixture', comment: 'hidden-capture message Desktop API 👋 <script>' } };
				send(message);
				send(message);
				const captured = () => received.filter(m => m.chatname === 'Desktop fixture');
				await waitFor(() => captured().length === 1, 'Desktop chat at relay');
				assert.match(captured()[0].chatmessage, /👋/);
				assert.ok(!captured()[0].chatmessage.includes('<script>'), 'Unsafe markup reached the relay');
				await page.waitForTimeout(1200);
				assert.strictEqual(captured().length, 1, 'Duplicate message forwarded');
				assert.match(await entry.innerText(), /Receiving LIVE events/);
				assert.strictEqual(await entry.locator('[data-signin]').isVisible(), false, 'Desktop mode must not suggest TikTok sign-in');
				const user = { userId: '456', uniqueId: 'desktop_gifter', nickname: 'Desktop gift' };
				for (const event of ['follow', 'share', 'subscribe', 'member', 'like']) send({ event, data: { ...user, action: 1, msgId: 'event-' + event } });
				send({ event: 'roomUser', data: { viewerCount: 123 } });
				const gift = { event: 'gift', data: { ...user, msgId: 'gift-810', giftId: 5655, giftName: 'Rose',
					giftType: 1, diamondCount: 1, repeatCount: 1, repeatEnd: false, groupId: 'streak-810' } };
				send(gift);
				gift.data.repeatCount = 3;
				send(gift);
				gift.data.repeatEnd = true;
				send(gift);
				send(gift);
				await waitFor(() => allTikTokEvents.some(m => m.chatname === 'Desktop gift' && m.event === 'gift'), 'Desktop gift streak');
				await page.waitForTimeout(1500);
				const gifts = allTikTokEvents.filter(m => m.chatname === 'Desktop gift' && m.event === 'gift');
				assert.strictEqual(gifts.length, 1, 'Gift progress/completion was counted twice');
				assert.match(gifts[0].hasDonation, /3/);
				for (const event of ['followed', 'shared', 'subscribe', 'joined', 'liked']) {
					assert.ok(allTikTokEvents.some(m => m.chatname === 'Desktop gift' && m.event === event), event + ' missing');
				}
				assert.strictEqual(await app.evaluate(() => global.__activationFixture.managers.find(m =>
					m.signingProvider === 'tikfinity' && !m.isStopped).lastViewerCount), 123, 'Viewer count not normalized');
				const reply = await app.evaluate(async () => {
					const manager = global.__activationFixture.managers.find(m => m.signingProvider === 'tikfinity' && !m.isStopped);
					manager.sessionId = 'fixture';
					return manager.sendChatMessage('must not send');
				});
				assert.strictEqual(reply.success, false);
				assert.match(reply.error, /read-only/);
				const second = await page.evaluate(() => stateManager.addSource({ target: 'tiktok', username: 'desktop_duplicate',
					url: 'https://www.tiktok.com/@desktop_duplicate/live', connectionMode: 'tiktok-websocket',
					tiktokSigningProvider: 'tikfinity', autoActivate: false }));
				await page.locator(`[data-source-id="${second}"] [data-activatehtml]`).click({ force: true });
				await waitFor(async () => (await sourceState(second)).status === 'error', 'duplicate Desktop source rejected');
				assert.strictEqual(count, 1, 'Duplicate Desktop socket opened');
				assert.strictEqual((await sourceState(id)).status, 'active', 'Duplicate attempt stopped the first source');
				for (let expected = 2; expected <= 4; expected++) {
					for (const socket of desktop.clients) socket.terminate();
					await waitFor(() => count === expected, 'Desktop reconnect ' + expected, 40000);
				}
				send({ ...message, data: { ...message.data, msgId: '810002', comment: 'hidden-capture message Desktop recovered' } });
				send(gift);
				await waitFor(() => captured().length === 2, 'chat after Desktop recovery');
				assert.strictEqual(allTikTokEvents.filter(m => m.chatname === 'Desktop gift' && m.event === 'gift').length, 1, 'Gift replayed after reconnect');
				assert.strictEqual(await app.evaluate(() => global.__activationFixture.signingCalls), signingCalls, 'Local API used remote signing');
				await entry.locator('[data-stophtml]').press('Enter');
				await waitFor(() => desktop.clients.size === 0, 'Desktop socket stopped');
				await page.waitForTimeout(1500);
				assert.strictEqual(captured().length, 2);
				assert.strictEqual(count, 4, 'Stopped Desktop source reconnected');
			} finally {
				await clear();
				for (const socket of desktop.clients) socket.terminate();
				await new Promise(resolve => desktop.close(resolve));
			}
		});
		await clear();
		await check('TikFinity unavailable API retries locally and Stop cancels recovery', async () => {
			const id = await addTikTok();
			const entry = page.locator(`[data-source-id="${id}"]`);
			await entry.locator('.tiktok-connection-select').selectOption('tikfinity');
			const before = await app.evaluate(() => global.__activationFixture.signingCalls);
			await entry.locator('[data-activatehtml]').click({ force: true });
			await waitFor(async () => app.evaluate(() => global.__activationFixture.managers.some(m =>
				m.signingProvider === 'tikfinity' && !m.isStopped && m.reconnectAttempts >= 2)), 'local retry after refusal');
			assert.match(await entry.innerText(), /TikFinity Desktop|retrying/);
			await entry.locator('[data-activatehtml]').click({ force: true });
			await waitFor(async () => app.evaluate(() => global.__activationFixture.managers.filter(m =>
				m.signingProvider === 'tikfinity').every(m => m.isStopped && !m.reconnectTimer)), 'cancel local retry');
			await page.waitForTimeout(5000);
			assert.strictEqual(await app.evaluate(() => global.__activationFixture.signingCalls), before, 'Unavailable local API called a sign service');
			await entry.locator('.tiktok-connection-select').selectOption('local');
			assert.strictEqual(await entry.locator('[data-signin]').isVisible(), true, 'Switching modes did not restore sign-in');
		});
		await clear();
		await check('TikFinity Activity Feed captures through Add other source and stops', async () => {
			const url = 'https://tikfinity.zerody.one/widget/activity-feed?cid=ssapp-test&did=1';
			const frameUrl = 'https://tikfinity.zerody.one/widget/vite/src/activity-feed/ssapp-test';
			await page.context().route(url, route => route.fulfill({
				contentType: 'text/html', body: `<html><body><iframe src="${frameUrl}"></iframe></body></html>`,
			}));
			await page.context().route(frameUrl, route => route.fulfill({
				contentType: 'text/html', body: `<html><body>TikFinity fixture<script>
				let sequence = 0;
				setInterval(() => window.postMessage({ type: 'chat', payload: {
					nickname: 'TikFinity fixture', uniqueId: 'ssapp_fixture',
					comment: 'hidden-capture message TikFinity ' + (++sequence), msgId: String(sequence)
				}}, '*'), 500);
				</script></body></html>`,
			}));
			await page.locator('[data-source-type="other"]').click();
			await page.locator('#source-setup-input').fill(url);
			await page.getByRole('button', { name: 'Add source', exact: true }).click();
			const id = await page.evaluate(() => stateManager.getSources().find(s => s.target === 'tikfinity')?.id);
			assert.ok(id, 'Activity Feed URL should be recognized as TikFinity');
			assert.deepStrictEqual((await sourceState(id)).sourceFiles, ['sources/tikfinity.js']);
			const entry = page.locator(`[data-source-id="${id}"]`);
			await entry.locator('[data-activatehtml]').press('Enter');
			const captured = () => received.filter(m => m.chatname === 'TikFinity fixture');
			await waitFor(() => captured().length >= 4, 'TikFinity iframe messages at relay');
			assert.ok(captured().every(m => m.type === 'tiktok'));
			assert.strictEqual(new Set(captured().map(m => m.chatmessage)).size, captured().length);
			await entry.locator('[data-stophtml]').press('Enter');
			await waitFor(async () => (await sourceState(id)).status === 'inactive', 'TikFinity Stop');
			const countAfterStop = captured().length;
			await page.waitForTimeout(1500);
			assert.strictEqual(captured().length, countAfterStop);
		});
		await clear();
		for (const region of ['global', 'us']) {
			await check(`TikTok Local Signer captures from the ${region} bootstrap endpoint`, async () => {
				const host = region === 'us' ? 'webcast.us.tiktok.com' : 'webcast.tiktok.com';
				const username = `local_${region}_fixture`;
				const bootstrapUrl = `https://${host}/webcast/im/fetch/?room_id=123456&identity=audience`;
				const body = Object.assign(connector.ProtoMessageFetchResult.decode(Buffer.alloc(0)), {
					messages: [], cursor: 'local-fixture', internalExt: '', routeParams: {},
					pushServer: `ws://127.0.0.1:${server.address().port}/`,
				});
				await page.context().route(bootstrapUrl, route => route.fulfill({
					contentType: 'application/octet-stream', body: Buffer.from(connector.ProtoMessageFetchResult.encode(body).finish()),
				}));
				await page.context().route(`https://www.tiktok.com/@${username}/live`, route => route.fulfill({
					contentType: 'text/html', body: `<html><body data-room-id="123456">Local signer fixture<script>
					window.SIGI_STATE = { room: { roomId: '123456' } };
					setTimeout(() => fetch(${JSON.stringify(bootstrapUrl)}).then(r => r.arrayBuffer()), 500);
					</script></body></html>`,
				}));
				const id = await page.evaluate(username => stateManager.addSource({
					target: 'tiktok', username, url: `https://www.tiktok.com/@${username}/live`, autoActivate: false,
					connectionMode: 'tiktok-websocket', tiktokSigningProvider: 'local',
				}), username);
				const before = received.length;
				await page.locator(`[data-source-id="${id}"] [data-activatehtml]`).press('Enter');
				await waitFor(async () => {
					const s = await sourceState(id);
					return s.status === 'active' && received.slice(before).some(m => m.tid === s.vid);
				}, `${region} local signer chat at relay`, 45000);
				const manager = await app.evaluate(() => {
					const m = global.__activationFixture.managers.at(-1);
					return { provider: m.signingProvider, roomId: m.connection.roomId, retries: m.reconnectAttempts };
				});
				assert.deepStrictEqual(manager, { provider: 'local', roomId: '123456', retries: 0 });
				await page.locator(`[data-source-id="${id}"] [data-activatehtml]`).press('Enter');
				await waitFor(async () => (await sourceState(id)).status === 'inactive', 'local signer Stop');
			});
			await clear();
		}
		await check('TikTok watchdog recovers a stalled busy connection without reconnecting a quiet room', async () => {
			const id = await addTikTok();
			await page.locator(`[data-source-id="${id}"] [data-activatehtml]`).press('Enter');
			await waitFor(async () => (await sourceState(id)).status === 'active', 'watchdog source connected', 45000);
			pauseChat = true;
			const before = socketConnections;
			try {
				await app.evaluate(() => {
					const m = global.__activationFixture.managers.at(-1);
					const at = Date.now() - 15 * 60000;
					m.lastMessageTime = at;
					m.activityBuckets = new Map([[Math.floor(at / 60000) * 60000, 1]]);
				});
				// Let the real, unaccelerated 60-second health timer run at least once.
				await page.waitForTimeout(65000);
				assert.strictEqual(socketConnections, before, 'Quiet room should keep its connection');
				assert.match(await page.locator(`[data-source-id="${id}"] .ws-status`).getAttribute('title'), /traffic:.*events forwarded/);
				const timeout = await app.evaluate(() => {
					const m = global.__activationFixture.managers.at(-1);
					const at = Date.now() - 6 * 60000;
					m.lastMessageTime = at;
					m.activityBuckets = new Map([[Math.floor(at / 60000) * 60000, 240]]);
					return m.getAdaptiveMessageTimeout();
				});
				assert.strictEqual(timeout, 5 * 60000, 'Busy stream must not become idle during silence');
				await waitFor(() => socketConnections > before, 'real watchdog automatic reconnect', 75000);
				pauseChat = false;
				const count = received.length;
				await waitFor(async () => {
					const s = await sourceState(id);
					return s.status === 'active' && received.slice(count).some(m => m.tid === s.vid);
				}, 'chat at relay after watchdog recovery');
				assert.strictEqual(socketConnections, before + 1, 'Watchdog must create only one replacement connection');
			} finally {
				pauseChat = false;
			}
		});
		await clear();
		await check('TikTok Local Signer honors Retry-After before reconnecting and capturing chat', async () => {
			const username = 'local_rate_limit_fixture';
			const bootstrapUrl = 'https://webcast.us.tiktok.com/webcast/im/fetch/?room_id=123456&identity=audience';
			const requests = [];
			const body = Object.assign(connector.ProtoMessageFetchResult.decode(Buffer.alloc(0)), {
				messages: [], cursor: 'local-retry-fixture', internalExt: '', routeParams: {},
				pushServer: `ws://127.0.0.1:${server.address().port}/`,
			});
			await page.context().route(bootstrapUrl, route => {
				requests.push(Date.now());
				return route.fulfill(requests.length === 1
					? { status: 429, headers: { 'Retry-After': '120' }, body: '' }
					: { contentType: 'application/octet-stream', body: Buffer.from(connector.ProtoMessageFetchResult.encode(body).finish()) });
			});
			await page.context().route(`https://www.tiktok.com/@${username}/live`, route => route.fulfill({
				contentType: 'text/html', body: `<html><body data-room-id="123456">Rate limit fixture<script>
				window.SIGI_STATE = { room: { roomId: '123456' } };
				setTimeout(() => fetch(${JSON.stringify(bootstrapUrl)}).then(r => r.arrayBuffer()), 500);
				</script></body></html>`,
			}));
			const id = await page.evaluate(username => stateManager.addSource({
				target: 'tiktok', username, url: `https://www.tiktok.com/@${username}/live`, autoActivate: false,
				connectionMode: 'tiktok-websocket', tiktokSigningProvider: 'local',
			}), username);
			const before = received.length;
			await page.locator(`[data-source-id="${id}"] [data-activatehtml]`).press('Enter');
			await waitFor(() => requests.length > 0, 'rate-limited bootstrap request', 45000);
			await waitFor(() => app.evaluate(() => global.__activationFixture.managers.at(-1).tiktokRateLimitCount === 1),
				'HTTP 429 recognized by the real connection manager', 45000);
			await waitFor(async () => {
				const s = await sourceState(id);
				return s.status === 'active' && received.slice(before).some(m => m.tid === s.vid);
			}, 'local signer reconnect and chat after Retry-After', 160000);
			assert.strictEqual(requests.length, 2, 'Only one retry should be needed');
			const retryDelayMs = requests[1] - requests[0];
			assert.ok(retryDelayMs >= 120000, `Retried before Retry-After expired: ${retryDelayMs}ms`);
			report.localSignerRetry = { retryAfterSeconds: 120, retryDelayMs };
			assert.strictEqual(await app.evaluate(() => global.__activationFixture.managers.at(-1).signingProvider), 'local');
			await page.locator(`[data-source-id="${id}"] [data-activatehtml]`).press('Enter');
			await waitFor(async () => (await sourceState(id)).status === 'inactive', 'rate-limited local signer Stop');
		});
		await clear();
		await check('TikTok Auto retires failed connectors and captures through a real Standard window', async () => {
			await app.evaluate(() => { global.__activationFixture.failBootstrap = true; });
			const id = await addTikTok();
			const before = received.length;
			await page.locator(`[data-source-id="${id}"] [data-activatehtml]`).press('Enter');
			await waitFor(async () => (await nativeWindows()).some(w => w.url.includes('tiktok.com')), 'Standard fallback window', 15000);
			await waitFor(() => received.slice(before).some(m => m.type === 'tiktok'), 'Standard fallback capture', 20000);
			await page.waitForTimeout(3000);
			const source = await sourceState(id);
			assert.strictEqual(source.status, 'active');
			assert.strictEqual(source.activeConnectionMode, 'classic');
			assert.ok(!source.tiktokWssId);
			assert.ok(await app.evaluate(() => global.__activationFixture.managers.every(m => m.isStopped)), 'Failed managers were not retired');
			const windowsBefore = await nativeWindows();
			await page.evaluate(id => createClassicWindowFromSource(stateManager.getSource(id)), id);
			assert.deepStrictEqual(await nativeWindows(), windowsBefore, 'Duplicate activation created a second real window');
		});
		await clear();
		await check('TikTok fallback ignores late connector completion and Stop closes the real window', async () => {
			await app.evaluate(() => { global.__activationFixture.failBootstrap = true; });
			await page.evaluate(() => {
				window.activationOriginalInvoke = ipcRenderer.invoke;
				// Keep the real IPC and connector work, delaying only response delivery.
				ipcRenderer.invoke = async function (channel, ...args) {
					const response = await window.activationOriginalInvoke.call(this, channel, ...args);
					if (channel === 'createTikTokConnection') await new Promise(resolve => { window.releaseActivationReply = resolve; });
					return response;
				};
			});
			try {
				const id = await addTikTok();
				await page.evaluate(id => {
					window.lateActivation = attemptActivationModes({ sourceId: id, initialMode: 'tiktok-legacy' });
				}, id);
				await page.waitForFunction(() => !!window.releaseActivationReply);
				// Advance the real fallback path while the older IPC response is in flight.
				await page.evaluate(id => performActivationAttempt({ sourceId: id, mode: 'classic' }), id);
				await page.evaluate(async () => { window.releaseActivationReply(); await window.lateActivation; });
				await page.waitForTimeout(1000);
				const source = await sourceState(id);
				assert.strictEqual(source.activeConnectionMode, 'classic', 'Late connector response replaced Standard mode');
				assert.strictEqual(source.status, 'active');
				assert.ok(!source.tiktokWssId);
				assert.strictEqual(await page.locator(`[data-source-id="${id}"] .ws-status.error`).count(), 0,
					'Canceled connector attempt replaced the connected UI with an error');
				const before = received.length;
				await waitFor(() => received.length > before, 'capture after late completion');
				await page.locator(`[data-source-id="${id}"] [data-stophtml]`).press('Enter');
				await waitFor(async () => (await nativeWindows()).length === 0, 'Stop closes actual capture window');
				await page.waitForTimeout(2500);
				assert.strictEqual((await sourceState(id)).status, 'inactive');
			} finally {
				await page.evaluate(() => { window.releaseActivationReply?.(); ipcRenderer.invoke = window.activationOriginalInvoke; });
			}
		});
		await clear();
		await app.evaluate(() => { global.__activationFixture.failBootstrap = false; });
		await check('Compatibility describes and uses signed WebSocket transport; saved mode still loads', async () => {
			const id = await addTikTok();
			const select = page.locator(`[data-source-id="${id}"] .tiktok-connection-select`);
			await select.selectOption('polling');
			const before = received.length;
			await page.locator(`[data-source-id="${id}"] [data-activatehtml]`).press('Enter');
			await waitFor(() => received.slice(before).some(m => m.type === 'tiktok'), 'compatibility WebSocket capture');
			const source = await sourceState(id);
			assert.strictEqual(source.connectionMode, 'tiktok-legacy');
			assert.ok(await app.evaluate(() => global.__activationFixture.signingCalls > 0));
			assert.match(await select.locator('option:checked').innerText(), /Compatibility \(WebSocket\)/);
			const help = await page.locator(`[data-source-id="${id}"] .provider-help-text`).innerText();
			assert.match(help, /signing/i);
			assert.doesNotMatch(help, /HTTP|No signing/i);
			const details = await app.evaluate(() => global.__activationFixture.managers.at(-1).getConnectionModeDetails());
			assert.match(details.label, /Compatibility \(WebSocket\)/);
			await reloadFor(`[data-source-id="${id}"] .tiktok-connection-select`);
			assert.strictEqual(await select.inputValue(), 'polling');
			assert.strictEqual((await sourceState(id)).vid, source.vid);
			const afterReload = received.length;
			await waitFor(() => received.length > afterReload, 'capture after UI reload');
		});
		await clear();
		for (const cancel of [true, false]) {
			await check(`TikTok startup auto-activation ${cancel ? 'honors cancellation' : 'connects when enabled'}`, async () => {
				const id = await addTikTok(true);
				const selector = `[data-source-id="${id}"] .auto-activate-toggle input`;
				await reloadFor(selector);
				if (cancel) await page.locator(selector).evaluate(el => el.click());
				const before = received.length;
				await page.waitForTimeout(6500);
				const source = await sourceState(id);
				assert.strictEqual(source.autoActivate, !cancel);
				if (cancel) {
					assert.ok(!source.vid && !source.tiktokWssId, 'Disabled source activated after startup timer');
					assert.strictEqual(server.clients.size, 0);
				} else {
					assert.strictEqual(source.status, 'active');
					await waitFor(() => received.length > before, 'startup capture');
				}
			});
			await clear();
		}
		let discoveryCalls = 0;
		let releaseDiscovery;
		await page.route('https://api.socialstream.ninja/youtube/streams?**', async route => {
			discoveryCalls++;
			await new Promise(resolve => { releaseDiscovery = resolve; });
			await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: [{
				videoId: 'AuditVideo01', title: 'Startup fixture', channelId: 'UCStartupAudit', status: 'live', viewers: 12,
			}] }) }).catch(() => {});
		});
		for (const action of ['disable-before', 'disable-pending', 'delete-pending', 'rename-pending', 'enabled', 'manual']) {
			await check(`YouTube startup/manual discovery: ${action}`, async () => {
				const id = 'startup-' + action;
				await page.evaluate(({ id, action }) => {
					stateManager.addGroup({ id, target: 'youtube', username: '@' + id, isChannel: false,
						connectionMode: 'classic', autoActivate: false, streams: [] });
					stateManager.getGroup(id).autoActivate = action !== 'manual';
					stateManager.persist();
				}, { id, action });
				const selector = `[data-group-id="${id}"] .auto-activate-toggle input`;
				const beforeCalls = discoveryCalls;
				await reloadFor(selector);
				if (action === 'disable-before') await page.locator(selector).first().evaluate(el => el.click());
				let manual;
				if (action === 'manual') {
					manual = page.evaluate(async id => {
						// The explicit action also checks the channel page; supply an empty remote response.
						const invoke = ipcRenderer.invoke;
						ipcRenderer.invoke = function (channel, payload, ...args) {
							if (channel === 'nodefetch' && payload.url.startsWith('https://www.youtube.com/')) {
								return Promise.resolve({ status: 200, data: '<html></html>' });
							}
							return invoke.call(this, channel, payload, ...args);
						};
						try {
							return await handleYouTubeActivation('@' + id, false, false, true, false, { groupId: id, manualTrigger: true });
						} finally { ipcRenderer.invoke = invoke; }
					}, id);
				}
				if (action !== 'disable-before') await waitFor(() => discoveryCalls > beforeCalls, 'startup discovery request');
				else await page.waitForTimeout(4500);
				if (action === 'disable-pending') await page.locator(selector).first().evaluate(el => el.click());
				if (action === 'delete-pending') await page.evaluate(id => stateManager.removeGroup(id), id);
				if (action === 'rename-pending') await page.evaluate(id => stateManager.updateGroup(id, { username: '@RenamedAccount' }), id);
				if (releaseDiscovery) { releaseDiscovery(); releaseDiscovery = null; }
				if (manual) await manual;
				await page.waitForTimeout(4000);
				const state = await page.evaluate(() => ({ groups: stateManager.getGroups(), sources: stateManager.getSources() }));
				if (action === 'enabled' || action === 'manual') {
					assert.strictEqual(state.sources.length, 1);
					assert.strictEqual(state.sources[0].status, 'active');
					assert.strictEqual((await nativeWindows()).length, 1);
					const count = received.length;
					await waitFor(() => received.slice(count).some(m => m.type === 'youtube'), 'YouTube source capture', 20000);
				} else {
					assert.strictEqual(state.sources.length, 0, 'Canceled discovery created sources');
					assert.strictEqual((await nativeWindows()).length, 0, 'Canceled discovery opened windows');
					if (action === 'delete-pending') assert.strictEqual(state.groups.length, 0, 'Deleted group was recreated');
					if (action === 'disable-before') assert.strictEqual(discoveryCalls, beforeCalls, 'Disabled startup still ran discovery');
				}
			});
			if (releaseDiscovery) { releaseDiscovery(); releaseDiscovery = null; }
			await clear();
		}
	} finally {
		clearInterval(sendTimer);
		if (relay) relay.terminate();
		if (app) {
			const child = app.process();
			await app.evaluate(({ BrowserWindow }) => {
				const main = BrowserWindow.getAllWindows().find(w => /\/index\.html/.test(w.webContents.getURL()));
				if (main) main.close();
			}).catch(() => {});
			await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'app shutdown', 10000).catch(() => child.kill());
			await app.close().catch(() => {});
		}
		for (const socket of server.clients) socket.terminate();
		await new Promise(resolve => server.close(resolve));
		fs.writeFileSync(path.join(profile, 'electron.log'), output);
		fs.writeFileSync(path.join(profile, 'events.json'), JSON.stringify(allTikTokEvents, null, 2));
		console.log(`Evidence: ${profile}`);
	}
	assert.strictEqual(report.checks.filter(c => !c.passed).length, 0, 'Functional regression checks failed');
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
