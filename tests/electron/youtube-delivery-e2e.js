'use strict';

// Exact delivery checks through real source windows, background, local relay and dock.
// Native Windows: node tests/electron/youtube-delivery-e2e.js
// Live, read-only: --live-video=VIDEO_ID --minutes=15
// Reports/profiles stay outside the checkout; --output=DIR chooses their location.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const root = path.resolve(__dirname, '../..');
const sourceRoot = path.resolve(root, '../social_stream');
const base = pathToFileURL(sourceRoot + path.sep).href;
const option = (name, fallback) => process.argv.find(arg => arg.startsWith('--' + name + '='))?.split('=').slice(1).join('=') || fallback;
const liveVideo = option('live-video', '');
const minutes = Number(option('minutes', liveVideo ? '15' : '3'));
const output = path.resolve(option('output', path.join(os.tmpdir(), 'ssapp-youtube-delivery-' + Date.now())));
const captureRoot = path.resolve(option('capture-root', sourceRoot));
const captureBase = pathToFileURL(captureRoot + path.sep).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30000) {
	const end = Date.now() + timeout;
	let error;
	while (Date.now() < end) {
		try { const value = await check(); if (value) return value; } catch (e) { error = e.message; }
		await delay(100);
	}
	throw new Error('Timed out: ' + label + (error ? ': ' + error : ''));
}
function id(key) { return 'delivery-' + key + '-youtube-native-message-id-longer-than-forty-characters'; }

