'use strict';

const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
let fixtureServer;

async function runQuitRegressions({ root, executable, packaged, base, bundle, output }) {
	const reports = [];
	const failures = [];
	for (const headless of [false, true]) {
		for (const scenario of ['normal', 'late-window', 'paused-renderer', 'repeated-quit']) {
			const label = `${headless ? 'headless' : 'desktop'}-${scenario}`;
			const profile = path.join(output, label);
			const lateWindowMarker = path.join(output, `${label}-late-window.json`);
			const options = {
				executablePath: executable, cwd: root,
				args: [...(packaged ? [] : ['.', '--running-from-source', '--filesource=' + base]),
					'--multiinstance', '--closetotray', ...(headless ? ['--ssapp-headless-control'] : [])],
				env: { ...process.env, SSAPP_USER_DATA_DIR: profile,
					...(packaged ? { SSAPP_PREFER_LOCAL_ASSETS: '1' } : {}) }, timeout: 60000,
			};
			const report = { label, passed: false };
			let app;
			let child;
			let log;
			let restarted;
			let watchdog;
			try {
				app = await _electron.launch(options);
				child = app.process();
				watchdog = setTimeout(() => child.kill('SIGKILL'), 90000);
				log = fs.createWriteStream(path.join(output, `${label}.log`));
				child.stdout.pipe(log);
				child.stderr.pipe(log);
				const page = await app.firstWindow();
				await page.waitForFunction(() => window.stateManager?.initialized && configReady);
				let background;
				for (let attempt = 0; attempt < 300; attempt++) {
					background = page.frames().find(frame => frame.url().includes('/background.html'));
					if (background) break;
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				assert.ok(background, 'Background must initialize before changing settings');
				await background.waitForFunction(() => typeof loadedFirst !== 'undefined' && loadedFirst);
				await app.evaluate(({ app, BrowserWindow }, { scenario, lateWindowMarker }) => {
					global.__quitRegression = { lateWindowCreated: false, events: [] };
					for (const event of ['before-quit', 'will-quit', 'window-all-closed']) {
						app.on(event, e => global.__quitRegression.events.push({
							event, prevented: e?.defaultPrevented, windows: BrowserWindow.getAllWindows().length,
						}));
					}
					if (scenario === 'late-window') {
						app.once('window-all-closed', () => {
							if (!app.isQuitting) return;
							setTimeout(() => {
								global.__lateQuitWindow = new BrowserWindow({ show: false });
								global.__quitRegression.lateWindowCreated = true;
								process.getBuiltinModule('fs').writeFileSync(lateWindowMarker,
									JSON.stringify({ created: true, quitting: app.isQuitting }));
							}, 50);
						});
					}
				}, { scenario, lateWindowMarker });
				await page.evaluate(label => localStorage.setItem('macQuitRegression', label), label);
				await background.evaluate(label => new Promise(resolve => {
					settings.macQuitRegression = { textparam: label };
					chrome.storage.local.set({ settings }, resolve);
				}), label);
				let cdp;
				if (scenario === 'paused-renderer' || scenario === 'repeated-quit') {
					cdp = await app.context().newCDPSession(page);
					await cdp.send('Debugger.enable');
					await cdp.send('Debugger.pause');
				}
				const started = Date.now();
				const quit = () => execFileSync('osascript', ['-e', `tell application ${JSON.stringify(bundle)} to quit`], { timeout: 15000 });
				quit();
				if (scenario === 'repeated-quit') {
					quit();
					await new Promise(resolve => setTimeout(resolve, 200));
					assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length > 0),
						'Second Quit must not destroy the renderer while its backup is pending');
					await cdp.send('Debugger.resume');
				}
				const deadline = started + 8000;
				while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				report.quitMs = Date.now() - started;
				if (child.exitCode === null && child.signalCode === null) {
					report.state = await app.evaluate(() => global.__quitRegression);
					throw new Error('Native Quit did not exit within 8 seconds');
				}
				assert.equal(child.exitCode, 0, 'Native Quit must exit cleanly');
				const persisted = JSON.parse(fs.readFileSync(path.join(profile, 'savedSync.json'), 'utf8'));
				assert.equal(persisted.settings.macQuitRegression.textparam, label, 'Pending settings must reach disk before quitting');
				if (scenario === 'late-window') {
					assert.deepEqual(JSON.parse(fs.readFileSync(lateWindowMarker, 'utf8')),
						{ created: true, quitting: true }, 'Late-window fixture must actually run during shutdown');
				}
				restarted = await _electron.launch(options);
				const restored = await restarted.firstWindow();
				await restored.waitForFunction(() => window.stateManager?.initialized && configReady);
				assert.equal(await restored.evaluate(() => localStorage.getItem('macQuitRegression')), label);
				assert.equal(await restored.evaluate(() => ipcRenderer.sendSync('storageGet', ['settings']).settings.macQuitRegression.textparam), label);
				report.passed = true;
				console.log(`PASS ${label}: native Quit in ${report.quitMs}ms; settings survived restart.`);
			} catch (error) {
				report.error = error.stack;
				failures.push(`${label}: ${error.message}`);
				console.error(`FAIL ${label}: ${error.message}`);
			} finally {
				clearTimeout(watchdog);
				if (restarted) {
					const timer = setTimeout(() => restarted.process().kill('SIGKILL'), 5000);
					await restarted.close().catch(() => {});
					clearTimeout(timer);
				}
				if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
				if (app) await app.close().catch(() => {});
				if (log) log.end();
				reports.push(report);
				fs.writeFileSync(path.join(output, 'quit-regressions.json'), JSON.stringify(reports, null, 2));
			}
		}
	}
	assert.deepEqual(failures, [], 'Mac Quit regressions failed');
}

