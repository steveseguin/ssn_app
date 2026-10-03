'use strict';

// Read-only live check through the actual source controls, capture pipeline,
// and local relay. No chat, reactions, or gifts are sent to TikTok.
// Set SSAPP_LIVE_PROFILE_MEMORY=1 for per-process/window memory diagnostics,
// including garbage-collected baselines and post-Stop retention.
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

// Opt-in diagnostics for this isolated test app. Do not retain message bodies,
// query strings, heap snapshots, or authentication data in the report.
async function sampleMemory(app, collectGarbage = false) {
    return app.evaluate(async ({ app, webContents }, collectGarbage) => {
        const pageName = value => {
            const url = new URL(value);
            if (url.protocol === 'file:') return url.pathname.split('/').pop();
            if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin + url.pathname;
            return url.protocol === 'about:' ? 'about:' + url.pathname : url.protocol;
        };
        const result = {
            main: process.memoryUsage(),
            processes: app.getAppMetrics().map(p => ({
                pid: p.pid, type: p.type, memory: p.memory,
            })),
            contents: [],
            managers: (global.__liveManagers || []).map(m => ({
                stopped: m.isStopped,
                collections: Object.fromEntries(Object.entries(m)
                    .filter(([, value]) => value instanceof Map || value instanceof Set || Array.isArray(value))
                    .map(([key, value]) => [key, value.size ?? value.length])),
            })),
        };
        for (const wc of webContents.getAllWebContents()) {
            const entry = { id: wc.id, pid: wc.getOSProcessId(), type: wc.getType() };
            let attached = false;
            try {
                entry.page = pageName(wc.getURL());
                entry.frames = wc.mainFrame.framesInSubtree.map(frame => ({
                    pid: frame.osProcessId, page: pageName(frame.url || 'about:blank'),
                }));
                if (!wc.debugger.isAttached()) {
                    wc.debugger.attach('1.3');
                    attached = true;
                } else {
                    // The local signer owns an existing debugger session. Read
                    // its counters without detaching or changing its domains.
                    entry.sharedDebugger = true;
                }
                const command = async method => {
                    let timer;
                    try {
                        return await Promise.race([
                            wc.debugger.sendCommand(method),
                            new Promise((_, reject) => {
                                timer = setTimeout(() => reject(new Error(method + ' timed out')), 10000);
                            }),
                        ]);
                    } finally {
                        clearTimeout(timer);
                    }
                };
                entry.heap = await command('Runtime.getHeapUsage');
                entry.dom = await command('Memory.getDOMCounters');
                if (collectGarbage && attached) {
                    await command('HeapProfiler.collectGarbage');
                    entry.heapAfterGC = await command('Runtime.getHeapUsage');
                    entry.domAfterGC = await command('Memory.getDOMCounters');
                }
            } catch (error) {
                entry.error = error.message;
            } finally {
                if (attached && !wc.isDestroyed()) {
                    try { wc.debugger.detach(); } catch (_) {}
                }
            }
            result.contents.push(entry);
        }
        return result;
    }, collectGarbage);
}