async function run() {
	if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('minutes must be positive');
	if (liveVideo && !/^[\w-]{11}$/.test(liveVideo)) throw new Error('Use a YouTube video ID');
	fs.mkdirSync(output, { recursive: true });
	const profile = fs.mkdtempSync(path.join(output, 'profile-'));
	const report = { mode: liveVideo ? 'live' : 'fixture', startedAt: new Date().toISOString(), profile,
		sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(captureRoot, 'sources/youtube.js'))).digest('hex'), cases: [] };
	const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
	function check(name, pass, details = {}) {
		report.cases.push({ name, pass, ...details }); save();
		console.log((pass ? 'PASS ' : 'FAIL ') + name + ' ' + JSON.stringify(details, (_key, value) =>
			Array.isArray(value) && value.length > 10 ? { count: value.length, first: value.slice(0, 5) } : value));
	}
	let app;
	let requestCount = 0;
	let initialKeys = ['old-history'];
	const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/hidden-capture.html'), 'utf8');
	const server = http.createServer((req, res) => {
		if (req.url.startsWith('/probe')) { requestCount++; res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end('ok'); return; }
		res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
		res.end(fixture.replace('</body>', '<script>' + fixtureSetup.toString() + ';fixtureSetup(' + JSON.stringify(initialKeys) + ');</script></body>'));
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const fixtureBase = 'http://127.0.0.1:' + server.address().port;
	const portServer = http.createServer();
	await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
	const relayPort = portServer.address().port;
	await new Promise(resolve => portServer.close(resolve));
	const room = 'youtube_delivery_' + Date.now();
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({ streamID: room, password: 'false', state: true,
		wsServer: true, settings: { server2: { setting: true } } }));
	try {
		app = await _electron.launch({ executablePath: require('electron'), cwd: root,
			args: ['.', '--running-from-source', '--filesource=' + base, '--multiinstance', '--disable-logs',
				'--ssapp-local-server-port=' + relayPort, '--num-raster-threads=2', ...linuxLaunchArgs()],
			env: { ...process.env, SSAPP_USER_DATA_DIR: profile, UV_THREADPOOL_SIZE: '2' }, timeout: 60000 });
		report.runtime = await app.evaluate(({ app }) => ({ app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome }));
		const main = await until(() => app.windows().find(page => page.url().includes('/index.html')), 'main');
		await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady);
		await delay(5000);
		const background = await until(async () => {
			const frame = main.frames().find(frame => frame.url().includes('/background.html'));
			return frame && await frame.evaluate(() => typeof handleRuntimeMessage === 'function' && loadedFirst) ? frame : null;
		}, 'background');
		await background.evaluate(() => {
			window.deliveryCaptured = [];
			const handle = handleRuntimeMessage;
			handleRuntimeMessage = function (request, ...args) {
				if (request.message?.meta?.messageId) deliveryCaptured.push({ id: request.message.meta.messageId, at: Date.now() });
				return handle(request, ...args);
			};
		});
		async function create(args) {
			await main.evaluate(value => {
				if (value.platform) { value.config = { ...config.global, ...config[value.platform] }; value.configs = config; }
				return ipcRenderer.sendSync('createWindow', value);
			}, args);
			return until(() => app.windows().find(page => page.url() === args.url), 'source window');
		}
		const dock = await create({ url: base + 'dock.html?session=' + room + '&password=false&server2&localserver&localserverport=' + relayPort, visible: false });
		const dockCdp = await dock.context().newCDPSession(dock);
		async function dockEval(expression) {
			const result = await dockCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
			if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
			return result.result.value;
		}
		await until(() => dockEval("typeof socketserverExtension !== 'undefined' && socketserverExtension?.readyState === 1"), 'dock relay');
		await until(() => background.evaluate(() => typeof socketserverDock !== 'undefined' && socketserverDock?.readyState === 1), 'background relay');
		await dockEval(`(${function () {
			window.deliveryDock = [];
			const seen = new WeakSet();
			new MutationObserver(() => {
				document.querySelectorAll('.highlight-chat').forEach(row => {
					const id = row.rawContents?.meta?.messageId;
					if (id && !seen.has(row)) { seen.add(row); deliveryDock.push({ id, at: Date.now() }); }
				});
			}).observe(document.body, { childList: true, subtree: true });
		}})()`);
		const ledgers = async () => ({ captured: await background.evaluate(() => deliveryCaptured), dock: await dockEval('deliveryDock') });
		async function exact(name, expected, excluded = []) {
			await delay(1000);
			const records = await ledgers();
			const details = {};
			for (const [stage, rows] of Object.entries(records)) {
				const counts = new Map(); rows.forEach(row => counts.set(row.id, (counts.get(row.id) || 0) + 1));
				details[stage] = { expected: expected.length, missing: expected.filter(key => !counts.get(id(key))),
					duplicates: expected.filter(key => counts.get(id(key)) > 1), unwanted: excluded.filter(key => counts.has(id(key))) };
			}
			check(name, Object.values(details).every(value => !value.missing.length && !value.duplicates.length && !value.unwanted.length), details);
		}
		const url = liveVideo ? 'https://www.youtube.com/live_chat?is_popout=1&v=' + liveVideo
			: fixtureBase + '/youtube.com/live_chat?platform=youtube&manual=1';
		const source = await create({ url, platform: 'youtube', sourceFiles: ['sources/youtube.js'], filesource: captureBase, visible: false });
		report.sourceErrors = [];
		source.on('pageerror', error => report.sourceErrors.push(error.message));
		source.on('console', message => { if (message.text().includes('[YouTube]')) { console.log(message.text()); } });
		if (liveVideo) {
			await runLive({ source, ledgers, report, check, save });
		} else {
			await source.waitForFunction(() => !!document.getElementById('items')?.skip);
			await source.evaluate(() => {
				window.deliveryDelaySetting = null;
				chrome.runtime.onMessage.addListener(message => {
					if (message.settings) window.deliveryDelaySetting = !!message.settings.delayyoutube;
				});
			});
			async function setCaptureDelay(value) {
				await source.evaluate(value => new Promise(resolve => chrome.runtime.sendMessage(chrome.runtime.id,
					{ cmd: 'saveSetting', setting: 'delayyoutube', value }, resolve)), value);
				await until(() => source.evaluate(value => deliveryDelaySetting === value, value), 'source received capture-delay setting');
			}
			await source.evaluate(() => addRow('control'));
			await until(async () => (await ledgers()).dock.some(row => row.id === id('control')), 'control capture');
			await exact('initial history excluded', ['control'], ['old-history']);
			await source.evaluate(() => {
				const old = document.getElementById('items'), next = old.cloneNode(false);
				['old-history', 'control', 'replace-1', 'replace-2', 'replace-3', 'replace-4', 'replace-5'].forEach(key => next.appendChild(makeRow(key)));
				old.replaceWith(next);
			});
			await delay(1600);
			await exact('rebuilt list: new rows once, history never', ['control', 'replace-1', 'replace-2', 'replace-3', 'replace-4', 'replace-5'], ['old-history']);
			await source.evaluate(() => {
				addRow('late-id', { idAfter: 650 });
				addRow('late-text', { textAfter: 3000 });
				addRow('late-author', { authorAfter: 3000 });
				addRow('very-late-text', { textAfter: 6500 });
				const missingAuthor = addRow('missing-author-node');
				missingAuthor.querySelector('#author-name').remove();
				setTimeout(() => missingAuthor.insertAdjacentHTML('afterbegin', '<span id="author-name">Delivery fixture</span>'), 3000);
				const temporaryId = addRow('temporary-id', { textAfter: 3000 });
				const finalId = temporaryId.id; temporaryId.id = 'temporary';
				setTimeout(() => temporaryId.id = finalId, 1000);
				const removed = addRow('deleted-before-ready', { textAfter: 2000 });
				setTimeout(() => removed.setAttribute('is-deleted', ''), 100);
			});
			await delay(8000);
			await exact('delayed ID, author and text; pending moderation', ['late-id', 'late-text', 'late-author', 'very-late-text', 'missing-author-node', 'temporary-id'], ['deleted-before-ready']);
			check('deleting an uncaptured row preserves earlier messages by that author',
				await dockEval(`Array.from(document.querySelectorAll('.highlight-chat')).some(row => row.rawContents?.meta?.messageId === ${JSON.stringify(id('control'))})`));
			await source.evaluate(() => {
				const row = document.querySelector('[data-delivery-key="late-text"]');
				row.querySelector('#message').textContent += ' edited';
				row.remove(); document.getElementById('items').appendChild(row);
				document.getElementById('items').appendChild(makeRow('late-text'));
			});
			await exact('edits, moves and duplicate IDs do not duplicate delivery', ['late-text']);
			await setCaptureDelay(true);
			await source.evaluate(() => {
				addRow('delayed-mode');
				const moderated = addRow('delayed-mode-deleted');
				setTimeout(() => moderated.setAttribute('is-deleted', ''), 500);
			});
			await delay(1000);
			check('configured moderation delay is respected', !(await ledgers()).captured.some(row => row.id === id('delayed-mode')));
			await delay(3500);
			await exact('configured delay delivers once and suppresses deleted rows', ['delayed-mode'], ['delayed-mode-deleted']);
			await setCaptureDelay(false);
			await source.evaluate(() => {
				performance.clearResourceTimings(); performance.setResourceTimingBufferSize(8);
				window.probeInterval = setInterval(() => fetch('/probe?t=' + Date.now()).then(response => response.text()), 200);
			});
			await until(() => source.evaluate(() => performance.getEntriesByType('resource').length === 8), 'timing buffer filled', 10000);
			const soakKeys = [];
			const end = Date.now() + minutes * 60000;
			let batch = 0;
			while (Date.now() < end) {
				const keys = Array.from({ length: 20 }, (_, i) => 'soak-' + batch + '-' + i); soakKeys.push(...keys);
				await source.evaluate(({ keys, replace }) => {
					if (replace) {
						const old = document.getElementById('items'), next = old.cloneNode(false);
						Array.from(old.children).slice(-100).forEach(row => next.appendChild(row.cloneNode(true)));
						keys.slice(0, 5).forEach(key => next.appendChild(makeRow(key))); old.replaceWith(next);
						keys = keys.slice(5);
					}
					keys.forEach(key => addRow(key));
					const items = document.getElementById('items');
					while (items.children.length > 150) items.firstElementChild.remove();
				}, { keys, replace: batch % 5 === 0 });
				batch++;
				if (batch % 10 === 0) console.log('PROGRESS fixture batches=' + batch + ' expected=' + soakKeys.length);
				await delay(1000);
			}
			await exact('hidden-window repeated replacement and pruning soak', soakKeys);
			// A real reload, after the real 60-second watchdog threshold. Fill its timing buffer
			// early without issuing thousands of requests. Only test-page timings are affected.
			initialKeys = [soakKeys[soakKeys.length - 1], 'reload-unseen-1', 'reload-unseen-2'];
			const beforeNavigation = await source.evaluate(() => performance.timeOrigin);
			let reloaded = false;
			try { await until(async () => await source.evaluate(() => performance.timeOrigin) !== beforeNavigation, 'watchdog reload', 75000); reloaded = true; } catch (_) { }
			check('stale recovery reloads after resource buffer fills', reloaded, { requests: requestCount,
				diagnostics: await source.evaluate(() => window.__deliveryDiagnostics ? __deliveryDiagnostics() : null) });
			if (reloaded) { await source.waitForFunction(() => !!document.getElementById('items')?.skip); await delay(2000); }
			await exact('recovery catches unseen backlog without replay', initialKeys);
			if (reloaded) {
				await source.evaluate(key => document.querySelector('[data-delivery-key="' + key + '"]').setAttribute('is-deleted', ''), initialKeys[0]);
				await delay(500);
				check('recovery preserves precise deletion IDs', await dockEval(`(() => {
					const ids = Array.from(document.querySelectorAll('.highlight-chat'), row => row.rawContents?.meta?.messageId);
					return !ids.includes(${JSON.stringify(id(initialKeys[0]))}) && ids.includes(${JSON.stringify(id('reload-unseen-1'))});
				})()`));
			}
			initialKeys = ['manual-history'];
			await source.reload(); await source.waitForFunction(() => !!document.getElementById('items')?.skip);
			await source.evaluate(() => addRow('after-manual-reload'));
			await exact('manual reload keeps normal history policy', ['after-manual-reload'], ['manual-history']);
			initialKeys = ['new-stream-history'];
			const nextStream = await create({ url: url + '&stream=next', platform: 'youtube', sourceFiles: ['sources/youtube.js'], filesource: captureBase, visible: false });
			await nextStream.waitForFunction(() => !!document.getElementById('items')?.skip);
			await nextStream.evaluate(() => addRow('new-stream-message'));
			await exact('new stream captures while previous window remains open', ['new-stream-message'], ['new-stream-history']);
		}
		report.finishedAt = new Date().toISOString(); save();
		if (report.cases.some(item => !item.pass)) process.exitCode = 1;
	} catch (error) { report.error = error.stack; save(); throw error; }
	finally { if (app) await app.close(); await new Promise(resolve => server.close(resolve)); }
	console.log('Report: ' + path.join(output, 'report.json'));
}

