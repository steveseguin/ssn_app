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
const socialStreamRepo = path.resolve(repoRoot, '..', 'social_stream');
const socialStreamRoot = pathToFileURL(socialStreamRepo + path.sep).href;
const pluginRoot = path.join(socialStreamRepo, 'ssn-streamdeck', 'plugin', 'ninja.socialstream.streamdeck.sdPlugin');
const pluginEntry = path.join(pluginRoot, 'bin', 'plugin.js');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-streamdeck-plugin-profile-'));
const token = `streamdeck-plugin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const sessionId = `streamdeck-plugin-e2e-${Date.now()}`;
const sourceId = 'streamdeck-plugin-e2e-source';
const sourceSecret = 'STREAMDECK_PLUGIN_SOURCE_SECRET';
const pluginUuid = 'streamdeck-plugin-e2e-runtime';
const deviceId = 'streamdeck-plugin-e2e-device';
const inspectorContext = 'streamdeck-plugin-e2e-inspector';

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
	const messages = [];
	await once(server, 'listening');
	server.on('connection', socket => {
		clients.add(socket);
		socket.on('message', raw => {
			let message;
			try {
				message = JSON.parse(raw.toString());
			} catch (_) {
				return;
			}
			messages.push(message);
			if (message && message.join) {
				socket.room = String(message.join);
				socket.inChannel = message.in;
				socket.outChannel = message.out;
				return;
			}
			const outChannel = message.out || socket.outChannel;
			for (const client of clients) {
				if (client === socket || client.readyState !== WebSocket.OPEN) continue;
				if (client.room && socket.room && client.room !== socket.room) continue;
				if (client.inChannel && outChannel && client.inChannel !== outChannel) continue;
				if ((client.inChannel && !outChannel) || (!client.inChannel && outChannel)) continue;
				client.send(raw.toString());
			}
		});
		socket.on('close', () => clients.delete(socket));
	});
	const address = server.address();
	return {
		port: address && typeof address === 'object' ? address.port : 0,
		messages,
		joinedClientCount: () => Array.from(clients).filter(client => client.room === sessionId).length,
		close: () => new Promise(resolve => {
			for (const client of clients) client.terminate();
			server.close(resolve);
		})
	};
}

async function createStreamDeckServer(relayPort) {
	const messages = [];
	let socket = null;
	const server = new WebSocket.WebSocketServer({ port: 0, host: '127.0.0.1' });
	await once(server, 'listening');
	server.on('connection', client => {
		socket = client;
		client.on('message', raw => {
			const message = JSON.parse(raw.toString());
			messages.push(message);
			if (message.event === 'getGlobalSettings') {
				send({
					event: 'didReceiveGlobalSettings',
					context: message.context,
					id: message.id,
					payload: {
						settings: {
							sessionId,
							apiHost: `127.0.0.1:${relayPort}`,
							useTls: false,
							httpFallback: false,
							inChannel: 2,
							outChannel: 1,
							requestTimeoutMs: 20000
						}
					}
				});
			}
			if (message.event === 'getSettings') {
				send({
					event: 'didReceiveSettings',
					action: 'ninja.socialstream.streamdeck.command',
					context: message.context,
					id: message.id,
					device: deviceId,
					payload: {
						controller: 'Keypad',
						coordinates: { column: 0, row: 0 },
						isInMultiAction: false,
						resources: {},
						settings: {},
						state: 0
					}
				});
			}
		});
	});
	const address = server.address();

	function send(message) {
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			throw new Error('Stream Deck plugin socket is not open');
		}
		socket.send(JSON.stringify(message));
	}

	return {
		port: address && typeof address === 'object' ? address.port : 0,
		messages,
		send,
		waitForMessage: (predicate, label, timeoutMs = 10000) => waitFor(() => messages.find(predicate), label, timeoutMs),
		close: () => new Promise(resolve => {
			if (socket) socket.terminate();
			server.close(resolve);
		})
	};
}

function requestJson(port, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : null;
		const request = http.request({
			host: '127.0.0.1',
			port,
			path: `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
			method: payload ? 'POST' : 'GET',
			headers: payload ? {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload)
			} : {}
		}, response => {
			let text = '';
			response.setEncoding('utf8');
			response.on('data', chunk => {
				text += chunk;
			});
			response.on('end', () => {
				try {
					const json = text ? JSON.parse(text) : {};
					if (response.statusCode >= 200 && response.statusCode < 300) {
						resolve(json);
						return;
					}
					reject(new Error(`HTTP ${response.statusCode}: ${text}`));
				} catch (error) {
					reject(error);
				}
			});
		});
		request.on('error', reject);
		if (payload) request.write(payload);
		request.end();
	});
}

