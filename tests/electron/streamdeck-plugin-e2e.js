'use strict';

const assert = require('assert');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
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

const ACTION_UUIDS = Object.freeze({
	connection: 'ninja.socialstream.streamdeck.connection',
	command: 'ninja.socialstream.streamdeck.command',
	custom: 'ninja.socialstream.streamdeck.custom-command',
	timer: 'ninja.socialstream.streamdeck.timer-dial',
	chat: 'ninja.socialstream.streamdeck.chat-feed'
});

const SSN_PRESETS = [
	'nextInQueue', 'clearOverlay', 'clearDock', 'clear', 'clearAll', 'clearHistory',
	'creditsStart', 'creditsPreview', 'creditsTest', 'creditsReset', 'resetleaderboard',
	'getQueueSize', 'sendChat', 'sendEncodedChat', 'pin', 'unpin', 'nextPinned', 'drawmode',
	'removefromwaitlist', 'highlightwaitlist', 'resetwaitlist', 'stopentries', 'startentries',
	'openentries', 'resumeentries', 'waitlistmessage', 'setwaitlistmessage', 'downloadwaitlist',
	'selectwinner', 'starttimer', 'pausetimer', 'toggletimer', 'resettimer', 'timeradd',
	'timersubtract', 'settimer', 'gettimerstate', 'loadpoll', 'setpollsettings', 'getpollpresets',
	'createpoll', 'resetpoll', 'closepoll', 'startmap', 'pausemap', 'resetmap'
];

const SUPPORTED_SSAPP_PRESETS = [
	'getSources', 'getSource', 'addSource', 'updateSource', 'removeSource', 'startSource',
	'stopSource', 'restartSource', 'setSourceMute', 'toggleSourceMute', 'setSourceVisibility',
	'toggleSourceVisibility', 'setSourceConnectionMode'
];

const GATED_SSAPP_PRESETS = [
	'startAllSources', 'stopAllSources', 'restartAllSources', 'getSettings', 'updateSettings'
];

const DOCK_COMMANDS = new Set(['nextInQueue', 'clearOverlay', 'nextPinned', 'getQueueSize']);

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

async function createSourceFixtureServer() {
	const server = http.createServer((request, response) => {
		response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		response.end('<!doctype html><html><body><main>Stream Deck isolated source fixture</main></body></html>');
	});
	await new Promise((resolve, reject) => {
		server.listen(0, '127.0.0.1', resolve);
		server.once('error', reject);
	});
	const address = server.address();
	return {
		port: address && typeof address === 'object' ? address.port : 0,
		close: () => new Promise(resolve => server.close(resolve))
	};
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
		broadcast: (message, outChannel) => {
			const raw = JSON.stringify(message);
			for (const client of clients) {
				if (client.readyState !== WebSocket.OPEN || client.room !== sessionId) continue;
				if (client.inChannel !== outChannel) continue;
				client.send(raw);
			}
		},
		close: () => new Promise(resolve => {
			for (const client of clients) client.terminate();
			server.close(resolve);
		})
	};
}

