#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const builtPortablePath = path.join(repoRoot, 'dist', 'socialstreamninja-portable.exe');
const builtInstalledPath = path.join(repoRoot, 'dist', 'win-unpacked', 'socialstream.exe');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-portable-build-e2e-'));
const originalBundleDir = path.join(testRoot, 'original-bundle');
const movedBundleDir = path.join(testRoot, 'moved-bundle');
const fakeRoamingDir = path.join(testRoot, 'fake-appdata', 'Roaming');
const fakeLocalDir = path.join(testRoot, 'fake-appdata', 'Local');
const extractionTempDir = path.join(testRoot, 'extraction-temp');
const legacyProfileDir = path.join(fakeRoamingDir, 'SocialStream');
const installedProfileDir = path.join(fakeRoamingDir, 'installed-profile');
const executableName = 'socialstreamninja-portable.exe';
const marker = `portable-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const token = `portable-token-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const legacyMarker = `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let runningChild = null;

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
			path: `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
			method: payload ? 'POST' : 'GET',
			headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
		}, (response) => {
			let responseText = '';
			response.setEncoding('utf8');
			response.on('data', (chunk) => { responseText += chunk; });
			response.on('end', () => {
				try {
					const data = responseText ? JSON.parse(responseText) : {};
					if (response.statusCode >= 200 && response.statusCode < 300) resolve(data);
					else reject(new Error(`HTTP ${response.statusCode}: ${responseText}`));
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

async function waitForControl(port, child, getOutput, timeoutMs = 90000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (child.exitCode !== null) throw new Error(`Portable app exited early (${child.exitCode}).\n${getOutput().slice(-8000)}`);
		try {
			const result = await requestJson(port, '/ping');
			if (result && result.ok) return;
		} catch (_) { }
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(`Timed out waiting for portable SSApp.\n${getOutput().slice(-8000)}`);
}

async function launchPortable(bundleDir) {
	const port = await getFreePort();
	const executablePath = path.join(bundleDir, executableName);
	const child = spawn(executablePath, [
		'--multiinstance',
		'--preferlocalassets',
		'--remote-control',
	], {
		cwd: bundleDir,
		env: {
			...process.env,
			APPDATA: fakeRoamingDir,
			LOCALAPPDATA: fakeLocalDir,
			TEMP: extractionTempDir,
			TMP: extractionTempDir,
			SSAPP_REMOTE_CONTROL: '1',
			SSAPP_REMOTE_CONTROL_PORT: String(port),
			SSAPP_REMOTE_CONTROL_TOKEN: token,
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
			SSAPP_DEBUG_LOGS: '1',
			SSAPP_PORTABLE_MIGRATION_CHOICE: 'copy',
			SSAPP_PORTABLE_LEGACY_USER_DATA_DIR: legacyProfileDir,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	runningChild = child;
	let output = '';
	child.stdout.on('data', (chunk) => { output += chunk.toString(); });
	child.stderr.on('data', (chunk) => { output += chunk.toString(); });
	await waitForControl(port, child, () => output);
	return { port, child, getOutput: () => output };
}

async function launchInstalled() {
	const port = await getFreePort();
	const child = spawn(builtInstalledPath, ['--multiinstance', '--preferlocalassets', '--remote-control'], {
		cwd: path.dirname(builtInstalledPath),
		env: {
			...process.env,
			APPDATA: fakeRoamingDir,
			LOCALAPPDATA: fakeLocalDir,
			TEMP: extractionTempDir,
			TMP: extractionTempDir,
			SSAPP_REMOTE_CONTROL: '1',
			SSAPP_REMOTE_CONTROL_PORT: String(port),
			SSAPP_REMOTE_CONTROL_TOKEN: token,
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
			SSAPP_DEBUG_LOGS: '1',
			SSAPP_USER_DATA_DIR: installedProfileDir,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	runningChild = child;
	let output = '';
	child.stdout.on('data', (chunk) => { output += chunk.toString(); });
	child.stderr.on('data', (chunk) => { output += chunk.toString(); });
	await waitForControl(port, child, () => output);
	return { port, child, getOutput: () => output };
}

async function findMainWindow(port) {
	const windows = await requestJson(port, '/windows');
	const mainWindow = (windows.windows || []).find((item) => String(item.url || '').includes('index.html')) || windows.windows[0];
	assert.ok(mainWindow && mainWindow.id, `Main window not found: ${JSON.stringify(windows)}`);
	return mainWindow;
}

async function execute(port, windowId, code) {
	const result = await requestJson(port, '/exec', { windowId, code });
	assert.strictEqual(result.ok, true, JSON.stringify(result));
	return result.result;
}

async function shutdown(instance) {
	await requestJson(instance.port, '/api/v1/command', { action: 'shutdownApp', value: { confirm: true } });
	await Promise.race([
		new Promise((resolve) => instance.child.once('exit', resolve)),
		new Promise((_, reject) => setTimeout(() => reject(new Error('Portable app did not shut down gracefully.')), 20000)),
	]);
	runningChild = null;
}

function snapshotDirectory(directory) {
	const snapshot = {};
	if (!fs.existsSync(directory)) return snapshot;
	for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
		const relativePath = path.relative(directory, path.join(entry.parentPath, entry.name));
		snapshot[relativePath] = entry.isFile()
			? fs.readFileSync(path.join(entry.parentPath, entry.name)).toString('base64')
			: null;
	}
	return snapshot;
}

function findSocialStreamEntries(directory) {
	if (!fs.existsSync(directory)) return [];
	return fs.readdirSync(directory, { recursive: true })
		.map((entry) => String(entry))
		.filter((entry) => /SocialStream|socialstream/i.test(entry));
}

async function run() {
	// Portable mode only exists on Windows: resolveEarlyDataPaths() returns null for any other
	// platform, so there is nothing here to exercise. Skip rather than fail, so that running
	// the whole suite on Linux or macOS gives a result you can trust.
	if (process.platform !== 'win32') {
		console.log(`portable-build-e2e: SKIPPED (portable builds are Windows-only; this is ${process.platform})`);
		return { skipped: true };
	}
	assert.strictEqual(fs.existsSync(builtPortablePath), true, `Build the portable executable first: ${builtPortablePath}`);
	assert.strictEqual(fs.existsSync(builtInstalledPath), true, `Build the unpacked Windows app first: ${builtInstalledPath}`);
	for (const directory of [originalBundleDir, fakeRoamingDir, fakeLocalDir, extractionTempDir]) {
		fs.mkdirSync(directory, { recursive: true });
	}
	fs.mkdirSync(path.join(legacyProfileDir, 'Local Storage'), { recursive: true });
	fs.writeFileSync(path.join(legacyProfileDir, 'config.json'), JSON.stringify({ portableMigrationMarker: legacyMarker }, null, 2));
	fs.writeFileSync(path.join(legacyProfileDir, 'Local Storage', 'legacy.txt'), legacyMarker);
	fs.writeFileSync(path.join(legacyProfileDir, 'SingletonLock'), 'stale-lock-must-not-copy');
	const legacySnapshot = snapshotDirectory(legacyProfileDir);
	fs.copyFileSync(builtPortablePath, path.join(originalBundleDir, executableName));

	let instance = await launchPortable(originalBundleDir);
	let mainWindow = await findMainWindow(instance.port);
	const firstResult = await execute(instance.port, mainWindow.id, `
		(async () => {
			localStorage.setItem('ssapp-portable-e2e', ${JSON.stringify(marker)});
			const environment = await window.ssappEnvironment.get();
			return { marker: localStorage.getItem('ssapp-portable-e2e'), environment };
		})()
	`);
	assert.strictEqual(firstResult.marker, marker);
	assert.strictEqual(firstResult.environment.isPackaged, true);
	await shutdown(instance);

	const originalDataRoot = path.join(originalBundleDir, 'SocialStreamNinja-data');
	assert.strictEqual(fs.existsSync(path.join(originalDataRoot, 'profile', 'config.json')), true, 'electron-store config was not kept locally');
	assert.strictEqual(fs.existsSync(path.join(originalDataRoot, 'README.txt')), true, 'portable data README was not created');
	assert.strictEqual(fs.existsSync(path.join(originalDataRoot, 'logs')), true, 'portable logs folder was not created');
	assert.strictEqual(fs.existsSync(path.join(originalDataRoot, 'crashes')), true, 'portable crashes folder was not created');
	const migratedConfig = JSON.parse(fs.readFileSync(path.join(originalDataRoot, 'profile', 'config.json'), 'utf8'));
	assert.strictEqual(migratedConfig.portableMigrationMarker, legacyMarker, 'existing AppData settings were not copied');
	assert.strictEqual(fs.readFileSync(path.join(originalDataRoot, 'profile', 'Local Storage', 'legacy.txt'), 'utf8'), legacyMarker);
	assert.strictEqual(fs.existsSync(path.join(originalDataRoot, 'profile', 'SingletonLock')), false, 'stale profile lock was copied');
	assert.deepStrictEqual(snapshotDirectory(legacyProfileDir), legacySnapshot, 'the original AppData profile was modified');
	assert.deepStrictEqual(findSocialStreamEntries(fakeLocalDir), [], 'Social Stream data escaped into Local AppData');

	fs.renameSync(originalBundleDir, movedBundleDir);
	fs.copyFileSync(builtPortablePath, path.join(movedBundleDir, executableName));
	instance = await launchPortable(movedBundleDir);
	mainWindow = await findMainWindow(instance.port);
	const persistedMarker = await execute(instance.port, mainWindow.id, `localStorage.getItem('ssapp-portable-e2e')`);
	assert.strictEqual(persistedMarker, marker, 'browser session data did not persist after moving the portable bundle');
	await shutdown(instance);

	assert.strictEqual(fs.existsSync(path.join(movedBundleDir, 'SocialStreamNinja-data', 'profile')), true);
	assert.deepStrictEqual(snapshotDirectory(legacyProfileDir), legacySnapshot, 'AppData was modified after portable restart');
	assert.deepStrictEqual(findSocialStreamEntries(fakeLocalDir), [], 'Social Stream data escaped into Local AppData after restart');

	instance = await launchInstalled();
	mainWindow = await findMainWindow(instance.port);
	await execute(instance.port, mainWindow.id, `localStorage.setItem('ssapp-installed-e2e', ${JSON.stringify(marker)}); true`);
	await shutdown(instance);
	assert.strictEqual(fs.existsSync(path.join(path.dirname(builtInstalledPath), 'SocialStreamNinja-data')), false, 'installed build created a portable data folder');
	assert.strictEqual(fs.existsSync(path.join(installedProfileDir, 'config.json')), true, 'installed build did not use its isolated profile');
	assert.deepStrictEqual(snapshotDirectory(legacyProfileDir), legacySnapshot, 'installed build modified the legacy profile');
	console.log('Packaged Windows end-to-end checks passed for legacy import, portable persistence/move/update, and installed-profile isolation.');
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
}).finally(async () => {
	if (runningChild && runningChild.exitCode === null) {
		try { runningChild.kill(); } catch (_) { }
	}
	await new Promise((resolve) => setTimeout(resolve, 500));
	try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_) { }
});
