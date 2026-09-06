'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const root = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-startup-outage-'));
	const room = 'startup_outage_' + Date.now();
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({ streamID: room, password: 'false', state: true, settings: {}, wsServer: false }));
	const report = [];
	for (const boot of ['fresh', 'restart']) {
		const app = await _electron.launch({ executablePath: process.env.SSAPP_TEST_SOURCE_EXECUTABLE || require('electron'), cwd: root,
			args: [path.join(__dirname, 'outage-bootstrap.js'), '--multiinstance', '--no-hwa', ...linuxLaunchArgs()],
			env: { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_PREFER_LOCAL_ASSETS: '0' }, timeout: 90000 });
		try {
			const main = await app.firstWindow();
			for (const phase of (boot === 'fresh' ? ['offline', 'online', 'partial', 'stalled'] : ['offline'])) {
				await app.evaluate((_, phase) => { global.__outage.phase = phase; if (phase !== 'offline') global.__outage.requests = []; }, phase);
				if (phase !== 'offline') await main.reload({ waitUntil: 'domcontentloaded' });
				let background;
				for (let attempt = 0; attempt < 180; attempt++) {
					background = main.frames().find(f => f.url().includes('/background.html'));
					try { if (background && await background.evaluate(room => streamID === room && typeof processIncomingMessage === 'function' && typeof filterXSS === 'function', room)) break; } catch (_) {}
					await delay(250);
				}
				assert.ok(background, boot + ' ' + phase + ': background exists');
				const state = await background.evaluate(() => ({ room: streamID, ready: typeof processIncomingMessage === 'function', sanitizer: typeof filterXSS }));
				assert.strictEqual(state.room, room, 'session persists');
				assert.ok(state.ready, 'background initialized');
				assert.strictEqual(state.sanitizer, 'function', 'sanitizer ready');
				assert.ok(background.url().startsWith(phase === 'online' ? 'https:' : 'file:'), phase + ': correct remote/bundled path');
				const settledUrl = background.url();
				await delay(2000);
				assert.strictEqual(background.url(), settledUrl, 'no repeated fallback reload');
				const requests = await app.evaluate(() => global.__outage.requests);
				assert.ok(requests.some(url => url.includes('socialstream.ninja')), 'normal remote startup was attempted');
				if (['partial', 'stalled'].includes(phase)) assert.ok(requests.some(url => url.includes('/libs/objects.js')), 'failed dependency was requested');
				await background.evaluate(() => {
					window.__startupCaptures = [];
					const original = processIncomingMessage;
					processIncomingMessage = function (data, ...args) {
						if (data.chatname === 'Startup QA') window.__startupCaptures.push(data);
						return original.call(this, data, ...args);
					};
				});
				const pending = app.waitForEvent('window');
				await main.evaluate(url => ipcRenderer.sendSync('createWindow', { url, visible: true, sourceFiles: ['sources/youtube.js'] }),
					pathToFileURL(path.join(__dirname, 'fixtures/hidden-capture.html')).href + '?platform=youtube&manual=1');
				const source = await pending;
				await source.waitForLoadState('domcontentloaded');
				await delay(4500);
				for (let repeat = 0; repeat < 2; repeat++) {
					await source.evaluate(id => {
						window.__hiddenCaptureFixture.appendRows([id]);
						document.querySelector('.ssn-chat-row:last-child #author-name').textContent = 'Startup QA';
					}, Date.now());
					await delay(1500);
				}
				assert.strictEqual(await background.evaluate(() => window.__startupCaptures.length), 2, 'capture works without duplicate delivery');
				await source.close();
				report.push({ boot, phase, state, url: background.url(), requests, captures: 2 });
				console.log(`[startup-outage] ${boot} ${phase}: passed`);
			}
		} finally {
			fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
			console.log('[startup-outage] Evidence: ' + profile);
			const timer = setTimeout(() => app.process().kill(), 5000);
			await app.close().catch(() => {});
			clearTimeout(timer);
		}
	}
}
run().catch(error => { console.error(error); process.exitCode = 1; });
