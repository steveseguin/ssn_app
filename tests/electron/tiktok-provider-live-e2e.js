'use strict';

// Read-only live checks. Credentials come from the ignored .secret file or
// environment, never from command-line arguments or checked-in fixtures.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const WebSocket = require('ws');
const { freePort, waitFor } = require('./tiktok-disconnect-validation-e2e');
const { linuxLaunchArgs, electronTestTarget, electronTestRuntime } = require('./helpers/electron-launch');
const root = path.resolve(__dirname, '../..');

async function run() {
    const username = process.env.SSAPP_LIVE_USER;
    assert.ok(username && /^[a-z0-9_.]+$/i.test(username) && !/camcam66gaming/i.test(username));
    const secret = fs.existsSync(path.join(root, '.secret')) ? fs.readFileSync(path.join(root, '.secret'), 'utf8') : '';
    const key = process.env.EULER_TEST_API_KEY || secret.match(/^EULER_TEST_API_KEY=(.+)$/m)?.[1].trim();
    assert.ok(key, 'Set EULER_TEST_API_KEY in the environment or ignored .secret file');
    const profile = process.env.SSAPP_TIKTOK_AUTH_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-tiktok-provider-live-'));
    assert.ok(path.basename(profile).startsWith('ssapp-tiktok-'), 'Use an isolated TikTok test profile');
    assert.strictEqual(path.resolve(path.dirname(profile)), path.resolve(os.tmpdir()));
    const port = await freePort();
    const room = 'provider_live_' + Date.now();
    const settingsPath = path.join(profile, 'savedSync.json');
    const saved = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
    // Preserve the authenticated profile's settings; replacing them with a
    // minimal fixture correctly triggers the application's backup recovery.
    fs.writeFileSync(settingsPath, JSON.stringify({ ...saved, streamID: room, password: 'false', state: true,
        wsServer: true, settings: { ...saved.settings, server2: { setting: true }, capturelikeevent: { setting: true } } }));
    const redact = value => String(value).split(key).join('[redacted]').replace(/euler_[A-Za-z0-9_-]+/g, '[redacted]');
    const report = { profile, username, checks: [] };
    const received = [];
    let app, relay;
    try {
        const sourceBase = pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href;
        const target = electronTestTarget(sourceBase);
        app = await _electron.launch({ executablePath: target.executablePath, cwd: root,
            args: [...target.args, '--multiinstance', '--disable-logs', '--ssapp-local-server-port=' + port, ...linuxLaunchArgs()],
            env: { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_DEBUG_LOGS: '0' }, timeout: 60000 });
        // Drain process output without recording credentials/cookies returned by
        // third-party libraries in diagnostic errors.
        app.process().stdout.resume(); app.process().stderr.resume();
        const page = await app.firstWindow();
        await page.waitForFunction(() => window.stateManager?.initialized && configReady);
        await page.waitForTimeout(6000);
        report.runtime = await electronTestRuntime(app);
        report.runtime.userData = await app.evaluate(({ app }) => app.getPath('userData'));
        report.savedSources = await page.evaluate(() => stateManager.getSources().map(s => ({
            id: s.id, target: s.target, username: s.username, hasSession: !!s.tiktokSessionId, hasIdc: !!s.tiktokTtTargetIdc,
        })));
        console.log(JSON.stringify({ savedSources: report.savedSources }));
        relay = new WebSocket('ws://127.0.0.1:' + port);
        await new Promise((resolve, reject) => { relay.once('open', resolve); relay.once('error', reject); });
        relay.send(JSON.stringify({ join: room, out: 3, in: 4 }));
        relay.on('message', raw => { try { const m = JSON.parse(raw); if (m.type === 'tiktok') received.push(m); } catch (_) {} });
        const presets = (process.env.SSAPP_LIVE_PRESETS || 'custom,euler-ws,auto,polling,local,standard').split(',');
        for (const preset of presets) {
            assert.ok(['custom', 'euler-ws', 'auto', 'polling', 'local', 'standard'].includes(preset));
            const check = { preset, passed: false };
            let id;
            try {
                id = await page.evaluate(({ username, preset }) => {
                    if (preset === 'local' || preset === 'standard') {
                        const existing = stateManager.getSources().find(s => s.target === 'tiktok' && s.username === username && s.tiktokSessionId);
                        if (existing) return existing.id;
                    }
                    return stateManager.addSource({ id: 'provider-live-' + preset, target: 'tiktok', username,
                        url: 'https://www.tiktok.com/@' + username + '/live', autoActivate: false,
                        connectionMode: 'tiktok-websocket', tiktokSigningProvider: 'auto', isVisible: false, isMuted: true });
                }, { username, preset });
                const entry = page.locator(`[data-source-id="${id}"]`);
                await entry.locator('.tiktok-connection-select').selectOption(preset);
                if (process.env.SSAPP_TIKTOK_AUTH_PROFILE && (preset === 'local' || preset === 'standard')) {
                    await page.evaluate(id => showTikTokSignInMenu(id), id);
                    await page.locator(`[id="tiktok-signing-generate-${id}"]`).click();
                    await waitFor(async () => await page.evaluate(id => !!stateManager.getSource(id).tiktokSessionId
                        && !!stateManager.getSource(id).tiktokTtTargetIdc, id), 'saved TikTok login collected', 60000);
                    await page.evaluate(() => closeModal());
                    // Collect Session selects Local Signer; restore the mode under test.
                    await entry.locator('.tiktok-connection-select').selectOption(preset);
                }
                check.authenticated = await page.evaluate(id => !!stateManager.getSource(id).tiktokSessionId, id);
                if (preset === 'custom' || preset === 'euler-ws' || preset === 'polling') {
                    await page.evaluate(id => showTikTokSignInMenu(id), id);
                    await page.locator(`[id="tiktok-signing-api-key-${id}"]`).fill(key);
                    await page.locator(`button[onclick="saveTikTokSigningConfig('${id}')"]`).click();
                    await page.evaluate(() => closeModal());
                }
                const start = received.length;
                await entry.locator('[data-activatehtml]').click({ force: true });
                await waitFor(async () => {
                    const state = await page.evaluate(id => { const s = stateManager.getSource(id); return { status: s.status, vid: s.vid, error: s.error }; }, id);
                    // Quota notices can briefly set an error while AUTO is
                    // still switching methods. Wait for the eventual outcome.
                    if (state.error) check.lastNotice = redact(state.error);
                    return received.slice(start).some(m => m.tid === state.vid && !m.event && !m.hasDonation);
                }, preset + ' fresh live chat', 150000);
                await page.waitForTimeout(20000);
                const state = await page.evaluate(id => { const s = stateManager.getSource(id); return { status: s.status, vid: s.vid, method: s.tiktokConnectionMethod }; }, id);
                check.method = state.method;
                const messages = received.slice(start).filter(m => m.tid === state.vid);
                check.chat = messages.filter(m => !m.event && !m.hasDonation).length;
                check.events = messages.filter(m => m.event || m.hasDonation).length;
                if (preset === 'euler-ws') assert.match(check.method || '', /Euler WS relay/i);
                const classicStop = entry.locator('[data-stophtml]');
                await (await classicStop.isVisible() ? classicStop : entry.locator('[data-activatehtml]')).click({ force: true });
                await waitFor(async () => await page.evaluate(id => stateManager.getSource(id).status === 'inactive', id), preset + ' Stop');
                await page.waitForTimeout(1500);
                const stopped = received.length;
                await page.waitForTimeout(4000);
                assert.strictEqual(received.length, stopped, 'Messages arrived after Stop');
                check.passed = true;
            } catch (error) {
                check.error = redact(error.message);
            } finally {
                if (id) await page.evaluate(async id => {
                    const entry = document.querySelector(`[data-source-id="${id}"]`);
                    if (entry) await stopThis(entry.querySelector('[data-stophtml]'));
                }, id).catch(() => {});
                report.checks.push(check);
                console.log(JSON.stringify(check));
                fs.writeFileSync(path.join(profile, 'provider-report.json'), redact(JSON.stringify(report, null, 2)));
            }
        }
        assert.ok(report.checks.every(c => c.passed), 'Live provider checks incomplete; see sanitized report');
        report.complete = true;
    } finally {
        if (relay) relay.terminate();
        if (app) {
            const child = app.process();
            await app.evaluate(({ BrowserWindow }) => {
                const main = BrowserWindow.getAllWindows().find(w => /\/index\.html/.test(w.webContents.getURL()));
                if (main) main.close();
            }).catch(() => {});
            await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'app shutdown', 10000).catch(() => child.kill());
            await app.close().catch(() => {});
        }
        fs.writeFileSync(path.join(profile, 'provider-report.json'), redact(JSON.stringify(report, null, 2)));
        console.log('Evidence: ' + path.join(profile, 'provider-report.json'));
    }
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