async function run() {
	if (process.platform !== 'darwin') {
		console.log('SKIP: native Mac window restoration requires macOS.');
		return;
	}
	const root = path.resolve(__dirname, '../..');
	const packaged = process.env.SSAPP_TEST_APP;
	const executable = packaged || require('electron');
	const existing = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' })
		.split('\n').filter(line => line.trim().endsWith(executable));
	assert.equal(existing.length, 0, 'Run alone so native Apple events target this test app');
	const bundle = path.resolve(path.dirname(executable), '../..');
	const sourceRoot = process.env.SSAPP_TEST_SOURCE_ROOT || path.resolve(root, '../social_stream');
	const base = pathToFileURL(sourceRoot + path.sep).href;
	const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-mac-restore-'));
	console.log('Evidence: ' + output);
	await runQuitRegressions({ root, executable, packaged, base, bundle, output });
	if (process.argv.includes('--quit-regressions-only')) return;
	fixtureServer = http.createServer((_request, response) => {
		response.writeHead(200, { 'Content-Type': 'text/html' });
		response.end('<title>Mac restoration fixture</title><p>Auxiliary window</p>');
	});
	await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
	const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/`;
	for (const headless of [false, true]) {
		const launchOptions = { executablePath: executable, cwd: root,
			args: [...(packaged ? [] : ['.', '--running-from-source', '--filesource=' + base]), '--multiinstance',
				...(headless ? ['--ssapp-headless-control'] : [])],
			env: { ...process.env, SSAPP_USER_DATA_DIR: path.join(output, headless ? 'headless' : 'desktop'),
				...(packaged ? { SSAPP_PREFER_LOCAL_ASSETS: '1' } : {}) }, timeout: 60000 };
		const app = await _electron.launch(launchOptions);
		const child = app.process();
		const log = fs.createWriteStream(path.join(output, headless ? 'headless.log' : 'desktop.log'));
		app.process().stdout.pipe(log);
		app.process().stderr.pipe(log);
		try {
			const page = await app.firstWindow();
			await page.waitForFunction(() => window.stateManager?.initialized && configReady, null, { polling: 100 });
			const main = await app.browserWindow(page);
			// Use the actual auxiliary-window IPC, then verify activation leaves it alone.
			const otherVid = await page.evaluate(url => ipcRenderer.sendSync('createWindow', { url, visible: false }), fixtureUrl);
			const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
				.map(w => ({ id: w.id, visible: w.isVisible() })).sort((a, b) => a.id - b.id));
			const initial = await windows();
			assert.equal(initial.length, 2);
			const mainId = await main.evaluate(w => w.id);
			const other = initial.find(w => w.id !== mainId);
			assert.equal(other.visible, false);
			if (!headless) {
				for (let cycle = 0; cycle < 3; cycle++) {
					await page.evaluate(vid => ipcRenderer.invoke('showWindow', { vid, state: false }), otherVid);
					await page.waitForTimeout(400);
					assert.equal((await windows()).find(w => w.id === other.id).visible, true);
					await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).minimize(), other.id);
					await page.waitForTimeout(900);
					assert.equal(await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isMinimized(), other.id), true);
					// Native restore completes asynchronously on Mac. Hide must remain
					// effective even when that restore finishes after the IPC response.
					await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).restore(), other.id);
					await page.evaluate(vid => ipcRenderer.invoke('showWindow', { vid, state: true }), otherVid);
					await page.waitForTimeout(1000);
					assert.equal((await windows()).find(w => w.id === other.id).visible, false, 'Restoring must not undo a later Hide');
					// A subsequent explicit reveal must still win over queued hiding.
					await page.evaluate(async vid => {
						await ipcRenderer.invoke('showWindow', { vid, state: true });
						await ipcRenderer.invoke('showWindow', { vid, state: false });
					}, otherVid);
					await page.waitForTimeout(500);
					assert.equal((await windows()).find(w => w.id === other.id).visible, true, 'Latest Show must restore the source');
					await page.evaluate(vid => ipcRenderer.invoke('showWindow', { vid, state: true }), otherVid);
				}
				console.log('PASS source restore/Hide races and subsequent explicit Show.');
				const warmup = await app.evaluate(async ({ BrowserWindow }, id) => {
					const window = BrowserWindow.fromId(id);
					try {
						window.__ssappInternalCapture = true;
						window.setOpacity(0);
						window.showInactive();
						await new Promise(resolve => setTimeout(resolve, 150));
						return { visible: window.isVisible(), empty: (await window.webContents.capturePage()).isEmpty() };
					} finally {
						window.hide();
						window.setOpacity(1);
						delete window.__ssappInternalCapture;
					}
				}, other.id);
				assert.deepEqual(warmup, { visible: true, empty: false }, 'Hidden screenshot warm-up must remain available');
			}
			for (let cycle = 0; cycle < 3; cycle++) {
				for (const action of (headless ? ['activate'] : ['Minimize to Tray', 'minimize', 'Close to Tray'])) {
					if (action === 'minimize') await main.evaluate(w => w.minimize());
					if (action === 'Minimize to Tray' || action === 'Close to Tray') {
						await app.evaluate(({ Menu }, label) => {
							function find(menu) {
								for (const item of menu.items) {
									if (item.label === label) return item;
									if (item.submenu) { const match = find(item.submenu); if (match) return match; }
								}
							}
							const item = find(Menu.getApplicationMenu());
							if (!item) throw new Error('Missing menu: ' + label);
							// Electron's checkbox click toggles checked before the handler.
							if (label === 'Close to Tray') item.checked = false;
							item.click(item);
							if (label === 'Close to Tray' && !item.checked) throw new Error('Close to Tray did not enable');
						}, action);
						if (action === 'Close to Tray') await main.evaluate(w => w.close());
					}
					await page.waitForTimeout(300);
					if (!headless && action !== 'minimize') assert.equal(await main.evaluate(w => w.isVisible()), false);
					execFileSync('osascript', ['-e', `tell application ${JSON.stringify(bundle)} to reopen`,
						'-e', `tell application ${JSON.stringify(bundle)} to activate`]);
					await page.waitForTimeout(700);
					const state = await main.evaluate(w => ({ visible: w.isVisible(), minimized: w.isMinimized() }));
					assert.equal(state.visible, !headless, `${action}: main window visibility`);
					if (!headless) assert.equal(state.minimized, false, `${action}: main window restored`);
					const current = await windows();
					assert.deepEqual(current.map(w => w.id), initial.map(w => w.id), 'Activation must not create windows');
					assert.deepEqual(current.find(w => w.id === other.id), other, 'Auxiliary window must remain hidden');
				}
			}
			console.log(headless ? 'PASS native activation preserves headless mode and auxiliary windows.'
				: 'PASS three native reopen cycles each for Minimize to Tray, minimize and Close to Tray.');
			await page.evaluate(() => localStorage.setItem('macNativeQuitFixture', 'preserved'));
			execFileSync('osascript', ['-e', `tell application ${JSON.stringify(bundle)} to quit`]);
			const deadline = Date.now() + 10000;
			while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			assert.ok(child.exitCode !== null || child.signalCode !== null, 'Native Quit must exit, including with Close to Tray enabled');
			console.log('PASS native Mac Quit exits the ' + (headless ? 'headless' : 'close-to-tray') + ' app.');
			const restarted = await _electron.launch(launchOptions);
			try {
				const restored = await restarted.firstWindow();
				await restored.waitForFunction(() => window.stateManager?.initialized, null, { polling: 100 });
				assert.equal(await restored.evaluate(() => localStorage.getItem('macNativeQuitFixture')), 'preserved');
				console.log('PASS settings survive native Quit and restart.');
			} finally { await restarted.close(); }
		} finally {
			// Ensure a failed quit assertion cannot leave its isolated test app running.
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
			await app.close().catch(() => {});
			log.end();
		}
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fixtureServer?.close());
