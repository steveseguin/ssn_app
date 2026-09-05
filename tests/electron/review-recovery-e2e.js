'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

async function run() {
	const root = path.resolve(__dirname, '../..');
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-recovery-e2e-'));
	const server = http.createServer((_req, res) => {
		res.setHeader('Content-Type', 'text/html');
		res.end('<title>Local fixture</title><script>window.ticks=0;setInterval(()=>window.ticks++,50)</script>');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://chat.alpha.co.uk:${server.address().port}/`;
	const other = `http://chat.beta.co.uk:${server.address().port}/`;
	const packagedApp = process.env.SSAPP_TEST_APP;
	const app = await _electron.launch({ executablePath: packagedApp || require('electron'), cwd: root,
		args: [...(packagedApp ? [] : ['.', '--running-from-source', `--filesource=${path.resolve(root, '../social_stream').replace(/\\/g, '/')}/`]),
			'--ssapp-headless-control', '--no-hwa', '--host-resolver-rules=MAP *.co.uk 127.0.0.1', ...linuxLaunchArgs()],
		env: { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_PREFER_LOCAL_ASSETS: packagedApp ? '1' : '0' }, timeout: 60000 });
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.stateManager?.initialized);
		const id = await page.evaluate(async url => {
			const id = stateManager.addSource({ target: 'youtube', url, autoActivate: false, customSession: 'review-isolated' });
			await performActivationAttempt({ sourceId: id, mode: 'classic' });
			return id;
		}, url);
		await page.waitForTimeout(1500);
		await app.evaluate(async ({ BrowserWindow }, { url, other }) => {
			const wc = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url).webContents;
			await wc.session.cookies.set({ url, name: 'alpha', value: 'alpha', httpOnly: true });
			await wc.session.cookies.set({ url, name: 'alphaPath', value: 'alpha', httpOnly: true, path: '/private' });
			await wc.session.cookies.set({ url: other, name: 'beta', value: 'beta', httpOnly: true });
			await wc.executeJavaScript('localStorage.setItem("review","stored"); sessionStorage.setItem("review","stored");');
		}, { url, other });
		await page.evaluate(async id => {
			const row = document.querySelector(`[data-source-id="${id}"]`);
			const button = document.createElement('button'); row.appendChild(button);
			await clearThis(button);
		}, id);
		await page.waitForTimeout(500);
		const cleared = await app.evaluate(async ({ BrowserWindow }, url) => {
			const wc = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url).webContents;
			return { cookies: (await wc.session.cookies.get({})).map(c => c.name),
				storage: await wc.executeJavaScript('[localStorage.getItem("review"),sessionStorage.getItem("review")]') };
		}, url);
		assert.deepStrictEqual(cleared.cookies, ['beta']);
		assert.deepStrictEqual(cleared.storage, [null, null]);
		// Crash and recover twice: no stale "active" state and no one-shot-only recovery.
		for (let attempt = 0; attempt < 2; attempt++) {
			await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url).webContents.forcefullyCrashRenderer(), url);
			await page.waitForFunction(id => stateManager.getSource(id)?.status === 'error', id);
			assert.match(await page.evaluate(id => stateManager.getSource(id).error, id), /capture page crashed/);
			await page.evaluate(id => refreshWindow(document.querySelector(`[data-source-id="${id}"] [data-reloadhtml]`)), id);
			await page.waitForFunction(id => stateManager.getSource(id)?.status === 'active' && !stateManager.getSource(id).error, id);
			await page.waitForTimeout(1000);
			const running = await app.evaluate(async ({ BrowserWindow }, url) => {
				const wc = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url).webContents;
				return !wc.isCrashed() && await wc.executeJavaScript('window.ticks > 2');
			}, url);
			assert.strictEqual(running, true);
		}
		await page.evaluate(async id => deleteThis(document.querySelector(`[data-source-id="${id}"]`)), id);
		const originalId = await page.evaluate(() => stateManager.addSource({ target: 'youtube', username: 'local_import_fixture', autoActivate: false }));
		// A profile's reusable session and user-agent definitions must travel with its backup.
		await page.evaluate(() => {
			localStorage.setItem('customSessions', JSON.stringify([{name: 'backup-session', created: 1, description: 'Fixture'}]));
			localStorage.setItem('customUserAgents', JSON.stringify([{name: 'Backup browser', value: 'Backup fixture/1.0'}]));
		});
		const exportPath = path.join(profile, 'export.data');
		await app.evaluate(({Menu, dialog}, exportPath) => {
			dialog.showSaveDialog = async () => ({canceled: false, filePath: exportPath});
			dialog.showMessageBox = async () => ({response: 0});
			function find(menu) { for (const item of menu.items) { if (item.label?.startsWith('Export Settings')) return item; if (item.submenu) { const found = find(item.submenu); if (found) return found; } } }
			find(Menu.getApplicationMenu()).click();
		}, exportPath);
		for (let i = 0; i < 100 && !fs.existsSync(exportPath); i++) await page.waitForTimeout(100);
		const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
		assert.ok(exported.localStorage.customSessions, 'Export omitted reusable browser sessions');
		assert.ok(exported.localStorage.customUserAgents, 'Export omitted reusable user agents');
		const importPath = path.join(profile, 'import.data');
		const importFile = async payload => {
			fs.writeFileSync(importPath, JSON.stringify(payload));
			await app.evaluate(({ Menu, dialog }, importPath) => {
				global.reviewImportDialogs = [];
				dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [importPath] });
				dialog.showMessageBox = async options => { global.reviewImportDialogs.push(options.title); return { response: 0 }; };
				function find(menu) { for (const item of menu.items) { if (item.label?.startsWith('Import Settings')) return item; if (item.submenu) { const found = find(item.submenu); if (found) return found; } } }
				find(Menu.getApplicationMenu()).click();
			}, importPath);
			for (let i = 0; i < 100; i++) {
				const done = await app.evaluate(() => global.reviewImportDialogs.find(title => title === 'Settings Import Failed' || title === 'Settings Imported'));
				if (done) return done;
				await page.waitForTimeout(100);
			}
			throw new Error('Import did not finish');
		};
		for (const key of ['customSessions', 'customUserAgents']) {
			for (const invalid of ['not-json', 'null', '{}', '[null]', '[{}]']) {
				assert.strictEqual(await importFile({localStorage: {[key]: invalid}}), 'Settings Import Failed');
				assert.strictEqual(await page.evaluate(id => !!stateManager.getSource(id), originalId), true);
			}
		}
		await page.evaluate(() => {
			localStorage.setItem('customSessions', '[]');
			localStorage.setItem('customUserAgents', '[]');
		});
		assert.strictEqual(await importFile(exported), 'Settings Imported');
		await page.waitForFunction(() => window.stateManager?.initialized && JSON.parse(localStorage.getItem('customSessions'))?.length === 1);
		assert.deepStrictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('customSessions'))), JSON.parse(exported.localStorage.customSessions));
		assert.deepStrictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('customUserAgents'))), JSON.parse(exported.localStorage.customUserAgents));
		await page.locator(`[data-source-id="${originalId}"] [onclick="openUserAgentSettings(this)"]`).waitFor({state: 'attached'});
		await page.evaluate(id => openUserAgentSettings(document.querySelector(`[data-source-id="${id}"] [onclick="openUserAgentSettings(this)"]`)), originalId);
		assert.strictEqual(await page.locator('#userAgentSelect option[value="Backup fixture/1.0"]').count(), 1);
		await page.evaluate(() => closeUserAgentModal());
		await page.evaluate(id => openSessionSettings(document.querySelector(`[data-source-id="${id}"] [onclick="openSessionSettings(this)"]`)), originalId);
		assert.strictEqual(await page.locator('#sessionsList [data-session-value="backup-session"]').count(), 1);
		await page.evaluate(() => closeSessionModal());
		for (const invalid of ['not-json', JSON.stringify({ sources: [['bad', null]], groups: [], global: {} })]) {
			assert.strictEqual(await importFile({ localStorage: { socialStreamState: invalid } }), 'Settings Import Failed');
			assert.strictEqual(await page.evaluate(id => !!stateManager.getSource(id), originalId), true);
		}
		const validState = { sources: [['restored', { id: 'restored', target: 'twitch', username: 'restored_fixture', autoActivate: false }]], groups: [], global: {} };
		assert.strictEqual(await importFile({ localStorage: { socialStreamState: JSON.stringify(validState) } }), 'Settings Imported');
		await page.waitForFunction(() => window.stateManager?.initialized && !!stateManager.getSource('restored'));
		const rollback = JSON.parse(fs.readFileSync(path.join(profile, 'settings-before-import.data'), 'utf8'));
		assert.ok(JSON.parse(rollback.localStorage.socialStreamState).sources.some(([id]) => id === originalId));
		assert.strictEqual(await importFile(rollback), 'Settings Imported');
		await page.waitForFunction(id => window.stateManager?.initialized && !!stateManager.getSource(id), originalId);
		console.log('[review-recovery-e2e] PASS: scoped cookies/storage, repeated crash/reload recovery, rejected invalid imports, valid import, reusable session/user-agent export/restore, malformed library rejection, and rollback backup.');
	} finally {
		await app.close();
		await new Promise(resolve => server.close(resolve));
	}
}
run().catch(error => { console.error(error); process.exitCode = 1; });
