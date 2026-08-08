#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const electronPath = require('electron');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const socialStreamUrl = pathToFileURL(socialStreamRoot + path.sep).href;
const MESSAGE_COUNT = 620;

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

async function createFixtureServer() {
	const html = fs.readFileSync(path.join(repoRoot, 'tests', 'electron', 'fixtures', 'hidden-capture.html'), 'utf8');
	const server = http.createServer((_request, response) => {
		response.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
		});
		response.end(html);
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	return {
		server,
		url: `http://127.0.0.1:${server.address().port}/@hidden-capture/live?platform=tiktok&manual=1`,
	};
}

function requestJson(port, token, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : JSON.stringify(body);
		const request = http.request({
			host: '127.0.0.1',
			port,
			path: `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
			method: payload === null ? 'GET' : 'POST',
			headers: payload === null ? {} : {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload),
			},
		}, response => {
			let text = '';
			response.setEncoding('utf8');
			response.on('data', chunk => { text += chunk; });
			response.on('end', () => {
				let data = {};
				try { data = text ? JSON.parse(text) : {}; } catch (error) { reject(error); return; }
				if (response.statusCode >= 200 && response.statusCode < 300) resolve(data);
				else reject(new Error(`HTTP ${response.statusCode}: ${text}`));
			});
		});
		request.once('error', reject);
		if (payload !== null) request.write(payload);
		request.end();
	});
}

async function waitFor(check, label, timeoutMs = 30000, intervalMs = 100) {
	const started = Date.now();
	let lastValue = null;
	while (Date.now() - started < timeoutMs) {
		lastValue = await check();
		if (lastValue) return lastValue;
		await new Promise(resolve => setTimeout(resolve, intervalMs));
	}
	throw new Error(`${label} timed out. Last value: ${JSON.stringify(lastValue)}`);
}

async function appendRowsInLiveSizedBatches(controlPort, token, viewKey, rows) {
	for (let offset = 0; offset < rows.length; offset += 250) {
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: `window.__hiddenCaptureFixture.appendRows(${JSON.stringify(rows.slice(offset, offset + 250))})`,
		});
		await new Promise(resolve => setTimeout(resolve, 25));
	}
}

function openSocket(port, room, captures) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}`);
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error(`Timed out connecting to local relay port ${port}.`));
		}, 30000);
		socket.once('open', () => {
			clearTimeout(timer);
			socket.send(JSON.stringify({ join: room, out: 3, in: 4 }));
			resolve(socket);
		});
		socket.on('message', raw => {
			try {
				const message = JSON.parse(raw.toString());
				if (message && message.type === 'tiktok' && String(message.chatmessage || '').includes('hidden-capture message')) {
					captures.push(message);
				}
			} catch (_) { }
		});
		socket.once('error', reject);
	});
}

async function stopApp(child) {
	if (!child || child.exitCode !== null) return;
	child.kill();
	await Promise.race([
		new Promise(resolve => child.once('exit', resolve)),
		new Promise(resolve => setTimeout(resolve, 5000)),
	]);
	if (child.exitCode === null) {
		try { child.kill('SIGKILL'); } catch (_) { }
	}
}

