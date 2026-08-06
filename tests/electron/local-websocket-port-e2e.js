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
const WebSocket = require('ws');

const electronPath = require('electron');
const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const socialStreamUrl = pathToFileURL(socialStreamRoot + path.sep).href;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-local-ws-e2e-'));
const controlToken = `local-ws-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const lanMode = process.argv.includes('--lan');
const packagedMode = process.argv.includes('--packaged');
const packagedAppPath = path.join(repoRoot, 'dist', 'linux-unpacked', 'socialstreamninja');

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
		const request = http.request({
			host: '127.0.0.1',
			port,
			path: `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(controlToken)}`,
			method: payload ? 'POST' : 'GET',
			headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
		}, response => {
			let text = '';
			response.setEncoding('utf8');
			response.on('data', chunk => { text += chunk; });
			response.on('end', () => {
				try {
					const parsed = text ? JSON.parse(text) : {};
					if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
					else reject(new Error(`HTTP ${response.statusCode}: ${text}`));
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

async function waitForControlApi(port, child, timeoutMs = 60000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (child.exitCode !== null || child.signalCode) {
			throw new Error(`SSApp exited early (${child.exitCode !== null ? `code ${child.exitCode}` : `signal ${child.signalCode}`}).`);
		}
		try {
			const response = await requestJson(port, '/api/v1/status');
			if (response && response.ok) return;
		} catch (_) { }
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('Timed out waiting for the SSApp control API.');
}

function openSocketAt(host, port) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://${host}:${port}`);
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error(`Timed out connecting to local WebSocket port ${port}.`));
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

function openSocket(port) {
	return openSocketAt('127.0.0.1', port);
}

function getLanAddress() {
	for (const addresses of Object.values(os.networkInterfaces())) {
		for (const address of addresses || []) {
			if (address.family === 'IPv4' && !address.internal) return address.address;
		}
	}
	return null;
}

function assertSocketRejected(host, port) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://${host}:${port}`);
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error(`Timed out checking loopback-only binding through ${host}:${port}.`));
		}, 5000);
		socket.once('open', () => {
			clearTimeout(timer);
			socket.close();
			reject(new Error(`Loopback-only relay was reachable through LAN address ${host}:${port}.`));
		});
		socket.once('error', () => {
			clearTimeout(timer);
			resolve();
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
	if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
	if (child.exitCode === null) {
		try { child.kill('SIGKILL'); } catch (_) { }
	}
}

(async () => {
	const controlPort = await getFreePort();
	const localWebSocketPort = await getFreePort();
	fs.writeFileSync(path.join(profileDir, 'savedSync.json'), JSON.stringify({
		streamID: 'local_ws_e2e',
		password: 'false',
		state: true,
		settings: {},
		wsServer: true,
	}));

	if (packagedMode) {
		assert.strictEqual(fs.existsSync(packagedAppPath), true, `Build the Linux app first: ${packagedAppPath}`);
	}
	const commonArgs = [
		'--ssapp-headless-control', '--ssapp-control-api', '--remote-control', `--ssapp-control-port=${controlPort}`,
		`--ssapp-local-server-port=${localWebSocketPort}`, '--no-hwa', ...linuxLaunchArgs(),
		...(lanMode ? ['--ssapp-local-server-host=lan'] : []),
	];
	const child = spawn(packagedMode ? packagedAppPath : electronPath, packagedMode
		? ['--multiinstance', '--preferlocalassets', ...commonArgs]
		: ['.', '--running-from-source', '--multiinstance', '--filesource', socialStreamUrl, ...commonArgs], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDir,
			SSAPP_CONTROL_PORT: String(controlPort),
			SSAPP_REMOTE_CONTROL_TOKEN: controlToken,
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
			SSAPP_DEBUG_LOGS: '0',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let output = '';
	child.stdout.on('data', chunk => { output += chunk.toString(); });
	child.stderr.on('data', chunk => { output += chunk.toString(); });

	let sender;
	let receiver;
	let foreignRoomReceiver;
	let lanSocket;
	try {
		await waitForControlApi(controlPort, child);
		[sender, receiver, foreignRoomReceiver] = await Promise.all([
			openSocket(localWebSocketPort),
			openSocket(localWebSocketPort),
			openSocket(localWebSocketPort),
		]);
		sender.send(JSON.stringify({ join: 'local-ws-e2e', out: 1, in: 2 }));
		receiver.send(JSON.stringify({ join: 'local-ws-e2e', out: 2, in: 1 }));
		foreignRoomReceiver.send(JSON.stringify({ join: 'different-local-ws-room', out: 2, in: 1 }));
		await new Promise(resolve => setTimeout(resolve, 100));

		const received = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Timed out waiting for relayed message.')), 5000);
			receiver.once('message', data => {
				clearTimeout(timer);
				resolve(JSON.parse(data.toString()));
			});
		});
		let leakedAcrossRooms = false;
		foreignRoomReceiver.once('message', () => {
			leakedAcrossRooms = true;
		});
		sender.send(JSON.stringify({ test: 'custom-port', value: localWebSocketPort }));
		assert.deepStrictEqual(await received, { test: 'custom-port', value: localWebSocketPort });
		await new Promise(resolve => setTimeout(resolve, 250));
		assert.strictEqual(leakedAcrossRooms, false, 'Local WebSocket traffic leaked into a different room.');

		const windows = await requestJson(controlPort, '/windows');
		const mainWindow = (windows.windows || []).find(item => String(item.url || '').includes('index.html'));
		assert.ok(mainWindow && mainWindow.id, `Main window missing: ${JSON.stringify(windows)}`);
		let result;
		const frameDeadline = Date.now() + 20000;
		do {
			result = await requestJson(controlPort, '/exec', {
				windowId: mainWindow.id,
				code: `(async () => {
					const environment = await window.ssappEnvironment.get();
					const frame = document.getElementById('frame1');
					return { environment, frameUrl: frame ? frame.src : '' };
				})()`,
			});
			if (result.ok && /[?&]localserver(?:[=&]|$)/.test(result.result.frameUrl)) break;
			await new Promise(resolve => setTimeout(resolve, 250));
		} while (Date.now() < frameDeadline);
		assert.strictEqual(result.ok, true, result.error || JSON.stringify(result));
		assert.strictEqual(result.result.environment.localWebSocketPort, localWebSocketPort);
		assert.strictEqual(result.result.environment.localWebSocketHost, lanMode ? '0.0.0.0' : '127.0.0.1');
		assert.strictEqual(result.result.environment.localWebSocketLanAccess, lanMode);
		const frameUrl = new URL(result.result.frameUrl);
		assert.strictEqual(frameUrl.searchParams.has('localserver'), true, result.result.frameUrl);
		assert.strictEqual(frameUrl.searchParams.get('localserverport'), String(localWebSocketPort));
		const lanAddress = getLanAddress();
		if (lanAddress && lanMode) {
			lanSocket = await openSocketAt(lanAddress, localWebSocketPort);
		} else if (lanAddress) {
			await assertSocketRejected(lanAddress, localWebSocketPort);
		}

		console.log(`Local WebSocket ${packagedMode ? 'packaged ' : ''}${lanMode ? 'explicit LAN' : 'loopback-only'} E2E passed on port ${localWebSocketPort}.`);
	} catch (error) {
		throw new Error(`${error.message}\n${output.slice(-6000)}`);
	} finally {
		if (sender) sender.close();
		if (receiver) receiver.close();
		if (foreignRoomReceiver) foreignRoomReceiver.close();
		if (lanSocket) lanSocket.close();
		await stopApp(child);
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
})().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
