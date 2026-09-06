#!/usr/bin/env node
'use strict';
// Exercise production source loading and injection through real SSApp IPC.
// Only the HTTPS transport is replaced with deterministic outage responses.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const root = path.resolve(__dirname, '../..');
const source = path.resolve(process.env.SOCIAL_STREAM_SOURCE_DIR || path.join(root, '../social_stream'));
const base = pathToFileURL(source + path.sep).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-source-mirrors-'));
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({ streamID: 'mirror_test_' + Date.now(), password: 'false', state: true, settings: {}, wsServer: false }));
	const app = await _electron.launch({ executablePath: process.env.SSAPP_TEST_APP || require('electron'), cwd: root,
		args: [...(process.env.SSAPP_TEST_APP ? [] : ['.', '--running-from-source', '--filesource=' + base]), '--multiinstance', '--no-hwa', ...linuxLaunchArgs()],
		env: { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_PREFER_LOCAL_ASSETS: '1' }, timeout: 90000 });
	const report = [];
	try {
		const main = await app.firstWindow();
		await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady);
		let background;
		for (let attempt = 0; attempt < 120; attempt++) {
			background = main.frames().find(f => f.url().includes('/background.html'));
			if (background) break;
			await delay(250);
		}
		assert.ok(background, 'real Social Stream background loaded');
		await background.waitForFunction(() => typeof processIncomingMessage === 'function');
		await background.evaluate(() => {
			window.__mirrorCaptures = [];
			const original = processIncomingMessage;
			processIncomingMessage = function (data, ...args) {
				if (data.chatname === 'Mirror QA') window.__mirrorCaptures.push(JSON.parse(JSON.stringify(data)));
				return original.call(this, data, ...args);
			};
		});
		const sourceScript = process.env.SSAPP_TEST_APP
			? await main.evaluate(() => window.ssappFallback.readFile('sources/youtube.js', { branch: 'main' }))
			: fs.readFileSync(path.join(source, 'sources/youtube.js'), 'utf8');
		assert.ok(sourceScript, 'capture script available through the runtime');
		await app.evaluate(async ({ session }, script) => {
			global.__mirrorTest = { script, phase: '', requests: [] };
			await session.defaultSession.protocol.handle('https', request => {
				const url = new URL(request.url);
				const state = global.__mirrorTest;
				if (!url.pathname.endsWith('/sources/youtube.js')) return new Response('', { status: 503 });
				state.requests.push(url.hostname);
				const success = (state.phase === 'cache' && url.hostname === 'cache.socialstream.ninja')
					|| (state.phase === 'bad-cache' && url.hostname === 'socialstream.ninja')
					|| (state.phase === 'raw' && url.hostname === 'raw.githubusercontent.com');
				if (success) return new Response(state.script, { headers: { 'content-type': 'application/javascript' } });
				if (state.phase === 'bad-cache' || state.phase === 'disk') return new Response('<!DOCTYPE html><html>Service unavailable</html>');
				if (state.phase === 'timeout' && url.hostname === 'cache.socialstream.ninja') {
					return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('// incomplete response')); } }));
				}
				return new Response('', { status: 503 });
			});
		}, sourceScript);
		for (const phase of ['cache', 'bad-cache', 'raw', 'disk', 'timeout', 'corrupt-disk']) {
			if (phase === 'corrupt-disk') {
				// Deliberately corrupt only this isolated test profile, as if an old
				// version had cached an outage page. The bundled script must recover.
				fs.writeFileSync(path.join(profile, 'social_stream_cache/main/sources/youtube.js'), '<html>Old cached error</html>');
			}
			await app.evaluate((_, phase) => { global.__mirrorTest.phase = phase; global.__mirrorTest.requests = []; }, phase);
			const fixture = pathToFileURL(path.join(root, 'tests/electron/fixtures/hidden-capture.html')).href + '?platform=youtube&manual=1&phase=' + phase;
			const pending = app.waitForEvent('window');
			await main.evaluate(({ url, phase }) => ipcRenderer.sendSync('createWindow', {
				url, visible: true, sourceFiles: ['https://raw.githubusercontent.com/steveseguin/social_stream/main/sources/youtube.js?outage=' + phase],
			}), { url: fixture, phase });
			const page = await pending;
			await page.waitForLoadState('load');
			// Includes the full remote timeout budget plus source observer initialization.
			await delay(8500);
			for (let repeat = 0; repeat < 2; repeat++) {
				await page.evaluate(({ phase, id }) => {
					window.__hiddenCaptureFixture.appendRows([id]);
					const row = document.querySelector('.ssn-chat-row:last-child');
					row.querySelector('#author-name').textContent = 'Mirror QA';
					row.querySelector('#message').textContent = phase + ' ' + id;
				}, { phase, id: Date.now() });
				await delay(1200);
			}
			const captures = await background.evaluate(phase => window.__mirrorCaptures.filter(d => d.chatmessage.startsWith(phase + ' ')), phase);
			const requests = await app.evaluate(() => global.__mirrorTest.requests);
			const expected = ['cache.socialstream.ninja', ...(phase === 'cache' ? [] : ['socialstream.ninja']), ...(['raw', 'disk', 'timeout', 'corrupt-disk'].includes(phase) ? ['raw.githubusercontent.com'] : [])];
			assert.deepStrictEqual(requests, expected, phase + ': mirror order');
			assert.strictEqual(captures.length, 2, phase + ': real messages reach background');
			report.push({ phase, requests, captures: captures.length });
			console.log('[source-mirrors] ' + phase + ': passed');
			await page.close();
		}
	} catch (error) {
		console.error(error);
		throw error;
	} finally {
		fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
		console.log('[source-mirrors] Evidence: ' + profile);
		const timer = setTimeout(() => app.process().kill(), 5000);
		await app.close().catch(() => {});
		clearTimeout(timer);
	}
}
run().catch(error => { console.error(error); process.exitCode = 1; });
