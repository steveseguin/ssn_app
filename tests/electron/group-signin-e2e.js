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
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-group-signin-'));
	const headers = [];
	const server = http.createServer((request, response) => {
		headers.push(request.headers['user-agent']);
		response.setHeader('Content-Type', 'text/html');
		response.end('<!doctype html><title>Local sign-in fixture</title><p>Sign-in fixture</p>');
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
		for (const group of [true, false]) {
			const userAgent = group ? 'SSApp-Group-Signin-Fixture/1.0' : 'SSApp-Source-Signin-Fixture/1.0';
			headers.length = 0;
			await page.evaluate(async ({ group, userAgent, url }) => {
				config.custom = { ...(config.custom || {}), signin: { url } };
				const data = { target: 'custom', username: 'signin_fixture', userAgent, customSession: 'signin-fixture', autoActivate: false };
				const id = group ? stateManager.addGroup(data) : stateManager.addSource(data);
				await signin(document.querySelector(`[data-${group ? 'group' : 'source'}-id="${id}"]`));
			}, { group, userAgent, url });
			const deadline = Date.now() + 10000;
			while (!headers.length && Date.now() < deadline) await page.waitForTimeout(100);
			console.log('Sign-in user agent reproduction', { group, expected: userAgent, actual: headers[0] });
			assert.strictEqual(headers[0], userAgent, 'Sign-in ignored the configured user agent.');
			if (!group) {
				await page.evaluate(() => {
					stateManager.updateSource('custom-user-signin_fixture', { mockUserAgentData: { platform: 'Windows', mobile: false } });
					openUserAgentSettings(document.querySelector('[data-source-id="custom-user-signin_fixture"]'));
				});
				const selected = await page.locator('#userAgentSelect').inputValue();
				await page.locator('#userAgentModal').getByRole('button', { name: 'Save', exact: true }).click();
				const saved = await page.evaluate(() => stateManager.getSource('custom-user-signin_fixture').userAgent);
				console.log('Unlisted user agent save reproduction', { selected, saved });
				assert.strictEqual(saved, userAgent, 'Opening and saving user-agent settings erased an unlisted existing value.');
				assert.strictEqual(selected, userAgent);
				assert.deepStrictEqual(await page.evaluate(() => stateManager.getSource('custom-user-signin_fixture').mockUserAgentData), { platform: 'Windows', mobile: false });
			}
			await app.evaluate(({ BrowserWindow }, url) => {
				for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().startsWith(url)) window.close();
			}, url);
		}
		await page.reload();
		await page.waitForFunction(() => window.stateManager?.initialized);
		assert.strictEqual(await page.evaluate(() => stateManager.getSource('custom-user-signin_fixture').userAgent), 'SSApp-Source-Signin-Fixture/1.0');
		await page.locator('[data-source-id="custom-user-signin_fixture"]').waitFor({ state: 'attached' });
		await page.evaluate(() => openUserAgentSettings(document.querySelector('[data-source-id="custom-user-signin_fixture"]')));
		await page.locator('#userAgentSelect').selectOption('AUTO');
		await page.locator('#userAgentModal').getByRole('button', { name: 'Save', exact: true }).click();
		assert.deepStrictEqual(await page.evaluate(() => {
			const source = stateManager.getSource('custom-user-signin_fixture');
			return { userAgent: source.userAgent, mock: source.mockUserAgentData };
		}), { userAgent: 'AUTO', mock: null });
		await page.evaluate(() => {
			const userAgent = defaultUserAgents.find(ua => ua.name === 'Chrome 142 - Windows').value;
			stateManager.updateSource('custom-user-signin_fixture', { userAgent, mockUserAgentData: { platform: 'Windows', mobile: false, architecture: 'x86' } });
			openUserAgentSettings(document.querySelector('[data-source-id="custom-user-signin_fixture"]'));
		});
		await page.locator('#userAgentModal').getByRole('button', { name: 'Save', exact: true }).click();
		const preservedMock = await page.evaluate(() => stateManager.getSource('custom-user-signin_fixture').mockUserAgentData);
		console.log('Known preset with source-specific browser fields', preservedMock);
		assert.deepStrictEqual(preservedMock, { platform: 'Windows', mobile: false, architecture: 'x86' });
		await page.reload();
		await page.waitForFunction(() => window.stateManager?.initialized);
		assert.deepStrictEqual(await page.evaluate(() => stateManager.getSource('custom-user-signin_fixture').mockUserAgentData), preservedMock);
		await page.locator('[data-source-id="custom-user-signin_fixture"]').waitFor({ state: 'attached' });
		for (const version of [142, 143, 144]) {
			for (const platform of ['Windows', 'Mac']) {
				await page.evaluate(() => openUserAgentSettings(document.querySelector('[data-source-id="custom-user-signin_fixture"]')));
				await page.locator('#userAgentSelect').selectOption({ label: `Chrome ${version} - ${platform}` });
				await page.locator('#userAgentModal').getByRole('button', { name: 'Save', exact: true }).click();
				assert.strictEqual(await page.evaluate(() => stateManager.getSource('custom-user-signin_fixture').mockUserAgentData), null);
				headers.length = 0;
				await page.evaluate(async url => {
					config.custom = { ...(config.custom || {}), signin: { url } };
					await signin(document.querySelector('[data-source-id="custom-user-signin_fixture"]'));
				}, url);
				const deadline = Date.now() + 10000;
				while (!headers.length && Date.now() < deadline) await page.waitForTimeout(100);
				console.log('Chrome preset request header', { version, platform, actual: headers[0] });
				assert.ok(headers[0]?.includes(`Chrome/${version}.0.0.0 `), 'Chrome preset sent a malformed version token.');
				await app.evaluate(({ BrowserWindow }, url) => {
					for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().startsWith(url)) window.close();
				}, url);
			}
		}
		await page.evaluate(() => {
			localStorage.setItem('customUserAgents', JSON.stringify([
				{ name: 'First copy', value: 'Duplicate-Fixture/1.0' },
				{ name: 'Second copy', value: 'Duplicate-Fixture/1.0' },
			]));
			openUserAgentSettings(document.querySelector('[data-source-id="custom-user-signin_fixture"]'));
		});
		await page.locator('#userAgentSelect').selectOption({ label: 'Custom: Second copy' });
		page.once('dialog', dialog => dialog.accept());
		await page.locator('#customUserAgentsList button').first().click();
		const remaining = await page.locator('#userAgentSelect').evaluate(select => ({
			selected: select.selectedOptions[0].textContent,
			custom: Array.from(select.options).filter(option => option.dataset.customIndex !== undefined).map(option => option.textContent),
		}));
		console.log('Duplicate custom preset removal', remaining);
		assert.deepStrictEqual(remaining, { selected: 'Custom: Second copy', custom: ['Custom: Second copy'] });
		await page.locator('#userAgentModal').getByRole('button', { name: 'Save', exact: true }).click();
		await page.reload();
		await page.waitForFunction(() => window.stateManager?.initialized);
		assert.strictEqual(await page.evaluate(() => stateManager.getSource('custom-user-signin_fixture').userAgent), 'Duplicate-Fixture/1.0');
		await page.locator('[data-source-id="custom-user-signin_fixture"]').waitFor({ state: 'attached' });
		await page.evaluate(() => openUserAgentSettings(document.querySelector('[data-source-id="custom-user-signin_fixture"]')));
		page.once('dialog', dialog => dialog.accept());
		await page.locator('#customUserAgentsList button').first().click();
		assert.strictEqual(await page.locator('#userAgentSelect').inputValue(), 'AUTO');
		assert.strictEqual(await page.locator('#userAgentSelect option[data-custom-index]').count(), 0);
		console.log('Sign-in headers, user-agent preservation, reload, AUTO reset, Chrome presets, and duplicate removal Electron E2E passed.');
	} finally {
		if (app) await app.close();
		await new Promise(resolve => server.close(resolve));
		const resolved = path.resolve(profile);
		if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ssapp-group-signin-')) throw new Error('Unexpected sign-in test profile path.');
		fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
