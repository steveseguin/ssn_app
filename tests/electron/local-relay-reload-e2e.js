#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright-core');

// Exercise the real settings handler with a page that cannot acknowledge the
// relay update, as happens with older pages or a slow background startup.
(async () => {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-relay-reload-'));
	let requests = 0;
	const server = http.createServer((request, response) => {
		if (request.url.startsWith('/background.html')) requests++;
		response.end('<!doctype html><title>Relay reload fixture</title>');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const binary = process.env.SSAPP_TEST_APP;
	const app = await _electron.launch({
		executablePath: binary || require('electron'),
		cwd: path.resolve(__dirname, '../..'),
		args: [...(binary ? [] : ['.']), '--multiinstance', '--preferlocalassets'],
		env: { ...process.env, SSAPP_USER_DATA_DIR: profile },
		timeout: 120000,
	});
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => typeof configReady !== 'undefined' && configReady);
		await page.evaluate(async base => {
			// Keep the fixture separate from the real startup background. Its ID
			// exercises the ACK path, while normal IPC still finds the first frame2.
			const frame = document.createElement('iframe');
			frame.id = 'frame2';
			document.body.appendChild(frame);
			window.__relayReloadFixture = frame;
			localServer = '&localserver';
			localWebSocketPort = 34567;
			await new Promise(resolve => {
				frame.addEventListener('load', resolve, { once: true });
				frame.src = base + '/background.html?session=fixture&localserver&localserverport=34567';
			});
		}, `http://127.0.0.1:${server.address().port}`);
		const before = requests;
		await page.evaluate(() => {
			localServer = '&localserver';
			localWebSocketPort = 34567;
			return updateFrameLocalServerConnection(window.__relayReloadFixture);
		});
		await page.waitForTimeout(2000);
		assert.strictEqual(requests, before, 'Unchanged relay settings must not reload the background');
		console.log('PASS unchanged relay settings preserve the running background without an ACK');
		for (const enabled of [true, false, true]) {
			const old = requests;
			const result = await page.evaluate(async enabled => {
				localServer = enabled ? '&localserver' : '';
				localWebSocketPort = 34568;
				const frame = window.__relayReloadFixture;
				await updateFrameLocalServerConnection(frame);
				return frame.src;
			}, enabled);
			await page.waitForTimeout(2000);
			assert.strictEqual(requests, old + 1, 'Changed relay settings must retain the reload fallback');
			assert.strictEqual(new URL(result).searchParams.has('localserver'), enabled);
			assert.strictEqual(new URL(result).searchParams.get('localserverport'), enabled ? '34568' : null);
		}
		console.log('PASS changed port, disable and re-enable retain the legacy reload fallback');
	} finally {
		await app.close();
		server.close();
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