async function createDockClient(relayPort) {
	const messages = [];
	const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/api`);
	await once(socket, 'open');
	socket.send(JSON.stringify({ join: sessionId, in: 1, out: 2 }));
	socket.on('message', raw => {
		let request;
		try {
			request = JSON.parse(raw.toString());
		} catch (_) {
			return;
		}
		messages.push(request);
		if (!request || !request.get || !DOCK_COMMANDS.has(request.action)) return;
		const payload = request.action === 'getQueueSize'
			? { action: request.action, queueSize: 0 }
			: { action: request.action, accepted: true };
		socket.send(JSON.stringify({
			callback: {
				get: request.get,
				result: { ok: true, status: 'completed', request: request.get, payload }
			}
		}));
	});
	return {
		messages,
		close: () => new Promise(resolve => {
			if (socket.readyState === WebSocket.CLOSED) {
				resolve();
				return;
			}
			socket.once('close', resolve);
			socket.close();
		})
	};
}

async function createStreamDeckServer(relayPort) {
	const messages = [];
	const actionContexts = new Map();
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
				const actionContext = actionContexts.get(message.context) || {
					action: ACTION_UUIDS.command,
					controller: 'Keypad',
					settings: {}
				};
				send({
					event: 'didReceiveSettings',
					action: actionContext.action,
					context: message.context,
					id: message.id,
					device: deviceId,
					payload: {
						controller: actionContext.controller,
						coordinates: { column: 0, row: 0 },
						...(actionContext.controller === 'Keypad' ? { isInMultiAction: false, state: 0 } : {}),
						resources: {},
						settings: actionContext.settings
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
		if (message && message.event === 'willAppear' && message.context && message.payload) {
			actionContexts.set(message.context, {
				action: message.action,
				controller: message.payload.controller || 'Keypad',
				settings: message.payload.settings || {}
			});
		}
		if (message && message.event === 'willDisappear' && message.context) {
			actionContexts.delete(message.context);
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

function actionEvent(event, context, settings, options = {}) {
	const controller = options.controller || 'Keypad';
	return {
		event,
		action: options.action || ACTION_UUIDS.command,
		context,
		device: deviceId,
		payload: {
			controller,
			coordinates: { column: 0, row: 0 },
			...(controller === 'Keypad' ? { isInMultiAction: false, state: 0 } : {}),
			resources: {},
			settings,
			...(options.payload || {})
		}
	};
}

function commandValue(value) {
	return typeof value === 'string' ? value : JSON.stringify(value);
}

let actionSequence = 0;

async function pressPreset(streamDeck, relay, command, value, expectedFeedback = 'showOk') {
	actionSequence += 1;
	const context = `streamdeck-plugin-e2e-${actionSequence}-${command}`;
	const settings = { command };
	if (typeof value !== 'undefined') settings.value = commandValue(value);
	streamDeck.send(actionEvent('willAppear', context, settings));
	await streamDeck.waitForMessage(
		message => message.event === 'setTitle' && message.context === context,
		`${command} title render`
	);
	const relayStart = relay.messages.length;
	const streamDeckStart = streamDeck.messages.length;
	streamDeck.send(actionEvent('keyDown', context, settings));
	if (command === 'creditsReset') {
		await waitFor(
			() => streamDeck.messages.slice(streamDeckStart).find(message => message.event === 'setTitle' && message.context === context),
			'creditsReset confirmation prompt'
		);
		streamDeck.send(actionEvent('keyDown', context, settings));
	}
	await streamDeck.waitForMessage(
		message => message.event === expectedFeedback && message.context === context,
		`${command} ${expectedFeedback}`,
		30000
	);
	const request = expectedFeedback === 'showOk'
		? await waitFor(
			() => relay.messages.slice(relayStart).find(message => message && message.action === command && message.apiid === sessionId),
			`${command} relay request`,
			30000
		)
		: relay.messages.slice(relayStart).find(message => message && message.action === command && message.apiid === sessionId) || null;
	const callback = request && request.get
		? relay.messages.slice(relayStart).find(message => message && message.callback && message.callback.get === request.get) || null
		: null;
	return { context, request, callback };
}

async function waitForRelayAction(relay, start, action, label, timeoutMs = 30000) {
	return await waitFor(
		() => relay.messages.slice(start).find(message => message && message.action === action && message.apiid === sessionId),
		label,
		timeoutMs
	);
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
		const result = await find();
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
	const sourceFixture = await createSourceFixtureServer();
	const relay = await createRelayServer();
	const streamDeck = await createStreamDeckServer(relay.port);
	let appChild = null;
	let pluginChild = null;
	let dockClient = null;
	let appStdout = '';
	let appStderr = '';
	let pluginStdout = '';
	let pluginStderr = '';

	try {
		appChild = spawn(
			electronPath,
			['.', '--running-from-source', '--multiinstance', '--filesource', socialStreamRoot, '--remote-control', ...linuxLaunchArgs()],
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
		const mainWindow = await waitFor(async () => {
			const windows = await requestJson(remotePort, '/windows');
			return (windows.windows || []).find(window => typeof window.url === 'string' && window.url.includes('index.html'));
		}, 'SSApp main window navigation', 60000);
		assert(mainWindow && mainWindow.id, 'SSApp main window did not finish navigating');

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
						videoId: '',
						url: 'http://127.0.0.1:${sourceFixture.port}/?access_token=${sourceSecret}',
						connectionMode: 'classic',
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
				background.__streamDeckE2eCreditsPackets = [];
				background.__streamDeckE2eOutgoingChats = [];
				background.__streamDeckE2eDownloads = 0;
				background.sendTargetP2P = async function(packet, target) {
					if (packet && packet.creditsCommand) {
						background.__streamDeckE2eCreditsPackets.push({ packet: JSON.parse(JSON.stringify(packet)), target: target });
					}
					return true;
				};
				background.sendMessageToTabs = async function(message) {
					background.__streamDeckE2eOutgoingChats.push(JSON.parse(JSON.stringify(message)));
					return true;
				};
				background.downloadWaitlist = function() {
					background.__streamDeckE2eDownloads += 1;
					return true;
				};
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

		dockClient = await createDockClient(relay.port);
		await waitFor(() => relay.joinedClientCount() >= 3, 'isolated Dock relay connection', 15000);

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
				message.payload.message === 'Connection verified.',
			'plugin Test Connection response'
		);
		assert.equal(connectionStatus.payload.ok, true, `plugin did not report connected: ${JSON.stringify(connectionStatus)}`);
		assert.equal(connectionStatus.payload.state, 'connected');
		assert.equal(connectionStatus.payload.capabilities.ssapp.available, true);
		assert.equal(connectionStatus.payload.capabilities.runtime, 'electron');

		const capabilities = connectionStatus.payload.capabilities;
		for (const command of SSN_PRESETS) {
			assert.equal(capabilities.ssn.actions[command], true, `${command} is missing from SSN capabilities`);
		}
		for (const command of SUPPORTED_SSAPP_PRESETS) {
			assert.equal(capabilities.ssapp.remoteActions[command], true, `${command} should be remotely available`);
		}
		for (const command of GATED_SSAPP_PRESETS) {
			assert.equal(capabilities.ssapp.remoteActions[command], undefined, `${command} should remain capability-gated`);
		}

		const registrySource = fs.readFileSync(
			path.join(socialStreamRepo, 'ssn-streamdeck', 'plugin', 'src', 'api', 'command-registry.ts'),
			'utf8'
		);
		const registryCommands = Array.from(registrySource.matchAll(/\{ id: "([^"]+)"/g), match => match[1]);
		assert.deepEqual(
			new Set(registryCommands),
			new Set([...SSN_PRESETS, ...SUPPORTED_SSAPP_PRESETS, ...GATED_SSAPP_PRESETS]),
			'exhaustive E2E command inventory is out of sync with the plugin registry'
		);

		const connectionContext = 'streamdeck-plugin-e2e-connection-action';
		streamDeck.send(actionEvent('willAppear', connectionContext, {}, { action: ACTION_UUIDS.connection }));
		await streamDeck.waitForMessage(
			message => message.event === 'setState' && message.context === connectionContext && message.payload && message.payload.state === 1,
			'Setup action connected state'
		);
		await streamDeck.waitForMessage(
			message => message.event === 'setTitle' && message.context === connectionContext && message.payload && message.payload.title === 'SSN\nOnline',
			'Setup action connected title'
		);

		const customContext = 'streamdeck-plugin-e2e-custom-action';
		const customSettings = { action: 'gettimerstate', awaitResponse: true, title: 'Custom Timer' };
		streamDeck.send(actionEvent('willAppear', customContext, customSettings, { action: ACTION_UUIDS.custom }));
		await streamDeck.waitForMessage(
			message => message.event === 'setTitle' && message.context === customContext && message.payload && message.payload.title === 'Custom Timer',
			'custom action title'
		);
		const customRelayStart = relay.messages.length;
		streamDeck.send(actionEvent('keyDown', customContext, customSettings, { action: ACTION_UUIDS.custom }));
		await streamDeck.waitForMessage(message => message.event === 'showOk' && message.context === customContext, 'custom action success', 30000);
		const customRequest = await waitForRelayAction(relay, customRelayStart, 'gettimerstate', 'custom action relay request');
		assert.equal(customRequest.protocol, 2, 'custom guaranteed command did not use protocol v2');

		const ssnValues = {
			sendChat: 'Hello from exhaustive Stream Deck E2E',
			sendEncodedChat: 'Encoded%20Stream%20Deck%20E2E',
			pin: 'streamdeck-e2e-message',
			unpin: 'streamdeck-e2e-message',
			loadpoll: { pollId: 'streamdeck-e2e-poll' },
			setpollsettings: { title: 'Stream Deck E2E', options: ['One', 'Two'] },
			createpoll: { settings: { title: 'Stream Deck E2E', options: ['One', 'Two'] } }
		};
		const ssnResults = new Map();
		for (const command of SSN_PRESETS) {
			ssnResults.set(command, await pressPreset(streamDeck, relay, command, ssnValues[command]));
		}

		for (const command of ['creditsStart', 'creditsPreview', 'creditsTest', 'creditsReset']) {
			const result = ssnResults.get(command);
			assert.equal(result.request.protocol, 2, `${command} did not use the credits v2 API`);
			assert.equal(result.callback.callback.result.ok, true, `${command} returned a failed result`);
			assert.equal(result.callback.callback.result.payload.action, command, `${command} returned the wrong action`);
		}
		const backgroundEffects = await execInRenderer(remotePort, mainWindow.id, `
			(() => {
				const background = document.getElementById('frame2').contentWindow;
				return {
					credits: background.__streamDeckE2eCreditsPackets,
					chats: background.__streamDeckE2eOutgoingChats,
					downloads: background.__streamDeckE2eDownloads
				};
			})()
		`, 'read exhaustive SSN action effects');
		assert.deepEqual(backgroundEffects.credits.map(entry => entry.packet.creditsCommand), ['start', 'preview', 'test', 'reset']);
		assert.equal(backgroundEffects.credits[2].packet.creditsSnapshot.length, 3, 'creditsTest omitted test entries');
		assert.equal(backgroundEffects.chats.length, 2, 'chat actions did not reach the Electron background');
		assert.equal(backgroundEffects.chats[0].response, ssnValues.sendChat);
		assert.equal(backgroundEffects.chats[1].response, 'Encoded Stream Deck E2E');
		assert.equal(backgroundEffects.downloads, 1, 'download waitlist action did not execute');

		const verifiedCommandRequest = ssnResults.get('gettimerstate').request;
		assert.equal(verifiedCommandRequest.protocol, 2, 'plugin did not use the versioned command callback protocol');

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

		const ssappResults = new Map();
		ssappResults.set('getSources', await pressPreset(streamDeck, relay, 'getSources'));
		ssappResults.set('getSource', await pressPreset(streamDeck, relay, 'getSource', sourceId));
		const addResult = await pressPreset(streamDeck, relay, 'addSource', {
			target: 'twitch',
			username: 'streamdeck-e2e-added',
			connectionMode: 'classic',
			idempotencyKey: 'streamdeck-e2e-added-source'
		});
		ssappResults.set('addSource', addResult);
		const addedSourceId = addResult.callback && addResult.callback.callback.result.payload.source.id;
		assert(addedSourceId, `addSource did not return a source ID: ${JSON.stringify(addResult.callback)}`);
		ssappResults.set('updateSource', await pressPreset(streamDeck, relay, 'updateSource', {
			sourceId: addedSourceId,
			updates: { username: 'streamdeck-e2e-updated' }
		}));
		ssappResults.set('setSourceMute', await pressPreset(streamDeck, relay, 'setSourceMute', { sourceId, isMuted: true }));
		ssappResults.set('toggleSourceMute', await pressPreset(streamDeck, relay, 'toggleSourceMute', sourceId));
		ssappResults.set('setSourceConnectionMode', await pressPreset(streamDeck, relay, 'setSourceConnectionMode', { sourceId, mode: 'classic' }));
		ssappResults.set('startSource', await pressPreset(streamDeck, relay, 'startSource', sourceId));
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
		assert.equal(activeState.activeConnectionMode, 'classic');
		ssappResults.set('setSourceVisibility', await pressPreset(streamDeck, relay, 'setSourceVisibility', { sourceId, isVisible: false }));
		ssappResults.set('toggleSourceVisibility', await pressPreset(streamDeck, relay, 'toggleSourceVisibility', sourceId));
		ssappResults.set('restartSource', await pressPreset(streamDeck, relay, 'restartSource', sourceId));
		ssappResults.set('stopSource', await pressPreset(streamDeck, relay, 'stopSource', sourceId));
		ssappResults.set('removeSource', await pressPreset(streamDeck, relay, 'removeSource', { sourceId: addedSourceId, confirm: true }));
		assert.deepEqual(new Set(ssappResults.keys()), new Set(SUPPORTED_SSAPP_PRESETS), 'not every remotely supported SSApp preset ran');

		for (const command of GATED_SSAPP_PRESETS) {
			const gated = await pressPreset(streamDeck, relay, command, undefined, 'showAlert');
			assert.equal(gated.request, null, `${command} escaped its capability gate`);
		}

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

		const timerContext = 'streamdeck-plugin-e2e-timer-dial';
		const timerSettings = { stepSeconds: 7, title: 'E2E Timer' };
		const timerAppearStart = relay.messages.length;
		streamDeck.send(actionEvent('willAppear', timerContext, timerSettings, {
			action: ACTION_UUIDS.timer,
			controller: 'Encoder'
		}));
		await waitForRelayAction(relay, timerAppearStart, 'gettimerstate', 'Timer Dial initial state request');
		await streamDeck.waitForMessage(
			message => message.event === 'setFeedback' && message.context === timerContext && message.payload && message.payload.value !== '--:--',
			'Timer Dial state feedback',
			30000
		);
		let timerRelayStart = relay.messages.length;
		streamDeck.send(actionEvent('dialRotate', timerContext, timerSettings, {
			action: ACTION_UUIDS.timer,
			controller: 'Encoder',
			payload: { ticks: 2, pressed: false }
		}));
		const timerAdd = await waitForRelayAction(relay, timerRelayStart, 'timeradd', 'Timer Dial rotate action');
		assert.equal(timerAdd.value, 14);
		streamDeck.send(actionEvent('dialDown', timerContext, timerSettings, { action: ACTION_UUIDS.timer, controller: 'Encoder' }));
		timerRelayStart = relay.messages.length;
		streamDeck.send(actionEvent('dialUp', timerContext, timerSettings, { action: ACTION_UUIDS.timer, controller: 'Encoder' }));
		await waitForRelayAction(relay, timerRelayStart, 'toggletimer', 'Timer Dial press action');
		timerRelayStart = relay.messages.length;
		streamDeck.send(actionEvent('touchTap', timerContext, timerSettings, {
			action: ACTION_UUIDS.timer,
			controller: 'Encoder',
			payload: { hold: true }
		}));
		const timerReset = await waitForRelayAction(relay, timerRelayStart, 'resettimer', 'Timer Dial hold action');
		assert.deepEqual(timerReset.value, { confirm: true });
		timerRelayStart = relay.messages.length;
		streamDeck.send(actionEvent('touchTap', timerContext, timerSettings, {
			action: ACTION_UUIDS.timer,
			controller: 'Encoder',
			payload: { hold: false }
		}));
		await waitForRelayAction(relay, timerRelayStart, 'gettimerstate', 'Timer Dial tap refresh');

		const chatContext = 'streamdeck-plugin-e2e-chat-dial';
		const chatSettings = { title: 'E2E Chat' };
		const chatJoinStart = relay.messages.length;
		streamDeck.send(actionEvent('willAppear', chatContext, chatSettings, {
			action: ACTION_UUIDS.chat,
			controller: 'Encoder'
		}));
		await waitFor(
			() => relay.messages.slice(chatJoinStart).find(message => message && message.join === sessionId && message.in === 4),
			'Chat Review channel-4 connection',
			15000
		);
		relay.broadcast({ mid: 'chat-one', chatname: 'Chat One', chatmessage: 'First message', type: 'youtube' }, 4);
		relay.broadcast({ mid: 'chat-two', chatname: 'Chat Two', chatmessage: 'Second message', type: 'twitch' }, 4);
		await streamDeck.waitForMessage(
			message => message.event === 'setFeedback' && message.context === chatContext && message.payload && message.payload.name === 'Chat Two',
			'Chat Review latest message',
			15000
		);
		streamDeck.send(actionEvent('dialRotate', chatContext, chatSettings, {
			action: ACTION_UUIDS.chat,
			controller: 'Encoder',
			payload: { ticks: -1, pressed: false }
		}));
		await streamDeck.waitForMessage(
			message => message.event === 'setFeedback' && message.context === chatContext && message.payload && message.payload.name === 'Chat One',
			'Chat Review browse action'
		);
		let chatRelayStart = relay.messages.length;
		streamDeck.send(actionEvent('dialDown', chatContext, chatSettings, { action: ACTION_UUIDS.chat, controller: 'Encoder' }));
		const pinRequest = await waitForRelayAction(relay, chatRelayStart, 'pin', 'Chat Review pin action');
		assert.equal(pinRequest.value, 'chat-one');
		chatRelayStart = relay.messages.length;
		streamDeck.send(actionEvent('touchTap', chatContext, chatSettings, {
			action: ACTION_UUIDS.chat,
			controller: 'Encoder',
			payload: { hold: false }
		}));
		await waitForRelayAction(relay, chatRelayStart, 'nextPinned', 'Chat Review next-pinned action');
		chatRelayStart = relay.messages.length;
		streamDeck.send(actionEvent('touchTap', chatContext, chatSettings, {
			action: ACTION_UUIDS.chat,
			controller: 'Encoder',
			payload: { hold: true }
		}));
		const unpinRequest = await waitForRelayAction(relay, chatRelayStart, 'unpin', 'Chat Review unpin action');
		assert.equal(unpinRequest.value, 'chat-one');
		streamDeck.send(actionEvent('willDisappear', chatContext, chatSettings, { action: ACTION_UUIDS.chat, controller: 'Encoder' }));
		streamDeck.send(actionEvent('willDisappear', timerContext, timerSettings, { action: ACTION_UUIDS.timer, controller: 'Encoder' }));

		assert.equal(pluginChild.exitCode, null, `plugin exited early\nstdout:\n${pluginStdout}\nstderr:\n${pluginStderr}`);
		console.log('[streamdeck-plugin-e2e] PASS', JSON.stringify({
			connection: connectionStatus.payload.state,
			runtime: connectionStatus.payload.capabilities.runtime,
			verifiedCommand: !!verifiedCommandRequest,
			ssnPresets: ssnResults.size,
			ssappPresets: ssappResults.size,
			gatedPresets: GATED_SSAPP_PRESETS.length,
			creditsCommands: backgroundEffects.credits.length,
			actions: Object.keys(ACTION_UUIDS).length,
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
		if (dockClient) await dockClient.close().catch(() => undefined);
		await streamDeck.close().catch(() => undefined);
		await relay.close().catch(() => undefined);
		await sourceFixture.close().catch(() => undefined);
		try {
			fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		} catch (_) { }
	}
}

run().catch(error => {
	console.error('[streamdeck-plugin-e2e]', error && error.stack ? error.stack : error);
	process.exitCode = 1;
});
