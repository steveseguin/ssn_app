'use strict';

// Real UI settings and complete app restarts, using an isolated profile and
// synthetic credentials. Does not contact or sign into any TikTok account.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { waitFor } = require('./tiktok-disconnect-validation-e2e');
const { electronTestTarget, electronTestRuntime, linuxLaunchArgs } = require('./helpers/electron-launch');
const root = path.resolve(__dirname, '../..');

async function run() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-tiktok-settings-'));
    const target = electronTestTarget(pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href);
    const report = { profile, checks: [] };
    let app;
    async function launch() {
        app = await _electron.launch({ executablePath: target.executablePath, cwd: root,
            args: [...target.args, '--multiinstance', ...linuxLaunchArgs()],
            env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000 });
        app.process().stdout.resume(); app.process().stderr.resume();
        const page = await app.firstWindow();
        await page.waitForFunction(() => window.stateManager?.initialized && configReady);
        await page.waitForTimeout(3000);
        report.runtime = await electronTestRuntime(app);
        return page;
    }
    async function close() {
        if (!app) return;
        const child = app.process();
        await app.evaluate(({ BrowserWindow }) => {
            const main = BrowserWindow.getAllWindows().find(w => /\/index\.html/.test(w.webContents.getURL()));
            if (main) main.close();
        });
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'normal shutdown', 15000);
        await app.close();
        app = null;
    }
    try {
        let page = await launch();
        const id = await page.evaluate(() => stateManager.addSource({
            target: 'tiktok', username: 'settings_fixture', url: 'https://www.tiktok.com/@settings_fixture/live',
            autoActivate: false, connectionMode: 'tiktok-websocket', tiktokSigningProvider: 'local',
            tiktokSessionId: 'synthetic-session-only', tiktokTtTargetIdc: 'synthetic-idc-only',
            tiktokSigningApiKey: 'synthetic-key-only',
        }));
        const selector = `[data-source-id="${id}"] .tiktok-connection-select`;
        await page.locator(selector).selectOption('tikfinity');
        await page.locator(selector).selectOption('polling');
        await close();
        page = await launch();
        const source = await page.evaluate(id => stateManager.getSource(id), id);
        assert.ok(source, 'TikTok source disappeared after app restart');
        assert.strictEqual(source.tiktokSigningProvider, 'auto');
        assert.strictEqual(source.connectionMode, 'tiktok-legacy');
        assert.strictEqual(source.tiktokSessionId, 'synthetic-session-only');
        assert.strictEqual(source.tiktokTtTargetIdc, 'synthetic-idc-only');
        assert.strictEqual(source.tiktokSigningApiKey, 'synthetic-key-only');
        assert.strictEqual(await page.locator(selector).inputValue(), 'polling');
        report.checks.push('Mode and credentials survive full app restart');
        await page.evaluate(id => stateManager.removeSource(id), id);
        await close();
        page = await launch();
        assert.strictEqual(await page.evaluate(id => !!stateManager.getSource(id), id), false);
        report.checks.push('Deleted source stays deleted after full app restart');
        report.complete = true;
        console.log('PASS TikTok settings survive app restarts and deletion');
    } catch (error) {
        report.error = error.message;
        throw error;
    } finally {
        await close().catch(() => {});
        fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
        console.log('Evidence: ' + profile);
    }
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
