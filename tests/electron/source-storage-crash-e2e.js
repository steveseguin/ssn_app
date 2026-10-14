'use strict';

// Launch through macOS like an installed app, without Playwright's main-process
// inspector: that inspector changes the storage timing and can mask this bug.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const output = process.env.SSAPP_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-source-crash-'));
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'profile-'));
const bundle = process.env.SSAPP_TEST_BUNDLE || path.resolve(path.dirname(require('electron')), '../..');
const report = { output, profile, bundle, cases: [], complete: false };
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, pid;
async function until(fn, label) {
    for (let n = 0; n < 400; n++) {
        try { const result = await fn(); if (result) return result; } catch (_) {}
        await delay(200);
    }
    throw new Error('Timed out: ' + label);
}
async function run() {
    assert.equal(process.platform, 'darwin', 'This regression covers macOS LaunchServices');
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    let expected;
    for (let cycle = 0; cycle < 5; cycle++) {
        execFileSync('/usr/bin/open', ['-n', '-a', bundle, '--env', 'SSAPP_USER_DATA_DIR=' + profile,
            '--stdout', path.join(output, `stdout-${cycle}.log`), '--stderr', path.join(output, `stderr-${cycle}.log`),
            '--args', ...(process.env.SSAPP_TEST_BUNDLE ? [] : [root]), '--multiinstance', '--remote-debugging-port=' + port]);
        browser = await until(() => chromium.connectOverCDP('http://127.0.0.1:' + port), 'app debugger');
        const main = await until(() => browser.contexts()[0].pages().find(page => page.url().includes('/index.html')), 'main window');
        await main.waitForFunction(() => window.stateManager?.initialized && configReady, null, { polling: 100, timeout: 90000 });
        pid = await main.evaluate(() => process.ppid);
        const background = await until(() => main.frames().find(frame => frame.url().includes('/background.html')), 'background');
        await background.waitForFunction(() => typeof loadedFirst !== 'undefined' && loadedFirst, null, { polling: 100, timeout: 90000 });
        const popup = await until(() => main.frames().find(frame => /\/popup(?:\.html)?(?:\?|$)/.test(frame.url())), 'settings');
        await popup.waitForSelector('#textonlymode', { state: 'attached' });
        await delay(2500);
        const snapshot = () => main.evaluate(() => ({
            sources: stateManager.getSources().map(({ id, url, username, groupId, customSession, userAgent, isMuted }) =>
                ({ id, url, username, groupId, customSession, userAgent, isMuted })),
            groups: stateManager.getGroups().map(({ id, username, customSession, userAgent, streams }) =>
                ({ id, username, customSession, userAgent, streams })),
            order: stateManager.state.global.rootOrder,
        }));
        if (expected) {
            const restored = await snapshot();
            report.cases.push({ cycle, expected, restored }); save();
            assert.deepEqual(restored, expected, 'Saved sources/groups changed after restart');
            assert.equal(await popup.locator('#textonlymode').isChecked(), true);
            assert.equal(await main.locator('#language-select').inputValue(), 'es');
        }
        if (cycle === 0) {
            await popup.locator('#textonlymode').evaluate(el => { if (!el.checked) el.click(); });
            await main.selectOption('#language-select', 'es');
            await main.locator('[data-source-type="other"]').click();
            await main.locator('#source-setup-input').fill('https://www.youtube.com/live_chat?is_popout=1&v=SSAPPQA0001');
            await main.locator('#source-setup-form button[type="submit"]').click();
            await main.waitForFunction(() => stateManager.getSources().length === 1, null, { polling: 100 });
        } else if (cycle === 1) {
            await main.evaluate(() => {
                const groupId = stateManager.addGroup({ target: 'custom', username: 'Crash group', autoActivate: false,
                    customSession: 'crash-group-session', userAgent: 'crash-group-agent' });
                stateManager.addSource({ target: 'custom', username: 'Grouped source', groupId, autoActivate: false });
                stateManager.updateSource(stateManager.getSources()[0].id, { userAgent: 'saved-agent', isMuted: false });
            });
        } else if (cycle === 2) {
            await main.evaluate(() => stateManager.removeSource(stateManager.getSources()[0].id));
        } else if (cycle === 3) {
            await main.evaluate(() => clearAllSources());
        }
        expected = await snapshot();
        // Bounded wait: this must not depend on Chromium's eventual idle commit.
        await delay(Number(process.env.SSAPP_CRASH_SETTLE_MS || 1500));
        if (cycle === 2 || cycle === 4) await main.evaluate(() => setTimeout(() => window.close(), 100));
        else process.kill(pid, 'SIGKILL');
        await browser.close().catch(() => {}); browser = null;
        await until(() => { try { process.kill(pid, 0); return false; } catch (_) { return true; } }, 'app exits');
        pid = null;
    }
    report.complete = true; save();
    console.log('PASS added/edited/grouped/deleted/cleared sources survive forced and normal quit; settings/language retained. ' + output);
}
run().catch(error => { report.error = error.stack; save(); console.error(error); process.exitCode = 1; }).finally(async () => {
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch (_) {} }
    if (browser) await browser.close().catch(() => {});
});
