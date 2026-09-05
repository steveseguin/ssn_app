'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

async function run() {
	const root = path.resolve(__dirname, '../..');
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-review-fixes-'));
	const server = net.createServer();
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	const fixtureServer = http.createServer((_request, response) => {
		response.setHeader('Content-Type', 'text/html');
		response.end('<!doctype html><title>Local capture fixture</title><p>Local fixture</p>');
	});
	await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
	const fixture = `http://127.0.0.1:${fixtureServer.address().port}/`;
	const app = await _electron.launch({
		executablePath: require('electron'), cwd: root,
		args: ['.', '--running-from-source', `--filesource=${path.resolve(root, '../social_stream').replace(/\\/g, '/')}/`,
			'--ssapp-headless-control', '--ssapp-control-api', `--ssapp-control-port=${port}`, '--no-hwa', ...linuxLaunchArgs()],
		env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000,
	});
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.stateManager?.initialized && typeof performActivationAttempt === 'function');
		// Exercise the real Delete and Clear All paths without contacting TikTok.
		for (const clearAll of [false, true]) {
			const canceled = await page.evaluate(async clearAll => {
				const id = stateManager.addSource({ target: 'tiktok', username: 'ssapp_local_fixture', autoActivate: false });
				const token = beginPendingTikTokActivation(id);
				if (clearAll) await clearAllSources();
				else await deleteThis(document.querySelector(`[data-source-id="${id}"]`));
				return !stateManager.getSource(id) && !isPendingTikTokActivationCurrent(id, token);
			}, clearAll);
			assert.strictEqual(canceled, true, 'Deletion left a pending TikTok activation');
		}
		// Delay delivery of a real Electron window ID to reproduce deletion while activation
		// is outstanding. Creation, deletion, and disposal still use the real app IPC paths.
		await page.evaluate(fixture => {
			window.reviewOriginalCreate = createClassicWindowFromSource;
			createClassicWindowFromSource = async (...args) => {
				const id = await window.reviewOriginalCreate(...args);
				window.reviewLateWindow = id;
				await new Promise(resolve => { window.reviewRelease = resolve; });
				return id;
			};
			window.reviewSource = stateManager.addSource({ target: 'youtube', url: fixture, autoActivate: false });
			window.reviewActivation = performActivationAttempt({ sourceId: window.reviewSource, mode: 'classic' });
		}, fixture);
		await page.waitForFunction(() => !!window.reviewRelease);
		const canceledActivation = await page.evaluate(async () => {
			await deleteThis(document.querySelector(`[data-source-id="${window.reviewSource}"]`));
			// Reuse the ID: the late result must not attach to or mutate this replacement.
			stateManager.addSource({ id: window.reviewSource, target: 'youtube', username: 'replacement', autoActivate: false });
			window.reviewRelease();
			const result = await window.reviewActivation;
			createClassicWindowFromSource = window.reviewOriginalCreate;
			return { success: result.success, error: result.error?.message, source: stateManager.getSource(window.reviewSource) };
		});
		assert.strictEqual(canceledActivation.success, false);
		assert.strictEqual(canceledActivation.error, 'Activation canceled');
		assert.strictEqual(canceledActivation.source.vid, null);
		assert.strictEqual(canceledActivation.source.status, 'inactive');
		const fixtureWindows = await app.evaluate(({ BrowserWindow }, fixture) =>
			BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() === fixture).length, fixture);
		assert.strictEqual(fixtureWindows, 0, 'Canceled activation left a real source window behind');
		// Use a real missing-window response, then a real successful cache clear/reload.
		const cache = await page.evaluate(async fixture => {
			const id = stateManager.addSource({ target: 'youtube', url: fixture, autoActivate: false });
			const row = document.querySelector(`[data-source-id="${id}"]`);
			const button = document.createElement('button');
			button.textContent = 'Clear Cache'; row.appendChild(button);
			stateManager.updateSource(id, { vid: 876543 });
			document.getElementById('toastContainer').innerHTML = '';
			await clearThis(button);
			const failure = document.getElementById('toastContainer').textContent;
			await performActivationAttempt({ sourceId: id, mode: 'classic' });
			await new Promise(resolve => setTimeout(resolve, 1500));
			document.getElementById('toastContainer').innerHTML = '';
			await clearThis(button);
			const success = document.getElementById('toastContainer').textContent;
			const missing = stateManager.addSource({ target: 'youtube', username: 'missing_window', vid: 876543, autoActivate: false });
			const groupId = stateManager.addGroup({ target: 'youtube', username: 'local_cache_fixture', streams: [id, missing], autoActivate: false });
			const group = document.querySelector(`[data-group-id="${groupId}"]`);
			const groupButton = document.createElement('button'); group.appendChild(groupButton);
			document.getElementById('toastContainer').innerHTML = '';
			await clearThis(groupButton);
			return { failure, success, partial: document.getElementById('toastContainer').textContent, enabled: !button.disabled && !groupButton.disabled };
		}, fixture);
		assert.match(cache.failure, /Cleared 0 of 1/);
		assert.doesNotMatch(cache.failure, /Cache cleared for/);
		assert.match(cache.success, /Cache cleared for 1/);
		assert.match(cache.partial, /Cleared 1 of 2/);
		assert.doesNotMatch(cache.partial, /Cache cleared for/);
		assert.strictEqual(cache.enabled, true);
		const settings = await fetch(`http://127.0.0.1:${port}/api/v1/command`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'getSettings', value: {} }),
		}).then(response => response.json());
		assert.ok(settings.ok, JSON.stringify(settings));
		for (const key of ['youtubeAutoAdd', 'youtubeAutoCleanup', 'youtubeCheckInterval']) {
			assert.ok(!(key in settings.payload.settings));
			assert.ok(!(key in settings.payload.definitions));
			const response = await fetch(`http://127.0.0.1:${port}/api/v1/command`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'updateSettings', value: { settings: { [key]: true } } }),
			});
			assert.strictEqual(response.status, 400);
		}
		await page.evaluate(() => youtubeStatusManager.showGlobalSettingsModal());
		assert.match(await page.locator('#toastContainer').textContent(), /Auto-activate/);
		console.log('[review-lifecycle-e2e] PASS: deletion, late real-window cleanup, replacement safety, cache failure/success, retired settings.');
	} finally {
		await app.close();
		await new Promise(resolve => fixtureServer.close(resolve));
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
