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

const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = pathToFileURL(path.resolve(repoRoot, '..', 'social_stream') + path.sep).href;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-streamdeck-bridge-profile-'));
const token = `streamdeck-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let mainExecWindowId = null;

async function getFreePort() {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = address && typeof address === 'object' ? address.port : 0;
			server.close(() => resolve(port));
		});
		server.on('error', reject);
	});
}

async function createRelayServer() {
	const server = new WebSocket.WebSocketServer({ port: 0, host: '127.0.0.1' });
	const clients = new Set();
	await new Promise((resolve, reject) => {
		server.once('listening', resolve);
		server.once('error', reject);
	});
	server.on('connection', (socket) => {
		clients.add(socket);
		socket.on('message', raw => {
			let message;
			try {
				message = JSON.parse(raw.toString());
			} catch (_) {
				return;
			}
			if (message && message.join) {
				socket.room = String(message.join);
				socket.inChannel = message.in;
				socket.outChannel = message.out;
				return;
			}
			const outChannel = message.out || socket.outChannel;
			for (const client of clients) {
				if (client === socket || client.readyState !== WebSocket.OPEN) {
					continue;
				}
				if (client.room && socket.room && client.room !== socket.room) {
					continue;
				}
				if (client.inChannel && outChannel && client.inChannel !== outChannel) {
					continue;
				}
				if ((client.inChannel && !outChannel) || (!client.inChannel && outChannel)) {
					continue;
				}
				client.send(raw.toString());
			}
		});
		socket.on('close', () => {
			clients.delete(socket);
		});
	});
	const address = server.address();
	return {
		server,
		port: address && typeof address === 'object' ? address.port : 0,
		joinedClientCount: () => Array.from(clients).filter(client => client.room).length,
		close: () => new Promise(resolve => {
			for (const client of clients) {
				try {
					client.terminate();
				} catch (_) { }
			}
			server.close(() => resolve());
			setTimeout(resolve, 1000);
		})
	};
}

async function openDeckClient(port, sessionId) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`);
	const messages = [];
	await new Promise((resolve, reject) => {
		socket.once('open', resolve);
		socket.once('error', reject);
	});
	socket.on('message', raw => {
		try {
			messages.push(JSON.parse(raw.toString()));
		} catch (_) {
			messages.push(raw.toString());
		}
	});
	socket.send(JSON.stringify({ join: sessionId, in: 2, out: 1 }));
	return { socket, messages };
}

