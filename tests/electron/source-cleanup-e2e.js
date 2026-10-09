'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

async function run() {
	const root = path.resolve(__dirname, '../..');
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-source-cleanup-'));
	const ticks = new Map();
	const server = http.createServer((request, response) => {
		const url = new URL(request.url, 'http://localhost');
		if (url.pathname === '/tick') {
			const name = url.searchParams.get('name');
			ticks.set(name, (ticks.get(name) || 0) + 1);
			response.writeHead(204).end();
			return;
		}
		response.setHeader('Content-Type', 'text/html');
		response.end(`<!doctype html><title>Source cleanup fixture</title><p>Running capture fixture</p>
			<script>
			localStorage.setItem('cleanup-session', 'preserved');
			document.cookie = 'cleanup-session=preserved; path=/';
			setInterval(() => fetch('/tick?name=' + encodeURIComponent(location.pathname)), 250);
			</script>`);
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const fixture = `http://127.0.0.1:${server.address().port}`;
	const launchOptions = {
		executablePath: require('electron'), cwd: root,
		args: ['.', '--running-from-source', '--multiinstance', '--no-hwa',
			`--filesource=${pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href}`, ...linuxLaunchArgs()],
		env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000,
	};
	let app;
	let page;
	// These listeners are registered after startup reconciliation and source cleanup.
	const ready = () => page.waitForFunction(() => window.stateManager?.initialized
		&& ipcRenderer.listenerCount('tiktokConnectionStatus') > 0);
	const reload = async () => {
		await page.reload({ waitUntil: 'load' });
		await ready();
	};
	const destinations = () => page.evaluate(() => ipcRenderer.sendSync('getTabs', {}));
	const runningWindows = () => app.evaluate(({ webContents }, fixture) => webContents.getAllWebContents()
		.filter(contents => contents.getURL().startsWith(fixture + '/'))
		.map(contents => ({ id: contents.id, url: contents.getURL() })), fixture);
	async function addSource(name, target, { grouped = false, mode = 'classic' } = {}) {
		const url = `${fixture}/${name}`;
		const source = await page.evaluate(async ({ name, target, grouped, mode, url }) => {
			const groupId = grouped ? stateManager.addGroup({ target, username: name, autoActivate: false }) : null;
			const id = stateManager.addSource({ target, username: name, url, groupId, connectionMode: mode, isDirectUrl: true,
				sourceFile: target === 'custom' ? 'sources/youtube.js' : undefined,
				autoActivate: false, isVisible: false, isMuted: true, customSession: 'cleanup-' + name });
			// Only substitute the remote page's address. Activation, source configuration,
			// preload, session, IPC, real BrowserWindow, and removal paths are unchanged.
			const originalResolver = resolveWebSocketHtml;
			try {
				if (mode === 'websocket') resolveWebSocketHtml = async () => ({ url, origin: 'remote', branch: 'main' });
				const result = await performActivationAttempt({ sourceId: id, mode });
				if (!result.success) throw new Error(`Could not activate ${name}: ${result.error?.message}`);
			} finally {
				resolveWebSocketHtml = originalResolver;
			}
			// Assign discovery metadata after opening the local fixture so classic YouTube
			// activation does not replace its URL with a live YouTube chat URL.
			if (target === 'youtube' || target === 'youtubeshorts') {
				stateManager.updateSource(id, { videoId: name });
			}
			return { ...stateManager.getSource(id), fixtureUrl: url, fixtureName: '/' + name };
		}, { name, target, grouped, mode, url });
		for (let attempt = 0; attempt < 300 && !ticks.get(source.fixtureName); attempt++) await page.waitForTimeout(100);
		assert.ok(ticks.get(source.fixtureName), `${name} must run and call the fixture server before testing cleanup: `
			+ JSON.stringify({ source, tabs: await destinations(), windows: await runningWindows() }));
		return source;
	}
	async function assertClosed(sources) {
		const tabs = await destinations();
		const windows = await runningWindows();
		for (const source of sources) {
			assert.ok(!tabs.some(tab => tab.id === source.vid), `Stale dock destination remains for ${source.id}.`);
			assert.ok(!windows.some(win => win.url === source.fixtureUrl), `Capture window remains for ${source.id}.`);
		}
		// Allow an in-flight heartbeat to finish, then prove the hidden pages stopped.
		await page.waitForTimeout(500);
		const before = sources.map(source => ticks.get(source.fixtureName));
		await page.waitForTimeout(1200);
		assert.deepStrictEqual(sources.map(source => ticks.get(source.fixtureName)), before, 'Removed sources kept making server calls.');
	}
	async function assertPreserved(sources, windowIds) {
		const tabs = await destinations();
		const windows = await runningWindows();
		for (const source of sources) {
			const current = await page.evaluate(id => stateManager.getSource(id), source.id);
			assert.ok(current, `Unrelated source ${source.id} was removed.`);
			assert.strictEqual(current.vid, source.vid, `${source.id} lost its running window on reload.`);
			assert.strictEqual(current.wssId, source.wssId, `${source.id} lost its WebSocket handle on reload.`);
			assert.ok(tabs.some(tab => tab.id === source.vid && tab.sourceId === source.id));
			assert.deepStrictEqual(windows.filter(win => win.url === source.fixtureUrl).map(win => win.id), [windowIds[source.id]],
				`${source.id} was duplicated, replaced, or closed.`);
		}
		const storage = await app.evaluate(async ({ webContents }, windowIds) => Promise.all(Object.values(windowIds).map(async id => {
			const wc = webContents.fromId(id);
			return wc.executeJavaScript('[localStorage.getItem("cleanup-session"), document.cookie.includes("cleanup-session=preserved")]');
		})), Object.fromEntries(sources.map(source => [source.id, windowIds[source.id]])));
		assert.ok(storage.every(values => values[0] === 'preserved' && values[1]), 'Reload changed an unrelated source session.');
		const before = sources.map(source => ticks.get(source.fixtureName));
		await page.waitForTimeout(1500);
		assert.ok(sources.every((source, index) => ticks.get(source.fixtureName) > before[index]), 'An unrelated hidden capture stopped running.');
	}
	try {
		app = await _electron.launch(launchOptions);
		page = await app.firstWindow();
		await ready();
		const expired = [];
		for (const target of ['youtube', 'youtubeshorts']) {
			for (const mode of ['classic', 'websocket']) {
				expired.push(await addSource(`${target}-${mode}`, target, { grouped: true, mode }));
			}
		}
		console.log('Running grouped YouTube/Shorts fixtures in classic and WebSocket modes.');
		const survivors = [];
		for (const target of ['youtube', 'twitch', 'kick', 'rumble', 'tiktok', 'custom']) {
			survivors.push(await addSource(`${target}-manual`, target));
		}
		for (const target of ['twitch', 'kick']) {
			survivors.push(await addSource(`${target}-websocket`, target, { mode: 'websocket' }));
		}
		const windowIds = Object.fromEntries(survivors.map(source => [source.id, null]));
		for (const source of survivors) windowIds[source.id] = (await runningWindows()).find(win => win.url === source.fixtureUrl).id;
		await reload();

		// Report both regressions on the unfixed app instead of masking the WebSocket
		// bug behind the first stale YouTube destination assertion.
		const failures = [];
		for (const [label, check] of [
			['YouTube cleanup', () => assertClosed(expired)],
			['Other sources after reload', () => assertPreserved(survivors, windowIds)],
		]) {
			try { await check(); } catch (error) { failures.push(`${label}: ${error.message}`); }
		}
		assert.deepStrictEqual(failures, [], failures.join('\n'));
		for (const source of expired) {
			assert.strictEqual(await page.evaluate(id => !!stateManager.getSource(id), source.id), false);
			assert.deepStrictEqual(await page.evaluate(id => stateManager.getGroup(id).streams, source.groupId), []);
		}
		console.log('PASS: YouTube/Shorts classic and WebSocket cleanup; unrelated sources and sessions survive reload.');

		// Reusing source IDs and doing another reload must not resurrect old windows.
		const repeated = await addSource('youtube-classic', 'youtube', { grouped: true });
		const staleSourceId = await page.evaluate(({ groupId, unrelatedVid }) => stateManager.addSource({
			target: 'youtube', videoId: 'stale-window-id', groupId, vid: unrelatedVid, autoActivate: false,
		}), { groupId: repeated.groupId, unrelatedVid: survivors[0].vid });
		await reload();
		await assertClosed([repeated]);
		assert.strictEqual(await page.evaluate(id => !!stateManager.getSource(id), staleSourceId), false);
		await assertPreserved(survivors, windowIds);
		console.log('PASS: repeated cleanup and source ID reuse.');

		const stopped = survivors.find(source => source.fixtureName === '/twitch-manual');
		await page.locator(`[data-source-id="${stopped.id}"] [data-stophtml]`).evaluate(button => button.click());
		await assertClosed([stopped]);
		assert.strictEqual(await page.evaluate(id => stateManager.getSource(id).vid, stopped.id), null);
		const deleted = survivors.find(source => source.fixtureName === '/kick-websocket');
		await page.evaluate(id => deleteThis(document.querySelector(`[data-source-id="${id}"]`)), deleted.id);
		await assertClosed([deleted]);
		const grouped = survivors.filter(source => ['/rumble-manual', '/twitch-websocket'].includes(source.fixtureName));
		await page.evaluate(async ids => {
			const groupId = stateManager.addGroup({ target: 'custom', username: 'delete-fixture', autoActivate: false });
			ids.forEach(id => stateManager.moveSourceToGroup(id, groupId));
			await deleteThis(document.querySelector(`[data-group-id="${groupId}"]`));
		}, grouped.map(source => source.id));
		await assertClosed(grouped);
		const remaining = survivors.filter(source => ![stopped, deleted, ...grouped].includes(source));
		await assertPreserved(remaining, windowIds);
		await page.evaluate(() => clearAllSources());
		await assertClosed(survivors);
		await reload();
		assert.deepStrictEqual(await destinations(), []);
		assert.deepStrictEqual(await page.evaluate(() => stateManager.getSources()), []);
		console.log('PASS: Stop, Delete, mixed-group deletion, Clear All, and persistence after reload.');

		// A full restart really does invalidate runtime IDs; it must not restore a
		// false active state.
		const restartSource = await addSource('restart-websocket', 'kick', { mode: 'websocket' });
		await app.close();
		app = null;
		app = await _electron.launch(launchOptions);
		page = await app.firstWindow();
		await ready();
		const restored = await page.evaluate(id => stateManager.getSource(id), restartSource.id);
		assert.strictEqual(restored.vid, null);
		assert.strictEqual(restored.wssId, null);
		assert.strictEqual(restored.status, 'inactive');
		assert.deepStrictEqual(await destinations(), []);
		console.log('PASS: full restart clears stale runtime IDs.');
	} finally {
		if (app) await app.close();
		await new Promise(resolve => server.close(resolve));
		const resolved = path.resolve(profile);
		if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ssapp-source-cleanup-')) {
			throw new Error('Unexpected source cleanup test profile path.');
		}
		fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
