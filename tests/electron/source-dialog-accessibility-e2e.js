'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');

async function run() {
	const root = path.resolve(__dirname, '../..');
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-source-dialog-'));
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
		const id = await page.evaluate(() => stateManager.addSource({target: 'youtube', username: 'dialog_fixture', autoActivate: false}));
		await page.waitForTimeout(2000); // Allow the initial source-list render to settle.
		const source = page.locator(`[data-source-id="${id}"]`);
		async function open(name) {
			await source.locator('.settings-btn').press('Enter');
			await source.locator(`[onclick="${name}(this)"]`).press('Enter');
		}
		for (let repeat = 0; repeat < 3; repeat++) {
			for (const [name, modalId] of [['openUserAgentSettings', 'userAgentModal'], ['openSessionSettings', 'sessionModal']]) {
				await open(name);
				const modal = page.locator(`#${modalId}`);
				assert.ok(await modal.isVisible());
				assert.ok(await modal.evaluate(el => el.contains(document.activeElement)));
				assert.strictEqual(await modal.locator('[role="dialog"]').getAttribute('aria-modal'), 'true');
				for (let tab = 0; tab < 12; tab++) {
					await page.keyboard.press(tab < 6 ? 'Tab' : 'Shift+Tab');
					assert.ok(await modal.evaluate(el => el.contains(document.activeElement)));
				}
				await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', isComposing: true, bubbles: true})));
				assert.ok(await modal.isVisible(), 'IME Escape must not dismiss the dialog');
				await page.keyboard.press('Escape');
				assert.ok(!(await modal.isVisible()));
				assert.ok(await source.locator('.settings-btn').evaluate(el => el === document.activeElement));
				assert.strictEqual(await page.locator('body > [inert]').count(), 0);
			}
		}
		await open('openSessionSettings');
		await page.locator('#customSessionName').fill('keyboard-session');
		await page.locator('[onclick="addCustomSession()"]').press('Enter');
		const row = page.locator('#sessionsList [data-session-value="keyboard-session"]');
		await page.locator('#sessionsList button[data-session-value]').press('Enter');
		await row.locator('button[aria-pressed]').press('Enter');
		assert.strictEqual(await page.evaluate(() => window.currentSelectedSession), 'keyboard-session');
		assert.strictEqual(await row.locator('button[aria-pressed]').getAttribute('aria-pressed'), 'true');
		await page.locator('[onclick="saveSessionSelection()"]').press('Enter');
		assert.ok(await source.locator('.settings-btn').evaluate(el => el === document.activeElement));
		await open('openUserAgentSettings');
		await page.locator('#customUserAgentInput').fill('SSApp keyboard fixture/1.0');
		await page.locator('[onclick="addCustomUserAgent()"]').press('Enter');
		await page.locator('#userAgentSelect').selectOption('SSApp keyboard fixture/1.0');
		await page.locator('[onclick="saveUserAgentSelection()"]').press('Enter');
		await page.reload();
		await page.waitForFunction(() => window.stateManager?.initialized, null, {polling: 100});
		await page.waitForTimeout(2000);
		const saved = await page.evaluate(id => stateManager.getSource(id), id);
		assert.strictEqual(saved.customSession, 'keyboard-session');
		assert.strictEqual(saved.userAgent, 'SSApp keyboard fixture/1.0');
		await open('openSessionSettings');
		assert.strictEqual(await row.locator('button[aria-pressed]').getAttribute('aria-pressed'), 'true');
		await page.locator('[onclick="closeSessionModal()"]').press('Enter');
		// Exercise a real existing dialog that uses the same shared modal behavior.
		const rumbleId = await page.evaluate(() => stateManager.addSource({target: 'rumble', username: 'dialog_fixture', autoActivate: false}));
		await page.waitForTimeout(2000);
		const signinButton = page.locator(`[data-source-id="${rumbleId}"] [data-signin]`);
		await signinButton.press('Enter');
		const signin = page.locator('#tiktok-auth-modal');
		await signin.waitFor({state: 'visible'});
		for (let tab = 0; tab < 5; tab++) {
			await page.keyboard.press('Tab');
			assert.ok(await signin.evaluate(el => el.contains(document.activeElement)));
		}
		await page.keyboard.press('Escape');
		assert.strictEqual(await signin.count(), 0);
		assert.ok(await signinButton.evaluate(el => el === document.activeElement));
		assert.strictEqual(await page.locator('body > [inert]').count(), 0);
		const locales = await page.locator('#language-select option').evaluateAll(options => options.map(option => option.value));
		for (const locale of locales) {
			await page.selectOption('#language-select', locale);
			for (const [name, modalId, key] of [['openSessionSettings', 'sessionModal', 'session.title'], ['openUserAgentSettings', 'userAgentModal', 'useragent.title']]) {
				await open(name);
				const title = await page.locator(`#${modalId} [role="dialog"]`).evaluate(el => document.getElementById(el.getAttribute('aria-labelledby')).textContent);
				assert.strictEqual(title, await page.evaluate(key => translate(key), key));
				assert.ok(title && title !== key);
				const inputId = modalId === 'sessionModal' ? 'customSessionName' : 'customUserAgentInput';
				const inputLabel = await page.locator(`#${inputId}`).evaluate(el => el.labels?.[0]?.textContent);
				assert.ok(inputLabel, 'Custom input must have an associated label');
				await page.keyboard.press('Escape');
			}
		}
		console.log(`PASS source dialog focus, repeated open/close, Tab containment, IME, keyboard selection, save/reload, and ${locales.length} language choices (${packagedApp ? 'packaged' : 'source'}).`);

	} finally {
		await app.close();
		fs.rmSync(profile, {recursive: true, force: true});
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
