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
		streamID: room, password: 'false', state: true, settings: { server2: { setting: true } }, wsServer: true,
	}));
	const server = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise(resolve => server.once('listening', resolve));
	let sequence = 10000;
	const sendTimer = setInterval(() => {
		for (const socket of server.clients) if (socket.readyState === WebSocket.OPEN) socket.send(chatFrame(++sequence));
	}, 500);
	const report = { profile, checks: [] };
	const received = [];
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
		console.log(`Evidence: ${profile}`);
	}
	assert.strictEqual(report.checks.filter(c => !c.passed).length, 0, 'Functional regression checks failed');
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
