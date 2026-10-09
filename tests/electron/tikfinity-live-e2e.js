'use strict';

// Requires TikFinity Desktop already signed in and receiving a live stream.
// Read-only: no chat, gifts, reactions, or synthetic events are sent upstream.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const WebSocket = require('ws');
const { freePort, waitFor } = require('./tiktok-disconnect-validation-e2e');
const { linuxLaunchArgs, electronTestTarget, electronTestRuntime, electronTestSourceBase } = require('./helpers/electron-launch');
const root = path.resolve(__dirname, '../..');

async function run() {
    const username = process.env.SSAPP_TIKFINITY_LIVE_USER;
    assert.ok(username && /^[a-z0-9_.]+$/i.test(username) && !/camcam66gaming/i.test(username),
        'Set SSAPP_TIKFINITY_LIVE_USER to the channel selected in TikFinity');
    const minutes = Number(process.env.SSAPP_LIVE_MINUTES || 3);
    assert.ok(Number.isFinite(minutes) && minutes >= 1 && minutes <= 120);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-tikfinity-live-'));
    const port = await freePort();
    const room = 'tikfinity_live_' + Date.now();
    fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
        streamID: room, password: 'false', state: true, wsServer: true,
        settings: { server2: { setting: true }, capturelikeevent: { setting: true },
            capturejoinedevent: { setting: true }, showviewercount: { setting: true } },
    }));
    const report = { profile, username, minutes, checks: [], upstream: {}, forwarded: {}, duplicates: 0 };
    const received = [];
    const seen = new Set();
    let app, relay, upstream, log = '';
    try {
        upstream = new WebSocket('ws://127.0.0.1:21213/');
        await new Promise((resolve, reject) => { upstream.once('open', resolve); upstream.once('error', reject); });
        upstream.on('message', raw => {
            try {
                const packet = JSON.parse(raw);
                report.upstream[packet.event] = (report.upstream[packet.event] || 0) + 1;
            } catch (_) {}
        });
        let sourceBase = pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href;
        const target = electronTestTarget(sourceBase);
        app = await _electron.launch({ executablePath: target.executablePath, cwd: root,
            args: [...target.args, '--multiinstance', '--ssapp-local-server-port=' + port, ...linuxLaunchArgs()],
            env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000 });
        for (const stream of [app.process().stdout, app.process().stderr]) {
            stream.on('data', chunk => { log = (log + chunk).slice(-200000); });
        }
        const page = await app.firstWindow();
        await page.waitForFunction(() => window.stateManager?.initialized && configReady);
        report.runtime = await electronTestRuntime(app);
        sourceBase = await electronTestSourceBase(page, sourceBase);
        await page.waitForTimeout(6000);
        await app.evaluate(({ app }) => {
            const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
            const { ConnectionManager } = req('./tiktok/connection-manager').__test;
            const initialize = ConnectionManager.prototype.initializeConnectionInstance;
            global.__tikfinityLiveManagers = [];
            ConnectionManager.prototype.initializeConnectionInstance = function (...args) {
                if (!global.__tikfinityLiveManagers.includes(this)) global.__tikfinityLiveManagers.push(this);
                return initialize.apply(this, args);
            };
        });
        relay = new WebSocket('ws://127.0.0.1:' + port);
        await new Promise((resolve, reject) => { relay.once('open', resolve); relay.once('error', reject); });
        relay.send(JSON.stringify({ join: room, out: 3, in: 4 }));
        relay.on('message', raw => {
            try {
                const data = JSON.parse(raw);
                if (data.type !== 'tiktok') return;
                received.push(data);
                const kind = data.hasDonation ? 'gift' : data.event || 'chat';
                report.forwarded[kind] = (report.forwarded[kind] || 0) + 1;
                if (kind === 'chat' && data.msgId) {
                    if (seen.has(String(data.msgId))) report.duplicates++;
                    seen.add(String(data.msgId));
                }
            } catch (_) {}
        });
        const dockUrl = sourceBase + 'dock.html?session=' + room + '&password=false&server2&localserver&localserverport=' + port;
        await page.evaluate(url => window.open(url, '_blank'), dockUrl);
        let dock;
        await waitFor(() => { dock = app.context().pages().find(p => p.url() === dockUrl); return dock; }, 'live dock');
        const cdp = await dock.context().newCDPSession(dock);
        const inDock = async (fn, arg) => {
            const result = await cdp.send('Runtime.evaluate', {
                expression: '(' + fn.toString() + ')(' + JSON.stringify(arg) + ')', returnByValue: true,
            });
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
            return result.result.value;
        };
        await waitFor(() => inDock(() => typeof socketserverExtension !== 'undefined' && socketserverExtension.readyState === 1), 'dock relay');
        const id = await page.evaluate(username => stateManager.addSource({
            target: 'tiktok', username, url: 'https://www.tiktok.com/@' + username + '/live',
            connectionMode: 'tiktok-websocket', tiktokSigningProvider: 'tikfinity',
            autoActivate: false, isVisible: false, isMuted: true,
        }), username);
        const entry = () => page.locator(`[data-source-id="${id}"]`);
        assert.strictEqual(await entry().locator('.tiktok-connection-select').inputValue(), 'tikfinity');
        const chatCount = () => received.filter(m => !m.event && !m.hasDonation).length;
        async function freshChat(label, before) {
            await waitFor(() => chatCount() > before + 2, label + ' fresh chat', 90000);
            const message = received.findLast(m => !m.event && !m.hasDonation && m.chatmessage && m.chatname);
            assert.ok(message, 'No real chat message');
            await waitFor(() => inDock(message => {
                const body = document.createElement('div');
                body.innerHTML = message.chatmessage;
                return [...document.querySelectorAll('.highlight-chat')].some(row =>
                    row.textContent.includes(message.chatname) && row.textContent.includes(body.textContent));
            }, message), label + ' rendered in Dock');
            report.checks.push({ name: label, passed: true, chat: chatCount() });
            console.log('PASS ' + label);
        }
        await entry().locator('[data-activatehtml]').click({ force: true });
        await freshChat('initial live capture', 0);
        const beforeReload = chatCount();
        await page.reload();
        await page.waitForFunction(() => window.stateManager?.initialized && configReady);
        assert.strictEqual(await entry().locator('.tiktok-connection-select').inputValue(), 'tikfinity');
        await freshChat('capture survives controls reload', beforeReload);
        const beforeRecovery = chatCount();
        await app.evaluate(() => {
            const manager = global.__tikfinityLiveManagers.find(m => !m.isStopped);
            if (!manager?.connection?.socket) throw new Error('No active TikFinity socket');
            global.__tikfinityOldSocket = manager.connection.socket;
            manager.connection.socket.terminate();
        });
        await waitFor(() => app.evaluate(() => global.__tikfinityLiveManagers.some(m =>
            !m.isStopped && m.connection?.isConnected && m.connection.socket !== global.__tikfinityOldSocket)), 'local socket recovery', 90000);
        await freshChat('capture recovers after local socket loss', beforeRecovery);
        await waitFor(() => received.some(m => m.event === 'joined'), 'real join event', 90000);
        const joined = received.findLast(m => m.event === 'joined' && m.chatname);
        assert.ok(joined, 'Join event has no name');
        await waitFor(() => inDock(message => [...document.querySelectorAll('.highlight-chat')].some(row =>
            row.textContent.includes(message.chatname) && row.textContent.includes('joined')), joined), 'real join rendered in Dock');
        report.checks.push({ name: 'real member actionId renders a join', passed: true });
        const started = Date.now();
        while (Date.now() - started < minutes * 60000) {
            const before = chatCount();
            await page.waitForTimeout(30000);
            await freshChat('live soak ' + Math.round((Date.now() - started) / 1000) + 's', before);
            fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
        }
        await entry().screenshot({ path: path.join(profile, 'source.png') });
        await dock.screenshot({ path: path.join(profile, 'dock.png') });
        await entry().locator('[data-activatehtml]').click({ force: true });
        await waitFor(() => app.evaluate(() => global.__tikfinityLiveManagers.every(m => m.isStopped)), 'Stop');
        await page.waitForTimeout(1500);
        const stoppedCount = received.length;
        const upstreamBefore = report.upstream.chat || 0;
        await page.waitForTimeout(15000);
        assert.strictEqual(received.length, stoppedCount, 'Forwarded after Stop');
        assert.ok((report.upstream.chat || 0) > upstreamBefore, 'Stop check inconclusive: upstream became quiet');
        report.checks.push({ name: 'Stop blocks ongoing upstream chat', passed: true });
        const beforeRestart = chatCount();
        // A new intentional capture session can include an upstream replay.
        seen.clear();
        await entry().locator('[data-activatehtml]').click({ force: true });
        await freshChat('manual restart resumes live capture', beforeRestart);
        await entry().locator('[data-activatehtml]').click({ force: true });
        await waitFor(() => app.evaluate(() => global.__tikfinityLiveManagers.every(m => m.isStopped)), 'final Stop');
        assert.strictEqual(report.duplicates, 0, 'Duplicate chat IDs forwarded in one capture session');
        report.complete = true;
    } catch (error) {
        report.error = error.stack;
        throw error;
    } finally {
        if (upstream) upstream.terminate();
        if (relay) relay.terminate();
        if (app) await app.close().catch(() => {});
        fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
        fs.writeFileSync(path.join(profile, 'electron.log'), log);
        console.log('Evidence: ' + profile);
    }
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
