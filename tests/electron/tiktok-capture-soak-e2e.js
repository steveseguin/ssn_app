'use strict';

// A/B soak in one real SSApp instance. All test chat/event traffic is local;
// no live accounts, sign servers, or app-wide runtime changes are involved.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { _electron } = require('playwright-core');
const WebSocket = require('ws');
const connector = require('tiktok-live-connector');
const { freePort, waitFor } = require('./tiktok-disconnect-validation-e2e');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const root = path.resolve(__dirname, '../..');
const sourceRoot = path.resolve(root, '../social_stream');
// Keep the original script available after the fix is committed to HEAD.
const baselineArg = process.argv.find(arg => arg.startsWith('--baseline-ref='));
const baselineRef = baselineArg ? baselineArg.slice('--baseline-ref='.length) : '1267e184';
const minutesArg = process.argv.find(arg => arg.startsWith('--minutes='));
const minutes = minutesArg ? Number(minutesArg.slice(10)) : 30;
// Keep successive closes over 60 seconds apart so this tests ordinary recovery,
// not the separate rapid-disconnect fallback path.
assert.ok(Number.isFinite(minutes) && minutes >= 4 && minutes <= 120);
const durationMs = minutes * 60000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const defaults = name => connector[name].decode(Buffer.alloc(0));

function frame(variant, sequence, like = false) {
	const id = String(100000000 + sequence * 10 + (variant === 'patched' ? 1 : 0) + (like ? 2 : 0));
	const common = Object.assign(defaults('CommonMessageData'), {
		msgId: id, roomId: '123456', createTime: String(Math.floor(Date.now() / 1000)),
	});
	const user = Object.assign(defaults('User'), {
		id: variant === 'patched' ? '124' : '123', nickname: `soak-event-${variant}-${sequence}`,
	});
	const method = like ? 'WebcastLikeMessage' : 'WebcastChatMessage';
	const data = Object.assign(defaults(method), like
		? { common, user, count: 1, total: String(sequence) }
		: { common, user, content: `soak-ws-${variant}-${sequence}` });
	const result = Object.assign(defaults('ProtoMessageFetchResult'), {
		messages: [Object.assign(defaults('BaseProtoMessage'), {
			method, msgId: id, payload: connector[method].encode(data).finish(),
		})],
	});
	return connector.createBaseWebcastPushFrame({ payload: connector.ProtoMessageFetchResult.encode(result).finish() }).finish();
}

