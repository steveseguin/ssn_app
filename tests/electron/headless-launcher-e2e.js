'use strict';

// Linux-only: real Electron setup, profile persistence, headless restart, and display loss.
// SSAPP_TEST_ELECTRON may point to a Linux Electron binary when testing a shared checkout.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
	assert.strictEqual(process.platform, 'linux', 'Run this integration test on Linux with Xvfb installed.');
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-launcher-e2e-'));
	const packagedApp = process.env.SSAPP_TEST_APP;
	const binary = packagedApp || process.env.SSAPP_TEST_ELECTRON || require('electron');
	const server = net.createServer();
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	// Pick an unused display; this test must never kill a user's existing display.
	let display;
	for (let candidate = 190; candidate < 290; candidate++) {
		if (!fs.existsSync(`/tmp/.X${candidate}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${candidate}`)) {
			display = candidate;
			break;
		}
	}
	assert.ok(display, 'No unused test display found');
	let child;
	let logFd;
	async function request(endpoint, body) {
		const response = await fetch(`http://127.0.0.1:${port}/api/v1/${endpoint}`, {
			method: body ? 'POST' : 'GET',
			headers: { 'Content-Type': 'application/json' },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(3000),
		});
		const data = await response.json();
		assert.ok(response.ok && data.ok, JSON.stringify(data));
		return data;
	}
	async function launch(setup) {
		logFd = fs.openSync(path.join(profile, setup ? 'setup.log' : 'headless.log'), 'w');
		child = spawn('bash', ['scripts/start-headless.sh', ...(setup ? ['--setup'] : []),
			...(packagedApp ? [] : ['.', '--running-from-source', '--filesource', `file://${path.resolve(repoRoot, '../social_stream')}/`]),
			...(process.env.SSAPP_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
			'--ssapp-control-api', `--ssapp-control-port=${port}`], {
			cwd: repoRoot,
			env: { ...process.env, SSAPP_BINARY: binary, SSAPP_USER_DATA_DIR: profile,
				SSAPP_PREFER_LOCAL_ASSETS: packagedApp ? '1' : '0',
				SSAPP_DATA_DIR: path.join(profile, 'wrong'), SSAPP_DISPLAY_NUM: String(display), SSAPP_HEADLESS_CONTROL: '1' },
			stdio: ['ignore', logFd, logFd],
		});
		for (let attempt = 0; attempt < 120; attempt++) {
			assert.strictEqual(child.exitCode, null, `Launcher exited; inspect ${profile}`);
			try {
				const status = await request('status');
				if (status.app.headless === !setup && status.app.mainWindowVisible === setup) return;
			} catch (_) { }
			await delay(500);
		}
		throw new Error(`App did not become ready; inspect ${profile}`);
	}
	async function stopped(expected) {
		for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) await delay(250);
		assert.strictEqual(child.exitCode, expected, `Unexpected launcher shutdown; inspect ${profile}`);
		fs.closeSync(logFd);
		logFd = undefined;
		child = undefined;
		assert.ok(!fs.existsSync(`/tmp/.X${display}-lock`), 'Launcher left its display running');
	}
	try {
		await launch(true);
		const tree = execFileSync('xwininfo', ['-display', `:${display}`, '-root', '-tree'], { encoding: 'utf8' });
		assert.match(tree, /Social Stream|SocialStream/i, 'Setup window missing from real X display');
		await request('command', { action: 'updateSettings', value: { settings: { preferTikTokLegacy: true } } });
		child.kill('SIGTERM');
		await stopped(143);
		await launch(false);
		const settings = await request('command', { action: 'getSettings', value: {} });
		assert.strictEqual(settings.payload.settings.preferTikTokLegacy, true, 'Setup settings lost on restart');
		await delay(5000);
		assert.strictEqual((await request('status')).app.mainWindowVisible, false);
		const displayPid = Number(fs.readFileSync(`/tmp/.X${display}-lock`, 'utf8').trim());
		process.kill(displayPid, 'SIGTERM');
		await stopped(1);
		console.log(`[headless-launcher-e2e] PASS: visible setup, saved settings, hidden restart, display-loss recovery. Logs: ${profile}`);
	} finally {
		if (child && child.exitCode === null) {
			child.kill('SIGTERM');
			for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) await delay(250);
		}
		if (logFd !== undefined) fs.closeSync(logFd);
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
