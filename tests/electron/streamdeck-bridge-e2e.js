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

async function createCustomJsPageServer(host) {
	const server = http.createServer((_request, response) => {
		response.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store'
		});
		response.end('<!doctype html><html><head><title>custom.js trust test</title></head><body>fixture</body></html>');
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, host, resolve);
	});
	const address = server.address();
	return {
		server,
		url: `http://${host}:${address.port}/dock.html`
	};
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
	const customJsMarker = `custom-js-trust-${Date.now()}`;
	const customJsPath = path.join(userDataDir, 'custom.js');
	const untrustedHtmlPath = path.join(userDataDir, 'streamdeck-untrusted.html');
	fs.writeFileSync(customJsPath, `window.__ssappCustomJsTrustMarker = ${JSON.stringify(customJsMarker)};`);
	fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({
		customJsFile: { filePath: customJsPath, updatedAt: Date.now() }
	}, null, 2));
	fs.writeFileSync(untrustedHtmlPath, '<!doctype html><meta charset="utf-8"><title>Untrusted Stream Deck Test</title>');
	const trustedCustomJsServer = await createCustomJsPageServer('127.0.0.1');
	const untrustedCustomJsServer = await createCustomJsPageServer('127.0.0.2');
	const child = spawn(
		electronPath,
		[
			'.',
			'--running-from-source',
			'--filesource',
			socialStreamRoot,
			'--remote-control',
			...linuxLaunchArgs(),
		],
		{
			cwd: repoRoot,
			env: {
				...process.env,
				SSAPP_USER_DATA_DIR: userDataDir,
				SSAPP_REMOTE_CONTROL: '1',
				SSAPP_REMOTE_CONTROL_PORT: String(port),
				SSAPP_REMOTE_CONTROL_TOKEN: token,
				SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
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
		const customJsState = await execInRenderer(port, 'window.ssappCustomJs.getState()', 'custom.js configured state');
		assert.equal(customJsState.enabled, true, `custom.js test file was not enabled: ${JSON.stringify(customJsState)}`);
		assert.equal(customJsState.exists, true, `custom.js test file was unavailable: ${JSON.stringify(customJsState)}`);

		const customJsSources = await execInRenderer(port, `
			(async () => {
				const started = Date.now();
				while (
					!window.SSAppStreamDeckBridge ||
					!window.stateManager ||
					!stateManager.initialized ||
					typeof createSourceElement !== 'function' ||
					typeof configReady !== 'undefined' && configReady !== true
				) {
					if (Date.now() - started > 45000) return { ready: false, sources: [] };
					await new Promise(resolve => setTimeout(resolve, 100));
				}

				const fixtures = [
					{ sourceId: 'custom-js-trusted-source', username: 'custom-js-trusted', url: ${JSON.stringify(trustedCustomJsServer.url)} },
					{ sourceId: 'custom-js-untrusted-source', username: 'custom-js-untrusted', url: ${JSON.stringify(untrustedCustomJsServer.url)} }
				];
				for (const fixture of fixtures) {
					if (!stateManager.getSource(fixture.sourceId)) {
						stateManager.addSource({
							id: fixture.sourceId,
							target: 'instagram',
							username: fixture.username,
							url: fixture.url,
							connectionMode: 'classic',
							isMuted: true,
							isVisible: false,
							autoActivate: false,
							status: 'inactive'
						});
					}
					let entry = document.querySelector('[data-source-id="' + fixture.sourceId + '"]');
					if (!entry) {
						entry = createSourceElement(fixture.sourceId);
						document.getElementById('sources').appendChild(entry);
					}
					fixture.startResult = await window.SSAppStreamDeckBridge.handleCommand({
						action: 'startSource',
						value: { sourceId: fixture.sourceId }
					});
				}

				const activationStarted = Date.now();
				while (Date.now() - activationStarted < 15000) {
					if (fixtures.every(fixture => {
						const source = stateManager.getSource(fixture.sourceId);
						return source && source.status === 'active' && source.vid;
					})) break;
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				return {
					ready: true,
					sources: fixtures.map(fixture => {
						const source = stateManager.getSource(fixture.sourceId);
						return {
							sourceId: fixture.sourceId,
							url: fixture.url,
							startResult: fixture.startResult,
							status: source && source.status,
							vid: source && source.vid
						};
					})
				};
			})()
		`, 'activate custom.js trust sources');
		assert.equal(customJsSources.ready, true, `custom.js source setup was not ready: ${JSON.stringify(customJsSources)}`);
		assert.equal(customJsSources.sources.length, 2);
		for (const source of customJsSources.sources) {
			assert.equal(source.startResult && source.startResult.ok, true, `custom.js source did not start: ${JSON.stringify(source)}`);
			assert.equal(source.status, 'active', `custom.js source was not active: ${JSON.stringify(source)}`);
			assert(source.vid, `custom.js source had no source-window handle: ${JSON.stringify(source)}`);
		}

		const trustedCustomJsWindow = await waitForWindow(
			port,
			win => win.id !== mainExecWindowId && win.url === trustedCustomJsServer.url
		);
		const trustedCustomJsResult = await execInWindow(port, trustedCustomJsWindow.id, `
			new Promise(resolve => {
				const started = Date.now();
				const check = async () => {
					const marker = window.__ssappCustomJsTrustMarker || '';
					const script = document.getElementById('ssapp-standalone-custom-js');
					if (marker) {
						resolve({ marker, hasInjectedScript: !!script, href: location.href });
						return;
					}
					if (Date.now() - started > 10000) {
						const hasBridge = !!(window.ssappCustomJs && typeof window.ssappCustomJs.reload === 'function');
						const reloadResult = hasBridge ? await window.ssappCustomJs.reload() : null;
						await new Promise(done => setTimeout(done, 100));
						resolve({
							marker: window.__ssappCustomJsTrustMarker || '',
							hasInjectedScript: !!document.getElementById('ssapp-standalone-custom-js'),
							hasBridge,
							reloadResult,
							href: location.href
						});
						return;
					}
					setTimeout(check, 50);
				};
				check();
			})
		`, 'trusted custom.js injection');
		assert.equal(trustedCustomJsResult.marker, customJsMarker, `trusted page did not run custom.js: ${JSON.stringify(trustedCustomJsResult)}`);
		assert.equal(trustedCustomJsResult.hasInjectedScript, true, 'trusted page did not retain the injected custom.js script');

		const untrustedCustomJsWindow = await waitForWindow(
			port,
			win => win.id !== mainExecWindowId && win.url === untrustedCustomJsServer.url
		);
		const untrustedCustomJsResult = await execInWindow(port, untrustedCustomJsWindow.id, `
			(async () => {
				await new Promise(resolve => setTimeout(resolve, 500));
				const reloadResult = window.ssappCustomJs && typeof window.ssappCustomJs.reload === 'function'
					? await window.ssappCustomJs.reload()
					: null;
				return {
					marker: window.__ssappCustomJsTrustMarker || '',
					hasInjectedScript: !!document.getElementById('ssapp-standalone-custom-js'),
					reloadResult
				};
			})()
		`, 'untrusted custom.js rejection');
		assert.equal(untrustedCustomJsResult.marker, '', `untrusted page ran custom.js: ${JSON.stringify(untrustedCustomJsResult)}`);
		assert.equal(untrustedCustomJsResult.hasInjectedScript, false, 'untrusted page could inspect the custom.js source');
		assert.equal(untrustedCustomJsResult.reloadResult && untrustedCustomJsResult.reloadResult.skipped, true, `untrusted manual reload was not blocked: ${JSON.stringify(untrustedCustomJsResult)}`);
		const customJsCleanup = await execInRenderer(port, `
			(async () => {
				const results = [];
				for (const sourceId of ['custom-js-trusted-source', 'custom-js-untrusted-source']) {
					results.push(await window.SSAppStreamDeckBridge.handleCommand({ action: 'stopSource', value: { sourceId } }));
					results.push(await window.SSAppStreamDeckBridge.handleCommand({ action: 'removeSource', value: { sourceId } }));
				}
				return results;
			})()
		`, 'clean up custom.js trust sources');
		assert(customJsCleanup.every(result => result && result.ok), `custom.js source cleanup failed: ${JSON.stringify(customJsCleanup)}`);

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
						url: 'https://www.youtube.com/watch?v=streamdeck-video&access_token=STREAMDECK_SECRET#private',
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

		const onboarding = await execInRenderer(port, `
			(async () => {
				showPage('streamdeck');
				await ensureStreamDeckSetupLoaded();
				const frame = document.getElementById('streamdeck-setup-frame');
				const started = Date.now();
				while (Date.now() - started < 15000) {
					const documentReady = frame && frame.contentDocument && frame.contentDocument.readyState === 'complete';
					const sessionValue = documentReady && frame.contentDocument.getElementById('sessionValue');
					const imagesLoaded = documentReady && Array.from(frame.contentDocument.querySelectorAll('.screenshots img')).every(image => image.complete && image.naturalWidth > 0);
					if (sessionValue && sessionValue.textContent && !sessionValue.textContent.includes('available in SSApp') && !sessionValue.textContent.includes('still loading') && imagesLoaded) {
						const setupState = await getStreamDeckSetupState();
						return {
							ready: true,
							src: frame.src,
							sessionId: setupState.sessionId,
							displayedSessionId: sessionValue.textContent,
							copyEnabled: !frame.contentDocument.getElementById('copySession').disabled,
							imagesLoaded,
							activeNav: document.querySelector('[data-page="streamdeck"]').classList.contains('active')
						};
					}
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				return {
					ready: false,
					src: frame && frame.src,
					setupState: await getStreamDeckSetupState(),
					displayedSessionId: frame && frame.contentDocument && frame.contentDocument.getElementById('sessionValue')
						? frame.contentDocument.getElementById('sessionValue').textContent
						: null
				};
			})()
		`, 'Stream Deck onboarding');
		assert.equal(onboarding.ready, true, `Stream Deck onboarding was not ready: ${JSON.stringify(onboarding)}`);
		assert(onboarding.src.includes('streamdeck/index.html'), `unexpected onboarding URL: ${onboarding.src}`);
		assert(onboarding.sessionId, 'onboarding did not read the active Social Stream session ID');
		assert.equal(onboarding.displayedSessionId, onboarding.sessionId, 'onboarding displayed the wrong session ID');
		assert.equal(onboarding.copyEnabled, true, 'onboarding copy button should be enabled');
		assert.equal(onboarding.imagesLoaded, true, 'onboarding screenshots should load');
		assert.equal(onboarding.activeNav, true, 'Stream Deck navigation tab should be active');

		const sources = await execInRenderer(port, `window.SSAppStreamDeckBridge.handleCommand({ action: 'getSources' })`, 'renderer getSources');
		assert.equal(sources.ok, true, 'getSources failed');
		const listedSource = sources.payload.sources.find(source => source.id === seed.sourceId);
		assert(listedSource, 'seeded source missing from getSources');
		assert.equal(Object.prototype.hasOwnProperty.call(listedSource, 'url'), false, 'getSources must not expose source URLs');
		assert.equal(listedSource.tabId, null, 'inactive source should not expose a tab ID');
		assert.equal(JSON.stringify(sources).includes('STREAMDECK_SECRET'), false, 'getSources leaked URL credentials');

		const getSource = await execInRenderer(port, `window.SSAppStreamDeckBridge.handleCommand({ action: 'getSource', value: '${seed.sourceId}' })`, 'renderer getSource');
		assert.equal(getSource.ok, true, 'getSource failed');
		assert.equal(getSource.payload.source.status, 'inactive', 'seeded source should start inactive');
		assert.equal(getSource.payload.source.activeConnectionMode, null, 'inactive source should not report an active connection mode');
		assert.equal(Object.prototype.hasOwnProperty.call(getSource.payload.source, 'url'), false, 'getSource must not expose source URLs');
		assert.equal(getSource.payload.source.tabId, null, 'inactive source should not expose a tab ID');

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
		assert.equal(mode.payload.source.activeConnectionMode, null, 'inactive source should keep activeConnectionMode null after mode change');

		const unsupportedPlatformModes = await execInRenderer(port, `
			(async () => {
				const sourceId = 'streamdeck-e2e-instagram-source';
				if (!stateManager.getSource(sourceId)) {
					stateManager.addSource({
						id: sourceId,
						target: 'instagram',
						username: 'streamdeck-e2e-instagram',
						url: 'https://www.instagram.com/streamdeck-e2e-instagram/',
						connectionMode: 'classic',
						isMuted: true,
						isVisible: false,
						autoActivate: false
					});
				}
				const updateResult = await window.SSAppStreamDeckBridge.handleCommand({
					action: 'updateSource',
					value: { sourceId, updates: { connectionMode: 'websocket' } }
				});
				const setResult = await window.SSAppStreamDeckBridge.handleCommand({
					action: 'setSourceConnectionMode',
					value: { sourceId, mode: 'websocket' }
				});
				return { updateResult, setResult, source: stateManager.getSource(sourceId) };
			})()
		`, 'renderer unsupported platform connection modes');
		assert.equal(unsupportedPlatformModes.updateResult.ok, false, 'updateSource accepted an unsupported platform mode');
		assert.equal(unsupportedPlatformModes.updateResult.error.code, 'INVALID_TARGET');
		assert.equal(unsupportedPlatformModes.setResult.ok, false, 'setSourceConnectionMode accepted an unsupported platform mode');
		assert.equal(unsupportedPlatformModes.setResult.error.code, 'INVALID_TARGET');
		assert.equal(unsupportedPlatformModes.source.connectionMode, 'classic', 'rejected mode change altered persisted source state');

		const forcedClassicBlock = await execInRenderer(port, `
			(async () => {
				const sourceId = 'streamdeck-e2e-tiktok-source';
				const previousGlobal = {
					forceTikTokClassic: !!stateManager.state.global.forceTikTokClassic,
					lastTikTokMode: stateManager.state.global.lastTikTokMode,
					tiktokModeExplicitlySelected: !!stateManager.state.global.tiktokModeExplicitlySelected
				};
				if (!stateManager.getSource(sourceId)) {
					stateManager.addSource({
						id: sourceId,
						target: 'tiktok',
						username: 'streamdeck-e2e-tiktok',
						url: 'https://www.tiktok.com/@streamdeck-e2e-tiktok/live',
						connectionMode: 'classic',
						isMuted: false,
						isVisible: true,
						autoActivate: false
					});
				}
				let entry = document.querySelector('[data-source-id="' + sourceId + '"]');
				if (!entry) {
					entry = createSourceElement(sourceId);
					document.getElementById('sources').appendChild(entry);
				}
				stateManager.updateGlobal({ forceTikTokClassic: true });
				if (typeof updatePreferTikTokClassicFromState === 'function') {
					updatePreferTikTokClassicFromState({ forceApply: true, skipSync: true, silent: true });
				}
				const response = await window.SSAppStreamDeckBridge.handleCommand({
					action: 'setSourceConnectionMode',
					value: { sourceId, mode: 'tiktok-websocket' }
				});
				const blockedSource = stateManager.getSource(sourceId);
				stateManager.updateGlobal(previousGlobal);
				if (typeof updatePreferTikTokClassicFromState === 'function') {
					updatePreferTikTokClassicFromState({ forceApply: true, skipSync: true, silent: true });
				}
				return {
					response,
					connectionMode: blockedSource && blockedSource.connectionMode,
					restoredForceTikTokClassic: !!stateManager.state.global.forceTikTokClassic
				};
			})()
		`, 'renderer forced classic setSourceConnectionMode');
		assert.equal(forcedClassicBlock.response.ok, false, `forced classic mode change should fail: ${JSON.stringify(forcedClassicBlock)}`);
		assert.equal(forcedClassicBlock.response.error && forcedClassicBlock.response.error.code, 'INVALID_TARGET', `unexpected forced classic response: ${JSON.stringify(forcedClassicBlock)}`);
		assert.equal(forcedClassicBlock.connectionMode, 'classic', 'forced classic block should leave TikTok source in classic mode');

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

		const untrustedFrameBridge = await execInRenderer(port, `
			new Promise(resolve => {
				const frame = document.createElement('iframe');
				frame.style.display = 'none';
				const messageType = 'streamdeck-forbidden-frame-' + Date.now();
				const timer = setTimeout(() => {
					window.removeEventListener('message', onMessage);
					frame.remove();
					resolve({ ok: false, error: { code: 'FRAME_TIMEOUT' } });
				}, 10000);
				function onMessage(event) {
					if (!event.data || event.data.type !== messageType) return;
					clearTimeout(timer);
					window.removeEventListener('message', onMessage);
					frame.remove();
					resolve(event.data.response);
				}
				window.addEventListener('message', onMessage);
				const script = \`
					(function () {
						function done(response) {
							parent.postMessage({ type: '\${messageType}', response: response }, '*');
						}
						try {
							const ipc = typeof require === 'function' ? require('electron').ipcRenderer : null;
							if (!ipc) {
								done({ ok: false, error: { code: 'IPC_UNAVAILABLE' } });
								return;
							}
							ipc.invoke('ssapp:background-command', {
								cmd: 'streamDeckSourceCommand',
								request: { action: 'getSource', value: '${seed.sourceId}' }
							}).then(done).catch(error => done({
								ok: false,
								error: { code: 'IPC_ERROR', message: error && error.message ? error.message : String(error) }
							}));
						} catch (error) {
							done({ ok: false, error: { code: 'FRAME_ERROR', message: error && error.message ? error.message : String(error) } });
						}
					})();
				\`;
				frame.srcdoc = '<!doctype html><script>' + script + '<\\/script>';
				document.body.appendChild(frame);
			})
		`, 'untrusted iframe streamDeckSourceCommand');
		assert.equal(untrustedFrameBridge.ok, false, `untrusted iframe should be denied: ${JSON.stringify(untrustedFrameBridge)}`);
		assert.equal(untrustedFrameBridge.error && untrustedFrameBridge.error.code, 'SSAPP_FORBIDDEN', `unexpected iframe denial response: ${JSON.stringify(untrustedFrameBridge)}`);

		const untrustedUrlObject = new URL(pathToFileURL(untrustedHtmlPath).href);
		untrustedUrlObject.searchParams.set('ssapp-streamdeck-forbidden', String(Date.now()));
		const untrustedUrl = untrustedUrlObject.href;
		await execInRenderer(port, `window.open(${JSON.stringify(untrustedUrl)}, '_blank'); true`, 'open untrusted renderer');
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

		const p2pFeedDelivery = await execInRenderer(port, `
			(() => {
				const frame = document.getElementById('frame2');
				const bg = frame && frame.contentWindow;
				if (!bg || typeof bg.sendDataP2P !== 'function') {
					return { ok: false, error: 'background P2P sender unavailable' };
				}
				const original = {
					ninjaBridge: bg.ninjaBridge,
					iframe: bg.iframe,
					connectedPeers: bg.connectedPeers,
					socketserverDock: bg.socketserverDock,
					settings: bg.settings
				};
				const labels = [];
				const broadcasts = [];
				const socketPackets = [];
				try {
					bg.ninjaBridge = {
						isReady: () => true,
						getPeers: () => ({ deck: 'streamdeck', dock: 'dock' }),
						sendToLabel: (data, label) => {
							labels.push({ data, label });
							return true;
						},
						send: data => {
							broadcasts.push(data);
							return true;
						}
					};
					bg.iframe = false;
					bg.connectedPeers = {};
					bg.socketserverDock = { readyState: 1, send: data => socketPackets.push(JSON.parse(data)) };
					bg.settings = Object.assign({}, bg.settings || {}, { server2: true, server2additivedelivery: false });
					bg.sendDataP2P({ mid: 'streamdeck-feed', chatname: 'Test', chatmessage: 'Hello', type: 'youtube' });
					return { ok: true, labels, broadcasts, socketPackets };
				} finally {
					bg.ninjaBridge = original.ninjaBridge;
					bg.iframe = original.iframe;
					bg.connectedPeers = original.connectedPeers;
					bg.socketserverDock = original.socketserverDock;
					bg.settings = original.settings;
				}
			})()
		`, 'Stream Deck P2P feed delivery alongside server2');
		assert.equal(p2pFeedDelivery.ok, true, `P2P feed delivery failed: ${JSON.stringify(p2pFeedDelivery)}`);
		assert.equal(p2pFeedDelivery.labels.filter(entry => entry.label === 'streamdeck').length, 1, 'P2P Stream Deck feed was not sent exactly once');
		assert.equal(p2pFeedDelivery.socketPackets.length, 1, 'server2 Dock feed was not preserved');
		assert.equal(p2pFeedDelivery.broadcasts.length, 0, 'Stream Deck feed should not fall through to a duplicate broadcast');

		const iframeTransportBridge = await execInRenderer(port, `
			(async () => {
				const frame = document.getElementById('frame2');
				const bg = frame && frame.contentWindow;
				if (!bg || typeof bg.processIncomingRequest !== 'function') {
					return { ok: false, error: 'background request dispatcher unavailable' };
				}

				const transport = bg.document.createElement('iframe');
				transport.style.display = 'none';
				transport.srcdoc = '<!doctype html><title>WebRTC transport fixture</title>';
				bg.document.body.appendChild(transport);
				await new Promise(resolve => {
					if (transport.contentDocument && transport.contentDocument.readyState === 'complete') resolve();
					else transport.addEventListener('load', resolve, { once: true });
				});

				const originalIframe = bg.iframe;
				const originalSendDataP2P = bg.sendDataP2P;
				const peerId = 'webrtc-e2e-peer';
				const packets = [];
				bg.iframe = transport;
				bg.sendDataP2P = function(data, UUID) {
					packets.push({ data, UUID });
					return true;
				};

				async function request(payload, callbackId) {
					const before = packets.length;
					const message = Object.assign({}, payload, { get: callbackId });
					bg.dispatchEvent(new bg.MessageEvent('message', {
						source: transport.contentWindow,
						data: {
							dataReceived: { overlayNinja: message },
							UUID: peerId
						}
					}));
					const started = Date.now();
					while (Date.now() - started < 15000) {
						const packet = packets.slice(before).find(entry =>
							entry && entry.data && entry.data.callback && entry.data.callback.get === callbackId
						);
						if (packet) return packet;
						await new Promise(resolve => setTimeout(resolve, 25));
					}
					return { timeout: true, callbackId, packets: packets.slice(before) };
				}

				try {
					const capabilities = await request({ action: 'getCapabilities' }, 'webrtc-capabilities');
					const existingSource = await request({
						action: 'getSource',
						target: 'ssapp',
						value: '${seed.sourceId}'
					}, 'webrtc-get-source');
					const added = await request({
						action: 'addSource',
						target: 'ssapp',
						value: {
							target: 'youtube',
							videoId: 'webrtc00001',
							connectionMode: 'websocket',
							autoActivate: false,
							idempotencyKey: 'webrtc-public-cold-start'
						}
					}, 'webrtc-add-public-source');
					const addedSourceId = added && added.data && added.data.callback && added.data.callback.result
						&& added.data.callback.result.payload && added.data.callback.result.payload.source
						? added.data.callback.result.payload.source.id
						: null;
					const started = addedSourceId ? await request({
						action: 'startSource',
						target: 'ssapp',
						value: { sourceId: addedSourceId }
					}, 'webrtc-start-public-source') : null;
					const stopped = addedSourceId ? await request({
						action: 'stopSource',
						target: 'ssapp',
						value: { sourceId: addedSourceId }
					}, 'webrtc-stop-public-source') : null;
					const removed = addedSourceId ? await request({
						action: 'removeSource',
						target: 'ssapp',
						value: { sourceId: addedSourceId }
					}, 'webrtc-remove-public-source') : null;
					const rejectedSettings = await request({
						action: 'getSettings',
						target: 'ssapp',
						value: {}
					}, 'webrtc-local-only-settings');
					return { ok: true, peerId, capabilities, existingSource, added, started, stopped, removed, rejectedSettings };
				} finally {
					bg.sendDataP2P = originalSendDataP2P;
					bg.iframe = originalIframe;
					transport.remove();
				}
			})()
		`, 'background WebRTC iframe route');
		assert.equal(iframeTransportBridge.ok, true, `WebRTC iframe route failed: ${JSON.stringify(iframeTransportBridge)}`);
		assert.equal(iframeTransportBridge.capabilities.UUID, iframeTransportBridge.peerId, 'WebRTC capability response reached the wrong peer');
		assert.equal(iframeTransportBridge.capabilities.data.callback.result.ssapp.available, true, 'WebRTC capabilities should advertise SSApp');
		assert.equal(iframeTransportBridge.capabilities.data.callback.result.ssapp.settings, false, 'WebRTC capabilities exposed local settings control');
		assert.equal(iframeTransportBridge.capabilities.data.callback.result.ssapp.appControls, false, 'WebRTC capabilities exposed local app lifecycle control');
		assert.equal(iframeTransportBridge.existingSource.data.callback.result.ok, true, `WebRTC getSource failed: ${JSON.stringify(iframeTransportBridge.existingSource)}`);
		assert.equal(iframeTransportBridge.existingSource.data.callback.result.payload.source.id, seed.sourceId, 'WebRTC getSource returned the wrong source');
		assert.equal(iframeTransportBridge.added.data.callback.result.ok, true, `WebRTC public cold-start add failed: ${JSON.stringify(iframeTransportBridge.added)}`);
		assert.equal(iframeTransportBridge.added.data.callback.result.payload.source.target, 'youtube', 'WebRTC added the wrong source type');
		assert.equal(iframeTransportBridge.started.data.callback.result.ok, true, `WebRTC public cold-start activation failed: ${JSON.stringify(iframeTransportBridge.started)}`);
		assert(['active', 'activating'].includes(iframeTransportBridge.started.data.callback.result.payload.source.status), `WebRTC source did not activate: ${JSON.stringify(iframeTransportBridge.started)}`);
		assert.equal(iframeTransportBridge.stopped.data.callback.result.ok, true, `WebRTC public-source stop failed: ${JSON.stringify(iframeTransportBridge.stopped)}`);
		assert.equal(iframeTransportBridge.stopped.data.callback.result.payload.source.status, 'inactive', 'WebRTC source did not stop cleanly');
		assert.equal(iframeTransportBridge.removed.data.callback.result.ok, true, `WebRTC public-source cleanup failed: ${JSON.stringify(iframeTransportBridge.removed)}`);
		assert.equal(iframeTransportBridge.rejectedSettings.data.callback.result.ok, false, 'WebRTC settings command should remain local-only');
		assert.equal(iframeTransportBridge.rejectedSettings.data.callback.result.error.code, 'UNSUPPORTED_ACTION', 'WebRTC settings rejection used the wrong error');

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
		assert.equal(Object.prototype.hasOwnProperty.call(socketCallback.callback.result.payload.source, 'url'), false, 'socket getSource exposed a source URL');
		assert.equal(JSON.stringify(socketCallback).includes('STREAMDECK_SECRET'), false, 'socket getSource leaked URL credentials');

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

		const activeSource = await execInRenderer(port, `window.SSAppStreamDeckBridge.handleCommand({ action: 'getSource', value: '${seed.sourceId}' })`, 'active source summary');
		assert.equal(activeSource.ok, true, `active source summary failed: ${JSON.stringify(activeSource)}`);
		assert.equal(activeSource.payload.source.tabId, activeState.vid, 'active source summary returned the wrong tab ID');
		assert.equal(Object.prototype.hasOwnProperty.call(activeSource.payload.source, 'url'), false, 'active source summary exposed a source URL');
		await execInRenderer(port, `
			(async () => {
				const bg = document.getElementById('frame2').contentWindow;
				const started = Date.now();
				while (Date.now() - started < 10000) {
					if (await bg.getSourceType(${activeState.vid}, 1000)) break;
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				bg.__streamDeckE2eTabMessages = [];
				if (!bg.__streamDeckE2eOriginalSendMessage) {
					bg.__streamDeckE2eOriginalSendMessage = bg.chrome.tabs.sendMessage;
					bg.chrome.tabs.sendMessage = function(tabId, message, callback) {
						bg.__streamDeckE2eTabMessages.push({ tabId, message });
						return bg.__streamDeckE2eOriginalSendMessage.call(this, tabId, message, callback);
					};
				}
				return true;
			})()
		`, 'targeted chat delivery probe');

		const targetedMessage = `streamdeck-targeted-${Date.now()}`;
		deckClient.socket.send(JSON.stringify({
			action: 'sendChat',
			target: 'youtube',
			tabId: activeState.vid,
			value: targetedMessage
		}));
		const targetedRoute = await execInRenderer(port, `
			(async () => {
				const bg = document.getElementById('frame2').contentWindow;
				const started = Date.now();
				while (Date.now() - started < 10000) {
					const deliveries = (bg.__streamDeckE2eTabMessages || []).filter(entry =>
						entry && entry.message && entry.message.message === '${targetedMessage}'
					);
					if (deliveries.length) {
						const matchingTabIds = deliveries.map(entry => String(entry.tabId));
						return { delivered: true, matchingTabIds };
					}
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				return { delivered: false, deliveries: bg.__streamDeckE2eTabMessages || [] };
			})()
		`, 'targeted Stream Deck chat route');
		assert.equal(targetedRoute.delivered, true, `targeted chat was not delivered: ${JSON.stringify(targetedRoute)}`);
		assert.deepEqual(targetedRoute.matchingTabIds, [String(activeState.vid)], `targeted chat reached the wrong source: ${JSON.stringify(targetedRoute)}`);

		const platformMessage = `platform-target-${Date.now()}`;
		deckClient.socket.send(JSON.stringify({
			action: 'sendChat',
			target: 'youtube',
			value: platformMessage
		}));
		const platformRoute = await execInRenderer(port, `
			(async () => {
				const bg = document.getElementById('frame2').contentWindow;
				const started = Date.now();
				while (Date.now() - started < 10000) {
					const delivered = (bg.__streamDeckE2eTabMessages || []).some(entry =>
						entry && entry.message && entry.message.message === '${platformMessage}'
					);
					if (delivered) {
						return { delivered: true };
					}
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				return { delivered: false };
			})()
		`, 'existing platform-target chat route');
		assert.equal(platformRoute.delivered, true, 'existing target-only chat routing regressed');

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
		assert.equal(socketStopCallback.callback.result.payload.source.activeConnectionMode, null, 'stopped source should not report an active connection mode');
		assert.equal(socketStopCallback.callback.result.payload.source.tabId, null, 'stopped source should not report a tab ID');

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
			onboarding: onboarding.ready,
			backgroundRoute: backgroundBridge.result.ok,
			iframeRoute: iframeTransportBridge.existingSource.data.callback.result.ok,
			iframeStartStop: iframeTransportBridge.started.data.callback.result.ok && iframeTransportBridge.stopped.data.callback.result.ok,
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
		for (const fixture of [trustedCustomJsServer, untrustedCustomJsServer]) {
			try {
				if (fixture.server.listening) {
					await new Promise(resolve => fixture.server.close(resolve));
				}
			} catch (_) { }
		}
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
