'use strict';

// Read-only live check through the actual source controls, capture pipeline,
// and local relay. No chat, reactions, or gifts are sent to TikTok.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const WebSocket = require('ws');
const { freePort, waitFor } = require('./tiktok-disconnect-validation-e2e');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const root = path.resolve(__dirname, '../..');

async function run() {
    const users = (process.env.SSAPP_LIVE_USERS || 'zachooh,hunterhalifaxx').split(',');
    const minutes = Number(process.env.SSAPP_LIVE_MINUTES || 15);
    assert.ok(users.length === 2 && users.every(user => /^[a-z0-9_.]+$/i.test(user) && !/camcam66gaming/i.test(user)));
    assert.ok(Number.isFinite(minutes) && minutes >= 2 && minutes <= 120);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-tiktok-live-reliability-'));
    const port = await freePort();
    const room = 'live_reliability_' + Date.now();
    fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
        streamID: room, password: 'false', state: true, wsServer: true,
        settings: { server2: { setting: true }, capturelikeevent: { setting: true } },
    }));
    const report = { profile, minutes, sources: [], samples: [], stopped: false };
    let app, relay, log = '';
    const counts = {};
    try {
        app = await _electron.launch({ executablePath: require('electron'), cwd: root,
            args: ['.', '--running-from-source', '--multiinstance',
                '--filesource=' + pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href,
                '--ssapp-local-server-port=' + port, ...linuxLaunchArgs()],
            env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000 });
        for (const stream of [app.process().stdout, app.process().stderr]) {
            stream.on('data', chunk => { log = (log + chunk).slice(-200000); });
        }
        const page = await app.firstWindow();
        report.runtime = await app.evaluate((_, root) => ({ electron: process.versions.electron,
            connector: process.getBuiltinModule('module').createRequire(root + '/package.json')('tiktok-live-connector/package.json').version }), root);
        await page.waitForFunction(() => window.stateManager?.initialized && configReady);
        await page.waitForTimeout(6000);
        await app.evaluate((_, root) => {
            const req = process.getBuiltinModule('module').createRequire(root + '/package.json');
            const { ConnectionManager } = req('./tiktok/connection-manager').__test;
            const initialize = ConnectionManager.prototype.initializeConnectionInstance;
            global.__liveManagers = [];
            ConnectionManager.prototype.initializeConnectionInstance = function (...args) {
                if (!global.__liveManagers.includes(this)) global.__liveManagers.push(this);
                return initialize.apply(this, args);
            };
        }, root);
        relay = new WebSocket('ws://127.0.0.1:' + port);
        await new Promise((resolve, reject) => { relay.once('open', resolve); relay.once('error', reject); });
        relay.send(JSON.stringify({ join: room, out: 3, in: 4 }));
        relay.on('message', raw => {
            try {
                const data = JSON.parse(raw);
                if (data.type !== 'tiktok') return;
                const source = counts[data.tid] ||= { chat: 0, events: {} };
                if (!data.event) source.chat++;
                else source.events[data.event] = (source.events[data.event] || 0) + 1;
            } catch (_) {}
        });
        for (let i = 0; i < users.length; i++) {
            const source = { username: users[i], mode: i ? 'classic' : 'tiktok-websocket' };
            source.id = await page.evaluate(source => stateManager.addSource({
                id: `live-check-${source.mode}-${source.username}`,
                target: 'tiktok', username: source.username, url: `https://www.tiktok.com/@${source.username}/live`,
                connectionMode: source.mode, tiktokSigningProvider: 'local',
                autoActivate: false, isVisible: false, isMuted: true,
            }), source);
            report.sources.push(source);
            await page.locator(`[data-source-id="${source.id}"] [data-activatehtml]`).click({ force: true });
            await page.waitForTimeout(15000);
        }
        const started = Date.now();
        let reconnected = false;
        while (Date.now() - started < minutes * 60000) {
            await page.waitForTimeout(20000);
            const sample = { seconds: Math.round((Date.now() - started) / 1000), counts: JSON.parse(JSON.stringify(counts)),
                states: await page.evaluate(ids => ids.map(id => {
                    const s = stateManager.getSource(id);
                    return { id, status: s.status, vid: s.vid, method: s.tiktokConnectionMethod, error: s.error };
                }), report.sources.map(s => s.id)),
                native: await app.evaluate(() => global.__liveManagers.map(m => ({
                    username: m.username, stopped: m.isStopped, connected: !!m.connection?.isConnected,
                    stats: m.getTikTokDiagnosticStats(), lastActivity: m.lastMessageTime,
                }))),
            };
            report.samples.push(sample);
            console.log(JSON.stringify(sample));
            fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
            if (!reconnected && sample.seconds >= minutes * 30) {
                reconnected = true;
                await app.evaluate(() => {
                    const manager = global.__liveManagers.find(m => !m.isStopped && m.connection?.isConnected);
                    if (manager) manager.forceReconnect();
                });
                report.reconnectRequestedAt = sample.seconds;
            }
        }
        for (const source of report.sources) {
            const state = await page.evaluate(id => stateManager.getSource(id), source.id);
            source.counts = counts[state.vid] || null;
            source.result = source.counts?.chat > 0 ? 'captured live chat' : 'inconclusive: no live chat captured';
            const stop = page.locator(`[data-source-id="${source.id}"] ${source.mode === 'classic' ? '[data-stophtml]' : '[data-activatehtml]'}`);
            await stop.click({ force: true });
        }
        await waitFor(async () => app.evaluate(() => global.__liveManagers.every(m => m.isStopped)), 'native Stop');
        const afterStop = JSON.stringify(counts);
        await page.waitForTimeout(5000);
        assert.strictEqual(JSON.stringify(counts), afterStop, 'Messages arrived after Stop');
        report.stopped = true;
        console.log(JSON.stringify(report.sources));
    } catch (error) {
        report.error = error.stack;
        throw error;
    } finally {
        if (relay) relay.terminate();
        if (app) await app.close().catch(() => {});
        fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
        fs.writeFileSync(path.join(profile, 'electron.log'), log);
        console.log('Evidence: ' + profile);
    }
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
