#!/usr/bin/env node

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

const electronPath = require('electron');
const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const socialStreamUrl = pathToFileURL(socialStreamRoot + path.sep).href;
const eventFlowEditorUrl = `${pathToFileURL(path.join(socialStreamRoot, 'actions', 'index.html')).href}?ssapp`;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-local-media-e2e-profile-'));
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-local-media-e2e-fixtures-'));
const imagePath = path.join(fixtureDir, 'local-image.svg');
const audioPath = path.join(fixtureDir, 'local-audio.wav');
const remoteToken = `local-media-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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

function requestJson(port, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : null;
		const req = http.request({
			host: '127.0.0.1',
			port,
			path: `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(remoteToken)}`,
			method: payload ? 'POST' : 'GET',
			headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
		}, (res) => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { text += chunk; });
			res.on('end', () => {
				try {
					const parsed = text ? JSON.parse(text) : {};
					if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
					else reject(new Error(`HTTP ${res.statusCode}: ${text}`));
				} catch (error) {
					reject(error);
				}
			});
		});
		req.on('error', reject);
		if (payload) req.write(payload);
		req.end();
	});
}

async function waitForRemoteControl(port, timeoutMs = 60000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const result = await requestJson(port, '/ping');
			if (result && result.ok) return;
		} catch (_) { }
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error('Timed out waiting for SSApp remote control.');
}

async function execInWindow(port, windowId, code) {
	const result = await requestJson(port, '/exec', { windowId, code });
	if (!result || result.ok !== true) throw new Error(result && result.error ? result.error : 'Renderer execution failed.');
	return result.result;
}

async function waitForWindow(port, predicate, timeoutMs = 20000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const result = await requestJson(port, '/windows');
		const match = (result.windows || []).find(predicate);
		if (match) return match;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error('Timed out waiting for the Local Flow Actions window.');
}

async function startApp(remotePort) {
	const child = spawn(electronPath, [
		'.', '--running-from-source', '--multiinstance', '--filesource', socialStreamUrl, '--remote-control',
		...linuxLaunchArgs(),
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDir,
			SSAPP_REMOTE_CONTROL: '1',
			SSAPP_REMOTE_CONTROL_PORT: String(remotePort),
			SSAPP_REMOTE_CONTROL_TOKEN: remoteToken,
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
			SSAPP_DEBUG_LOGS: '0',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let output = '';
	child.stdout.on('data', (chunk) => { output += chunk.toString(); });
	child.stderr.on('data', (chunk) => { output += chunk.toString(); });
	try {
		await waitForRemoteControl(remotePort);
		return { child, getOutput: () => output };
	} catch (error) {
		child.kill();
		throw new Error(`${error.message}\n${output.slice(-5000)}`);
	}
}

async function stopApp(child) {
	if (!child || child.exitCode !== null) return;
	child.kill();
	await Promise.race([
		new Promise((resolve) => child.once('exit', resolve)),
		new Promise((resolve) => setTimeout(resolve, 5000)),
	]);
}

async function runInstance(mediaPort, verifyPlayback) {
	const remotePort = await getFreePort();
	const app = await startApp(remotePort);
	try {
		const windows = await requestJson(remotePort, '/windows');
		const mainWindow = (windows.windows || []).find((item) => String(item.url || '').includes('index.html')) || windows.windows[0];
		assert.ok(mainWindow && mainWindow.id, `Main SSApp window was not found: ${JSON.stringify(windows)}`);
		const bridge = await execInWindow(remotePort, mainWindow.id, `
			(async () => {
				const started = Date.now();
				while (!(window.ninjafy && window.ninjafy.localMedia)) {
					if (Date.now() - started > 30000) return { ready: false };
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				const status = await window.ninjafy.localMedia.status();
				const audio = await window.ninjafy.localMedia.get('asset_audio_e2e');
				const flow = await window.ninjafy.localMedia.getFlowActionsUrl({
					sessionId: 'local-media-e2e',
					search: '?session=local-media-e2e&volume=0.75'
				});
				return { ready: true, status, audio, flow, hasEditor: typeof EventFlowEditor !== 'undefined' };
			})()
		`);
		assert.strictEqual(bridge.ready, true, 'Local media preload bridge did not become available.');
		assert.strictEqual(bridge.status.running, true, JSON.stringify(bridge.status));
		assert.strictEqual(bridge.status.port, mediaPort);
		assert.strictEqual(bridge.status.assetCount, verifyPlayback ? 1 : 2);
		assert.strictEqual(bridge.audio.status, 'available');
		const controlStatus = await requestJson(remotePort, '/api/v1/status');
		assert.strictEqual(controlStatus.app.headless, false);

		if (!verifyPlayback) return;
		await execInWindow(remotePort, mainWindow.id, `window.open(${JSON.stringify(eventFlowEditorUrl)}, '_blank'); true`);
		const editorWindow = await waitForWindow(remotePort, (item) => String(item.url || '') === eventFlowEditorUrl, 30000);
		await requestJson(remotePort, '/queue-file-selection', { filePath: imagePath });
		const editorUi = await execInWindow(remotePort, editorWindow.id, `
			(async () => {
				const started = Date.now();
				while (!window.flowEditor || !(window.ninjafy && window.ninjafy.localMedia)) {
					if (Date.now() - started > 30000) return { ready: false };
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				const node = {
					id: 'local-ui-node', type: 'action', actionType: 'playTenorGiphy',
					config: { sourceType: 'url', mediaUrl: '', mediaType: 'image', duration: 10000 }
				};
				window.flowEditor.currentFlow = { id: 'local-ui-flow', name: 'Local UI Test', nodes: [node], connections: [] };
				window.flowEditor.showNodeProperties(node);
				document.getElementById('chooseLocalMediaBtn')?.click();
				for (let i = 0; i < 100; i += 1) {
					const status = document.getElementById('localMediaStatus');
					if (node.config.localAssetId && status && !status.textContent.includes('Checking')) break;
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				return {
					ready: true,
					assetId: node.config.localAssetId || '',
					sourceType: node.config.sourceType,
					mediaType: node.config.localMediaType,
					text: document.getElementById('node-properties-content')?.textContent || '',
					status: document.getElementById('localMediaStatus')?.textContent || '',
					hasRelink: !!document.getElementById('chooseLocalMediaBtn'),
					hasPreview: !!document.getElementById('previewLocalMediaBtn'),
					hasReveal: !!document.getElementById('revealLocalMediaBtn'),
					hasCopyUrl: !!document.getElementById('copyLocalFlowActionsUrlBtn')
				};
			})()
		`);
		assert.strictEqual(editorUi.ready, true, 'Event Flow editor did not become ready in SSApp.');
		assert.match(editorUi.assetId, /^asset_[a-f0-9]{32}$/);
		assert.strictEqual(editorUi.sourceType, 'local');
		assert.strictEqual(editorUi.mediaType, 'image');
		assert.strictEqual(editorUi.hasRelink, true);
		assert.strictEqual(editorUi.hasPreview, true);
		assert.strictEqual(editorUi.hasReveal, true);
		assert.strictEqual(editorUi.hasCopyUrl, true);
		assert.match(editorUi.status, /Available.*port/i);
		assert.strictEqual(editorUi.text.includes(imagePath), false, 'Event Flow UI exposed a private disk path.');
		const selectedAsset = await execInWindow(remotePort, editorWindow.id, `window.ninjafy.localMedia.get(${JSON.stringify(editorUi.assetId)})`);
		assert.strictEqual(selectedAsset.status, 'available');
		assert.strictEqual(Object.prototype.hasOwnProperty.call(selectedAsset, 'approvedPath'), false);

		await execInWindow(remotePort, mainWindow.id, `window.open(${JSON.stringify(bridge.flow.url)}, '_blank'); true`);
		const actionsWindow = await waitForWindow(remotePort, (item) => String(item.url || '').startsWith(bridge.flow.url));
		const playback = await execInWindow(remotePort, actionsWindow.id, `
			(async () => {
				const started = Date.now();
				while (typeof processInput !== 'function' || typeof TTS === 'undefined') {
					if (Date.now() - started > 30000) return { ready: false };
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				processInput({
					actionType: 'play_media', sourceType: 'local', localAssetId: ${JSON.stringify(editorUi.assetId)},
					localAssetName: 'E2E Image', mediaType: 'image', duration: 15000
				});
				let image = null;
				for (let i = 0; i < 100; i += 1) {
					image = document.querySelector('.fullscreen-media-container img');
					if (image && image.complete && image.naturalWidth > 0) break;
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				const audioUrl = resolveLocalMediaUrl('asset_audio_e2e');
				const NativeAudio = window.Audio;
				window.__ssappE2eAudio = null;
				window.Audio = function (...args) {
					const audio = new NativeAudio(...args);
					window.__ssappE2eAudio = audio;
					return audio;
				};
				window.Audio.prototype = NativeAudio.prototype;
				processInput({
					actionType: 'play_audio', sourceType: 'local', localAssetId: 'asset_audio_e2e',
					localAssetName: 'E2E Audio', volume: 0.1
				});
				for (let i = 0; i < 100; i += 1) {
					if (window.__ssappE2eAudio && !window.__ssappE2eAudio.paused && window.__ssappE2eAudio.currentTime > 0) break;
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				const playedAudio = window.__ssappE2eAudio;
				return {
					ready: true,
					imageSrc: image && image.src,
					imageWidth: image && image.naturalWidth,
					audioUrl,
					audioRequests: performance.getEntriesByName(audioUrl).length,
					audioPlaying: !!playedAudio && !playedAudio.paused,
					audioCurrentTime: playedAudio ? playedAudio.currentTime : 0,
					audioReadyState: playedAudio ? playedAudio.readyState : 0,
					hasTts: typeof TTS !== 'undefined',
					referrerPolicy: document.querySelector('meta[name="referrer"]')?.content || ''
				};
			})()
		`);
		assert.strictEqual(playback.ready, true, 'Local actions.html did not become ready.');
		assert.ok(playback.imageSrc.includes('/media/' + editorUi.assetId), playback.imageSrc);
		assert.ok(playback.imageWidth > 0, `Local image did not decode: ${JSON.stringify(playback)}`);
		assert.ok(playback.audioRequests > 0, `Local audio was not requested: ${JSON.stringify(playback)}`);
		assert.strictEqual(playback.audioPlaying, true, `Local audio play() did not enter playback: ${JSON.stringify(playback)}`);
		assert.ok(playback.audioCurrentTime > 0, `Local audio playback did not advance: ${JSON.stringify(playback)}`);
		assert.strictEqual(playback.hasTts, true, 'Relative actions.html dependency did not load.');
		assert.strictEqual(playback.referrerPolicy, 'no-referrer');
	} catch (error) {
		throw new Error(`${error.message}\n${app.getOutput().slice(-5000)}`);
	} finally {
		await stopApp(app.child);
	}
}

async function run() {
	const mediaPort = await getFreePort();
	fs.writeFileSync(imagePath, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#4caf50"/></svg>');
	fs.copyFileSync(path.join(repoRoot, 'tests', 'electron', 'fixtures', 'cohost-stt.wav'), audioPath);
	fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify({
		localMediaLibrary: {
			token: 'b'.repeat(64),
			port: mediaPort,
			assets: {
				asset_audio_e2e: {
					id: 'asset_audio_e2e', displayName: 'E2E Audio', fileName: path.basename(audioPath),
					mediaType: 'audio', mimeType: 'audio/wav', approvedPath: audioPath,
					size: fs.statSync(audioPath).size, modifiedAt: fs.statSync(audioPath).mtimeMs,
				},
			},
		},
	}, null, 2));

	try {
		await runInstance(mediaPort, true);
		await runInstance(mediaPort, false);
		console.log('Local media Electron end-to-end checks passed, including restart persistence.');
	} finally {
		fs.rmSync(profileDir, { recursive: true, force: true });
		fs.rmSync(fixtureDir, { recursive: true, force: true });
	}
}

run().catch((error) => {
	console.error(error);
	process.exit(1);
});
