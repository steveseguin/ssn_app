'use strict';

// Exercise real capture -> existing SSApp IPC -> background -> local relay -> dock.
// Do not prefill dataset.mid: that hides the broken app callback this test guards.
// Only local chat fixtures are used; no live channels or account actions.
const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const root = path.resolve(__dirname, '../..');
const sourceRoot = path.resolve(root, '../social_stream');
const base = pathToFileURL(sourceRoot + path.sep).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeout = 20000) {
	const end = Date.now() + timeout;
	let last;
	while (Date.now() < end) {
		try { const value = await check(); if (value) return value; } catch (error) { last = error.message; }
		await delay(100);
	}
	throw new Error(`Timed out: ${label}${last ? ' (' + last + ')' : ''}`);
}

async function freePort() {
	const server = net.createServer();
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-youtube-mid-'));
	const relayPort = await freePort();
	const room = 'youtube_mid_' + Date.now();
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
		streamID: room, password: 'false', state: true, wsServer: true,
		settings: { server2: { setting: true } },
	}));
	let app;
	try {
		app = await _electron.launch({
			executablePath: require('electron'), cwd: root,
			args: ['.', '--running-from-source', '--filesource=' + base, '--multiinstance',
				'--disable-logs', '--ssapp-local-server-port=' + relayPort, ...linuxLaunchArgs()],
			env: { ...process.env, SSAPP_USER_DATA_DIR: profile, UV_THREADPOOL_SIZE: '2' }, timeout: 60000,
		});
		const main = await until(() => app.windows().find(page => page.url().includes('/index.html')), 'main');
		await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady);
		// Startup can replace the background frame while selecting the local core.
		await delay(5000);
		const background = await until(async () => {
			const frame = main.frames().find(frame => frame.url().includes('/background.html'));
			return frame && await frame.evaluate(() => typeof handleRuntimeMessage === 'function' && loadedFirst) ? frame : null;
		}, 'background');
		await background.evaluate(() => {
			window.midTestDeletes = [];
			window.midTestFallbacks = [];
			window.midTestHeldReplies = [];
			const ipcSend = ipcRenderer.send.bind(ipcRenderer);
			ipcRenderer.send = function (channel, response, reply) {
				if (channel === 'fromBackgroundResponse' && reply && window.midTestTimeoutId !== undefined && response?.id === window.midTestTimeoutId) {
					midTestHeldReplies.push([channel, response, reply]);
					return;
				}
				return ipcSend(...arguments);
			};
			window.midTestReleaseReplies = () => midTestHeldReplies.splice(0).forEach(args => ipcSend(...args));
			const runtimeHandler = handleRuntimeMessage;
			handleRuntimeMessage = function (request, ...args) {
				if (request.message?.chatmessage === 'error-callback') return Promise.reject(new Error('Fixture processing failure'));
				if (['timeout-callback', 'timeout-source-callback', 'state-during-capture'].includes(request.message?.chatmessage)) {
					const callback = args[1];
					args[1] = function (response) {
						window.midTestTimeoutId = response.id;
						return callback(response);
					};
				}
				return runtimeHandler(request, ...args);
			};
			const tabSend = chrome.tabs.sendMessage;
			chrome.tabs.sendMessage = function (tab, message, ...args) {
				if (message?.youtubeMessageResponse) midTestFallbacks.push({ tab, message });
				return tabSend(tab, message, ...args);
			};
			const send = sendToDestinations;
			sendToDestinations = function (message, ...args) {
				if (message.delete) midTestDeletes.push(JSON.parse(JSON.stringify(message.delete)));
				return send(message, ...args);
			};
			const actions = applyBotActions;
			applyBotActions = async function (message, ...args) {
				if (['delete-while-pending', 'concurrent-0', 'closing-source', 'reloading-source', 'state-during-capture'].includes(message.chatmessage)) {
					await new Promise(resolve => setTimeout(resolve, 900));
				}
				return actions(message, ...args);
			};
		});
		async function create(args) {
			await main.evaluate(value => {
				if (value.platform) {
					value.config = { ...config.global, ...config[value.platform] };
					if (value.wss && value.config.wss) value.config = { ...value.config, ...value.config.wss };
					value.configs = config;
				}
				return ipcRenderer.sendSync('createWindow', value);
			}, args);
			return until(() => app.windows().find(page => page.url() === args.url), 'source window');
		}
		await app.evaluate(({ app }) => {
			globalThis.midTestDefaultInjections = [];
			app.on('web-contents-created', (_event, contents) => {
				const execute = contents.executeJavaScriptInIsolatedWorld.bind(contents);
				contents.executeJavaScriptInIsolatedWorld = function (world, scripts, ...args) {
					const result = execute(world, scripts, ...args);
					if (scripts.some(script => script.code.includes('Simple callback with empty response for now'))) {
						result.then(() => midTestDefaultInjections.push('ok'), error => midTestDefaultInjections.push(error.message));
					}
					return result;
				};
			});
		});
		const dock = await create({
			url: base + 'dock.html?session=' + room + '&password=false&server2&localserver&localserverport=' + relayPort,
			visible: false,
		});
		await until(() => app.evaluate(() => midTestDefaultInjections.length), 'default bridge injection completed');
		assert.deepEqual(await app.evaluate(() => midTestDefaultInjections), ['ok'], 'Default bridge injection must return a serializable result');
		console.log('PASS default bridge injection completes without a clone error');
		const dockCdp = await dock.context().newCDPSession(dock);
		async function dockEval(expression) {
			const result = await dockCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
			if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
			return result.result.value;
		}
		const rows = () => dockEval("Array.from(document.querySelectorAll('.highlight-chat')).map(row => ({mid:row.dataset.mid,text:row.rawContents?.chatmessage,type:row.dataset.sourceType}))");
		await until(() => dockEval("typeof socketserverExtension !== 'undefined' && socketserverExtension?.readyState === 1"), 'dock relay');
		await until(() => background.evaluate(() => typeof socketserverDock !== 'undefined' && socketserverDock?.readyState === 1), 'background relay');
		const fixture = pathToFileURL(path.join(root, 'tests/electron/fixtures/hidden-capture.html')).href;
		async function source(index) {
			const page = await create({ url: fixture + '?platform=youtube&manual=1&window=' + index,
				platform: 'youtube', sourceFiles: ['sources/youtube.js'], filesource: base, visible: false });
			await page.waitForFunction(() => !!document.getElementById('items')?.skip);
			return page;
		}
		const first = await source(1);
		const callbackReply = await first.evaluate(() => new Promise(resolve => {
			chrome.runtime.sendMessage(chrome.runtime.id, {
				message: { type: 'youtube', chatname: 'Callback fixture', chatmessage: 'real-callback' },
			}, resolve);
		}));
		assert.ok(Number.isSafeInteger(callbackReply.id), 'App callback must return the real background MID');
		await until(async () => (await rows()).some(row => row.text === 'real-callback'), 'callback capture');
		assert.equal((await rows()).find(row => row.text === 'real-callback').mid, String(callbackReply.id));
		console.log('PASS original capture callback returns the background MID');
		async function insert(page, key) {
			await page.evaluate(key => {
				const row = document.createElement('yt-live-chat-text-message-renderer');
				row.id = key + '-native-youtube-message-id-longer-than-forty-characters';
				row.dataset.fixtureKey = key;
				row.innerHTML = '<span id="author-name">Same Author</span><span id="message"></span>';
				row.querySelector('#message').textContent = key;
				document.getElementById('items').appendChild(row);
			}, key);
		}
		async function midFor(page, key) {
			return until(() => page.evaluate(key => document.querySelector('[data-fixture-key="' + key + '"]')?.dataset.mid, key),
				'SSN MID returned to captured YouTube row ' + key, 8000);
		}
		async function capture(page, key) {
			await insert(page, key);
			const mid = await midFor(page, key);
			assert.ok(Number.isSafeInteger(Number(mid)) && Number(mid) > 0, 'MID must be numeric');
			await until(async () => (await rows()).some(row => row.text === key), 'dock capture ' + key);
			assert.equal((await rows()).find(row => row.text === key).mid, mid, 'Source and dock must use the same MID');
			return Number(mid);
		}
		async function remove(page, key) {
			await page.evaluate(key => {
				const row = document.querySelector('[data-fixture-key="' + key + '"]');
				row.querySelector('#author-name')?.remove();
				row.setAttribute('is-deleted', '');
			}, key);
		}
		const a = await capture(first, 'first-message');
		const b = await capture(first, 'second-message');
		assert.ok(b > a, 'MIDs must increase');
		await remove(first, 'first-message');
		await until(async () => !(await rows()).some(row => row.text === 'first-message'), 'targeted deletion');
		assert.ok((await rows()).some(row => row.text === 'second-message'), 'Keep other messages from the same author');
		const deletion = await background.evaluate(() => midTestDeletes[0]);
		assert.equal(deletion.id, a);
		assert.ok(!deletion.meta?.messageId, 'Dock deletion must use SSN MID, not YouTube ID');
		console.log('PASS real YouTube capture receives MID; precise deletion after author removal');

		const second = await source(2);
		const mids = await Promise.all(Array.from({ length: 20 }, (_, index) => capture(index % 2 ? first : second, 'concurrent-' + index)));
		assert.equal(new Set(mids).size, mids.length, 'Concurrent windows must never allocate duplicate MIDs');
		assert.ok(mids.every(mid => mid > b));
		console.log('PASS 20 concurrent messages across two source windows have unique numeric MIDs');
		await insert(first, 'delete-while-pending');
		await until(() => first.evaluate(() => document.querySelector('[data-fixture-key="delete-while-pending"]')?.skip), 'pending capture');
		await remove(first, 'delete-while-pending');
		await midFor(first, 'delete-while-pending');
		await delay(1500);
		assert.ok(!(await rows()).some(row => row.text === 'delete-while-pending'), 'Deleted pending message must not reappear');
		assert.ok((await rows()).some(row => row.text === 'second-message'));
		console.log('PASS deletion while background processing is pending');
		assert.equal(await background.evaluate(() => midTestFallbacks.length), 23,
			'YouTube gets an independent MID reply before processing can time out');
		await background.evaluate(() => { midTestFallbacks.length = 0; });

		// Exercise the unchanged old IPC path: forward without a response request,
		// and return the legacy immediate state-only acknowledgement to the source.
		const legacy = await source(3);
		await legacy.evaluate(() => {
			const send = chrome.runtime.sendMessage;
			chrome.runtime.sendMessage = function (id, request, callback) {
				if (request.message) {
					send(id, request);
					if (callback) callback({ state: true });
				} else send(id, request, callback);
			};
		});
		await capture(legacy, 'legacy-first');
		await capture(legacy, 'legacy-second');
		await remove(legacy, 'legacy-first');
		await until(async () => !(await rows()).some(row => row.text === 'legacy-first'), 'legacy deletion');
		assert.ok((await rows()).some(row => row.text === 'legacy-second'));
		assert.equal(await background.evaluate(() => midTestFallbacks.length), 2);
		await background.evaluate(() => {
			const { tab, message } = midTestFallbacks[0];
			chrome.tabs.sendMessage(tab, message, function () {});
		});
		await delay(200);
		assert.ok((await rows()).some(row => row.text === 'legacy-second'));
		console.log('PASS legacy app reply path still receives MID; duplicate fallback is ignored');

		for (const type of ['twitch', 'kick']) {
			const page = await create({ url: fixture + '?platform=' + type + '&manual=1',
				platform: type, sourceFiles: ['sources/' + type + '.js'], filesource: base, visible: false });
			await page.waitForFunction(() => !!window.__hiddenCaptureFixture);
			if (type === 'kick') await page.evaluate(() => {
				const feed = document.getElementById('chatroom');
				const wrapper = document.createElement('div');
				wrapper.id = 'chatroom-messages';
				feed.parentNode.insertBefore(wrapper, feed);
				wrapper.appendChild(feed);
			});
			// Allow the shipped source's observer to attach before adding live rows.
			await delay(6000);
			for (const id of [type + '-one', type + '-two']) {
				await page.evaluate(id => window.__hiddenCaptureFixture.appendRows([id]), id);
				await until(() => page.evaluate(id => document.getElementById('ssn-hidden-capture-' + id)?.dataset.mid, id), type + ' source MID');
			}
			const sourceMids = await page.evaluate(() => Array.from(document.querySelectorAll('.ssn-chat-row')).map(row => Number(row.dataset.mid)));
			assert.ok(sourceMids.every(Number.isSafeInteger));
			assert.ok(sourceMids[1] > sourceMids[0]);
			await until(async () => (await rows()).filter(row => row.type === type).length === 2, type + ' dock rows');
			assert.deepEqual((await rows()).filter(row => row.type === type).map(row => Number(row.mid)).sort((a,b) => a-b), sourceMids);
			await page.evaluate(type => {
				const row = document.querySelector('.ssn-chat-row');
				if (type === 'twitch') row.classList.add('chat-line__message--deleted-notice');
				else {
					const marker = document.createElement('span');
					marker.className = 'deleted-message';
					row.appendChild(marker);
				}
			}, type);
			await until(async () => !(await rows()).some(row => Number(row.mid) === sourceMids[0]), type + ' targeted deletion');
			assert.ok((await rows()).some(row => Number(row.mid) === sourceMids[1]));
			console.log('PASS real ' + type + ' capture receives MID and deletes only the intended message');
		}

		// Exercise the same background handler Chrome calls, with its ordinary callback.
		const extensionMID = await background.evaluate(async () => {
			let response;
			await handleRuntimeMessage({ message: { type: 'youtube', chatname: 'Extension fixture', chatmessage: 'extension-callback' } },
				{ tab: { id: 987654, url: 'https://www.youtube.com/live_chat' } }, value => { response = value; });
			return response.id;
		});
		assert.ok(extensionMID > Math.max(...mids));
		await until(async () => (await rows()).some(row => row.text === 'extension-callback'), 'extension callback row');
		assert.equal((await rows()).find(row => row.text === 'extension-callback').mid, String(extensionMID));
		console.log('PASS extension background callback keeps the same MID contract');

		const reloading = await source(4);
		await insert(reloading, 'reloading-source');
		await until(() => reloading.evaluate(() => document.querySelector('[data-fixture-key="reloading-source"]')?.skip), 'capture before reload');
		await reloading.reload();
		await reloading.waitForFunction(() => !!document.getElementById('items')?.skip);
		await capture(reloading, 'after-reload');
		const closing = await source(5);
		await insert(closing, 'closing-source');
		await until(() => closing.evaluate(() => document.querySelector('[data-fixture-key="closing-source"]')?.skip), 'capture before close');
		await app.evaluate(({ BrowserWindow }, url) => {
			const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url);
			win.destroy();
		}, closing.url());
		await delay(1200);
		await capture(first, 'after-source-close');
		console.log('PASS source reload and closure during pending replies; later capture still works');

		const failure = await first.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage(chrome.runtime.id,
			{ message: { type: 'youtube', chatname: 'Fixture', chatmessage: 'error-callback' } }, resolve)));
		assert.equal(failure.error, 'Fixture processing failure');
		const nativeReply = await first.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage(chrome.runtime.id,
			{ message: { id: 'existing-native-id', type: 'fixture', chatname: 'Fixture', chatmessage: 'preassigned-id' } }, resolve)));
		assert.equal(nativeReply.id, 'existing-native-id', 'Existing IDs must not be replaced by another allocator');
		await first.evaluate(() => {
			window.midTestStateReply = null;
			chrome.runtime.sendMessage(chrome.runtime.id,
				{ message: { type: 'youtube', chatname: 'Fixture', chatmessage: 'state-during-capture' } },
				response => { midTestStateReply = response; });
		});
		await delay(200);
		await background.evaluate(() => {
			isExtensionOn = false;
			ipcRenderer.send('fromBackgroundResponse', { state: false });
		});
		await until(() => background.evaluate(() => midTestHeldReplies.length === 1), 'held reply before state changes');
		await background.evaluate(() => midTestReleaseReplies());
		await until(() => first.evaluate(() => midTestStateReply), 'delayed reply after state change');
		assert.equal(await main.evaluate(() => ipcRenderer.sendSync('postMessage', { getSettings: true }).state), false,
			'A delayed capture reply must not overwrite newer app state');
		await background.evaluate(() => {
			isExtensionOn = true;
			ipcRenderer.send('fromBackgroundResponse', { state: true });
		});
		console.log('PASS delayed replies cannot overwrite newer app state');
		await first.evaluate(() => {
			window.midTestTimeoutResponses = [];
			chrome.runtime.sendMessage(chrome.runtime.id,
				{ message: { type: 'youtube', chatname: 'Fixture', chatmessage: 'timeout-callback' } },
				response => midTestTimeoutResponses.push(response));
		});
		await until(() => background.evaluate(() => midTestHeldReplies.length === 1), 'held callback response');
		await insert(first, 'timeout-source-callback');
		await until(() => background.evaluate(() => midTestHeldReplies.length === 2), 'held source callback');
		await midFor(first, 'timeout-source-callback');
		await remove(first, 'timeout-source-callback');
		await until(() => first.evaluate(() => midTestTimeoutResponses.length === 1), 'callback timeout', 35000);
		assert.match((await first.evaluate(() => midTestTimeoutResponses[0])).error, /timed out/);
		await background.evaluate(() => midTestReleaseReplies());
		await delay(200);
		assert.equal(await first.evaluate(() => midTestTimeoutResponses.length), 1, 'Late response must not call an expired callback');
		assert.ok(!(await rows()).some(row => row.text === 'timeout-source-callback'), 'Deletion survives original callback timeout through independent MID reply');
		await capture(first, 'after-timeout');
		console.log('PASS processing errors, existing IDs, timeout cleanup, and ignored late replies');
		await delay(2000);
		assert.ok(!(await rows()).some(row => ['first-message', 'delete-while-pending'].includes(row.text)));

		const bridgeSource = await source(10);
		await bridgeSource.evaluate(() => {
			window.bridgeMessages = [];
			chrome.runtime.onMessage.addListener(message => { if (message.bridgeProbe) bridgeMessages.push('first'); });
			chrome.runtime.onMessage.addListener(message => { if (message.bridgeProbe) bridgeMessages.push('second'); });
		});
		const bridgeTab = await bridgeSource.evaluate(() => window.__SSAPP_TAB_ID__);
		await background.evaluate(tab => { chrome.tabs.sendMessage(tab, { bridgeProbe: true }, function () {}); }, bridgeTab);
		await until(() => bridgeSource.evaluate(() => bridgeMessages.length === 2), 'both incoming listeners');
		assert.deepEqual(await bridgeSource.evaluate(() => bridgeMessages), ['first', 'second']);
		await capture(bridgeSource, 'capture-after-listeners');
		await background.evaluate(() => {
			settings.midRegressionSetting = { setting: true };
			ipcRenderer.send('fromBackgroundResponse', { state: isExtensionOn, settings });
		});
		await until(() => bridgeSource.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage(chrome.runtime.id,
			{ getSettings: true }, response => resolve(response.settings.midRegressionSetting?.setting)))), 'current settings');
		console.log('PASS multiple incoming listeners, original YouTube listener, and live getSettings');
		console.log('PASS YouTube MID end-to-end regression. Isolated profile:', profile);
	} finally {
		if (app) await app.close();
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
