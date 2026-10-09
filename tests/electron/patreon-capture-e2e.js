'use strict';

// Local Patreon DOM replay through real SSApp windows, preload, injection, and IPC.
// No login, archived member content, or messages to real channels are used.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const root = path.resolve(__dirname, '../..');
const sourceBase = pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href;
const fixtureUrl = 'https://www.patreon.com/ssapp-fixture/events/1';
const otherUrl = 'https://arena.social/live/ssapp-patreon-regression-fixture';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-patreon-capture-'));
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
		streamID: 'patreon_fixture_' + Date.now(), password: 'false', state: true, settings: {},
	}));
	console.log('Launching isolated SSApp');
	const app = await _electron.launch({
		executablePath: require('electron'), cwd: root,
		args: ['.', '--running-from-source', '--filesource=' + sourceBase, '--multiinstance', '--disable-logs', ...linuxLaunchArgs()],
		env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000,
	});
	try {
		await app.evaluate(({ app, ipcMain, session }, urls) => {
			global.__patreonMessages = [];
			ipcMain.on('postMessage', (_event, payload) => {
				if (['patreon', 'arenasocial'].includes(payload?.message?.type)) global.__patreonMessages.push(payload.message);
			});
			const install = target => target.protocol.handle('https', request => {
				if (request.url === urls.fixtureUrl) return new Response('<!doctype html><html><body><div data-testid="virtuoso-list"></div><textarea id="send-message"></textarea></body></html>', { headers: { 'content-type': 'text/html' } });
				if (request.url === urls.otherUrl) return new Response('<!doctype html><html><body><div data-testid="virtuoso-item-list"></div></body></html>', { headers: { 'content-type': 'text/html' } });
				return target.fetch(request, { bypassCustomProtocolHandlers: true });
			});
			app.on('session-created', install);
			install(session.defaultSession);
		}, { fixtureUrl, otherUrl });
		console.log('SSApp launched');
		const main = await app.firstWindow();
		await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady, null, { timeout: 60000 });
		async function openSource(url, platform, file) {
			const pending = app.waitForEvent('window');
			await main.evaluate(data => ipcRenderer.sendSync('createWindow', data), {
				url, visible: true, platform, sourceFiles: [file], filesource: sourceBase,
			});
			return pending;
		}
		console.log('Main window ready');
		const source = await openSource(fixtureUrl, 'patreon', 'sources/patreon.js');
		await source.waitForSelector('[data-testid="virtuoso-list"]', { state: 'attached' });
		await source.evaluate(() => {
			window.list = () => document.querySelector('[data-testid="virtuoso-list"]');
			window.row = (id, index, text, name = 'Steve & QA', header = true) => {
				const e = document.createElement('div');
				e.dataset.index = index;
				e.dataset.knownSize = '54';
				e.innerHTML = '<div data-tag="chat-message"><picture><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></picture><div class="ChatMessageView-module__fixture__messageBubbleTopHeader"></div><p data-tag="chat-message-text-content"></p></div>';
				e.firstElementChild.dataset.id = id;
				e.querySelector('img').alt = name + "'s profile picture";
				if (header) { const strong = document.createElement('strong'); strong.textContent = name; e.querySelector('[class]').append(strong); }
				e.querySelector('p').textContent = text;
				return e;
			};
		});
		const messages = () => app.evaluate(() => global.__patreonMessages);
		async function expectMessages(expected) {
			const deadline = Date.now() + 10000;
			while ((await messages()).length < expected.length && Date.now() < deadline) await delay(100);
			assert.deepEqual((await messages()).map(m => m.chatmessage), expected);
		}
		// Let normal source injection attach to an empty chat before its first live message.
		await delay(4000);
		const expected = [];
		async function expectNext(text) { expected.push(text); await expectMessages(expected); console.log('PASS ' + text); }
		await source.evaluate(() => list().append(row('a', 0, 'first')));
		await expectNext('first');
		assert.equal((await messages())[0].chatname, 'Steve & QA');
		await source.evaluate(() => list().append(row('b', 0, 'same row index', 'Second author', false)));
		await expectNext('same row index');
		assert.equal((await messages())[1].chatname, 'Second author');
		await source.evaluate(() => { const e = row('c', 1, ''); e.dataset.knownSize = '0'; list().append(e); });
		await delay(500);
		await source.evaluate(() => { list().lastElementChild.querySelector('p').textContent = 'hydrated'; });
		await expectNext('hydrated');
		await source.evaluate(() => { const e = list().lastElementChild; e.firstElementChild.dataset.id = 'd'; e.querySelector('p').textContent = 'recycled'; });
		await expectNext('recycled');
		await source.evaluate(() => { list().append(list().firstElementChild.cloneNode(true)); list().replaceWith(list().cloneNode(true)); });
		await delay(2200);
		await expectMessages(expected);
		await source.evaluate(() => list().append(row('e', 0, 'after remount')));
		await expectNext('after remount');
		await source.evaluate(() => { history.pushState({}, '', '/ssapp-fixture/events/2'); list().replaceChildren(row('history', 0, 'archive')); });
		await delay(1500);
		await expectMessages(expected);
		await source.evaluate(() => list().append(row('a', 0, 'second event')));
		await expectNext('second event');
		await source.evaluate(() => { history.pushState({}, '', '/ssapp-fixture/events/1'); list().replaceChildren(row('a', 99, 'first')); });
		await delay(1500);
		await expectMessages(expected);
		await source.evaluate(() => { history.replaceState({}, '', location.pathname + '?tracking=1#chat'); list().append(row('f', 0, 'tracking unchanged')); });
		await expectNext('tracking unchanged');

		// Closed archive remains idle across remounts while another source keeps capturing.
		await source.evaluate(() => { document.querySelector('textarea').disabled = true; document.querySelector('textarea').placeholder = 'This chat has closed'; list().append(row('closed', 5, 'closed history')); });
		const other = await openSource(otherUrl, 'arenasocial', 'sources/arenasocial.js');
		await other.waitForSelector('[data-testid="virtuoso-item-list"]', { state: 'attached' });
		await other.evaluate(() => {
			window.addOther = index => {
				const e = document.createElement('div'); e.dataset.index = index; e.dataset.knownSize = '46';
				e.innerHTML = '<li><div class="grow text-sm"><span role="button">Other author</span><div class="inline"><span>other ' + index + '</span></div></div></li>';
				document.querySelector('[data-testid="virtuoso-item-list"]').append(e);
			};
			addOther(0);
		});
		await expectNext('other 0');
		for (let i = 1; i <= 3; i++) {
			await source.evaluate(() => list().replaceWith(list().cloneNode(true)));
			await delay(3000);
			await other.evaluate(i => addOther(i), i);
			await expectNext('other ' + i);
		}
		await source.evaluate(() => { document.querySelector('textarea').disabled = false; list().append(row('g', 0, 'reopened')); });
		await expectNext('reopened');
		await source.evaluate(() => list().remove());
		await delay(1500);
		await source.evaluate(() => { const e = document.createElement('div'); e.dataset.testid = 'virtuoso-list'; document.body.append(e); });
		await delay(1500);
		await source.evaluate(() => list().append(row('h', 0, 'returned panel')));
		await expectNext('returned panel');
		// A disabled composer alone may mean a read-only viewer, not a closed stream.
		await source.evaluate(() => {
			const composer = document.querySelector('textarea'); composer.disabled = true; composer.placeholder = 'Join to chat';
			list().append(row('readonly', 1, 'read-only viewer'));
		});
		await expectNext('read-only viewer');
		await source.evaluate(() => {
			const e = row('image', 2, '', 'Image author', false);
			const picture = document.createElement('picture'); const img = document.createElement('img');
			img.src = e.querySelector('img').src; img.alt = 'User posted image'; picture.append(img); e.firstElementChild.append(picture); list().append(e);
		});
		await expectNext('');
		assert.equal((await messages()).at(-1).chatname, 'Image author');
		assert.ok((await messages()).at(-1).contentimg.startsWith('data:image/gif'));
		await delay(2200);
		await expectMessages(expected);
		console.log('PASS Patreon SSApp DOM replay: first message, authors, hydration, recycled rows, stable IDs, remounts, per-event history, tracking URL, closed/reopened chat, missing/returned panel, and concurrent Arena capture.');
		if (process.argv.includes('--inspect-live')) {
			const live = await openSource('https://www.patreon.com/meevepics/events/169302832', 'patreon', 'sources/patreon.js');
			await delay(15000);
			console.log('LIVE PAGE INSPECTION ' + JSON.stringify(await live.evaluate(() => ({
				url: location.href, title: document.title,
				messages: document.querySelectorAll('[data-tag="chat-message"][data-id]').length,
				closed: document.body.innerText.includes('This chat has closed'),
				loginRequired: /log in|sign in/i.test(document.body.innerText),
				pageExcerpt: document.body.innerText.slice(0, 500),
			}))));
		}
	} finally {
		await app.close();
	}
}
run().catch(error => { console.error(error); process.exitCode = 1; });
