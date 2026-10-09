'use strict';

// Replay Arena's chat DOM in a real SSApp source window using its normal preload,
// source injection, and IPC. The fixture never sends messages to a live channel.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const root = path.resolve(__dirname, '../..');
const sourceBase = pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href;
const fixtureUrl = 'https://arena.social/live/ssapp-local-capture-fixture';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-arena-capture-'));
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
		streamID: 'arena_fixture_' + Date.now(), password: 'false', state: true, settings: {},
	}));
	const app = await _electron.launch({
		executablePath: require('electron'), cwd: root,
		args: ['.', '--running-from-source', '--filesource=' + sourceBase, '--multiinstance', '--disable-logs', ...linuxLaunchArgs()],
		env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000,
	});
	try {
		await app.evaluate(({ app, ipcMain, session }, fixtureUrl) => {
			global.__arenaFixtureMessages = [];
			ipcMain.on('postMessage', (_event, payload) => {
				if (payload?.message?.type === 'arenasocial') global.__arenaFixtureMessages.push(payload.message);
			});
			const install = target => target.protocol.handle('https', request => {
				if (request.url === fixtureUrl) return new Response('<!doctype html><html><body><div data-testid="virtuoso-item-list"></div></body></html>', { headers: { 'content-type': 'text/html' } });
				return target.fetch(request, { bypassCustomProtocolHandlers: true });
			});
			app.on('session-created', install);
			install(session.defaultSession);
		}, fixtureUrl);
		const main = await app.firstWindow();
		await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady, null, { timeout: 60000 });
		const pending = app.waitForEvent('window');
		await main.evaluate(({ fixtureUrl, sourceBase }) => ipcRenderer.sendSync('createWindow', {
			url: fixtureUrl, visible: true, platform: 'arenasocial', sourceFiles: ['sources/arenasocial.js'], filesource: sourceBase,
		}), { fixtureUrl, sourceBase });
		const source = await pending;
		await source.waitForSelector('[data-testid="virtuoso-item-list"]', { state: 'attached', timeout: 30000 });
		await source.evaluate(() => {
			window.arenaFixtureRow = (index, message, oldLayout = false) => {
				const row = document.createElement('div');
				row.dataset.index = index;
				row.dataset.itemIndex = index;
				row.dataset.knownSize = '46';
				row.innerHTML = '<li class="flex flex-col gap-1 px-3 py-0.5"><div class="flex w-full gap-2 px-2 py-1.5 items-center"><span role="button"><span class="relative flex overflow-hidden rounded-full"><img class="aspect-square h-full w-full" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></span></span><div class="' + (oldLayout ? 'flex-grow' : 'grow') + ' text-sm"><span role="button" class="mr-2" style="color: rgb(10, 20, 30)">Steve &amp; QA</span><div class="inline"><span></span></div></div></div></li>';
				row.querySelector('.inline > span').textContent = message;
				return row;
			};
			window.arenaFixtureList = () => document.querySelector('[data-testid="virtuoso-item-list"]');
			arenaFixtureList().append(arenaFixtureRow(0, 'first message'));
		});
		const messages = () => app.evaluate(() => global.__arenaFixtureMessages);
		async function expectCount(count) {
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline) {
				if ((await messages()).length >= count) break;
				await delay(100);
			}
			assert.equal((await messages()).length, count);
		}
		await expectCount(1);
		assert.equal((await messages())[0].chatname, 'Steve & QA');
		assert.equal((await messages())[0].chatmessage, 'first message');
		assert.equal((await messages())[0].nameColor, 'rgb(10, 20, 30)');
		assert.ok((await messages())[0].chatimg.startsWith('data:image/gif'));

		// Hydration after the wrapper appears, including an initially unmeasured row.
		await source.evaluate(() => { const row = document.createElement('div'); row.dataset.index = '1'; row.dataset.knownSize = '0'; arenaFixtureList().append(row); });
		await delay(400);
		await source.evaluate(() => { const row = arenaFixtureList().lastElementChild; row.innerHTML = arenaFixtureRow(1, 'delayed content').innerHTML; row.dataset.knownSize = '46'; });
		await expectCount(2);

		// Virtualized lists reuse a DOM element for a new message index.
		await source.evaluate(() => { const row = arenaFixtureList().firstElementChild; row.dataset.index = '2'; row.dataset.itemIndex = '2'; row.querySelector('.inline > span').textContent = 'recycled row'; });
		await expectCount(3);
		await source.evaluate(() => { const list = arenaFixtureList(); list.replaceWith(list.cloneNode(true)); });
		await delay(2500);
		await expectCount(3);
		await source.evaluate(() => arenaFixtureList().append(arenaFixtureRow(3, 'old layout', true)));
		await expectCount(4);

		// Lower indexes may hydrate after later rows; both should be captured once.
		await source.evaluate(() => arenaFixtureList().append(arenaFixtureRow(5, 'same text')));
		await expectCount(5);
		await source.evaluate(() => arenaFixtureList().append(arenaFixtureRow(4, 'same text')));
		await expectCount(6);
		await source.evaluate(() => { const list = arenaFixtureList(); list.append(list.lastElementChild.cloneNode(true)); });
		await delay(500);
		await expectCount(6);

		// Arena uses client-side navigation: a new stream starts at index zero again.
		await source.evaluate(() => { history.pushState({}, '', '/live/ssapp-local-capture-fixture-two'); arenaFixtureList().replaceChildren(arenaFixtureRow(0, 'new stream first')); });
		await expectCount(7);
		await delay(2500);
		await expectCount(7);
		assert.deepEqual((await messages()).map(m => m.chatmessage), [
			'first message', 'delayed content', 'recycled row', 'old layout', 'same text', 'same text', 'new stream first',
		]);
		await source.evaluate(() => {
			const host = arenaFixtureRow(1, 'host message');
			host.querySelector('.inline').className = 'mt-1';
			arenaFixtureList().append(host);
			const card = arenaFixtureRow(2, '');
			card.querySelector('.inline').outerHTML = '<div class="mt-1"><div><h5>Tipping Party!</h5></div></div>';
			arenaFixtureList().append(card);
		});
		await expectCount(8);
		await delay(500);
		await expectCount(8);
		assert.equal((await messages())[7].chatmessage, 'host message');
		await source.evaluate(() => history.replaceState({}, '', location.pathname + '?chat=1#chat'));
		await delay(2500);
		await expectCount(8);
		console.log('PASS Arena capture in SSApp: first message, hydration, recycled rows, remount deduplication, legacy layout, out-of-order rows, repeated text, and stream navigation.');
	} finally {
		await app.close();
	}
}
run().catch(error => { console.error(error); process.exitCode = 1; });
