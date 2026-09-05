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
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-youtube-type-'));
	const requests = [];
	const server = http.createServer((request, response) => {
		requests.push(request.url);
		response.setHeader('Content-Type', 'text/html');
		response.end('<!doctype html><title>Local chat fixture</title><p>Local chat fixture</p>');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	let app;
	try {
		app = await _electron.launch({
			executablePath: require('electron'), cwd: root,
			args: ['.', '--running-from-source', '--multiinstance', '--no-hwa',
				`--filesource=${pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href}`, ...linuxLaunchArgs()],
			env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000,
		});
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.stateManager?.initialized);
		const cases = [
			{ target: 'youtubeshorts', url: `${origin}/live_chat?v=abcdefghijk&shorts=1` },
			{ target: 'youtubeshorts', url: `${origin}/live_chat?shorts=1&v=abcdefghijk&keep=yes` },
			{ target: 'youtube', url: `${origin}/live_chat?v=abcdefghijk#chat` },
			{ target: 'youtube', url: `${origin}/live_chat?v=abcdefghijk&shortsExtra=keep` },
			{ target: 'youtube', url: '' },
		];
		const results = [];
		for (const fixture of cases) {
			const id = await page.evaluate(fixture => stateManager.addSource({ ...fixture, videoId: 'abcdefghijk', autoActivate: false }), fixture);
			const row = page.locator(`[data-source-id="${id}"]`);
			await row.locator('.settings-btn').click();
			await row.locator('.youtube-type-toggle').click();
			const source = await page.evaluate(id => stateManager.getSource(id), id);
			results.push({ original: fixture.url, target: source.target, url: source.url });
			if (fixture === cases[0]) {
				const activation = await page.evaluate(id => performActivationAttempt({ sourceId: id, mode: 'classic' }), id);
				assert.ok(activation.success, JSON.stringify(activation));
				await page.waitForTimeout(500);
				await page.evaluate(id => stopThis(document.querySelector(`[data-source-id="${id}"]`)), id);
			}
		}
		console.log('YouTube type toggle reproduction', JSON.stringify({ results, requests }));
		assert.ok(requests.includes('/live_chat?v=abcdefghijk'), 'Switching from Shorts changed the video ID sent to the real capture window.');
		for (let i = 0; i < cases.length; i++) {
			if (!cases[i].url) { assert.strictEqual(results[i].url, ''); continue; }
			const updated = new URL(results[i].url);
			assert.strictEqual(updated.searchParams.get('v'), 'abcdefghijk');
			assert.strictEqual(updated.searchParams.has('shorts'), results[i].target === 'youtubeshorts');
			assert.strictEqual(updated.hash, new URL(cases[i].url).hash);
		}
		assert.strictEqual(new URL(results[1].url).searchParams.get('keep'), 'yes');
		assert.strictEqual(new URL(results[3].url).searchParams.get('shortsExtra'), 'keep');
		await page.reload();
		await page.waitForFunction(() => window.stateManager?.initialized);
		assert.deepStrictEqual(await page.evaluate(() => stateManager.getSources().map(source => source.url)), results.map(source => source.url));
		console.log('YouTube type toggle, real capture request, and persistence Electron E2E passed.');
	} finally {
		if (app) await app.close();
		await new Promise(resolve => server.close(resolve));
		const resolved = path.resolve(profile);
		if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ssapp-youtube-type-')) throw new Error('Unexpected type test profile path.');
		fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