function fixtureSetup(initial) {
	window.makeRow = function (key, options = {}) {
		const row = document.createElement('yt-live-chat-text-message-renderer');
		row.dataset.deliveryKey = key;
		const nativeId = 'delivery-' + key + '-youtube-native-message-id-longer-than-forty-characters';
		if (!options.idAfter) row.id = nativeId;
		row.innerHTML = '<span id="author-name"></span><span id="message"></span>';
		if (!options.textAfter) row.querySelector('#message').textContent = key;
		if (!options.authorAfter) row.querySelector('#author-name').textContent = 'Delivery fixture';
		if (options.idAfter) setTimeout(() => row.id = nativeId, options.idAfter);
		if (options.textAfter) setTimeout(() => row.querySelector('#message').textContent = key, options.textAfter);
		if (options.authorAfter) setTimeout(() => row.querySelector('#author-name').textContent = 'Delivery fixture', options.authorAfter);
		return row;
	};
	window.addRow = function (key, options) { const row = makeRow(key, options); document.getElementById('items').appendChild(row); return row; };
	initial.forEach(key => addRow(key));
}

async function runLive({ source, ledgers, report, check, save }) {
	try {
		await source.waitForFunction(() => !!document.querySelector('yt-live-chat-app #items.yt-live-chat-item-list-renderer')?.skip, null, { timeout: 60000 });
	} catch (error) {
		report.livePageFailure = await source.evaluate(() => ({ url: location.href, title: document.title, text: document.body.innerText.slice(0, 1500) }));
		save(); throw error;
	}
	await delay(5000);
	report.livePage = await source.evaluate(() => ({ title: document.title, header: document.querySelector('yt-live-chat-header-renderer')?.innerText, url: location.href }));
	if (/camcam66gaming/i.test(JSON.stringify(report.livePage))) throw new Error('Excluded channel');
	save();
	console.log('LIVE PAGE ' + JSON.stringify(report.livePage));
	const initialIds = new Set(await source.evaluate(() => Array.from(document.querySelectorAll('yt-live-chat-text-message-renderer[id]'), row => row.id)));
	const cdp = await source.context().newCDPSession(source);
	await cdp.send('Network.enable');
	const requests = new Set(), expected = new Set(), deleted = new Set(), bodyReads = new Set(), authors = new Map();
	let responses = 0, bodyErrors = 0, collecting = true;
	cdp.on('Network.responseReceived', event => { if (collecting && /\/youtubei\/v1\/live_chat\/get_live_chat(?:\?|$)/.test(event.response.url)) requests.add(event.requestId); });
	cdp.on('Network.loadingFinished', event => {
		if (!requests.delete(event.requestId)) return;
		const promise = (async () => {
			try {
				const response = await cdp.send('Network.getResponseBody', { requestId: event.requestId });
				const json = JSON.parse(response.base64Encoded ? Buffer.from(response.body, 'base64').toString() : response.body);
				responses++;
				for (const action of json.continuationContents?.liveChatContinuation?.actions || []) {
					const row = action.addChatItemAction?.item?.liveChatTextMessageRenderer;
					if (row?.id && !initialIds.has(row.id)) { expected.add(row.id); authors.set(row.id, row.authorExternalChannelId); }
					if (action.removeChatItemAction?.targetItemId) deleted.add(action.removeChatItemAction.targetItemId);
					if (action.markChatItemAsDeletedAction?.targetItemId) deleted.add(action.markChatItemAsDeletedAction.targetItemId);
					const bannedAuthor = action.markChatItemsByAuthorAsDeletedAction?.externalChannelId;
					if (bannedAuthor) authors.forEach((author, id) => { if (author === bannedAuthor) deleted.add(id); });
				}
			} catch (_) { bodyErrors++; }
		})();
		bodyReads.add(promise); promise.finally(() => bodyReads.delete(promise));
	});
	await source.evaluate(() => {
		window.deliveryDom = new Set();
		const scan = () => document.querySelectorAll('yt-live-chat-text-message-renderer[id]').forEach(row => deliveryDom.add(row.id));
		scan(); new MutationObserver(scan).observe(document.querySelector('yt-live-chat-app'), { childList: true, subtree: true, attributes: true, attributeFilter: ['id'] });
	});
	const end = Date.now() + minutes * 60000;
	while (Date.now() < end) {
		await delay(Math.min(30000, Math.max(1, end - Date.now())));
		console.log('PROGRESS live responses=' + responses + ' expected=' + expected.size);
	}
	collecting = false;
	await Promise.all(Array.from(bodyReads)); await delay(8000);
	const records = await ledgers();
	const dom = new Set(await source.evaluate(() => Array.from(deliveryDom)));
	const eligible = Array.from(expected).filter(id => !deleted.has(id));
	const stages = {};
	for (const [stage, rows] of Object.entries(records)) {
		const counts = new Map(); rows.forEach(row => counts.set(row.id, (counts.get(row.id) || 0) + 1));
		stages[stage] = { missing: eligible.filter(id => !counts.has(id)), duplicates: eligible.filter(id => counts.get(id) > 1) };
	}
	report.live = { responses, bodyErrors, expected: expected.size, deleted: deleted.size, eligible: eligible.length,
		missingFromDom: eligible.filter(id => !dom.has(id)), stages };
	check('live response IDs reach capture and dock exactly once', eligible.length > 0 && bodyErrors === 0 && Object.values(stages).every(stage => !stage.missing.length && !stage.duplicates.length), report.live);
	save();
}

run().catch(error => { console.error(error); process.exitCode = 1; });
