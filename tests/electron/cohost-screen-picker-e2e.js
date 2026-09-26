'use strict';

// Run with a desktop: node tests/electron/cohost-screen-picker-e2e.js
// Before applying the fix, --expect-vulnerable confirms the inert HTML marker.
// Also checks Dock's destination picker with raw legacy tabsList messages.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { WebSocketServer } = require('ws');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const root = path.resolve(__dirname, '../..');
const sourceRoot = path.resolve(root, '../social_stream');
const expectVulnerable = process.argv.includes('--expect-vulnerable');
const markerTitle = 'SSApp picker " data-ssapp-title-attribute="inert" & <b data-ssapp-title-marker>literal</b>';
const ordinaryTitle = 'SSApp picker: Steve\'s "window" & <notes> — 日本語';

async function until(fn, label) {
	const start = Date.now();
	while (Date.now() - start < 60000) {
		const result = await fn();
		if (result) return result;
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error(`Timed out: ${label}`);
}

async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-picker-e2e-'));
	const report = { expectVulnerable, profile, checks: [] };
	const server = http.createServer((_request, response) => {
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.end('<!doctype html><title>SSApp picker fixture</title><p>Local window-title fixture; no media capture.</p>');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const legacyTabs = [markerTitle, ordinaryTitle + ' &amp; &#60;b&#62;', ordinaryTitle.repeat(4)].map((title, index) => ({
		id: 990 + index, title, url: 'https://example.invalid/?q=<b title="literal">&amp;',
	}));
	let dockRequests = 0;
	const relay = new WebSocketServer({ server, path: '/legacy-dock-relay' });
	relay.on('connection', socket => {
		socket.on('message', raw => {
			const message = JSON.parse(raw);
			if (message.action === 'getChatSources') {
				dockRequests++;
				// Raw old-format input: no escaping or sanitizing by the desktop app.
				socket.send(JSON.stringify({ tabsList: legacyTabs }));
			}
		});
	});
	let app;
	try {
		const env = { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_DEBUG_LOGS: '0' };
		delete env.ELECTRON_RUN_AS_NODE;
		app = await _electron.launch({
			executablePath: require('electron'), cwd: root,
			args: ['.', '--multiinstance', '--running-from-source', '--disable-logs',
				`--filesource=${pathToFileURL(sourceRoot + path.sep).href}`, ...linuxLaunchArgs()],
			env, timeout: 60000,
		});
		const log = fs.createWriteStream(path.join(profile, 'app.log'));
		app.process().stdout.pipe(log);
		app.process().stderr.pipe(log);
		const main = await app.firstWindow();
		await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady && typeof ipcRenderer !== 'undefined');

		// Block camera/microphone permission probes and any accidental capture in this
		// test only. Native source enumeration, thumbnails and picker code are real.
		await app.context().addInitScript(() => {
			if (!location.pathname.endsWith('/cohost.html')) return;
			window.__pickerDesktopCaptureCalls = 0;
			navigator.mediaDevices.getUserMedia = async constraints => {
				if (constraints.video?.mandatory?.chromeMediaSource === 'desktop' ||
					constraints.audio?.mandatory?.chromeMediaSource === 'desktop') {
					window.__pickerDesktopCaptureCalls++;
				}
				throw new DOMException('Media capture disabled by the picker test', 'NotAllowedError');
			};
		});
		const fixtureUrl = `http://127.0.0.1:${server.address().port}/title-fixture`;
		await app.evaluate(async ({ BrowserWindow }, url) => {
			const fixture = new BrowserWindow({
				width: 480, height: 240, show: true,
				webPreferences: { nodeIntegration: false, contextIsolation: true },
			});
			await fixture.loadURL(url);
		}, fixtureUrl);
		const fixture = await until(() => app.windows().find(page => page.url() === fixtureUrl), 'fixture window');
		const cohostUrl = `${pathToFileURL(path.join(sourceRoot, 'cohost.html')).href}?session=picker-e2e-${Date.now()}`;
		await main.evaluate(url => { window.open(url, '_blank'); }, cohostUrl);
		const cohost = await until(() => app.windows().find(page => page.url() === cohostUrl), 'Co-host window');
		await cohost.waitForFunction(() => typeof ElectronDesktopCapture !== 'undefined' && ElectronDesktopCapture);
		await cohost.bringToFront();

		async function checkPicker(title, cancelWithEscape) {
			// A normal unprivileged page controls its native window title.
			await fixture.evaluate(value => { document.title = value; }, title);
			const sourceId = await until(() => app.evaluate(async ({ desktopCapturer }, name) => {
				const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
				return sources.find(source => source.name === name)?.id;
			}, title), 'fixture title visible to native desktopCapturer');
			await cohost.locator('#providerSelect').focus();
			// Open the real in-app picker without starting an AI provider or capture.
			await cohost.evaluate(() => {
				window.__pickerResult = 'pending';
				navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(stream => {
					stream.getTracks().forEach(track => track.stop());
					window.__pickerResult = 'unexpected-stream';
				}, reason => {
					window.__pickerResult = reason === null ? 'cancelled' : String(reason);
				});
			});
			const dialog = cohost.locator('.desktop-capturer-selection');
			await dialog.waitFor({ state: 'visible' });
			const observed = await dialog.evaluate((element, id) => {
				const button = Array.from(element.querySelectorAll('button[data-id]')).find(row => row.dataset.id === id);
				if (!button) throw new Error('Fixture source missing from actual picker');
				const label = button.querySelector('.desktop-capturer-selection__name');
				const image = button.querySelector('img');
				return {
					title: button.title,
					text: label.textContent,
					markerElements: element.querySelectorAll('[data-ssapp-title-marker]').length,
					injectedAttribute: button.hasAttribute('data-ssapp-title-attribute'),
					labelChildren: label.childElementCount,
					sourceIdPreserved: button.dataset.id === id,
					thumbnailPresent: image.src.startsWith('data:image/'),
					focusInside: element.contains(document.activeElement),
					audioChecked: element.querySelector('#alsoCaptureAudio').checked,
				};
			}, sourceId);
			report.checks.push(observed);
			console.log('Picker result:', JSON.stringify(observed));
			assert(observed.sourceIdPreserved && observed.thumbnailPresent && observed.focusInside);
			assert.strictEqual(observed.audioChecked, process.platform !== 'darwin');
			if (expectVulnerable) {
				assert(observed.markerElements > 0, 'Expected the unfixed picker to parse the inert markup');
				assert(observed.injectedAttribute, 'Expected the unfixed tooltip attribute to break out');
			} else {
				assert.strictEqual(observed.markerElements, 0);
				assert.strictEqual(observed.injectedAttribute, false);
				assert.strictEqual(observed.labelChildren, 0);
				assert.strictEqual(observed.text, title);
				assert.strictEqual(observed.title, title);
			}
			await cohost.locator('#cancelscreenshare').focus();
			await cohost.keyboard.press('Tab');
			assert(await cohost.evaluate(() => document.activeElement === document.querySelector('.desktop-capturer-selection button')));
			await cohost.keyboard.press('Shift+Tab');
			assert(await cohost.evaluate(() => document.activeElement.id === 'cancelscreenshare'));
			if (cancelWithEscape) await cohost.keyboard.press('Escape');
			else await cohost.locator('#cancelscreenshare').click();
			await cohost.waitForFunction(() => window.__pickerResult === 'cancelled');
			assert.strictEqual(await dialog.count(), 0);
			assert(await cohost.evaluate(() => document.activeElement.id === 'providerSelect'));
			assert.strictEqual(await cohost.evaluate(() => window.__pickerDesktopCaptureCalls), 0);
		}

		await checkPicker(markerTitle, false);
		if (!expectVulnerable) {
			await checkPicker(ordinaryTitle, true);
			await cohost.reload();
			await cohost.waitForFunction(() => typeof ElectronDesktopCapture !== 'undefined' && ElectronDesktopCapture);
			await checkPicker(markerTitle, true);

			const dockUrl = `${pathToFileURL(path.join(sourceRoot, 'dock.html')).href}?session=title-e2e-${Date.now()}` +
				`&chatonly&server2=${encodeURIComponent(`ws://127.0.0.1:${server.address().port}/legacy-dock-relay`)}&server3`;
			await main.evaluate(url => { ipcRenderer.sendSync('createWindow', { url, visible: true }); }, dockUrl);
			const dock = await until(() => app.context().pages().find(page => page.url() === dockUrl), 'Dock window');
			// Source windows can use an isolated Playwright world. Observe the page's
			// real WebSocket readiness through CDP without replacing any page function.
			const cdp = await dock.context().newCDPSession(dock);
			async function dockReady() {
				await until(async () => {
					const result = await cdp.send('Runtime.evaluate', {
						expression: 'typeof socketserverExtension !== "undefined" && socketserverExtension.readyState === 1',
						returnByValue: true,
					});
					return result.result.value;
				}, 'Dock connected to legacy fixture relay');
			}
			async function checkDock() {
				await dockReady();
				await dock.locator('#getChatSources').click();
				await dock.locator('#chatDestinations:not(.hidden)').waitFor({ state: 'visible' });
				const rows = dock.locator('#chatDestinationsList > p');
				assert.strictEqual(await rows.count(), legacyTabs.length);
				for (let index = 0; index < legacyTabs.length; index++) {
					const tab = legacyTabs[index];
					const row = rows.nth(index);
					assert.strictEqual(await row.textContent(), `📄 ${tab.title.slice(0, 100)} - (${tab.url.slice(0, 100)})`);
					assert.strictEqual(await row.getAttribute('title'), `TabID: ${tab.id}`);
					assert.strictEqual(await row.locator('input').getAttribute('data-tab'), String(tab.id));
					assert.strictEqual(await row.locator('b, [data-ssapp-title-marker], [data-ssapp-title-attribute]').count(), 0);
				}
				const firstCheckbox = rows.first().locator('input');
				await firstCheckbox.check();
				assert.strictEqual(await firstCheckbox.isChecked(), true);
				await dock.locator('#tabslistclose').click();
				await dock.locator('#getChatSources').click();
				await dock.locator('#chatDestinations:not(.hidden)').waitFor({ state: 'visible' });
				assert.strictEqual(await rows.first().locator('input').isChecked(), true);
				await rows.first().locator('input').uncheck();
				await dock.locator('#tabslistclose').click();
			}
			await checkDock();
			await dock.reload();
			await checkDock();
			assert.strictEqual(dockRequests, 4);
			report.dock = { rawLegacyTitles: true, requests: dockRequests, reload: true, selectionPreservedOnReopen: true };
			console.log('Dock title E2E passed: raw legacy titles/URLs, literal entities, existing truncation, selection, reopen and reload.');
		}
		report.passed = true;
		console.log(expectVulnerable ? 'Confirmed title HTML/attribute injection with inert markup; cancelled before capture.' :
			'Co-host picker Electron E2E passed: literal labels/tooltips, native IDs/thumbnails, focus, Tab, Cancel, Escape, reopen and reload; no capture started.');
	} finally {
		fs.writeFileSync(path.join(profile, 'picker-results.json'), JSON.stringify(report, null, 2));
		console.log(`Evidence: ${path.join(profile, 'picker-results.json')}`);
		try { if (app) await app.close(); } finally {
			for (const socket of relay.clients) socket.terminate();
			await new Promise(resolve => relay.close(resolve));
			server.closeAllConnections();
			await new Promise(resolve => server.close(resolve));
		}
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
