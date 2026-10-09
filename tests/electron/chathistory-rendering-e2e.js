#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const APP_ROOT = path.resolve(__dirname, '../..');
const HISTORY_URL = pathToFileURL(path.join(APP_ROOT, 'chathistory.html')).href;
const SOURCE_ROOT = path.resolve(process.env.SOCIAL_STREAM_SOURCE_DIR || path.join(APP_ROOT, '../social_stream'));

async function waitFor(check, label) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function openWindow(app, main, url) {
	await main.evaluate(target => window.open(target, '_blank'), url);
	return waitFor(() => app.windows().find(page => page.url() === url), url);
}

async function inspectBodies(page, exported) {
	return page.evaluate(isExport => {
		const rows = document.querySelectorAll(isExport ? '.message' : '.message-wrapper');
		return Array.from(rows, row => {
			const body = row.querySelector(isExport ? 'p' : '.message-text');
			const name = row.querySelector(isExport ? '.username' : '.user-name');
			return {
				name: name.textContent,
				nameElements: name.children.length,
				text: body.textContent,
				elements: body.children.length,
				bold: body.querySelector('b')?.textContent || null,
				emotes: Array.from(body.querySelectorAll('img'), img => ({
					alt: img.alt, loaded: img.complete && img.naturalWidth > 0,
				})),
				unsafeElements: body.querySelectorAll('script,style,iframe,object,embed,svg,math,template').length,
				unsafeAttributes: Array.from(body.querySelectorAll('*')).flatMap(element =>
					Array.from(element.attributes).filter(attribute =>
						/^on/i.test(attribute.name) || ['style', 'srcdoc', 'srcset'].includes(attribute.name)
					).map(attribute => attribute.name)
				),
				unsafeLinks: Array.from(body.querySelectorAll('a[href]')).filter(link =>
					!['http:', 'https:'].includes(new URL(link.href).protocol)
				).length,
			};
		});
	}, exported);
}

async function verifyBodies(page, records, exported = false) {
	const imageSelector = exported ? '.message p img' : '.message-text img';
	await page.waitForFunction(selector => {
		const images = Array.from(document.querySelectorAll(selector));
		return images.length === 2 && images.every(img => img.complete && img.naturalWidth > 0);
	}, imageSelector);
	const rows = await inspectBodies(page, exported);
	assert.strictEqual(rows.length, records.length);
	for (const record of records) {
		const row = rows.find(item => item.name === record.chatname);
		assert.ok(row, `Missing row: ${record.chatname}`);
		assert.strictEqual(row.nameElements, 0, 'Names must remain literal');
		assert.strictEqual(row.unsafeElements, 0, 'Executable/embedded elements must be removed');
		assert.deepStrictEqual(row.unsafeAttributes, [], 'Event handlers and unsafe attributes must be removed');
		assert.strictEqual(row.unsafeLinks, 0, 'Unsafe link protocols must be removed');
		if (record.textonly) {
			assert.strictEqual(row.text, record.chatmessage, 'Literal characters/entities must survive unchanged');
			assert.strictEqual(row.elements, 0, 'Text-only bodies must contain no elements');
		} else {
			assert.strictEqual(row.bold, 'Rich formatting');
			assert.ok(row.text.includes('<literal> & entity'), 'Rich entities must decode exactly once');
			assert.deepStrictEqual(row.emotes, [{ alt: 'Emote & "label"', loaded: true }]);
		}
	}
}