async function run() {
    const users = (process.env.SSAPP_LIVE_USERS || 'zachooh,hunterhalifaxx').split(',');
    const minutes = Number(process.env.SSAPP_LIVE_MINUTES || 15);
    const profileMemory = process.env.SSAPP_LIVE_PROFILE_MEMORY === '1';
    assert.ok(users.length === 2 && users.every(user => /^[a-z0-9_.]+$/i.test(user) && !/camcam66gaming/i.test(user)));
    assert.ok(Number.isFinite(minutes) && minutes >= 2 && minutes <= 120);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-tiktok-live-reliability-'));
    const port = await freePort();
    const room = 'live_reliability_' + Date.now();
    fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
        streamID: room, password: 'false', state: true, wsServer: true,
        settings: { server2: { setting: true }, capturelikeevent: { setting: true } },
    }));
    const report = { profile, minutes, sources: [], samples: [], stopped: false, duplicates: 0, proactiveRefreshes: 0 };
    if (profileMemory) {
        report.memoryNotes = [
            'Process working sets can include shared pages; do not treat their sum as unique physical memory.',
            'The test retains native manager references until exit for recovery and Stop assertions.',
            'GC checkpoints affect only test renderers whose debugger is owned by this diagnostic.',
        ];
    }
    let app, relay, log = '';
    const counts = {};
    const seenChatIds = new Set();
    try {
        app = await _electron.launch({ executablePath: require('electron'), cwd: root,
            args: ['.', '--running-from-source', '--multiinstance',
                '--filesource=' + pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href,
                '--ssapp-local-server-port=' + port, ...linuxLaunchArgs()],
            env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000 });
        for (const stream of [app.process().stdout, app.process().stderr]) {
            stream.on('data', chunk => {
                log = (log + chunk).slice(-200000);
                if (String(chunk).includes('Proactively refreshing connection after 90 minutes')) {
                    report.proactiveRefreshes++;
                    report.lastProactiveRefreshAt = Date.now();
                }
            });
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
                if (!data.event && !data.hasDonation) {
                    source.chat++;
                    source.lastChatAt = Date.now();
                    if (data.msgId) {
                        const key = data.tid + ':' + data.msgId;
                        if (seenChatIds.has(key)) report.duplicates++;
                        seenChatIds.add(key);
                    }
                }
                else {
                    const kind = data.hasDonation ? 'gift' : data.event;
                    source.events[kind] = (source.events[kind] || 0) + 1;
                }
            } catch (_) {}
        });
        if (profileMemory) report.memoryIdleBaseline = await sampleMemory(app, true);
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
        if (profileMemory) report.memoryBaseline = await sampleMemory(app, true);
        let reconnected = false;
        while (Date.now() - started < minutes * 60000) {
            await page.waitForTimeout(20000);
            const sample = { seconds: Math.round((Date.now() - started) / 1000), counts: JSON.parse(JSON.stringify(counts)),
                states: await page.evaluate(ids => ids.map(id => {
                    const s = stateManager.getSource(id);
                    return { id, status: s.status, vid: s.vid, method: s.tiktokConnectionMethod, error: s.error };
                }), report.sources.map(s => s.id)),
                memory: await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({
                    type: p.type, workingSetSizeKb: p.memory.workingSetSize,
                }))),
                native: await app.evaluate(() => global.__liveManagers.map(m => ({
                    username: m.username, stopped: m.isStopped, connected: !!m.connection?.isConnected,
                    stats: m.getTikTokDiagnosticStats(), lastActivity: m.lastMessageTime, lastConnectTimestamp: m.lastConnectTimestamp,
                }))),
            };
            if (profileMemory && (report.samples.length % 3 === 0)) {
                sample.memoryDetails = await sampleMemory(app);
            }
            report.samples.push(sample);
            console.log(JSON.stringify({ ...sample, memoryDetails: undefined }));
            fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
            if (!reconnected && sample.seconds >= minutes * 30) {
                reconnected = true;
                const didReconnect = await app.evaluate(() => {
                    const manager = global.__liveManagers.find(m => !m.isStopped && m.connection?.isConnected);
                    if (!manager) return false;
                    global.__liveReconnectStarted = Date.now();
                    manager.forceReconnect();
                    return true;
                });
                assert.ok(didReconnect, 'No connected native source for recovery test');
                report.reconnectRequestedAt = sample.seconds;
            }
            if (reconnected && !report.recoveredAt) {
                const recovered = await app.evaluate(() => global.__liveManagers.some(m =>
                    !m.isStopped && m.connection?.isConnected && m.lastConnectTimestamp >= global.__liveReconnectStarted));
                const nativeState = sample.states[0];
                if (recovered && counts[nativeState.vid]?.lastChatAt > started + report.reconnectRequestedAt * 1000) {
                    report.recoveredAt = sample.seconds;
                }
            }
        }
        if (profileMemory) report.memoryBeforeStop = await sampleMemory(app, true);
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
        if (profileMemory) {
            report.memoryAfterStop = await sampleMemory(app, true);
            // Disconnect deliberately keeps the reusable signing window. Test
            // the separate user-facing Close control and measure its cleanup.
            await page.evaluate(id => showTikTokSignInMenu(id), report.sources[0].id);
            await page.locator(`#tiktok-signing-stop-${report.sources[0].id}`).click();
            await waitFor(() => app.evaluate(({ webContents }) => webContents.getAllWebContents()
                .every(wc => !/^https:\/\/(www\.)?tiktok\.com\//.test(wc.getURL()))), 'signing window closed');
            await page.waitForTimeout(5000);
            report.memoryAfterHelperClose = await sampleMemory(app, true);
            assert.strictEqual(JSON.stringify(counts), afterStop, 'Closing the signing window restarted capture');
        }
        assert.ok(report.sources.every(source => source.counts?.chat > 0),
            'Live validation incomplete: one or more sources captured no chat');
        assert.ok(report.recoveredAt, 'Native source did not capture fresh chat after reconnect');
        assert.strictEqual(report.duplicates, 0, 'Duplicate chat IDs forwarded during live capture');
        if (minutes >= 100) {
            assert.ok(report.proactiveRefreshes > 0, 'The real 90-minute refresh was not observed');
            assert.ok(report.sources[0].counts.lastChatAt > report.lastProactiveRefreshAt,
                'No fresh native chat after the 90-minute refresh');
        }
        report.complete = true;
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
