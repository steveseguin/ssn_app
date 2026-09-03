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

const electronPath = require('electron');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const socialStreamUrl = pathToFileURL(socialStreamRoot + path.sep).href;

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

function requestJson(port, token, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : JSON.stringify(body);
		const request = http.request({
			host: '127.0.0.1',
			port,
			path: `${pathname}?token=${encodeURIComponent(token)}`,
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
				try {
					const data = text ? JSON.parse(text) : {};
					if (response.statusCode >= 200 && response.statusCode < 300) resolve(data);
					else reject(new Error(`HTTP ${response.statusCode}: ${text}`));
				} catch (error) {
					reject(error);
				}
			});
		});
		request.once('error', reject);
		if (payload !== null) request.write(payload);
		request.end();
	});
}

async function waitFor(check, label, timeoutMs, intervalMs = 250) {
	const started = Date.now();
	let lastError = null;
	while (Date.now() - started < timeoutMs) {
		try {
			const result = await check();
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		await new Promise(resolve => setTimeout(resolve, intervalMs));
	}
	throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
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
	const controlPort = await getFreePort();
	const localRelayPort = await getFreePort();
	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-reflection-profile-'));
	const token = `reflection-${Date.now()}-${Math.random().toString(36).slice(2)}`;

	fs.writeFileSync(path.join(profileDir, 'savedSync.json'), JSON.stringify({
		streamID: `reflection_e2e_${Date.now()}`,
		password: 'false',
		state: true,
		settings: {},
		wsServer: false,
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
	child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-30000); });
	child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-30000); });

	try {
		await waitFor(async () => {
			if (child.exitCode !== null) throw new Error(`SSApp exited with code ${child.exitCode}`);
			const ping = await requestJson(controlPort, token, '/ping');
			return ping && ping.ok;
		}, 'SSApp remote control', 60000);

		const mainWindow = await waitFor(async () => {
			const windows = await requestJson(controlPort, token, '/windows');
			return (windows.windows || []).find(item => String(item.url || '').includes('index.html')) || false;
		}, 'main window navigation', 60000);

		await waitFor(async () => {
			const response = await requestJson(controlPort, token, '/exec', {
				windowId: mainWindow.id,
				code: `(() => {
					const frame = document.getElementById('frame2');
					if (!frame || !frame.contentWindow) return false;
					try {
						return frame.contentWindow.eval('typeof normalizeMessageForTracking === "function" && typeof checkExactDuplicateAlreadyReceived === "function"');
					} catch (_) {
						return false;
					}
				})()`,
			});
			return response.ok && response.result;
		}, 'Social Stream background frame', 60000);

		const response = await requestJson(controlPort, token, '/exec', {
			windowId: mainWindow.id,
			code: `(() => {
				const frame = document.getElementById('frame2');
				return frame.contentWindow.eval(\`(() => {
					const firstTab = 990001;
					const secondTab = 990002;
					const priorSettings = settings;
					const priorLastSentTimestamp = lastSentTimestamp;
					const priorAlreadyCaptured = alreadyCaptured;
					const now = Date.now();
					const diamond = String.fromCodePoint(0x1f48e);
					const results = {};
					try {
						results.namedEmote = normalizeMessageForTracking('<img alt="erallieLuv" src="emote.png">', false);
						results.namedEmoteTextOnly = normalizeMessageForTracking('<img alt="erallieLuv" src="emote.png">', true);
						results.diamond = normalizeMessageForTracking('donated 1 <img alt="' + diamond + '" src="diamond.png">&nbsp;. Thank you', false);
						results.unicode = normalizeMessageForTracking('Cafe\\u0301 ❤️ 👩‍👩‍👧‍👦', false);
						results.unknownImage = normalizeMessageForTracking('hello<img src="unknown.png">', false);

						settings = { firstsourceonly: true };
						lastSentTimestamp = now;
						alreadyCaptured = [];
						messageStore[firstTab] = [{ message: 'erallieLuv', timestamp: now, relayMode: true, origin: 'relay' }];
						messageStore[secondTab] = [{ message: 'erallieLuv', timestamp: now, relayMode: true, origin: 'relay' }];
						results.emoteFirst = checkExactDuplicateAlreadyReceived('<img alt="erallieLuv" src="emote.png">', false, firstTab, 'twitch');
						results.emoteSecond = checkExactDuplicateAlreadyReceived('erallieLuv', false, secondTab, 'youtube');

						settings = { firstsourceonly: true };
						lastSentTimestamp = now;
						alreadyCaptured = [];
						const donation = 'donated 1 ' + diamond + '. Thank you';
						messageStore[firstTab] = [{ message: donation, timestamp: now, relayMode: true, origin: 'relay' }];
						messageStore[secondTab] = [{ message: donation, timestamp: now, relayMode: true, origin: 'relay' }];
						results.diamondFirst = checkExactDuplicateAlreadyReceived('donated 1 <img alt="' + diamond + '" src="diamond.png"> . Thank you', false, firstTab, 'twitch');
						results.diamondSecond = checkExactDuplicateAlreadyReceived(donation, false, secondTab, 'youtube');
						return results;
					} finally {
						delete messageStore[firstTab];
						delete messageStore[secondTab];
						settings = priorSettings;
						lastSentTimestamp = priorLastSentTimestamp;
						alreadyCaptured = priorAlreadyCaptured;
					}
				})()\`);
			})()`,
		});

		assert.strictEqual(response.ok, true, response.error || JSON.stringify(response));
		assert.deepStrictEqual(response.result, {
			namedEmote: 'erallieLuv',
			namedEmoteTextOnly: 'erallieLuv',
			diamond: 'donated 1 💎. Thank you',
			unicode: 'Café ❤ 👩‍👩‍👧‍👦',
			unknownImage: `hello${String.fromCharCode(0xe002)}`,
			emoteFirst: null,
			emoteSecond: true,
			diamondFirst: null,
			diamondSecond: true,
		});

		console.log('[reflection-filter] PASS: actual SSApp background frame normalized rich emotes and suppressed later reflections.');
	} catch (error) {
		console.error('[reflection-filter] FAIL:', error.stack || error.message || error);
		if (output.trim()) console.error(output);
		throw error;
	} finally {
		await stopApp(child);
		try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) { }
	}
}

run().catch(() => {
	process.exitCode = 1;
});
