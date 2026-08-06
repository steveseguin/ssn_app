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
const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const socialStreamUrl = pathToFileURL(socialStreamRoot + path.sep).href;

function argumentValue(name) {
	const prefix = `--${name}=`;
	const inline = process.argv.find(value => value.startsWith(prefix));
	if (inline) return inline.slice(prefix.length);
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : '';
}

function hasArgument(name) {
	return process.argv.includes(`--${name}`);
}

function positiveInteger(value, fallback) {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function waitForSignalOrTimeout(timeoutMs) {
	return new Promise(resolve => {
		const finish = () => {
			clearTimeout(timer);
			process.removeListener('SIGINT', finish);
			process.removeListener('SIGTERM', finish);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		process.once('SIGINT', finish);
		process.once('SIGTERM', finish);
	});
}

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

function openSocket(port) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}`);
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error(`Timed out connecting to local relay port ${port}.`));
		}, 30000);
		socket.once('open', () => {
			clearTimeout(timer);
			resolve(socket);
		});
		socket.once('error', error => {
			clearTimeout(timer);
			reject(error);
		});
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
	const youtubeVideo = String(argumentValue('youtube-video') || '').trim();
	const twitchChannel = String(argumentValue('twitch-channel') || '').trim().replace(/^[@#]/, '').toLowerCase();
	if (!youtubeVideo && !twitchChannel) {
		throw new Error('Provide --youtube-video VIDEO_ID and/or --twitch-channel CHANNEL.');
	}
	const room = String(argumentValue('room') || `live_chat_e2e_${Date.now()}`).trim();
	const publisherOnly = hasArgument('publisher-only');
	const timeoutSeconds = positiveInteger(argumentValue('timeout-seconds'), 180);
	const lingerSeconds = positiveInteger(argumentValue('linger-seconds'), 0);
	const controlPort = positiveInteger(argumentValue('control-port'), await getFreePort());
	const localRelayPort = positiveInteger(argumentValue('local-port'), await getFreePort());
	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-live-chat-profile-'));
	const token = `live-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;

	fs.writeFileSync(path.join(profileDir, 'savedSync.json'), JSON.stringify({
		streamID: room,
		password: 'false',
		state: true,
		settings: publisherOnly ? {} : { server2: { setting: true } },
		wsServer: !publisherOnly,
	}));

	const args = [
		'.', '--running-from-source', '--multiinstance', '--filesource', socialStreamUrl,
		'--ssapp-headless-control', '--ssapp-control-api', '--remote-control',
		`--ssapp-control-port=${controlPort}`,
		`--ssapp-local-server-port=${localRelayPort}`,
		'--no-hwa',
	];
	if (process.platform === 'linux') args.push('--no-sandbox', '--ozone-platform=x11');
	const child = spawn(electronPath, args, {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDir,
			SSAPP_CONTROL_PORT: String(controlPort),
			SSAPP_REMOTE_CONTROL_TOKEN: token,
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
			SSAPP_DEBUG_LOGS: '1',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let output = '';
	child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-50000); });
	child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-50000); });

	let listener;
	const captures = [];
	try {
		await waitFor(async () => {
			if (child.exitCode !== null) throw new Error(`SSApp exited with code ${child.exitCode}`);
			const ping = await requestJson(controlPort, token, '/ping');
			return ping && ping.ok;
		}, 'SSApp remote control', 60000);

		const windows = await requestJson(controlPort, token, '/windows');
		const mainWindow = (windows.windows || []).find(item => String(item.url || '').includes('index.html'));
		assert.ok(mainWindow && mainWindow.id, `Main window not found: ${JSON.stringify(windows)}`);
		await waitFor(async () => {
			const response = await requestJson(controlPort, token, '/exec', {
				windowId: mainWindow.id,
				code: 'Boolean(window.stateManager && stateManager.initialized && typeof configReady !== "undefined" && configReady && typeof createWindow === "function" && typeof newSourceVideoID === "function" && typeof newOtherSource === "function")',
			});
			return response.ok && response.result;
		}, 'SSApp renderer initialization', 60000);

		if (!publisherOnly) {
			listener = await openSocket(localRelayPort);
			listener.send(JSON.stringify({ join: room, out: 3, in: 4 }));
			listener.on('message', raw => {
				try {
					const message = JSON.parse(raw.toString());
					if (!message || !message.chatmessage || !message.type) return;
					captures.push(message);
					console.log(`[live-chat] ${message.type} | ${message.chatname || 'Anonymous'}: ${String(message.chatmessage).replace(/<[^>]+>/g, ' ').slice(0, 180)}`);
				} catch (_) { }
			});
		}

		const launchResult = await requestJson(controlPort, token, '/exec', {
			windowId: mainWindow.id,
			code: `(async () => {
				const launched = {};
				if (${JSON.stringify(Boolean(youtubeVideo))}) {
					await newSourceVideoID('youtube', ${JSON.stringify(youtubeVideo)}, false, {
						connectionMode: 'classic', autoActivate: false, isVisible: false, isMuted: true
					});
					const source = stateManager.getSources().find(item => item.target === 'youtube' && item.videoId === ${JSON.stringify(youtubeVideo)});
					if (!source) throw new Error('YouTube source was not created');
					const entry = document.querySelector('[data-source-id="' + source.id + '"]');
					const activate = entry && entry.querySelector('[data-activatehtml]');
					if (!activate) throw new Error('YouTube activation control was not found');
					launched.youtube = { sourceId: source.id, tabId: await createWindow(activate) };
				}
				if (${JSON.stringify(Boolean(twitchChannel))}) {
					const element = await newOtherSource('twitch', ${JSON.stringify(`https://www.twitch.tv/popout/${twitchChannel}/chat?popout=`)}, false, {
						username: ${JSON.stringify(twitchChannel)}, connectionMode: 'classic',
						autoActivate: false, isVisible: false, isMuted: true
					});
					const sourceId = element && element.dataset ? element.dataset.sourceId : null;
					const source = sourceId ? stateManager.getSource(sourceId) : stateManager.getSources().find(item => item.target === 'twitch');
					if (!source) throw new Error('Twitch source was not created');
					const entry = document.querySelector('[data-source-id="' + source.id + '"]');
					const activate = entry && entry.querySelector('[data-activatehtml]');
					if (!activate) throw new Error('Twitch activation control was not found');
					launched.twitch = { sourceId: source.id, tabId: await createWindow(activate) };
				}
				return launched;
			})()`,
		});
		assert.strictEqual(launchResult.ok, true, launchResult.error || JSON.stringify(launchResult));
		if (youtubeVideo) assert.ok(launchResult.result?.youtube?.tabId, `YouTube source did not activate: ${JSON.stringify(launchResult.result)}`);
		if (twitchChannel) assert.ok(launchResult.result?.twitch?.tabId, `Twitch source did not activate: ${JSON.stringify(launchResult.result)}`);
		console.log(`[live-chat] launched ${JSON.stringify(launchResult.result)} in room ${room}${publisherOnly ? ' using P2P output' : ` on local relay ${localRelayPort}`}`);
		if (publisherOnly) {
			console.log(`[live-chat] PUBLISHER_READY ${JSON.stringify({ room, platforms: [youtubeVideo && 'youtube', twitchChannel && 'twitch'].filter(Boolean) })}`);
			await waitForSignalOrTimeout(timeoutSeconds * 1000);
			console.log(`[live-chat] PASS ${JSON.stringify({ room, publisherOnly: true, durationSeconds: timeoutSeconds })}`);
			return { room, publisherOnly: true };
		}

		const requestedPlatforms = [youtubeVideo && 'youtube', twitchChannel && 'twitch'].filter(Boolean);
		await waitFor(() => requestedPlatforms.every(platform => captures.some(message => message.type === platform)),
			`live messages from ${requestedPlatforms.join(' and ')}`, timeoutSeconds * 1000, 500);

		const summary = {};
		for (const platform of requestedPlatforms) {
			summary[platform] = captures.filter(message => message.type === platform).length;
		}
		console.log(`[live-chat] PASS ${JSON.stringify({ room, localRelayPort, summary })}`);
		if (lingerSeconds) {
			console.log(`[live-chat] LINGER_READY ${JSON.stringify({ room, lingerSeconds })}`);
			await waitForSignalOrTimeout(lingerSeconds * 1000);
		}
		return { room, localRelayPort, summary };
	} catch (error) {
		let diagnostics = null;
		try {
			const views = await requestJson(controlPort, token, '/views');
			diagnostics = views.views || [];
		} catch (_) { }
		throw new Error(`${error.message}\nViews: ${JSON.stringify(diagnostics)}\nElectron output:\n${output.slice(-12000)}`);
	} finally {
		if (listener) listener.close();
		await stopApp(child);
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

run().catch(error => {
	console.error(`[live-chat] FAIL ${error.stack || error.message}`);
	process.exitCode = 1;
});