async function run() {
	const fixture = await createFixtureServer();
	const controlPort = await getFreePort();
	const localRelayPort = await getFreePort();
	const room = `tiktok_dom_replay_${Date.now()}`;
	const token = `tiktok-dom-replay-${Date.now()}`;
	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-tiktok-dom-replay-'));
	fs.writeFileSync(path.join(profileDir, 'savedSync.json'), JSON.stringify({
		streamID: room,
		password: 'false',
		state: true,
		settings: { server2: { setting: true } },
		wsServer: true,
	}));

	const child = spawn(electronPath, [
		'.', '--running-from-source', '--multiinstance', '--filesource', socialStreamUrl,
		'--ssapp-headless-control', '--ssapp-control-api', '--remote-control',
		`--ssapp-control-port=${controlPort}`,
		`--ssapp-local-server-port=${localRelayPort}`,
		'--no-hwa',
		...linuxLaunchArgs(),
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDir,
			SSAPP_CONTROL_PORT: String(controlPort),
			SSAPP_REMOTE_CONTROL_TOKEN: token,
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let output = '';
	child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-50000); });
	child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-50000); });

	let socket;
	const captures = [];
	const productionIssues = [];
	try {
		await waitFor(async () => {
			if (child.exitCode !== null) throw new Error(`SSApp exited with code ${child.exitCode}`);
			try { return (await requestJson(controlPort, token, '/ping')).ok; } catch (_) { return false; }
		}, 'SSApp remote control', 60000, 250);

		const mainWindow = await waitFor(async () => {
			const windows = await requestJson(controlPort, token, '/windows');
			return (windows.windows || []).find(item => String(item.url || '').includes('index.html')) || false;
		}, 'SSApp main window', 60000, 250);
		await waitFor(async () => {
			const response = await requestJson(controlPort, token, '/exec', {
				windowId: mainWindow.id,
				code: 'Boolean(window.stateManager && stateManager.initialized && typeof configReady !== "undefined" && configReady && typeof createWindow === "function" && typeof newOtherSource === "function")',
			});
			return response.ok && response.result;
		}, 'SSApp renderer initialization', 60000, 250);

		socket = await openSocket(localRelayPort, room, captures);
		const launched = await requestJson(controlPort, token, '/exec', {
			windowId: mainWindow.id,
			code: `(async () => {
				const element = await newOtherSource('tiktok', ${JSON.stringify(fixture.url)}, false, {
					username: 'hidden-capture', sourceFile: 'sources/tiktok.js', connectionMode: 'classic',
					autoActivate: false, isVisible: false, isMuted: true
				});
				const sourceId = element && element.dataset ? element.dataset.sourceId : null;
				const source = sourceId ? stateManager.getSource(sourceId) : null;
				if (!source) throw new Error('TikTok fixture source was not created');
				const entry = document.querySelector('[data-source-id="' + source.id + '"]');
				const activate = entry && entry.querySelector('[data-activatehtml]');
				if (!activate) throw new Error('TikTok activation control was not found');
				return { sourceId: source.id, tabId: await createWindow(activate) };
			})()`,
		});
		assert.strictEqual(launched.ok, true, launched.error || JSON.stringify(launched));
		assert.ok(launched.result?.tabId, `TikTok source did not activate: ${JSON.stringify(launched)}`);
		const viewKey = String(launched.result.tabId);

		await waitFor(async () => {
			try {
				const response = await requestJson(controlPort, token, '/view-exec', {
					key: viewKey,
					code: `Boolean(window.__hiddenCaptureFixture && window.chrome && chrome.runtime &&
						typeof chrome.runtime.sendMessage === 'function' && document.querySelector('[data-e2e="chat-room"]'))`,
				});
				return response.ok && response.result;
			} catch (_) { return false; }
		}, 'TikTok fixture and source injection', 60000, 250);

		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: `(function () {
				window.__tiktokReplayProbe = [];
				var original = chrome.runtime.sendMessage;
				chrome.runtime.sendMessage = function () {
					var payload = arguments.length > 1 ? arguments[1] : arguments[0];
					var message = payload && payload.message;
					if (message && message.type === 'tiktok' && String(message.chatmessage || '').includes('hidden-capture message')) {
						window.__tiktokReplayProbe.push(String(message.chatmessage));
					}
					return original.apply(this, arguments);
				};
				return true;
			})()`,
		});

		// Start with the continuously arriving pattern used by hidden-capture diagnostics.
		// Some rows exist before TikTok attaches its observer, while later rows arrive
		// without a quiet gap; startup must settle and begin delivering those later rows.
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__hiddenCaptureFixture.startAuto()',
		});
		await new Promise(resolve => setTimeout(resolve, 6000));
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__hiddenCaptureFixture.stopAuto()',
		});
		const continuousStartupProbe = await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.slice()',
		});
		assert.ok(continuousStartupProbe.result.length > 0,
			'TikTok must begin capturing continuously arriving rows after observer startup.');
		await waitFor(() => captures.length >= continuousStartupProbe.result.length ? true : false,
			'continuous-startup destination messages', 30000, 100);
		const initialDestinationBaseline = captures.length;
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: `(function () {
				window.__tiktokReplayProbe.length = 0;
				document.querySelectorAll('[data-e2e="chat-message"]').forEach(function (element) { element.remove(); });
				return true;
			})()`,
		});

		// Keep fixture IDs separate from the short automatic startup sample above.
		const ids = Array.from({ length: MESSAGE_COUNT }, (_, index) => 1001 + index);
		await appendRowsInLiveSizedBatches(controlPort, token, viewKey, ids);
		await waitFor(async () => {
			const response = await requestJson(controlPort, token, '/view-exec', {
				key: viewKey,
				code: 'window.__tiktokReplayProbe.length',
			});
			return response.result >= MESSAGE_COUNT ? response.result : false;
		}, 'initial TikTok messages', 30000, 100);
		await waitFor(() => captures.length - initialDestinationBaseline >= MESSAGE_COUNT ? captures.length : false,
			'initial destination messages', 30000, 100);

		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.length = 0; window.__hiddenCaptureFixture.replaceFeed();',
		});
		await new Promise(resolve => setTimeout(resolve, 3000));
		const destinationBaseline = captures.length;
		const replayedRowsWithNewIdentity = ids.map(id => ({
			id: MESSAGE_COUNT + id,
			message: `hidden-capture message ${id}`,
		}));
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: `window.__hiddenCaptureFixture.appendRows(${JSON.stringify(replayedRowsWithNewIdentity)})`,
		});
		await new Promise(resolve => setTimeout(resolve, 5000));

		const replayProbe = await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.slice()',
		});
		const sourceReplayCount = Array.isArray(replayProbe.result) ? replayProbe.result.length : -1;
		const destinationReplayCount = captures.length - destinationBaseline;
		console.log(`[tiktok-dom-replay] initial=${MESSAGE_COUNT} sourceReplay=${sourceReplayCount} destinationReplay=${destinationReplayCount}`);

		assert.strictEqual(sourceReplayCount, 0, `TikTok source replayed ${sourceReplayCount} old DOM messages.`);
		assert.strictEqual(destinationReplayCount, 0, `TikTok destinations received ${destinationReplayCount} replayed messages.`);

		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.length = 0;',
		});
		const repeatedTextBaseline = captures.length;
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: `window.__hiddenCaptureFixture.appendRows(${JSON.stringify([
				{ id: MESSAGE_COUNT + 1, message: 'hidden-capture message repeated legitimately' },
				{ id: MESSAGE_COUNT + 2, message: 'hidden-capture message repeated legitimately' },
			])})`,
		});
		await new Promise(resolve => setTimeout(resolve, 2000));
		const repeatedTextProbe = await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.slice()',
		});
		console.log(`[tiktok-dom-replay] identical messages filtered=${2 - repeatedTextProbe.result.length}`);

		const rowsWithoutIdentity = ids.map(id => ({
			id: 10000 + id,
			message: `hidden-capture message fallback ${id}`,
			omitIdentity: true,
		}));
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.length = 0;',
		});
		const noIdentityInitialBaseline = captures.length;
		await appendRowsInLiveSizedBatches(controlPort, token, viewKey, rowsWithoutIdentity);
		await waitFor(async () => {
			const response = await requestJson(controlPort, token, '/view-exec', {
				key: viewKey,
				code: 'window.__tiktokReplayProbe.length',
			});
			return response.result >= MESSAGE_COUNT ? response.result : false;
		}, 'initial TikTok messages without DOM identity', 30000, 100);
		await waitFor(() => captures.length - noIdentityInitialBaseline >= MESSAGE_COUNT ? true : false,
			'initial destination messages without DOM identity', 30000, 100);

		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.length = 0; window.__hiddenCaptureFixture.replaceFeed();',
		});
		await new Promise(resolve => setTimeout(resolve, 3000));
		const noIdentityReplayBaseline = captures.length;
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: `window.__hiddenCaptureFixture.appendRows(${JSON.stringify(rowsWithoutIdentity)})`,
		});
		await new Promise(resolve => setTimeout(resolve, 5000));
		const noIdentityReplayProbe = await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.slice()',
		});
		assert.strictEqual(noIdentityReplayProbe.result.length, 0,
			'TikTok replay protection must work when a row has no stable DOM identity.');
		assert.strictEqual(captures.length - noIdentityReplayBaseline, 0,
			'TikTok destinations must not receive replayed rows that lack stable DOM identity.');

		// TikTok recycles data-index values (commonly 0..299), so an oversized DOM
		// rebuild must be recognized as a batch instead of relying on those values or
		// on every historical message still fitting in the content cache.
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.length = 0; window.__hiddenCaptureFixture.replaceFeed();',
		});
		await new Promise(resolve => setTimeout(resolve, 3000));
		const oversizedReplayBaseline = captures.length;
		const oversizedRebuildRows = ids.map((id, offset) => ({
			id: 20000 + id,
			index: offset % 300,
			message: `hidden-capture message unseen rebuild ${id}`,
		}));
		const firstOversizedChunk = oversizedRebuildRows.slice(0, 300);
		const secondOversizedChunk = oversizedRebuildRows.slice(300);
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: `(function () {
				window.__hiddenCaptureFixture.appendRows(${JSON.stringify(firstOversizedChunk)});
				setTimeout(function () {
					window.__hiddenCaptureFixture.appendRows(${JSON.stringify(secondOversizedChunk)});
				}, 100);
				return true;
			})()`,
		});
		await new Promise(resolve => setTimeout(resolve, 5000));
		const oversizedReplayProbe = await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.slice()',
		});
		assert.strictEqual(oversizedReplayProbe.result.length, 0,
			'TikTok must discard an oversized reconnect batch even when its content was not cached.');
		assert.strictEqual(captures.length - oversizedReplayBaseline, 0,
			'TikTok destinations must not receive an oversized reconnect batch.');

		// Once the oversized rebuild is discarded, later live rows must resume
		// immediately even though TikTok reuses the same data-index values.
		const resumedLiveBaseline = captures.length;
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: `window.__hiddenCaptureFixture.appendRows(${JSON.stringify([{
				id: 30000,
				index: 0,
				message: 'hidden-capture message after oversized rebuild',
			}])})`,
		});
		await waitFor(async () => {
			const response = await requestJson(controlPort, token, '/view-exec', {
				key: viewKey,
				code: 'window.__tiktokReplayProbe.length',
			});
			return response.result >= 1 ? response.result : false;
		}, 'live TikTok message after oversized rebuild', 10000, 100);
		await waitFor(() => captures.length - resumedLiveBaseline >= 1 ? true : false,
			'live destination message after oversized rebuild', 10000, 100);

		// Reusing data-index must not make two distinct rows with the same author and
		// text look like one message. Fill the 0..299 cycle, then reuse index 0.
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.length = 0;',
		});
		const recycledTextBaseline = captures.length;
		const recycledRows = Array.from({ length: 300 }, (_, index) => ({
			id: 31000 + index,
			index,
			message: index === 0
				? 'hidden-capture message legitimate recycled text'
				: `hidden-capture message recycled filler ${index}`,
		}));
		await appendRowsInLiveSizedBatches(controlPort, token, viewKey, recycledRows);
		await waitFor(async () => {
			const response = await requestJson(controlPort, token, '/view-exec', {
				key: viewKey,
				code: 'window.__tiktokReplayProbe.length',
			});
			return response.result >= recycledRows.length ? response.result : false;
		}, 'first TikTok data-index cycle', 30000, 100);
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: `window.__hiddenCaptureFixture.appendRows(${JSON.stringify([{
				id: 32000,
				index: 0,
				message: 'hidden-capture message legitimate recycled text',
			}])})`,
		});
		await new Promise(resolve => setTimeout(resolve, 2000));
		const recycledProbe = await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.length',
		});
		console.log(`[tiktok-dom-replay] recycled identical messages filtered=${recycledRows.length + 1 - recycledProbe.result}`);

		// TikTok also repopulates an existing virtual-list element after its index
		// wraps. The source's own processed marker must not permanently poison that
		// DOM element when its author/message content changes.
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.length = 0;',
		});
		const reusedElementBaseline = captures.length;
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: `window.__hiddenCaptureFixture.appendRows(${JSON.stringify([{
				id: 33000,
				index: 42,
				message: 'hidden-capture message before element reuse',
			}])})`,
		});
		await waitFor(async () => {
			const response = await requestJson(controlPort, token, '/view-exec', {
				key: viewKey,
				code: 'window.__tiktokReplayProbe.length',
			});
			return response.result >= 1 ? response.result : false;
		}, 'TikTok message before DOM element reuse', 10000, 100);
		await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: `window.__hiddenCaptureFixture.reuseLastRow(${JSON.stringify({
				id: 33001,
				index: 42,
				message: 'hidden-capture message after element reuse',
			})})`,
		});
		await new Promise(resolve => setTimeout(resolve, 2000));
		const reusedElementProbe = await requestJson(controlPort, token, '/view-exec', {
			key: viewKey,
			code: 'window.__tiktokReplayProbe.length',
		});
		if (reusedElementProbe.result !== 2 || captures.length - reusedElementBaseline !== 2) {
			productionIssues.push(`reused element: source=${reusedElementProbe.result}, destination=${captures.length - reusedElementBaseline}`);
		}

		assert.deepStrictEqual(productionIssues, [], `TikTok production issues: ${productionIssues.join('; ')}`);
		console.log('[tiktok-dom-replay] PASS reconnect batches were bounded without treating recycled data-index values as message IDs.');
	} catch (error) {
		throw new Error(`${error.message}\nElectron output:\n${output.slice(-12000)}`);
	} finally {
		if (socket) socket.close();
		await stopApp(child);
		if (fixture.server.listening) {
			await new Promise(resolve => fixture.server.close(resolve));
		}
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

run().catch(error => {
	console.error(`[tiktok-dom-replay] FAIL ${error.stack || error.message}`);
	process.exitCode = 1;
});
