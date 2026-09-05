'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');

async function run() {
	const root = path.resolve(__dirname, '../..');
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-navigation-'));
	const packagedApp = process.env.SSAPP_TEST_APP;
	const app = await _electron.launch({
		executablePath: packagedApp || require('electron'), cwd: root,
		args: [
			...(packagedApp ? [] : ['.', '--running-from-source', '--filesource', pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href]),
			'--multiinstance', '--no-hwa',
			...(process.platform === 'linux' ? ['--no-sandbox', `--ozone-platform=${process.env.SSAPP_TEST_OZONE || 'x11'}`] : []),
		],
		env: { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_PREFER_LOCAL_ASSETS: packagedApp ? '1' : '0' },
		timeout: 60000,
	});
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.stateManager?.initialized, null, { polling: 100 });
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 800));
		const toggle = page.locator('.menu-toggle');
		const menu = page.locator('#navigation-links');
		assert.strictEqual(await toggle.getAttribute('aria-label'), 'Navigation menu');
		assert.strictEqual(await toggle.getAttribute('aria-controls'), 'navigation-links');
		for (let attempt = 0; attempt < 3; attempt++) {
			await toggle.press('Enter');
			assert.strictEqual(await toggle.getAttribute('aria-expanded'), 'true');
			await menu.locator('a').first().focus();
			await page.keyboard.press('Escape');
			assert.strictEqual(await menu.isVisible(), false);
			assert.strictEqual(await toggle.getAttribute('aria-expanded'), 'false');
			assert.strictEqual(await toggle.evaluate(element => element === document.activeElement), true);
		}
		await toggle.press('Space');
		await menu.locator('[data-page="sessions"]').press('Enter');
		assert.strictEqual(await menu.isVisible(), false);
		assert.strictEqual(await toggle.evaluate(element => element === document.activeElement), true);
		assert.strictEqual(await menu.locator('[data-page="sessions"]').getAttribute('aria-current'), 'page');
		await toggle.press('Enter');
		await page.locator('#language-select').focus();
		assert.strictEqual(await toggle.getAttribute('aria-expanded'), 'true');
		await page.mouse.click(850, 700);
		await page.waitForFunction(() => document.querySelector('.menu-toggle').getAttribute('aria-expanded') === 'false', null, { polling: 100 });
		assert.strictEqual(await toggle.getAttribute('aria-expanded'), 'false');
		const locales = await page.locator('#language-select option').evaluateAll(options => options.map(option => option.value));
		for (const locale of locales) {
			await page.selectOption('#language-select', locale);
			const labels = await page.evaluate(() => ({
				menu: document.querySelector('.menu-toggle').getAttribute('aria-label'),
				language: document.querySelector('#language-select').getAttribute('aria-label'),
				expected: [translate('nav.menu'), translate('nav.language')],
			}));
			assert.deepStrictEqual([labels.menu, labels.language], labels.expected);
			assert.ok(labels.menu && labels.language && labels.menu !== 'nav.menu');
		}
		await page.selectOption('#language-select', 'th');
		await page.evaluate(() => showPage('streams'));
		assert.match(await page.locator('[data-source-type="twitch"]').textContent(), /Twitch/);
		assert.match(await page.locator('[data-source-type="kick"]').textContent(), /Kick/);
		await page.reload();
		await page.waitForFunction(() => window.stateManager?.initialized, null, { polling: 100 });
		assert.strictEqual(await page.locator('#language-select').inputValue(), 'th');
		assert.strictEqual(await toggle.getAttribute('aria-label'), 'เมนูนำทาง');
		console.log(`PASS navigation keyboard, focus, accessible labels, ${locales.length} locales, and reload persistence (${packagedApp ? 'packaged' : 'source'}).`);
	} finally {
		await app.close();
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