async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-history-rendering-'));
	const requests = [];
	const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
	const fixture = http.createServer((request, response) => {
		requests.push(request.url);
		response.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
		response.end(gif);
	});
	await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${fixture.address().port}`;
	// Empty scripts/handlers are inert markers. No supplied JavaScript is executed.
	const literal = `<b>Literal tags</b> &lt;literal&gt; & "quotes"\n<img src="${origin}/literal-only.gif" onerror="">`;
	const rich = `<b>Rich formatting</b> <span>&lt;literal&gt; &amp; entity</span>` +
		`<img src="${origin}/emote.gif" alt="Emote &amp; &quot;label&quot;" onload="" onerror="" srcset="${origin}/blocked-srcset.gif 2x" style="display:none">` +
		`<a href="javascript:/* inert */" onclick="">Blocked link</a><script></script>` +
		`<iframe src="${origin}/blocked-frame"></iframe><svg></svg><math></math>`;
	const records = [
		{ id: 1, chatname: 'Literal <b>name</b>', chatmessage: literal, textonly: true },
		{ id: 2, chatname: 'Rich', chatmessage: rich, textonly: false },
		{ id: 3, chatname: 'Legacy missing flag', chatmessage: rich },
		{ id: 4, chatname: 'Literal rich-looking body', chatmessage: rich, textonly: true },
	].map(record => ({ ...record, timestamp: Date.now() - 1000, chatimg: `${origin}/avatar.gif` }));
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
		streamID: 'history_rendering_fixture', password: 'false', state: false, settings: {},
	}));
	let app;
	let log;
	let passed = false;
	try {
		for (const phase of ['initial', 'restart']) {
			const env = { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_DEBUG_LOGS: '0' };
			delete env.ELECTRON_RUN_AS_NODE;
			app = await _electron.launch({
				executablePath: require('electron'), cwd: APP_ROOT, env, timeout: 60000,
				args: ['.', '--multiinstance', '--running-from-source', '--disable-logs',
					`--filesource=${pathToFileURL(SOURCE_ROOT + path.sep).href}`,
					`--savefolder=${profile}${path.sep}`, ...linuxLaunchArgs()],
			});
			log = fs.createWriteStream(path.join(profile, `${phase}.log`));
			app.process().stdout.pipe(log, { end: false });
			app.process().stderr.pipe(log, { end: false });
			const main = await app.firstWindow();
			await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady);
			const history = await openWindow(app, main, HISTORY_URL);
			history.on('console', message => {
				if (message.type() === 'error') console.error(`[History renderer] ${message.text()}`);
			});
			history.on('pageerror', error => console.error(`[History renderer] ${error.message}`));
			// Observe actual Electron download completion and choose a destination
			// inside the disposable profile, without interacting with a save dialog.
			await app.evaluate(({ BrowserWindow }, { url, directory }) => {
				const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === url);
				const path = process.getBuiltinModule('path');
				global.__historyDownload = null;
				window.webContents.session.on('will-download', (_event, item) => {
					const target = path.join(directory, path.basename(item.getFilename()));
					item.setSavePath(target);
					global.__historyDownload = { path: target, state: 'started' };
					item.once('done', (_event, state) => { global.__historyDownload.state = state; });
				});
			}, { url: HISTORY_URL, directory: profile });
			await history.waitForFunction(() => typeof db !== 'undefined' && db && !isLoading);
			if (phase === 'initial') {
				await history.evaluate(rows => new Promise((resolve, reject) => {
					const transaction = db.transaction(['messages'], 'readwrite');
					const store = transaction.objectStore('messages');
					rows.forEach(row => store.put(row));
					transaction.oncomplete = resolve;
					transaction.onerror = () => reject(transaction.error);
				}), records);
				await history.reload();
			}
			await history.waitForFunction(() => document.querySelectorAll('.message-wrapper').length === 4);
			await verifyBodies(history, records);
			await history.locator('#keyword-filter').fill('Literal tags');
			await history.waitForFunction(() => document.querySelectorAll('.message-wrapper').length === 1);
			assert.strictEqual(await history.locator('.message-text').textContent(), literal);
			await history.locator('#clear-filters').click();
			await history.waitForFunction(() => document.querySelectorAll('.message-wrapper').length === 4);
			await verifyBodies(history, records);
			await history.locator('#export-format').selectOption('html');
			await history.locator('#export-timeframe').selectOption('all');
			await history.locator('#export-button').click();
			const download = await waitFor(() => app.evaluate(() => {
				const download = global.__historyDownload;
				return download && download.state !== 'started' ? download : null;
			}), 'HTML export download');
			assert.strictEqual(download.state, 'completed');
			const exportPath = download.path;
			assert.ok(fs.existsSync(exportPath));
			const exported = await openWindow(app, main, pathToFileURL(exportPath).href);
			await verifyBodies(exported, records, true);
			await history.reload();
			await history.waitForFunction(() => document.querySelectorAll('.message-wrapper').length === 4);
			await verifyBodies(history, records);
			assert.deepStrictEqual(await history.evaluate(() => new Promise((resolve, reject) => {
				const request = db.transaction(['messages'], 'readonly').objectStore('messages').getAll();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			})), records, 'Rendering and export must not mutate stored messages');
			await history.waitForTimeout(1000);
			assert.ok(requests.includes('/emote.gif'), 'Real emote loading must be exercised');
			assert.ok(requests.every(url => ['/emote.gif', '/avatar.gif'].includes(url)),
				`Literal or removed markup made a request: ${JSON.stringify(requests)}`);
			console.log(`Local history ${phase}: literal/rich/legacy display, filtering, HTML download, exported page and reload passed`);
			await app.close();
			app = null;
			await new Promise(resolve => log.end(resolve));
			log = null;
		}
		passed = true;
	} finally {
		if (app) await app.close().catch(() => {});
		if (log) await new Promise(resolve => log.end(resolve));
		fixture.closeAllConnections();
		await new Promise(resolve => fixture.close(resolve));
		if (passed) {
			const target = path.resolve(profile);
			assert.strictEqual(path.dirname(target), path.resolve(os.tmpdir()));
			assert.ok(path.basename(target).startsWith('ssapp-history-rendering-'));
			fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
		} else {
			console.error(`History test profile/logs retained: ${profile}`);
		}
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
