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
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-group-controls-'));
	const server = http.createServer((request, response) => {
		response.setHeader('Content-Type', 'text/html');
		response.end('<!doctype html><title>Local capture fixture</title><p>Capture fixture</p>');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${server.address().port}/`;
	let app;
	try {
		app = await _electron.launch({ executablePath: require('electron'), cwd: root,
			args: ['.', '--running-from-source', '--multiinstance', '--no-hwa',
				`--filesource=${pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href}`, ...linuxLaunchArgs()],
			env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000 });

		const page = await app.firstWindow();
		await page.waitForFunction(() => window.stateManager?.initialized);
		await page.waitForTimeout(1000);

		const groupId = await page.evaluate(async url => {
			const groupId = stateManager.addGroup({ target: 'youtube', username: 'controls_fixture', autoActivate: false });
			for (let i = 0; i < 3; i++) {
				const id = stateManager.addSource({ target: 'youtube', username: `controls_${i}`, url: `${url}?source=${i}`,
					groupId: i < 2 ? groupId : null, isMuted: false, autoActivate: false });
				const result = await performActivationAttempt({ sourceId: id, mode: 'classic' });
				if (!result.success) throw new Error('Could not activate the local fixture.');
			}
			return groupId;
		}, url);

		await page.waitForTimeout(500);
		const readAudio = () => app.evaluate(({ webContents }, url) => webContents.getAllWebContents()
			.filter(contents => contents.getURL().startsWith(url))
			.map(contents => ({ url: contents.getURL(), muted: contents.isAudioMuted() }))
			.sort((a, b) => a.url.localeCompare(b.url)), url);
		assert.deepStrictEqual((await readAudio()).map(row => row.muted), [false, false, false]);
		for (const muted of [true, false, true]) {
			await page.locator(`[data-group-id="${groupId}"] [data-group-mute]`).click();
			await page.waitForTimeout(250);
			const audio = await readAudio();
			const saved = await page.evaluate(id => stateManager.getSourcesByGroup(id).map(source => source.isMuted), groupId);
			console.log('Group mute reproduction', { muted, saved, audio });
			assert.deepStrictEqual(saved, [muted, muted]);
			assert.strictEqual(await page.locator(`[data-group-id="${groupId}"] [data-group-mute]`).getAttribute('aria-pressed'), String(muted));
			assert.deepStrictEqual(audio.map(row => row.muted), [muted, muted, false], 'Group mute updated settings but not the running capture pages.');
		}
		await page.evaluate(async () => {
			for (const source of stateManager.getSources()) await stopThis(document.querySelector(`[data-source-id="${source.id}"]`));
		});
		await page.reload();
		await page.waitForFunction(() => window.stateManager?.initialized);
		assert.deepStrictEqual(await page.evaluate(id => stateManager.getSourcesByGroup(id).map(source => source.isMuted), groupId), [true, true]);
		await page.evaluate(async id => {
			for (const source of stateManager.getSourcesByGroup(id)) {
				const result = await performActivationAttempt({ sourceId: source.id, mode: 'classic' });
				if (!result.success) throw new Error('Fixture reactivation failed.');
			}
		}, groupId);
		await page.waitForTimeout(500);
		assert.deepStrictEqual((await readAudio()).map(row => row.muted), [true, true]);
		await page.evaluate(id => {
			const source = stateManager.getSourcesByGroup(id)[0];
			stateManager.updateSource(source.id, { vid: 876543 });
			document.getElementById('toastContainer').replaceChildren();
		}, groupId);
		await page.locator(`[data-group-id="${groupId}"] [data-group-mute]`).click();
		const warning = await page.locator('#toastContainer').textContent();
		console.log('Failed group mute feedback', { warning });
		assert.match(warning, /1 capture page/);
		assert.deepStrictEqual((await readAudio()).map(row => row.muted), [true, false]);
		console.log('Group mute/unmute, unrelated source isolation, and reactivation after reload Electron E2E passed.');
	} finally {
		if (app) await app.close();
		await new Promise(resolve => server.close(resolve));
		const resolved = path.resolve(profile);
		if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ssapp-group-controls-')) throw new Error('Unexpected group control test profile path.');
		fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
