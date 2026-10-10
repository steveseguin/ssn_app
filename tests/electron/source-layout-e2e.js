'use strict';

// Real-app visual/layout audit. Screenshots use BrowserWindow.capturePage because
// Playwright's page screenshots clip Electron windows at non-default zoom.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const root = path.resolve(__dirname, '../..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-source-layout-'));
const base = pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href;
const report = { screens: [], errors: [] };

(async () => {
	console.log('Screenshots and report: ' + output);
	const app = await _electron.launch({ executablePath: require('electron'), cwd: root,
		args: ['.', '--running-from-source', '--filesource=' + base, '--multiinstance', ...linuxLaunchArgs()],
		env: { ...process.env, SSAPP_USER_DATA_DIR: path.join(output, 'profile') }, timeout: 60000 });
	try {
		const page = await app.firstWindow();
		page.on('pageerror', error => report.errors.push(error.message));
		await page.waitForFunction(() => window.stateManager?.initialized && typeof configReady !== 'undefined' && configReady);
		const win = await app.browserWindow(page);
		const ids = await page.evaluate(() => {
			const result = {};
			for (const target of ['tiktok', 'youtube', 'whatnot', 'ebay']) {
				result[target] = stateManager.addSource({ target, username: 'layout_example', autoActivate: false,
					connectionMode: target === 'tiktok' ? 'tiktok-websocket' : target === 'whatnot' ? 'websocket' : 'classic',
					tiktokSigningProvider: 'auto', url: `https://example.invalid/${target}` });
			}
			manageWelcomePage(); return result;
		});
		async function shot(name) {
			await page.waitForTimeout(150);
			const layout = await page.evaluate(() => ({
				width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
				dialogs: [...document.querySelectorAll('[role="dialog"], .yt-stream-modal-content')]
					.filter(el => el.getBoundingClientRect().width && !el.closest('.hidden'))
					.map(el => ({ rect: el.getBoundingClientRect().toJSON(), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
			}));
			const contrast = await page.evaluate(() => {
				const rgb = value => (value.match(/[\d.]+/g) || []).map(Number);
				const blend = (front, back) => front.slice(0, 3).map((c, i) => c * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)));
				const luminance = color => color.map(c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; })
					.reduce((sum, c, i) => sum + c * [.2126,.7152,.0722][i], 0);
				return [...document.querySelectorAll('.source-setup button:not(:disabled), .source-setup label, .provider-help-text, .youtube-source-choice-description, .youtube-source-choice-badge, .signin-method-option-description, .signin-method-note, .stream-status-badge, .yt-stream-button:not(:disabled)')]
					.filter(el => el.getBoundingClientRect().width && el.textContent.trim())
					.map(el => {
						const chain = []; for (let node = el; node; node = node.parentElement) chain.unshift(node);
						let background = [255,255,255];
						for (const node of chain) background = blend(rgb(getComputedStyle(node).backgroundColor), background);
						const foreground = blend(rgb(getComputedStyle(el).color), background);
						const l1 = luminance(foreground), l2 = luminance(background);
						return { selector: el.className || el.tagName, ratio: (Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05) };
					});
			});
			report.screens.push({ name, layout, contrast });
			fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(await win.evaluate(async w => (await w.capturePage()).toPNG().toString('base64')), 'base64'));
			fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
			assert.ok(!layout.overflow, name + ': page must not overflow horizontally');
			assert.ok(contrast.every(item => item.ratio >= 4.5), name + ': text contrast ' + JSON.stringify(contrast.filter(item => item.ratio < 4.5)));
			for (const dialog of layout.dialogs) {
				assert.ok(dialog.rect.left >= -1 && dialog.rect.right <= layout.width + 1, name + ': dialog fits horizontally');
				assert.ok(dialog.scrollWidth <= dialog.clientWidth + 1, name + ': dialog content must not overflow horizontally');
			}
		}
		async function setupDialogs(tag) {
			for (const target of ['whatnot', 'ebay', 'youtube']) {
				await page.locator(`[data-source-type="${target}"]`).click();
				await shot(tag + '-' + target);
				if (target === 'youtube') {
					const modal = page.locator('#youtubeAddModeModal');
					assert.ok(await modal.evaluate(el => el.contains(document.activeElement)));
					for (let n = 0; n < 6; n++) await page.keyboard.press('Tab');
					assert.ok(await modal.evaluate(el => el.contains(document.activeElement)));
				}
				await page.keyboard.press('Escape');
				assert.ok(await page.locator('#youtubeAddModeModal').isHidden());
			}
		}
		for (const theme of ['dark', 'light']) {
			await app.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value; }, theme);
			await page.emulateMedia({ colorScheme: theme });
			assert.strictEqual(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), theme === 'dark');
			for (const [width, height, zoom] of [[1920,1080,1], [1366,768,1], [1024,768,1.25], [800,600,1.5]]) {
				await win.evaluate((w, v) => { w.setSize(v.width, v.height); w.webContents.setZoomFactor(v.zoom); }, { width, height, zoom });
				const tag = `${theme}-${width}-${height}-${zoom}`;
				await shot(tag + '-sources'); await setupDialogs(tag);
				await page.evaluate(id => showTikTokSignInMenu(id), ids.tiktok);
				await shot(tag + '-tiktok'); await page.keyboard.press('Escape');
			}
		}
		await win.evaluate(w => { w.setSize(1024,768); w.webContents.setZoomFactor(1); });
		for (const locale of ['de', 'es', 'fr', 'pt-br', 'cs', 'tr', 'uk', 'ar', 'th', 'zh-CN', 'zh-TW']) {
			await page.selectOption('#language-select', locale);
			await shot(locale + '-sources'); await setupDialogs(locale);
			await page.evaluate(id => showTikTokSignInMenu(id), ids.tiktok);
			await shot(locale + '-tiktok'); await page.keyboard.press('Escape');
		}
		await page.selectOption('#language-select', 'de');
		await win.evaluate(w => { w.setSize(800,600); w.webContents.setZoomFactor(1.5); });
		for (const target of ['youtube', 'whatnot', 'ebay']) {
			const row = page.locator(`[data-source-id="${ids[target]}"]`);
			await row.scrollIntoViewIfNeeded(); await shot('source-row-' + target);
			for (const mode of ['classic', 'websocket']) {
				const option = row.locator(`.mode-option[data-mode="${mode}"]`);
				if (!await option.count()) continue;
				await option.click(); await shot('source-row-' + target + '-' + mode);
			}
		}
		for (const mode of ['auto', 'local', 'polling', 'standard', 'euler-ws', 'custom', 'tikfinity']) {
			await page.locator('.tiktok-connection-select').selectOption(mode);
			await shot('mode-' + mode);
			if (['standard', 'tikfinity'].includes(mode)) continue;
			await page.evaluate(id => showTikTokSignInMenu(id), ids.tiktok);
			await shot('mode-' + mode + '-signin');
			await page.locator('.tiktok-signing-dialog details summary').click();
			await shot('mode-' + mode + '-advanced');
			await page.keyboard.press('Escape');
		}
		await page.evaluate(() => { document.documentElement.style.fontSize = '150%'; });
		await shot('font-150-sources'); await setupDialogs('font-150');
		await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
		for (const theme of ['dark', 'light']) {
			await page.evaluate(({ id, theme }) => {
				document.documentElement.dataset.ssappTheme = theme;
				const source = stateManager.getSource(id);
				if (!showSigninMethodChoice(document.querySelector(`[data-source-id="${id}"] [data-signin]`), { ...source, connectionMode: 'classic' })) throw new Error('Sign-in choice did not open');
			}, { id: ids.tiktok, theme });
			await shot('signin-palette-' + theme); await page.keyboard.press('Escape');
		}
		await page.evaluate(() => {
			delete document.documentElement.dataset.ssappTheme;
			if (!window.streamSelector) window.streamSelector = new YouTubeStreamSelector();
			void streamSelector.show([
				{ videoId: 'fixture1', title: 'Eine außergewöhnlich lange Live-Sendung mit vielen unterschiedlichen Artikeln und Angeboten', status: 'live', viewers: 1234 },
				{ videoId: 'fixture2', title: '予定されたライブ配信 – تفاصيل البث المباشر القادمة', status: 'upcoming', scheduledStartTime: new Date(Date.now()+3600000).toISOString() }
			], 'Example channel', false, false);
		});
		await page.waitForTimeout(500); await shot('long-stream-picker'); await page.locator('#ytCancelButton').click();
		await page.waitForTimeout(500);
		await page.reload();
		await page.waitForFunction(() => window.stateManager?.initialized);
		assert.strictEqual(await page.locator('.tiktok-connection-select').inputValue(), 'tikfinity', 'Selected TikTok mode survives reload');
		assert.deepStrictEqual(report.errors, []);
		console.log(`PASS ${report.screens.length} real-app layout screenshots, dialog bounds, keyboard containment, resolutions, zoom, font size, themes and locales.`);
	} finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
