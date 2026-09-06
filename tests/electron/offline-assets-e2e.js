#!/usr/bin/env node
'use strict';

// Real SSApp windows, isolated profile, with all HTTP requests blocked. In source
// mode stage exactly the build allowlist; SSAPP_TEST_APP tests the shipped bundle.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deflateSync } = require('zlib');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const { BASE_PATTERNS, TTS_PATTERNS, copyLocalFallback } = require('../../scripts/updateSocialStreamFallback');
const { checkFallbackDependencies } = require('../../scripts/check-fallback-dependencies');
const root = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, label) {
	const end = Date.now() + 30000;
	while (Date.now() < end) {
		if (await fn()) return;
		await delay(200);
	}
	throw new Error('Timed out: ' + label);
}

async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-offline-assets-'));
	const room = 'offline_test_' + Date.now();
	const packaged = process.env.SSAPP_TEST_APP;
	let base;
	if (!packaged) {
		const source = path.resolve(process.env.SOCIAL_STREAM_SOURCE_DIR || path.join(root, '../social_stream'));
		checkFallbackDependencies(source, BASE_PATTERNS, TTS_PATTERNS);
		const stage = path.join(profile, 'site');
		copyLocalFallback(source, stage, BASE_PATTERNS);
		base = pathToFileURL(stage + path.sep).href;
	}
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
		streamID: room, password: 'false', state: false, settings: {}, wsServer: false,
	}));
	const app = await _electron.launch({
		executablePath: packaged || require('electron'), cwd: root,
		args: [...(packaged ? [] : ['.', '--running-from-source', '--filesource=' + base]),
			'--multiinstance', '--no-hwa', ...linuxLaunchArgs()],
		env: { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_PREFER_LOCAL_ASSETS: '1' }, timeout: 90000,
	});
	const report = { packaged: !!packaged, results: [], blockedRequests: 0 };
	try {
		const main = await app.firstWindow();
		await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady);
		report.version = await main.evaluate(() => ipcRenderer.sendSync('getVersion'));
		await app.context().routeWebSocket('**/*', socket => socket.close());
		await app.context().route('**/*', route => {
			if (/^https?:/.test(route.request().url())) {
				report.blockedRequests++;
				return route.abort('internetdisconnected');
			}
			return route.continue();
		});
		const cases = [
			['monetization.html', 'demo&mode=wishlist', async (page, evaluate) => {
				await until(() => evaluate(() => !!document.querySelector('#qr canvas') && !document.querySelector('#qr').hidden), 'rendered QR code');
				assert.ok(await evaluate(() => {
					const c = document.querySelector('#qr canvas');
					const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
					return pixels.some((v, i) => i % 4 === 0 && v === 0) && pixels.some((v, i) => i % 4 === 0 && v === 255);
				}), 'QR canvas contains black and white modules');
			}],
			['tipjar.html', 'style=jar&celebration=hearts', async (page, evaluate) => {
				await until(() => evaluate(() => typeof world !== 'undefined' && !!world), 'physics world');
				await evaluate(() => processData({ chatname: 'Offline QA', type: 'twitch', hasDonation: '$5.00' }));
				await until(() => evaluate(() => Matter.Composite.allBodies(world).some(b => !b.isStatic)), 'donation heart');
				const before = await evaluate(() => Matter.Composite.allBodies(world).filter(b => !b.isStatic).map(b => ({ id: b.id, y: b.position.y })));
				await until(async () => {
					const after = await evaluate(() => Matter.Composite.allBodies(world).filter(b => !b.isStatic).map(b => ({ id: b.id, y: b.position.y })));
					return after.some(b => before.some(a => a.id === b.id && Math.abs(a.y - b.y) > 0.1));
				}, 'donation hearts animate');
			}],
			['sources/websocket/bilibili.html', '', async (page, evaluate) => {
				const body = Buffer.from(JSON.stringify({ cmd: 'DANMU_MSG', info: [[], 'Offline compressed chat', [123, 'Offline QA', 0, 0, 0]] }));
				const packet = Buffer.alloc(16 + body.length);
				packet.writeUInt32BE(packet.length, 0); packet.writeUInt16BE(16, 4); packet.writeUInt16BE(1, 6); packet.writeUInt32BE(5, 8); body.copy(packet, 16);
				await evaluate(bytes => new BilibiliLiveClient('0').handleDataPacket(2, new Uint8Array(bytes)), [...deflateSync(packet)]);
				await until(() => evaluate(() => document.querySelector('#messageContainer').textContent.includes('Offline compressed chat')), 'decompressed chat rendered');
			}],
			['streamelements-importer.html', '', async (page, evaluate) => {
				const zip = await evaluate(async () => {
					const archive = new JSZip();
					archive.file('widget.html', '<div id="offline-widget">Offline ZIP widget</div>');
					return archive.generateAsync({ type: 'base64' });
				});
				await page.locator('#zipInput').setInputFiles({ name: 'offline-widget.zip', mimeType: 'application/zip', buffer: Buffer.from(zip, 'base64') });
				await until(() => evaluate(() => document.querySelector('#statusBox').textContent.includes('Ready.')), 'ZIP import complete');
				await until(async () => {
					for (const frame of page.frames()) if (await frame.locator('#offline-widget').count()) return true;
					return false;
				}, 'imported widget preview rendered');
			}],
			['map.html', '', async (page, evaluate) => {
				await until(() => evaluate(() => document.querySelectorAll('#world-map path.country[d]').length > 100), 'world map geography rendered');
			}],
		];
		for (const [file, query, verify] of cases) {
			if (process.env.SSAPP_OFFLINE_CASE && file !== process.env.SSAPP_OFFLINE_CASE) continue;
			const url = packaged ? (await main.evaluate(file => window.ssappFallback.resolveUrl(file, { branch: 'main' }), file))?.url : base + file;
			assert.ok(url, 'bundled page exists: ' + file);
			const pending = app.waitForEvent('window');
			await main.evaluate(url => ipcRenderer.sendSync('createWindow', { url, visible: true }), url + '?session=' + room + '&' + query);
			const page = await pending;
			const nativeWindow = await app.browserWindow(page);
			await nativeWindow.evaluate(window => window.setSize(1000, 800));
			page.on('console', message => { if (message.type() === 'error' && !message.text().includes('ERR_INTERNET_DISCONNECTED')) console.log(`[offline-assets] ${file}: ${message.text()}`); });
			const scriptErrors = [];
			page.on('pageerror', error => {
				const stack = error.stack || error.message;
				// The deliberately disconnected external transport can load its shell
				// without its network scripts. Keep this narrow and record it separately.
				if (['WebRTC is not defined', 'main is not a function'].includes(error.message)
					&& /at (?:onload \()?https:\/\/vdo\.socialstream\.ninja\//.test(stack)) {
					(report.expectedTransportErrors ||= []).push(stack);
				} else scriptErrors.push(stack);
			});
			const missing = [];
			page.on('requestfailed', request => { if (request.url().startsWith('file:') && request.failure()?.errorText.includes('FILE_NOT_FOUND')) missing.push(request.url()); });
			await page.waitForLoadState('load');
			const cdp = await page.context().newCDPSession(page);
			const evaluate = async (fn, arg) => {
				const result = await cdp.send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true });
				if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
				return result.result.value;
			};
			for (const phase of ['initial', 'reload']) {
				if (phase === 'reload') await page.reload({ waitUntil: 'load' });
				await verify(page, evaluate);
				await delay(500);
				assert.deepStrictEqual(missing, [], file + ': no missing local dependencies');
				assert.deepStrictEqual(scriptErrors, [], file + ': no unexpected JavaScript errors');
				report.results.push({ file, phase, passed: true });
				console.log(`[offline-assets] ${file} ${phase}: passed`);
			}
			await page.screenshot({ path: path.join(profile, path.basename(file) + '.png') });
			await page.close();
		}
		assert.ok(report.blockedRequests > 0, 'outage interception was exercised');
	} catch (error) {
		report.error = error.stack;
		console.error(error);
		throw error;
	} finally {
		fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
		console.log('[offline-assets] Evidence: ' + profile);
		const timer = setTimeout(() => app.process().kill(), 5000);
		await app.close().catch(() => {});
		clearTimeout(timer);
	}
}
run().catch(error => { console.error(error); process.exitCode = 1; });