async function waitForMessage(messages, predicate, timeoutMs = 10000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const match = messages.find(predicate);
		if (match) {
			return match;
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error('Timed out waiting for WebSocket message');
}

async function waitForCondition(predicate, timeoutMs = 10000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error('Timed out waiting for condition');
}

function requestJson(port, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : null;
		const req = http.request({
			host: '127.0.0.1',
			port,
			path: `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
			method: payload ? 'POST' : 'GET',
			headers: payload ? {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload)
			} : {}
		}, (res) => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', chunk => {
				text += chunk;
			});
			res.on('end', () => {
				try {
					const json = text ? JSON.parse(text) : {};
					if (res.statusCode >= 200 && res.statusCode < 300) {
						resolve(json);
						return;
					}
					reject(new Error(`HTTP ${res.statusCode}: ${text}`));
				} catch (error) {
					reject(error);
				}
			});
		});
		req.on('error', reject);
		if (payload) {
			req.write(payload);
		}
		req.end();
	});
}

async function waitForWindow(port, predicate, timeoutMs = 15000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const windows = await requestJson(port, '/windows');
		const match = (windows.windows || []).find(predicate);
		if (match) {
			return match;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('Timed out waiting for matching window');
}

async function waitForRemoteControl(port, timeoutMs = 60000) {
	const started = Date.now();
	let lastError = null;
	while (Date.now() - started < timeoutMs) {
		try {
			const ping = await requestJson(port, '/ping');
			if (ping && ping.ok) {
				return ping;
			}
		} catch (error) {
			lastError = error;
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	throw new Error(`Timed out waiting for remote control server: ${lastError ? lastError.message : 'no response'}`);
}

async function execInWindow(port, windowId, code, label = 'renderer exec') {
	let response;
	try {
		const body = { code };
		if (windowId) {
			body.windowId = windowId;
		}
		response = await requestJson(port, '/exec', body);
	} catch (error) {
		throw new Error(`${label}: ${error && error.message ? error.message : error}`);
	}
	if (!response || response.ok !== true) {
		const message = response && response.error ? response.error : 'renderer exec failed';
		throw new Error(`${label}: ${message}`);
	}
	return response.result;
}

async function execInRenderer(port, code, label = 'renderer exec') {
	return execInWindow(port, mainExecWindowId, code, label);
}

async function run() {
	const port = await getFreePort();
	const child = spawn(
		electronPath,
		[
			'.',
			'--running-from-source',
			'--filesource',
			socialStreamRoot,
			'--remote-control'
		],
		{
			cwd: repoRoot,
			env: {
				...process.env,
				SSAPP_USER_DATA_DIR: userDataDir,
				SSAPP_REMOTE_CONTROL: '1',
				SSAPP_REMOTE_CONTROL_PORT: String(port),
				SSAPP_REMOTE_CONTROL_TOKEN: token,
				SSAPP_DEBUG_LOGS: '0'
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		}
	);

	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', chunk => {
		stdout += chunk;
	});
	child.stderr.on('data', chunk => {
		stderr += chunk;
	});

	const timer = setTimeout(() => {
		try {
			child.kill();
		} catch (_) { }
	}, 90000);
	let relay = null;
	let deckClient = null;

	try {
		await waitForRemoteControl(port);
		const windows = await requestJson(port, '/windows');
		const mainWindow = (windows.windows || []).find(win => typeof win.url === 'string' && win.url.includes('index.html'))
			|| (windows.windows || [])[0];
		assert(mainWindow && mainWindow.id, `main window not found: ${JSON.stringify(windows)}`);
		mainExecWindowId = mainWindow.id;

		const seed = await execInRenderer(port, `
			(async () => {
				const sourceId = 'streamdeck-e2e-source';
				const started = Date.now();
				while (
					!window.SSAppStreamDeckBridge ||
					!window.stateManager ||
					!stateManager.initialized ||
					typeof createSourceElement !== 'function' ||
					typeof configReady !== 'undefined' && configReady !== true
				) {
					if (Date.now() - started > 45000) {
						return {
							ready: false,
							hasBridge: !!window.SSAppStreamDeckBridge,
							hasStateManager: !!window.stateManager,
							initialized: !!(window.stateManager && stateManager.initialized),
							configReady: typeof configReady === 'undefined' ? null : configReady
						};
					}
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				if (!stateManager.getSource(sourceId)) {
					stateManager.addSource({
						id: sourceId,
						target: 'youtube',
						username: 'streamdeck-e2e',
						videoId: 'streamdeck-video',
						url: 'https://www.youtube.com/watch?v=streamdeck-video',
						connectionMode: 'classic',
						isMuted: false,
						isVisible: true,
						autoActivate: false
					});
				}
				let entry = document.querySelector('[data-source-id="streamdeck-e2e-source"]');
				if (!entry) {
					entry = createSourceElement(sourceId);
					document.getElementById('sources').appendChild(entry);
				}
				return {
					ready: true,
					sourceId,
					hasEntry: !!entry,
					source: stateManager.getSource(sourceId)
				};
			})()
		`, 'seed source');
		assert.equal(seed.ready, true, `renderer was not ready: ${JSON.stringify(seed)}`);
		assert.equal(seed.hasEntry, true, 'test source entry was not rendered');

		const capabilities = await execInRenderer(port, `window.SSAppStreamDeckBridge.handleCommand({ action: 'getCapabilities' })`, 'renderer getCapabilities');
		assert.equal(capabilities.ok, true, 'capability command failed');
		assert.equal(capabilities.payload.available, true, 'SSApp capabilities should be available');
		assert.equal(capabilities.payload.sourceControls.start, true, 'source start capability missing');

		const sources = await execInRenderer(port, `window.SSAppStreamDeckBridge.handleCommand({ action: 'getSources' })`, 'renderer getSources');
		assert.equal(sources.ok, true, 'getSources failed');
		assert(sources.payload.sources.some(source => source.id === seed.sourceId), 'seeded source missing from getSources');

		const getSource = await execInRenderer(port, `window.SSAppStreamDeckBridge.handleCommand({ action: 'getSource', value: '${seed.sourceId}' })`, 'renderer getSource');
		assert.equal(getSource.ok, true, 'getSource failed');
		assert.equal(getSource.payload.source.status, 'inactive', 'seeded source should start inactive');

		const mute = await execInRenderer(port, `
			window.SSAppStreamDeckBridge.handleCommand({
				action: 'setSourceMute',
				value: { sourceId: '${seed.sourceId}', isMuted: true }
			})
		`, 'renderer setSourceMute');
		assert.equal(mute.ok, true, 'setSourceMute failed');
		assert.equal(mute.payload.source.isMuted, true, 'source mute state did not update');

		const mode = await execInRenderer(port, `
			window.SSAppStreamDeckBridge.handleCommand({
				action: 'setSourceConnectionMode',
				value: { sourceId: '${seed.sourceId}', mode: 'websocket' }
			})
		`, 'renderer setSourceConnectionMode');
		assert.equal(mode.ok, true, 'setSourceConnectionMode failed');
		assert.equal(mode.payload.source.connectionMode, 'websocket', 'connection mode did not update');

		const badSource = await execInRenderer(port, `window.SSAppStreamDeckBridge.handleCommand({ action: 'getSource', value: 'missing-source' })`, 'renderer SOURCE_NOT_FOUND');
		assert.equal(badSource.ok, false, 'missing source should fail');
		assert.equal(badSource.error.code, 'SOURCE_NOT_FOUND', 'missing source should return SOURCE_NOT_FOUND');

		const mainBridge = await execInRenderer(port, `
			ipcRenderer.invoke('ssapp:background-command', {
				cmd: 'streamDeckSourceCommand',
				request: { action: 'getSource', value: '${seed.sourceId}' }
			})
		`, 'main bridge getSource');
		assert.equal(mainBridge.ok, true, 'main-process streamDeckSourceCommand failed');
		assert.equal(mainBridge.payload.source.id, seed.sourceId, 'main-process bridge returned wrong source');

		const untrustedUrl = `https://example.com/?ssapp-streamdeck-forbidden=${Date.now()}`;
		await execInRenderer(port, `window.open('${untrustedUrl}', '_blank'); true`, 'open untrusted renderer');
		const untrustedWindow = await waitForWindow(port, win => win.id !== mainExecWindowId && win.url === untrustedUrl);
		const forbiddenBridge = await execInWindow(port, untrustedWindow.id, `
			new Promise(resolve => {
				const started = Date.now();
				function sendWhenReady() {
					if (window.ninjafy && typeof window.ninjafy.sendMessage === 'function') {
						window.ninjafy.sendMessage(null, {
							type: 'toBackground',
							data: {
								cmd: 'streamDeckSourceCommand',
								request: { action: 'getSource', value: '${seed.sourceId}' }
							}
						}, response => resolve(response));
						return;
					}
					if (Date.now() - started > 10000) {
						resolve({ ok: false, error: { code: 'NINJAFY_UNAVAILABLE' } });
						return;
					}
					setTimeout(sendWhenReady, 100);
				}
				sendWhenReady();
			})
		`, 'untrusted renderer streamDeckSourceCommand');
		assert.equal(forbiddenBridge.ok, false, `untrusted renderer should be denied: ${JSON.stringify(forbiddenBridge)}`);
		assert.equal(forbiddenBridge.error && forbiddenBridge.error.code, 'SSAPP_FORBIDDEN', `unexpected denial response: ${JSON.stringify(forbiddenBridge)}`);

		const backgroundBridge = await execInRenderer(port, `
			(async () => {
				const frame = document.getElementById('frame2');
				const started = Date.now();
				while (
					!frame ||
					!frame.contentWindow ||
					typeof frame.contentWindow.getStreamDeckCapabilities !== 'function' ||
					typeof frame.contentWindow.handleStreamDeckSsappRequest !== 'function'
				) {
					if (Date.now() - started > 30000) {
						return {
							ok: false,
							error: 'background frame bridge not ready',
							hasFrame: !!frame,
							hasContentWindow: !!(frame && frame.contentWindow),
							hasCapabilities: !!(frame && frame.contentWindow && frame.contentWindow.getStreamDeckCapabilities),
							hasHandler: !!(frame && frame.contentWindow && frame.contentWindow.handleStreamDeckSsappRequest)
						};
					}
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				const capabilities = await frame.contentWindow.getStreamDeckCapabilities();
				const result = await frame.contentWindow.handleStreamDeckSsappRequest({
					action: 'getSource',
					value: '${seed.sourceId}'
				});
				return {
					ok: true,
					src: frame.src,
					routerLoaded: !!frame.contentWindow.StreamDeckRemoteControl,
					loaderScripts: Array.from(frame.contentDocument.querySelectorAll('script[src]')).map(script => script.getAttribute('src')),
					capabilities,
					result
				};
			})()
		`, 'background frame bridge getSource');
		assert.equal(backgroundBridge.ok, true, `background bridge was not ready: ${JSON.stringify(backgroundBridge)}`);
		assert.equal(backgroundBridge.capabilities.ssapp.available, true, `background capability packet should advertise SSApp: ${JSON.stringify(backgroundBridge)}`);
		assert.equal(backgroundBridge.result.ok, true, 'background SSApp route failed');
		assert.equal(backgroundBridge.result.payload.source.id, seed.sourceId, 'background route returned wrong source');

		relay = await createRelayServer();
		const sessionId = `streamdeck-e2e-${Date.now()}`;
		deckClient = await openDeckClient(relay.port, sessionId);
		const socketStart = await execInRenderer(port, `
			(async () => {
				const frame = document.getElementById('frame2');
				if (!frame || !frame.contentWindow || typeof frame.contentWindow.setupSocket !== 'function') {
					return { ok: false, error: 'background socket setup unavailable' };
				}
				const bg = frame.contentWindow;
				try {
					if (bg.socketserver && typeof bg.socketserver.close === 'function') {
						bg.socketserver.onclose = null;
						bg.socketserver.close();
					}
				} catch (_) {}
				bg.socketserver = false;
				bg.serverURL = 'ws://127.0.0.1:${relay.port}/api';
				bg.streamID = '${sessionId}';
				bg.isExtensionOn = true;
				bg.settings = Object.assign({}, bg.settings || {}, { socketserver: true });
				bg.setupSocket();
				return { ok: true, serverURL: bg.serverURL, streamID: bg.streamID, socketserver: !!bg.socketserver };
			})()
		`, 'background socket setup');
		assert.equal(socketStart.ok, true, `background socket did not start: ${JSON.stringify(socketStart)}`);
		await waitForCondition(() => relay.joinedClientCount() >= 2);
		const capabilityRequestId = `capabilities-${Date.now()}`;
		deckClient.socket.send(JSON.stringify({
			action: 'getCapabilities',
			get: capabilityRequestId
		}));
		const socketCapabilities = await waitForMessage(
			deckClient.messages,
			message => message && message.callback && message.callback.get === capabilityRequestId
		);
		assert.equal(socketCapabilities.callback.result.ssapp.available, true, 'socket capabilities should advertise SSApp');

		const requestId = `source-${Date.now()}`;
		deckClient.socket.send(JSON.stringify({
			action: 'getSource',
			target: 'ssapp',
			value: seed.sourceId,
			get: requestId
		}));
		const socketCallback = await waitForMessage(
			deckClient.messages,
			message => message && message.callback && message.callback.get === requestId
		);
		assert.equal(socketCallback.callback.result.ok, true, `socket getSource failed: ${JSON.stringify(socketCallback)}`);
		assert.equal(socketCallback.callback.result.payload.source.id, seed.sourceId, 'socket callback returned wrong source');

		const startRequestId = `start-${Date.now()}`;
		deckClient.socket.send(JSON.stringify({
			action: 'startSource',
			target: 'ssapp',
			value: seed.sourceId,
			get: startRequestId
		}));
		const socketStartCallback = await waitForMessage(
			deckClient.messages,
			message => message && message.callback && message.callback.get === startRequestId,
			30000
		);
		assert.equal(socketStartCallback.callback.result.ok, true, `socket startSource failed: ${JSON.stringify(socketStartCallback)}`);
		assert(
			['active', 'activating'].includes(socketStartCallback.callback.result.payload.source.status),
			`source should be active or activating after start: ${JSON.stringify(socketStartCallback)}`
		);

		const activeState = await execInRenderer(port, `
			(() => {
				const source = stateManager.getSource('${seed.sourceId}');
				return {
					status: source && source.status,
					vid: source && source.vid,
					wssId: source && source.wssId,
					activeConnectionMode: source && source.activeConnectionMode
				};
			})()
		`, 'active source state');
		assert(
			!!(activeState.vid || activeState.wssId),
			`source should have an active window or websocket handle: ${JSON.stringify(activeState)}`
		);
		assert.equal(activeState.activeConnectionMode, 'websocket', `source should use websocket mode: ${JSON.stringify(activeState)}`);

		const stopRequestId = `stop-${Date.now()}`;
		deckClient.socket.send(JSON.stringify({
			action: 'stopSource',
			target: 'ssapp',
			value: seed.sourceId,
			get: stopRequestId
		}));
		const socketStopCallback = await waitForMessage(
			deckClient.messages,
			message => message && message.callback && message.callback.get === stopRequestId,
			30000
		);
		assert.equal(socketStopCallback.callback.result.ok, true, `socket stopSource failed: ${JSON.stringify(socketStopCallback)}`);
		assert.equal(socketStopCallback.callback.result.payload.source.status, 'inactive', 'source should be inactive after stop');

		const stoppedState = await execInRenderer(port, `
			(() => {
				const source = stateManager.getSource('${seed.sourceId}');
				return {
					status: source && source.status,
					vid: source && source.vid,
					wssId: source && source.wssId,
					activeConnectionMode: source && source.activeConnectionMode
				};
			})()
		`, 'stopped source state');
		assert.equal(stoppedState.status, 'inactive', `source status should be inactive after stop: ${JSON.stringify(stoppedState)}`);
		assert.equal(stoppedState.vid || null, null, `source vid should be cleared after stop: ${JSON.stringify(stoppedState)}`);
		assert.equal(stoppedState.wssId || null, null, `source websocket id should be cleared after stop: ${JSON.stringify(stoppedState)}`);
		assert.equal(stoppedState.activeConnectionMode || null, null, `source active mode should be cleared after stop: ${JSON.stringify(stoppedState)}`);

		console.log('[streamdeck-bridge-e2e] PASS', JSON.stringify({
			sourceId: seed.sourceId,
			sourceCount: sources.payload.sources.length,
			connectionMode: mode.payload.source.connectionMode,
			muted: mute.payload.source.isMuted,
			backgroundRoute: backgroundBridge.result.ok,
			socketRoute: socketCallback.callback.result.ok,
			socketStartStop: socketStartCallback.callback.result.ok && socketStopCallback.callback.result.ok
		}));
	} catch (error) {
		console.error('[streamdeck-bridge-e2e] stdout:', stdout.slice(-4000));
		console.error('[streamdeck-bridge-e2e] stderr:', stderr.slice(-4000));
		throw error;
	} finally {
		clearTimeout(timer);
		try {
			if (deckClient && deckClient.socket) {
				deckClient.socket.close();
			}
		} catch (_) { }
		try {
			if (relay) {
				await relay.close();
			}
		} catch (_) { }
		try {
			child.kill();
		} catch (_) { }
	}
}

run()
	.then(() => {
		process.exit(0);
	})
	.catch(error => {
		console.error('[streamdeck-bridge-e2e]', error && error.stack ? error.stack : error);
		process.exit(1);
	});