async function waitForRemoteControl(port, timeoutMs = 60000) {
	let lastError = null;
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const ping = await requestJson(port, '/ping');
			if (ping && ping.ok) return;
		} catch (error) {
			lastError = error;
		}
		await delay(250);
	}
	throw new Error(`Timed out waiting for SSApp remote control: ${lastError ? lastError.message : 'no response'}`);
}

async function execInRenderer(port, windowId, code, label) {
	const response = await requestJson(port, '/exec', { windowId, code });
	if (!response || response.ok !== true) {
		throw new Error(`${label}: ${response && response.error ? response.error : 'renderer exec failed'}`);
	}
	return response.result;
}

function actionEvent(event, context, settings) {
	return {
		event,
		action: 'ninja.socialstream.streamdeck.command',
		context,
		device: deviceId,
		payload: {
			controller: 'Keypad',
			coordinates: { column: 0, row: 0 },
			isInMultiAction: false,
			resources: {},
			settings,
			state: 0
		}
	};
}

async function once(emitter, event) {
	return await new Promise((resolve, reject) => {
		emitter.once(event, resolve);
		emitter.once('error', reject);
	});
}

async function waitFor(find, label, timeoutMs = 10000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const result = find();
		if (result) return result;
		await delay(25);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function delay(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function stopChild(child) {
	if (!child || child.exitCode !== null) return;
	child.kill();
	await Promise.race([
		once(child, 'exit').catch(() => undefined),
		delay(5000)
	]);
}

async function run() {
	assert(fs.existsSync(pluginEntry), `Compiled Stream Deck plugin missing: ${pluginEntry}. Run npm run build in ssn-streamdeck/plugin first.`);

	const remotePort = await getFreePort();
	const relay = await createRelayServer();
	const streamDeck = await createStreamDeckServer(relay.port);
	let appChild = null;
	let pluginChild = null;
	let appStdout = '';
	let appStderr = '';
	let pluginStdout = '';
	let pluginStderr = '';

	try {
		appChild = spawn(
			electronPath,
			['.', '--running-from-source', '--multiinstance', '--filesource', socialStreamRoot, '--remote-control'],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					SSAPP_USER_DATA_DIR: userDataDir,
					SSAPP_REMOTE_CONTROL: '1',
					SSAPP_REMOTE_CONTROL_PORT: String(remotePort),
					SSAPP_REMOTE_CONTROL_TOKEN: token,
					SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
					SSAPP_DEBUG_LOGS: '0'
				},
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true
			}
		);
		appChild.stdout.setEncoding('utf8');
		appChild.stderr.setEncoding('utf8');
		appChild.stdout.on('data', chunk => {
			appStdout += chunk;
		});
		appChild.stderr.on('data', chunk => {
			appStderr += chunk;
		});

		await waitForRemoteControl(remotePort);
		const windows = await requestJson(remotePort, '/windows');
		const mainWindow = (windows.windows || []).find(window => typeof window.url === 'string' && window.url.includes('index.html'));
		assert(mainWindow && mainWindow.id, `SSApp main window not found: ${JSON.stringify(windows)}`);

		const setup = await execInRenderer(remotePort, mainWindow.id, `
			(async () => {
				const started = Date.now();
				while (
					!window.stateManager ||
					!stateManager.initialized ||
					!window.SSAppStreamDeckBridge ||
					typeof createSourceElement !== 'function' ||
					!document.getElementById('frame2') ||
					!document.getElementById('frame2').contentWindow ||
					typeof document.getElementById('frame2').contentWindow.setupSocket !== 'function' ||
					(typeof configReady !== 'undefined' && configReady !== true)
				) {
					if (Date.now() - started > 45000) return { ready: false };
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				if (!stateManager.getSource(${JSON.stringify(sourceId)})) {
					stateManager.addSource({
						id: ${JSON.stringify(sourceId)},
						target: 'youtube',
						username: 'streamdeck-plugin-e2e',
						videoId: 'streamdeck-plugin-video',
						url: 'https://www.youtube.com/watch?v=streamdeck-plugin-video&access_token=${sourceSecret}',
						connectionMode: 'websocket',
						isMuted: false,
						isVisible: true,
						autoActivate: false
					});
				}
				let entry = document.querySelector('[data-source-id="' + ${JSON.stringify(sourceId)} + '"]');
				if (!entry) {
					entry = createSourceElement(${JSON.stringify(sourceId)});
					document.getElementById('sources').appendChild(entry);
				}
				const background = document.getElementById('frame2').contentWindow;
				try {
					if (background.socketserver && typeof background.socketserver.close === 'function') {
						background.socketserver.onclose = null;
						background.socketserver.close();
					}
				} catch (_) {}
				background.socketserver = false;
				background.serverURL = 'ws://127.0.0.1:${relay.port}/api';
				background.streamID = ${JSON.stringify(sessionId)};
				background.isExtensionOn = true;
				background.settings = Object.assign({}, background.settings || {}, { socketserver: true });
				background.setupSocket();
				return { ready: true, sourceId: ${JSON.stringify(sourceId)} };
			})()
		`, 'initialize SSApp Stream Deck bridge');
		assert.equal(setup.ready, true, 'SSApp renderer did not become ready');
		await waitFor(() => relay.joinedClientCount() >= 1, 'SSApp relay connection', 15000);

		pluginChild = spawn(
			process.execPath,
			[
				pluginEntry,
				'-port',
				String(streamDeck.port),
				'-pluginUUID',
				pluginUuid,
				'-registerEvent',
				'registerPlugin',
				'-info',
				JSON.stringify({
					application: {
						font: 'Segoe UI',
						language: 'en',
						platform: 'windows',
						platformVersion: '10.0.0',
						version: '7.5.0'
					},
					colors: {},
					devicePixelRatio: 2,
					devices: [{ id: deviceId, name: 'SSApp E2E Deck', size: { columns: 5, rows: 3 }, type: 0 }],
					plugin: { uuid: 'ninja.socialstream.streamdeck', version: '0.2.1.0' }
				})
			],
			{
				cwd: pluginRoot,
				env: process.env,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true
			}
		);
		pluginChild.stdout.setEncoding('utf8');
		pluginChild.stderr.setEncoding('utf8');
		pluginChild.stdout.on('data', chunk => {
			pluginStdout += chunk;
		});
		pluginChild.stderr.on('data', chunk => {
			pluginStderr += chunk;
		});

		await streamDeck.waitForMessage(message => message.event === 'registerPlugin' && message.uuid === pluginUuid, 'plugin registration');
		await waitFor(() => relay.joinedClientCount() >= 2, 'plugin relay connection', 15000);
		await waitFor(
			() => relay.messages.find(message => message && message.callback && message.callback.result && message.callback.result.ssapp && message.callback.result.ssapp.available),
			'SSApp capability response to plugin',
			30000
		);

		streamDeck.send(actionEvent('willAppear', inspectorContext, { command: 'getSources' }));
		await streamDeck.waitForMessage(
			message => message.event === 'setTitle' && message.context === inspectorContext,
			'command action render'
		);
		streamDeck.send({
			event: 'propertyInspectorDidAppear',
			action: 'ninja.socialstream.streamdeck.command',
			context: inspectorContext,
			device: deviceId
		});
		streamDeck.send({
			event: 'sendToPlugin',
			action: 'ninja.socialstream.streamdeck.command',
			context: inspectorContext,
			payload: { type: 'testConnection' }
		});
		const connectionStatus = await streamDeck.waitForMessage(
			message => message.event === 'sendToPropertyInspector' &&
				message.context === inspectorContext &&
				message.payload &&
				message.payload.type === 'status' &&
				message.payload.message === 'Connection requested.',
			'plugin Test Connection response'
		);
		assert.equal(connectionStatus.payload.ok, true, `plugin did not report connected: ${JSON.stringify(connectionStatus)}`);
		assert.equal(connectionStatus.payload.state, 'connected');
		assert.equal(connectionStatus.payload.capabilities.ssapp.available, true);
		assert.equal(connectionStatus.payload.capabilities.runtime, 'electron');

		streamDeck.send({
			event: 'sendToPlugin',
			action: 'ninja.socialstream.streamdeck.command',
			context: inspectorContext,
			payload: { type: 'requestSources' }
		});
		const sourceResponse = await streamDeck.waitForMessage(
			message => message.event === 'sendToPropertyInspector' &&
				message.context === inspectorContext &&
				message.payload &&
				message.payload.type === 'sources',
			'plugin source list',
			30000
		);
		const listedSource = sourceResponse.payload.sources.find(source => source.id === sourceId);
		assert(listedSource, `plugin source list omitted ${sourceId}: ${JSON.stringify(sourceResponse)}`);
		assert.equal(listedSource.status, 'inactive');
		assert.equal(listedSource.tabId, null);
		assert.equal(Object.prototype.hasOwnProperty.call(listedSource, 'url'), false);
		assert.equal(JSON.stringify(sourceResponse).includes(sourceSecret), false, 'plugin source list leaked source credentials');

		const startContext = 'streamdeck-plugin-e2e-start';
		streamDeck.send(actionEvent('willAppear', startContext, { command: 'startSource', value: sourceId }));
		await streamDeck.waitForMessage(
			message => message.event === 'setTitle' && message.context === startContext,
			'start-source action render'
		);
		streamDeck.send(actionEvent('keyDown', startContext, { command: 'startSource', value: sourceId }));
		await streamDeck.waitForMessage(
			message => message.event === 'showOk' && message.context === startContext,
			'plugin start-source success',
			30000
		);
		const activeState = await execInRenderer(remotePort, mainWindow.id, `
			(() => {
				const source = stateManager.getSource(${JSON.stringify(sourceId)});
				return source ? {
					status: source.status,
					vid: source.vid || null,
					wssId: source.wssId || null,
					activeConnectionMode: source.activeConnectionMode || null
				} : null;
			})()
		`, 'read started source state');
		assert(activeState && ['active', 'activating'].includes(activeState.status), `source did not start: ${JSON.stringify(activeState)}`);
		assert(activeState.vid || activeState.wssId, `source has no active handle: ${JSON.stringify(activeState)}`);
		assert.equal(activeState.activeConnectionMode, 'websocket');

		const stopContext = 'streamdeck-plugin-e2e-stop';
		streamDeck.send(actionEvent('willAppear', stopContext, { command: 'stopSource', value: sourceId }));
		await streamDeck.waitForMessage(
			message => message.event === 'setTitle' && message.context === stopContext,
			'stop-source action render'
		);
		streamDeck.send(actionEvent('keyDown', stopContext, { command: 'stopSource', value: sourceId }));
		await streamDeck.waitForMessage(
			message => message.event === 'showOk' && message.context === stopContext,
			'plugin stop-source success',
			30000
		);
		const stoppedState = await execInRenderer(remotePort, mainWindow.id, `
			(() => {
				const source = stateManager.getSource(${JSON.stringify(sourceId)});
				return source ? {
					status: source.status,
					vid: source.vid || null,
					wssId: source.wssId || null,
					activeConnectionMode: source.activeConnectionMode || null
				} : null;
			})()
		`, 'read stopped source state');
		assert(stoppedState, 'source disappeared after stop');
		assert.equal(stoppedState.status, 'inactive');
		assert.equal(stoppedState.vid, null);
		assert.equal(stoppedState.wssId, null);
		assert.equal(stoppedState.activeConnectionMode, null);
		assert.equal(JSON.stringify(streamDeck.messages).includes(sourceSecret), false, 'source credentials reached Stream Deck');

		assert.equal(pluginChild.exitCode, null, `plugin exited early\nstdout:\n${pluginStdout}\nstderr:\n${pluginStderr}`);
		console.log('[streamdeck-plugin-e2e] PASS', JSON.stringify({
			connection: connectionStatus.payload.state,
			runtime: connectionStatus.payload.capabilities.runtime,
			sourceListed: !!listedSource,
			sourceStarted: !!(activeState.vid || activeState.wssId),
			sourceStopped: stoppedState.status === 'inactive',
			credentialsRedacted: true
		}));
	} catch (error) {
		console.error('[streamdeck-plugin-e2e] SSApp stdout:', appStdout.slice(-4000));
		console.error('[streamdeck-plugin-e2e] SSApp stderr:', appStderr.slice(-4000));
		console.error('[streamdeck-plugin-e2e] plugin stdout:', pluginStdout.slice(-4000));
		console.error('[streamdeck-plugin-e2e] plugin stderr:', pluginStderr.slice(-4000));
		throw error;
	} finally {
		try {
			if (appChild && appChild.exitCode === null) {
				await requestJson(remotePort, '/api/v1/command', { action: 'shutdownApp', value: { confirm: true } });
			}
		} catch (_) { }
		await stopChild(pluginChild);
		await stopChild(appChild);
		await streamDeck.close().catch(() => undefined);
		await relay.close().catch(() => undefined);
		try {
			fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		} catch (_) { }
	}
}

run().catch(error => {
	console.error('[streamdeck-plugin-e2e]', error && error.stack ? error.stack : error);
	process.exitCode = 1;
});
