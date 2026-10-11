'use strict';

// Real SSApp background/co-host pages, host renderer and workers. No model weights
// are downloaded: reset exercises worker IPC without initializing inference.
const assert = require('assert/strict');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(100);
	}
	throw new Error('Timed out: ' + label);
}

async function run() {
	const root = path.resolve(__dirname, '../..');
	const sourceRoot = path.resolve(process.env.SSAPP_TEST_SOURCE_ROOT || path.join(root, '../social_stream'));
	assert.ok(fs.existsSync(path.join(sourceRoot, 'local-browser-model-host.html')), 'Use a current Social Stream core checkout.');
	const base = pathToFileURL(sourceRoot + path.sep).href;
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-local-model-'));
	console.log('PROFILE', profile);
	let app;
	try {
		app = await _electron.launch({
			executablePath: require('electron'), cwd: root,
			args: ['.', '--running-from-source', '--multiinstance', '--filesource=' + base, ...linuxLaunchArgs()],
			env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000,
		});
		const log = fs.createWriteStream(path.join(profile, 'runtime.log'));
		app.process().stdout.pipe(log);
		app.process().stderr.pipe(log);
		const main = await app.firstWindow();
		await main.waitForFunction(() => window.stateManager?.initialized && typeof configReady !== 'undefined' && configReady);
		// Startup can replace the background while resolving the core path.
		await delay(5000);
		const background = () => main.frames().find(frame => frame.url().includes('/background.html'));
		await until(() => !!background(), 'background');
		await main.evaluate(url => ipcRenderer.sendSync('createWindow', { url, visible: true }), base + 'cohost.html');
		await until(() => app.windows().some(page => page.url().includes('/cohost.html')), 'co-host');
		const cohost = app.windows().find(page => page.url().includes('/cohost.html'));
		await cohost.waitForFunction(() => !!window.ssappLocalModel);
		const hosts = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
			.filter(win => win.webContents.getURL().includes('/local-browser-model-host.html')).map(win => win.id));
		const listenerCounts = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
			.filter(win => /\/(index|cohost)\.html/.test(win.webContents.getURL()))
			.map(win => [win.id, ...['did-frame-navigate', 'destroyed', 'render-process-gone'].map(event => win.webContents.listenerCount(event))]));
		const initialListeners = await listenerCounts();
		async function reset(frame, id) {
			const requestId = 'reset-' + Date.now();
			await frame.evaluate(async ({ id, requestId }) => {
				window.lifecycleMessages = [];
				window.lifecycleUnsubscribe?.();
				window.lifecycleUnsubscribe = ssappLocalModel.onMessage(message => lifecycleMessages.push(message));
				await ssappLocalModel.post(id, { type: 'reset', requestId });
			}, { id, requestId });
			await frame.waitForFunction(({ id, requestId }) => lifecycleMessages.some(message => message.id === id
				&& message.data?.requestId === requestId && message.data.ok), { id, requestId });
		}

		for (const [name, getFrame] of [['background', background], ['co-host', () => cohost]]) {
			for (let cycle = 0; cycle < 6; cycle++) {
				const frame = getFrame();
				await frame.waitForFunction(() => !!window.ssappLocalModel);
				const id = await frame.evaluate(() => ssappLocalModel.create());
				await reset(frame, id);
				assert.equal((await hosts()).length, 1);
				await frame.evaluate(() => location.reload());
				await until(async () => !(await hosts()).length, name + ' reload releases host');
				await getFrame().waitForFunction(() => !!window.ssappLocalModel);
			}
			console.log('PASS six ' + name + ' create/reload cycles release workers and host');
		}

		let survivor = await cohost.evaluate(() => ssappLocalModel.create());
		const ownerId = await background().evaluate(() => ssappLocalModel.create());
		const sharedHost = await hosts();
		await background().evaluate(() => { location.hash = 'lifecycle'; });
		await reset(background(), ownerId);
		await background().evaluate(() => location.reload());
		await delay(1500);
		assert.deepEqual(await hosts(), sharedHost, 'Background reload must preserve the co-host worker');
		await reset(cohost, survivor);
		const ids = await background().evaluate(async () => {
			const ids = [];
			for (let i = 0; i < 3; i++) ids.push(await ssappLocalModel.create());
			return ids;
		});
		await assert.rejects(background().evaluate(() => ssappLocalModel.create()), /Too many local AI clients/);
		for (const id of ids) await background().evaluate(id => ssappLocalModel.terminate(id), id);
		await reset(cohost, survivor);
		await cohost.evaluate(id => ssappLocalModel.terminate(id), survivor);
		await until(async () => !(await hosts()).length, 'last explicit termination');
		assert.deepEqual(await listenerCounts(), initialListeners, 'Client cleanup must release event listeners');
		console.log('PASS shared host, same-document navigation, client quota, termination and listener cleanup');

		survivor = await cohost.evaluate(() => ssappLocalModel.create());
		await background().evaluate(() => ssappLocalModel.create());
		await main.reload({ waitUntil: 'load' });
		await main.waitForFunction(() => window.stateManager?.initialized && typeof configReady !== 'undefined' && configReady);
		await delay(1500);
		await reset(cohost, survivor);
		await background().evaluate(async () => {
			const ids = await Promise.all(Array.from({ length: 3 }, () => ssappLocalModel.create()));
			for (const id of ids) await ssappLocalModel.terminate(id);
		});
		await cohost.evaluate(id => ssappLocalModel.terminate(id), survivor);
		await until(async () => !(await hosts()).length, 'main window reload cleanup');
		console.log('PASS main window reload releases its background clients and preserves the co-host');

		// Hold the real host request so the owner reloads before create() resolves.
		const hostUrl = base + 'local-browser-model-host.html';
		await app.evaluate(({ session }, { url, hash }) => {
			global.lifecycleSession = session.fromPartition('persist:ssn-local-models-' + hash);
			global.lifecycleSession.webRequest.onBeforeRequest({ urls: [url] }, (_details, callback) => {
				global.lifecycleHeldRequest = callback;
			});
		}, { url: hostUrl, hash: createHash('sha256').update(hostUrl).digest('hex').slice(0, 16) });
		await background().evaluate(() => { ssappLocalModel.create().catch(() => {}); });
		await until(() => app.evaluate(() => !!global.lifecycleHeldRequest), 'host request paused');
		await background().evaluate(() => location.reload());
		await delay(1000);
		await app.evaluate(() => {
			global.lifecycleSession.webRequest.onBeforeRequest(null);
			global.lifecycleHeldRequest({ cancel: true });
			delete global.lifecycleHeldRequest;
			delete global.lifecycleSession;
		});
		// A host blocked before loading has no URL; count its partition instead.
		assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
			.filter(win => /ssn-local-models-/.test(win.webContents.session.getStoragePath() || '')).length), 0);
		const restarted = await background().evaluate(() => ssappLocalModel.create());
		await reset(background(), restarted);
		await background().evaluate(id => ssappLocalModel.terminate(id), restarted);
		console.log('PASS reload cancels pending creation and permits a fresh host');

		survivor = await cohost.evaluate(() => ssappLocalModel.create());
		await reset(cohost, survivor);
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
			.find(win => win.webContents.getURL().includes('/local-browser-model-host.html')).webContents.forcefullyCrashRenderer());
		await cohost.waitForFunction(id => lifecycleMessages.some(message => message.id === id && message.error), survivor);
		await until(async () => !(await hosts()).length, 'crashed host cleanup');
		const replacement = await cohost.evaluate(() => ssappLocalModel.create());
		await reset(cohost, replacement);
		await cohost.close();
		await until(async () => !(await hosts()).length, 'closed owner cleanup');
		console.log('PASS host crash recovery and closing the owner releases the host');
	} finally {
		if (app) await app.close();
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