async function run() {
	const started = new Date().toISOString();
	const artifactDir = path.join(root, 'test-results');
	fs.mkdirSync(artifactDir, { recursive: true });
	const reportPath = path.join(artifactDir, `tiktok-soak-${Date.now()}.json`);
	const progressPath = reportPath.replace('.json', '.jsonl');
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-tiktok-soak-'));
	const baselineText = execFileSync('git', ['show', `${baselineRef}:sources/tiktok.js`], { cwd: sourceRoot, encoding: 'utf8' });
	const baselinePath = path.join(profile, 'tiktok-original.js');
	fs.writeFileSync(baselinePath, baselineText);
	const patchedText = fs.readFileSync(path.join(sourceRoot, 'sources/tiktok.js'), 'utf8');
	assert.notStrictEqual(baselineText, patchedText, 'A/B requires distinct original and patched scripts');
	const relayPort = await freePort();
	const room = `tiktok_soak_${Date.now()}`;
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
		streamID: room, password: 'false', state: true,
		settings: { server2: { setting: true }, capturelikeevent: { setting: true } }, wsServer: true,
	}));
	const html = fs.readFileSync(path.join(__dirname, 'fixtures/hidden-capture.html'));
	const fixture = http.createServer((_request, response) => {
		response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
		response.end(html);
	});
	await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
	const sockets = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise(resolve => sockets.once('listening', resolve));
	const variants = ['baseline', 'patched'];
	const connections = { baseline: 0, patched: 0 };
	const wsSent = { baseline: new Set(), patched: new Set() };
	const wsReceived = { baseline: new Set(), patched: new Set() };
	const domReceived = { baseline: new Set(), patched: new Set() };
	const controlsReceived = { baseline: new Set(), patched: new Set() };
	const likesReceived = { baseline: 0, patched: 0 };
	const duplicates = { ws: 0, dom: 0 };
	const actions = [];
	const dom = {};
	const wsSources = {};
	let app, child, relay, wsTimer, watchdog;
	let output = '';
	let paused = true;
	let suppressChat = false;
	let sequence = 0;
	let report = { started, minutes, baselineRef, environment: {}, actions, scope: 'Windows SSApp with local fixtures; signing/room lookup bypassed' };
	const writeProgress = entry => {
		fs.appendFileSync(progressPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
		console.log('[tiktok-soak] ' + JSON.stringify(entry));
	};
	sockets.on('connection', (socket, request) => {
		socket.variant = new URL(request.url, 'http://fixture').searchParams.get('variant');
		assert.ok(variants.includes(socket.variant));
		socket.sendAfter = Date.now() + 1000;
		connections[socket.variant]++;
	});
	try {
		app = await _electron.launch({
			executablePath: require('electron'), cwd: root,
			args: ['.', '--running-from-source', '--multiinstance', `--filesource=${sourceRoot.replace(/\\/g, '/')}/`,
				`--ssapp-local-server-port=${relayPort}`, '--ssapp-headless-control', '--no-hwa', ...linuxLaunchArgs()],
			env: { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_DIAGNOSTICS_SAFE_GPU: '1', UV_THREADPOOL_SIZE: '2' },
			timeout: 60000,
		});
		child = app.process();
		watchdog = setTimeout(() => { if (child.exitCode === null) child.kill(); }, durationMs + 180000);
		child.stdout.on('data', data => { output = (output + data).slice(-16000); });
		child.stderr.on('data', data => { output = (output + data).slice(-16000); });
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.stateManager?.initialized && typeof configReady !== 'undefined' && configReady);
		await delay(6000);
		report.environment = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform }));
		report.environment.app = require('../../package.json').version;
		report.environment.connector = require('tiktok-live-connector/package.json').version;
		report.sourceHashes = Object.fromEntries([['baseline', baselineText], ['patched', patchedText]].map(([name, text]) => [name, crypto.createHash('sha256').update(text).digest('hex')]));
		relay = new WebSocket(`ws://127.0.0.1:${relayPort}`);
		await new Promise((resolve, reject) => { relay.once('open', resolve); relay.once('error', reject); });
		relay.send(JSON.stringify({ join: room, out: 3, in: 4 }));
		relay.on('message', raw => {
			try {
				const message = JSON.parse(raw.toString());
				if (message.type !== 'tiktok') return;
				const match = String(message.chatmessage || '').match(/soak-(ws|dom|control)-(baseline|patched)-(\d+)/);
				if (match) {
					const collection = match[1] === 'ws' ? wsReceived : match[1] === 'dom' ? domReceived : controlsReceived;
					const id = Number(match[3]);
					if (collection[match[2]].has(id) && match[1] !== 'control') duplicates[match[1]]++;
					collection[match[2]].add(id);
				}
				const like = String(message.chatname || '').match(/soak-event-(baseline|patched)-/);
				if (like && message.event === 'liked') likesReceived[like[1]]++;
			} catch (_) { }
		});
		await app.evaluate((_electron, { root, port }) => {
			const localRequire = process.getBuiltinModule('module').createRequire(root + '/package.json');
			const proto = localRequire('./tiktok/connection-manager').__test.ConnectionManager.prototype;
			const original = proto.initializeConnectionInstance;
			global.__tiktokSoak = {};
			proto.initializeConnectionInstance = function (...args) {
				original.apply(this, args);
				const variant = this.username.replace('ssapp_soak_', '');
				if (!['baseline', 'patched'].includes(variant)) throw new Error('Unexpected fixture source');
				global.__tiktokSoak[variant] = this;
				const connection = this.connection;
				connection._connect = () => {
					connection.webClient.roomId = '123456';
					return connection.setupWebsocket(`ws://127.0.0.1:${port}/?variant=${variant}&fixture=1`, {}, '123456');
				};
				if (variant === 'baseline') {
					for (const listener of connection.listeners('disconnected')) {
						connection.removeListener('disconnected', listener);
						connection.on('disconnect', listener);
					}
				}
			};
		}, { root, port: sockets.address().port });
		for (const variant of variants) {
			wsSources[variant] = await page.evaluate(variant => stateManager.addSource({
				target: 'tiktok', username: 'ssapp_soak_' + variant, connectionMode: 'tiktok-websocket', tiktokSigningProvider: 'auto', autoActivate: false,
			}), variant);
			const activated = await page.evaluate(async sourceId => (await performActivationAttempt({ sourceId, mode: 'tiktok-websocket' })).success, wsSources[variant]);
			assert.strictEqual(activated, true);
			const url = `http://127.0.0.1:${fixture.address().port}/@soak_${variant}/live?platform=tiktok&manual=1&variant=${variant}`;
			const sourceFile = variant === 'baseline' ? baselinePath : 'sources/tiktok.js';
			const created = await page.evaluate(async ({ url, sourceFile, variant }) => {
				const element = await newOtherSource('tiktok', url, false, { username: 'soak_' + variant, sourceFile, connectionMode: 'classic', autoActivate: false, isVisible: false, isMuted: true });
				const sourceId = element.dataset.sourceId;
				const button = document.querySelector(`[data-source-id="${sourceId}"] [data-activatehtml]`);
				return { sourceId, tabId: await createWindow(button) };
			}, { url, sourceFile, variant });
			await waitFor(() => app.windows().some(window => window.url() === url), 'DOM source page');
			const sourcePage = app.windows().find(window => window.url() === url);
			await sourcePage.waitForFunction(() => window.__hiddenCaptureFixture && window.chrome?.runtime?.sendMessage);
			await sourcePage.evaluate(variant => {
				window.__soak = { generated: 0, controls: 0, sourceMessages: 0, timer: null };
				const originalSend = chrome.runtime.sendMessage;
				chrome.runtime.sendMessage = function () {
					const payload = arguments[1] || arguments[0];
					if (payload?.message?.chatmessage?.includes('soak-dom-' + variant + '-')) window.__soak.sourceMessages++;
					return originalSend.apply(this, arguments);
				};
			}, variant);
			dom[variant] = { ...created, page: sourcePage, url };
		}
		await delay(4000);
		await waitFor(() => app.evaluate(() => Object.values(global.__tiktokSoak).every(manager => manager.connection.isConnected)), 'both WebSockets ready');
		for (const variant of variants) {
			await dom[variant].page.evaluate(variant => {
				window.__soak.timer = setInterval(() => {
					const id = ++window.__soak.generated;
					const index = (id - 1) % 300;
					const message = 'soak-dom-' + variant + '-' + id;
					if (id <= 300) window.__hiddenCaptureFixture.appendRows([{ id, index, message }]);
					else {
						const row = document.querySelector('[data-e2e="chat-message"][data-index="' + index + '"]');
						const text = row.querySelector('.break-words');
						if (id % 2) text.textContent = message;
						else text.firstChild.nodeValue = message;
						// Same-content rerenders must not produce duplicate chat rows.
						if (id % 50 === 0) setTimeout(() => { text.firstChild.nodeValue = message; }, 40);
					}
					if (id % 1500 === 0) {
						window.__soak.controls++;
						window.__hiddenCaptureFixture.appendRows([{ id: 100000 + id, index: -1, message: 'soak-control-' + variant + '-' + id }]);
					}
				}, 200);
			}, variant);
		}
		wsTimer = setInterval(() => {
			if (paused) return;
			sequence++;
			for (const socket of sockets.clients) {
				if (socket.readyState !== WebSocket.OPEN || Date.now() < socket.sendAfter) continue;
				if (!suppressChat) {
					socket.send(frame(socket.variant, sequence));
					wsSent[socket.variant].add(sequence);
				}
				if (sequence % 5 === 0) socket.send(frame(socket.variant, sequence, true));
			}
		}, 200);
		paused = false;
		const soakStart = Date.now();
		let dropIndex = 0, restartAt = null, lastSample = 0, silenceStarted = null, silenceFinished = false;
		const dropTimes = [0.2, 0.5, 0.8].map(fraction => durationMs * fraction);
		while (Date.now() - soakStart < durationMs) {
			const elapsed = Date.now() - soakStart;
			if (dropIndex < dropTimes.length && elapsed >= dropTimes[dropIndex]) {
				paused = true;
				await delay(1000);
				for (const socket of sockets.clients) socket.close(1012, 'soak restart');
				paused = false;
				dropIndex++;
				restartAt = elapsed + Math.min(60000, durationMs * 0.08);
				actions.push({ action: 'closeBothSockets', elapsedMs: elapsed, drop: dropIndex });
			}
			if (restartAt !== null && elapsed >= restartAt) {
				const states = await app.evaluate(() => Object.fromEntries(Object.entries(global.__tiktokSoak).map(([variant, manager]) => [variant, { connected: manager.connection.isConnected, retry: !!manager.reconnectTimer }])));
				assert.strictEqual(states.baseline.connected, false, 'Original handler unexpectedly recovered');
				assert.strictEqual(states.baseline.retry, false);
				assert.strictEqual(states.patched.connected, true, 'Patched handler failed to recover');
				actions.push({ action: 'checkedRecovery', elapsedMs: elapsed, states });
				await page.evaluate(async sourceId => {
					await stopThis(document.querySelector(`[data-source-id="${sourceId}"] [data-stophtml]`));
					await performActivationAttempt({ sourceId, mode: 'tiktok-websocket' });
				}, wsSources.baseline);
				restartAt = null;
			}
			if (!silenceStarted && elapsed >= durationMs * 0.35) {
				suppressChat = true;
				silenceStarted = { counts: { baseline: wsReceived.baseline.size, patched: wsReceived.patched.size }, connections: { ...connections }, likes: { ...likesReceived } };
				actions.push({ action: 'withholdChatKeepLikes', elapsedMs: elapsed, ...silenceStarted });
			}
			if (silenceStarted && !silenceFinished && elapsed >= durationMs * 0.42) {
				const states = await app.evaluate(() => Object.fromEntries(Object.entries(global.__tiktokSoak).map(([variant, manager]) => [variant, { connected: manager.connection.isConnected, stats: manager.getTikTokDiagnosticStats() }])));
				actions.push({ action: 'endSelectiveSilence', elapsedMs: elapsed, states, connections: { ...connections }, likes: { ...likesReceived } });
				assert.deepStrictEqual(connections, silenceStarted.connections, 'Event-only traffic should not force a reconnect');
				for (const variant of variants) assert.ok(likesReceived[variant] > silenceStarted.likes[variant]);
				suppressChat = false;
				silenceFinished = true;
			}
			if (elapsed - lastSample >= 30000) {
				lastSample = elapsed;
				const domCounts = {};
				for (const variant of variants) domCounts[variant] = await dom[variant].page.evaluate(() => ({ generated: window.__soak.generated, captured: window.__soak.sourceMessages }));
				writeProgress({ elapsedSeconds: Math.round(elapsed / 1000), dom: domCounts, delivered: Object.fromEntries(variants.map(v => [v, domReceived[v].size])), wsSent: Object.fromEntries(variants.map(v => [v, wsSent[v].size])), wsReceived: Object.fromEntries(variants.map(v => [v, wsReceived[v].size])), connections, likesReceived, duplicates });
			}
			await delay(250);
		}
		paused = true;
		clearInterval(wsTimer);
		for (const variant of variants) await dom[variant].page.evaluate(() => clearInterval(window.__soak.timer));
		await delay(3000);
		report.elapsedSeconds = Math.round((Date.now() - soakStart) / 1000);
		report.dom = {};
		report.ws = {};
		for (const variant of variants) {
			const counts = await dom[variant].page.evaluate(() => ({ generated: window.__soak.generated, captured: window.__soak.sourceMessages, controls: window.__soak.controls }));
			report.dom[variant] = { ...counts, delivered: domReceived[variant].size, controlsDelivered: controlsReceived[variant].size };
			const missing = [...wsSent[variant]].filter(id => !wsReceived[variant].has(id));
			report.ws[variant] = { sentOnOpenSocket: wsSent[variant].size, delivered: wsReceived[variant].size, missingCount: missing.length, missingSample: missing.slice(0, 20), connections: connections[variant], likesDelivered: likesReceived[variant] };
		}
		report.duplicates = duplicates;
		assert.strictEqual(report.dom.baseline.delivered, 300, 'Original must capture initial rows but miss text reuse');
		assert.strictEqual(report.dom.patched.delivered, report.dom.patched.generated, 'Patched DOM lost messages');
		assert.strictEqual(report.dom.patched.captured, report.dom.patched.generated);
		for (const variant of variants) {
			assert.strictEqual(report.dom[variant].controlsDelivered, report.dom[variant].controls);
			assert.strictEqual(report.ws[variant].missingCount, 0, 'Chat frames actually sent on open sockets must arrive');
		}
		assert.strictEqual(duplicates.dom, 0);
		assert.strictEqual(duplicates.ws, 0);
		report.outcome = 'PASS';
		writeProgress({ outcome: report.outcome, reportPath, dom: report.dom, ws: report.ws, duplicates });
	} catch (error) {
		report.outcome = 'FAIL';
		report.error = error.stack;
		console.error(output.slice(-6000));
		throw error;
	} finally {
		clearTimeout(watchdog);
		clearInterval(wsTimer);
		report.finished = new Date().toISOString();
		fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
		console.log('[tiktok-soak] report=' + reportPath);
		if (relay) relay.terminate();
		if (app) {
			await Promise.race([app.close(), delay(5000)]);
			if (child.exitCode === null) child.kill();
		}
		for (const socket of sockets.clients) socket.terminate();
		await new Promise(resolve => sockets.close(resolve));
		await new Promise(resolve => fixture.close(resolve));
		assert.ok(path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(profile).startsWith('ssapp-tiktok-soak-'));
		fs.rmSync(profile, { recursive: true, force: true });
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
