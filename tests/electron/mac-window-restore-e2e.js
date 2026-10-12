'use strict';

const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');

async function run() {
	if (process.platform !== 'darwin') {
		console.log('SKIP: native Mac window restoration requires macOS.');
		return;
	}
	const root = path.resolve(__dirname, '../..');
	const executable = require('electron');
	const existing = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' })
		.split('\n').filter(line => line.trim().endsWith(executable));
	assert.equal(existing.length, 0, 'Run alone so native Apple events target this test app');
	const bundle = path.resolve(path.dirname(executable), '../..');
	const sourceRoot = process.env.SSAPP_TEST_SOURCE_ROOT || path.resolve(root, '../social_stream');
	const base = pathToFileURL(sourceRoot + path.sep).href;
	const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-mac-restore-'));
	console.log('Evidence: ' + output);
	for (const headless of [false, true]) {
		const launchOptions = { executablePath: executable, cwd: root,
			args: ['.', '--running-from-source', '--multiinstance', '--filesource=' + base,
				...(headless ? ['--ssapp-headless-control'] : [])],
			env: { ...process.env, SSAPP_USER_DATA_DIR: path.join(output, headless ? 'headless' : 'desktop') }, timeout: 60000 };
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
			const otherVid = await page.evaluate(() => ipcRenderer.sendSync('createWindow', {
				url: 'data:text/html,<title>Mac restoration fixture</title><p>Auxiliary window</p>', visible: false,
			}));
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

run().catch(error => { console.error(error); process.exitCode = 1; });
