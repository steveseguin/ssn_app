#!/usr/bin/env node
'use strict';

// Real source capture -> SSApp IPC -> local WebSocket relay -> dock rendering.
// No live channels, account profiles, or posted chat messages are used.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const root = path.resolve(__dirname, '../..');
const sourceRoot = path.resolve(process.env.SOCIAL_STREAM_SOURCE_DIR || path.join(root, '../social_stream'));
let sourceBase = pathToFileURL(sourceRoot + path.sep).href;
const bundled = process.env.SSAPP_TEST_BUNDLED === '1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOnly = process.argv.includes('--text-only') || process.env.SSAPP_TEST_TEXT_ONLY === '1';

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

async function until(check, label, timeout = 30000) {
	const end = Date.now() + timeout;
	let lastError;
	while (Date.now() < end) {
		try {
			const result = await check();
			if (result) return result;
		} catch (error) { lastError = error; }
		await delay(250);
	}
	throw new Error(`Timed out waiting for ${label}${lastError ? ': ' + lastError.message : ''}`);
}

async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-emote-sanitizer-'));
	const room = 'emote_test_' + Date.now();
	const debugPort = await freePort();
	const relayPort = await freePort();
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
		streamID: room, password: 'false', state: true,
		settings: { server2: { setting: true }, textonlymode: { setting: textOnly } }, wsServer: true,
	}));
	const executable = process.env.SSAPP_TEST_EXECUTABLE || require('electron');
	const child = spawn(executable, [
		...(process.env.SSAPP_TEST_EXECUTABLE ? [] : ['.']),
		...(bundled ? ['--preferlocalassets'] : ['--running-from-source', `--filesource=${sourceBase}`]), '--multiinstance', '--disable-logs',
		`--remote-debugging-port=${debugPort}`, `--ssapp-local-server-port=${relayPort}`,
		...linuxLaunchArgs(),
	], {
		cwd: root,
		env: { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_DEBUG_LOGS: '0' },
		stdio: 'ignore', windowsHide: true,
	});
	let browser;
	let appPid;
	const report = { profile, textOnly, phases: [] };
	try {
		browser = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`), 'SSApp debugger', 120000);
		const system = await browser.newBrowserCDPSession();
		appPid = (await system.send('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser').id;
		const pages = () => browser.contexts().flatMap(context => context.pages());
		const main = await until(async () => pages().find(page => page.url().includes('/index.html')), 'main window');
		await until(() => main.evaluate(() => typeof ipcRenderer !== 'undefined' && typeof configReady !== 'undefined' && configReady), 'main initialization');
		report.version = await main.evaluate(() => ipcRenderer.sendSync('getVersion'));
		if (bundled) {
			const resolved = await main.evaluate(() => window.ssappFallback.resolveUrl('dock.html', { branch: 'main' }));
			assert.ok(resolved?.url, 'bundled dock available');
			sourceBase = new URL('.', resolved.url).href;
		}
		const createWindow = args => main.evaluate(value => ipcRenderer.sendSync('createWindow', value), args);
		await createWindow({
			url: `${sourceBase}dock.html?session=${room}&password=false&server2&localserver&localserverport=${relayPort}`,
			visible: true,
		});
		const dock = await until(async () => pages().find(page => page.url().includes('/dock.html')), 'dock');
		const dockSession = await dock.context().newCDPSession(dock);
		// Dock deliberately disables window.eval, so use the native DevTools evaluator.
		const evaluateDock = async (fn, arg) => {
			const result = await dockSession.send('Runtime.evaluate', {
				expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
				awaitPromise: true, returnByValue: true,
			});
			if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
			return result.result.value;
		};
		await dockSession.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 1000, deviceScaleFactor: 1, mobile: false });
		await until(() => evaluateDock(() => typeof processInput === 'function' && socketserverExtension?.readyState === 1), 'dock relay');
		const sources = [];
		for (const platform of ['youtube', 'twitch', 'kick']) {
			const url = pathToFileURL(path.join(root, 'tests/electron/fixtures/hidden-capture.html')).href + `?platform=${platform}&manual=1`;
			await createWindow({ url, visible: true, sourceFiles: [`sources/${platform}.js`], filesource: sourceBase });
			const page = await until(async () => pages().find(p => p.url().includes(`platform=${platform}`)), platform + ' source');
			await until(() => page.evaluate(() => !!window.__hiddenCaptureFixture), platform + ' fixture');
			sources.push({ platform, page });
		}
		await delay(4500); // Allow the real capture scripts to install their observers.
		for (const phase of ['normal', 'blocked-library', 'reload']) {
			await main.context().unroute('**/thirdparty/xss.min.js*');
			let blockedRequests = 0;
			if (phase === 'blocked-library') {
				await main.context().route('**/thirdparty/xss.min.js*', route => {
					blockedRequests++;
					return route.abort('failed');
				});
			}
			let background = main.frames().find(frame => frame.url().includes('/background.html'));
			if (phase !== 'normal') {
				await background.evaluate(() => location.reload());
				await delay(3500);
			}
			background = await until(async () => {
				const frame = main.frames().find(f => f.url().includes('/background.html'));
				return frame && await frame.evaluate(() => typeof processIncomingMessage === 'function' && socketserverDock?.readyState === 1) ? frame : null;
			}, 'background relay');
			assert.strictEqual(await background.evaluate(() => !!settings.textonlymode), textOnly, 'text-only setting survives background reload');
			if (phase === 'blocked-library') {
				// Also cover an older cached loader still requesting the separate asset.
				const loaded = await background.evaluate(() => new Promise(resolve => {
					const script = document.createElement('script');
					script.onload = () => resolve(true);
					script.onerror = () => resolve(false);
					script.src = './thirdparty/xss.min.js?emote-regression';
					document.body.appendChild(script);
				}));
				assert.strictEqual(loaded, false, 'Separate library request must fail in this phase');
				assert.ok(blockedRequests > 0);
			}
			await background.evaluate(() => {
				window.__emoteCaptures = [];
				const original = processIncomingMessage;
				processIncomingMessage = function (data, ...args) {
					if (data.chatname?.startsWith('Emote ')) window.__emoteCaptures.push(JSON.parse(JSON.stringify(data)));
					return original.call(this, data, ...args);
				};
			});
			for (let repeat = 0; repeat < 2; repeat++) {
				for (const { platform, page } of sources) {
					await page.evaluate(({ phase, platform, id }) => {
						window.__hiddenCaptureFixture.appendRows([id]);
						const row = document.querySelector('.ssn-chat-row:last-child');
						row.querySelector('#author-name,.chat-author__display-name,.chat-entry-username').textContent = `Emote ${phase} ${platform} ${id}`;
						row.querySelector('#message,[data-a-target="chat-line-message-body"],.chat-entry-content').innerHTML = `it's 👑 sadNik :) <img src="https://cdn.betterttv.net/emote/64040c27ccf0dd06e1af2c67/2x" alt="sadNik" title="sadNik" class="regular-emote">`;
					}, { phase, platform, id: Date.now() });
				}
				await delay(2500);
			}
			const captures = await background.evaluate(() => window.__emoteCaptures);
			assert.strictEqual(captures.length, 6, phase + ': real source capture');
			for (const capture of captures) {
				assert.strictEqual(!!capture.textonly, textOnly, capture.type + ': source received text-only setting');
				if (textOnly) {
					assert.ok(!/<img\b|&#0*39;|&apos;/.test(capture.chatmessage), capture.type + ': clean text-only payload');
					assert.ok(capture.chatmessage.includes("it's 👑 sadNik :)"), capture.type + ': plain emoji and emote names preserved');
				}
			}
			const rows = await until(async () => {
				const result = await evaluateDock(phase => Array.from(document.querySelectorAll('.highlight-chat'))
					.filter(row => row.textContent.includes('Emote ' + phase))
					.map(row => ({ text: row.textContent, images: row.querySelectorAll('img.regular-emote').length })), phase);
				return result.length === 6 ? result : null;
			}, phase + ' dock messages');
			for (const row of rows) {
				assert.strictEqual(row.images, textOnly ? 0 : 1, phase + ': correct image behavior for selected mode');
				assert.ok(row.text.includes('sadNik :)'), phase + ': text emotes survive');
				assert.ok(row.text.includes("it's 👑"), phase + ': apostrophe and Unicode must survive');
				assert.ok(!row.text.includes('<img') && !row.text.includes('&#039;'), phase + ': markup must not become text');
			}
			report.phases.push({ phase, blockedRequests, captures, rows });
			await dock.screenshot({ path: path.join(profile, phase + '.png') });
			console.log(`[emote-sanitizer] ${report.version} ${textOnly ? 'text-only' : 'rich'} ${phase}: 6 captured messages rendered correctly`);
		}
	} finally {
		fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
		console.log(`[emote-sanitizer] Evidence: ${profile}`);
		if (browser) await browser.close().catch(() => {});
		// Portable builds launch a child executable; terminate that test process too.
		if (appPid) { try { process.kill(appPid); } catch (_) {} }
		if (child.exitCode === null) child.kill();
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
