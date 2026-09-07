'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-script-recovery-'));
    fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({ streamID: 'scriptrecovery', password: 'false', state: false, settings: {}, wsServer: false }));
    const app = await _electron.launch({ executablePath: require('electron'), cwd: root,
        args: [path.join(__dirname, 'outage-bootstrap.js'), '--multiinstance', '--no-hwa'],
        env: { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_PREFER_LOCAL_ASSETS: '0' } });
    const report = [];
    try {
        const main = await app.firstWindow();
        await main.waitForFunction(() => document.getElementById('frame2').src.startsWith('file:'));
        async function load(phase) {
            await app.evaluate((_, phase) => { global.__outage.phase = phase; global.__outage.requests = []; }, phase);
            await main.reload({ waitUntil: 'domcontentloaded' });
            await main.waitForFunction(() => document.getElementById('frame2').src.startsWith('https:'));
            let frame;
            for (let n = 0; n < 100; n++) {
                frame = main.frames().find(frame => frame.url().startsWith('https:') && frame.url().includes('/background.html'));
                if (frame) break;
                await delay(100);
            }
            assert(frame, phase + ': remote frame exists');
            return frame;
        }
        async function ready(frame) {
            await frame.waitForFunction(() => (!window.ssappBackgroundLoadState || window.ssappBackgroundLoadState.status === 'ready')
                && typeof window.processIncomingMessage === 'function' && typeof window.filterXSS === 'function' && window.eventFlowSystem?.db, null, { timeout: 60000 });
        }
        let frame = await load('online');
        await ready(frame);
        assert.equal(await frame.evaluate(() => streamID), 'scriptrecovery', 'Background receives saved session');
        const url = frame.url();
        const flow = { id: 'recovery-flow', name: 'Keep my saved flow', active: false, order: 0,
            nodes: [
                { id: 'trigger', type: 'trigger', triggerType: 'messageContains', x: 30, y: 50, config: { text: 'RECOVERY-QA' } },
                { id: 'action', type: 'action', actionType: 'customJs', x: 350, y: 50, config: { code: 'window.recoveryFlowHits++;return result;' } }
            ], connections: [{ from: 'trigger', to: 'action' }] };
        await frame.evaluate(async flow => {
            await eventFlowSystem.saveFlow(flow);
            await eventFlowSystem.saveFlow({ ...flow, id: 'active-recovery-flow', name: 'Active recovery flow', active: true, order: 1 });
        }, flow);
        const saved = await frame.evaluate(() => JSON.parse(JSON.stringify(eventFlowSystem.flows)));
        for (const phase of (process.env.SSAPP_RECOVERY_PHASES || 'mime,mime-html,loader-mime,loader-html,loader-outage,html,syntax,empty,json,raw-only,redirect,slow-cache,stalled-body,partial,runtime,slow').split(',')) {
            const start = Date.now();
            frame = await load(phase);
            const selectedUrl = frame.url();
            assert.equal(new URL(selectedUrl).origin, new URL(url).origin);
            const failed = ['partial', 'runtime', 'slow', 'loader-outage'].includes(phase);
            if (failed) {
                await frame.waitForFunction(() => window.ssappBackgroundLoadState?.status === 'failed', null, { timeout: 65000 });
                await main.locator('[data-page="event-flow-editor"]').click();
                await main.locator('#background-load-retry').waitFor({ state: 'visible' });
                assert.equal(frame.url(), selectedUrl, phase + ': failure must preserve original database origin');
                const requests = await app.evaluate((_, phase) => global.__outage.requests.filter(url => url.includes(phase === 'loader-outage' ? '/loader.js' : '/libs/objects.js')), phase);
                assert.equal(requests.length, phase === 'runtime' ? 1 : phase === 'loader-outage' ? 4 : 3, 'Each mirror is attempted once; execution errors are not re-executed');
                await app.evaluate(() => { global.__outage.phase = 'online'; });
                await main.locator('#background-load-retry').click();
                await ready(frame);
            } else {
                await ready(frame);
                if (phase === 'live-assets') await delay(20000);
                if (phase === 'slow-cache') await delay(10000); // The late original response cannot execute or reload the page.
            }
            assert.equal(frame.url(), selectedUrl, phase + ': successful recovery keeps the exact page address');
            assert.deepStrictEqual(await frame.evaluate(() => JSON.parse(JSON.stringify(eventFlowSystem.flows))), saved, phase + ': flow persists unchanged');
            await main.locator('[data-page="event-flow-editor"]').click();
            await frame.getByText(flow.name, { exact: true }).first().waitFor({ state: 'visible' });
            const requests = await app.evaluate(() => global.__outage.requests.filter(url => url.includes('/libs/objects.js') || url.includes('/objects.download')));
            if (['html', 'syntax', 'empty', 'json', 'slow-cache', 'stalled-body'].includes(phase)) {
                assert(requests.some(url => url.startsWith('https://socialstream.ninja/')), phase + ': hosted mirror used');
            }
            if (phase === 'raw-only') assert(requests.some(url => url.startsWith('https://raw.githubusercontent.com/')), 'GitHub mirror used');
            if (phase !== 'live-assets') assert.equal(await frame.evaluate(() => window.__scriptRecoveryExecutions), 1, 'Late/retried downloads execute only once');
            assert.equal(await frame.evaluate(() => streamID), 'scriptrecovery', 'Saved session initializes after asynchronous downloads');
            assert.equal(await frame.evaluate(async () => {
                window.recoveryFlowHits = 0;
                eventFlowSystem.allowEvalCustomJs = true;
                await eventFlowSystem.processMessage({ type: 'youtube', chatname: 'Recovery Fixture', chatmessage: 'RECOVERY-QA', textonly: true });
                return window.recoveryFlowHits;
            }), 1, 'Only the active saved flow executes, exactly once');
            const result = { phase, failedThenRetried: failed, elapsedMs: Date.now() - start, url: frame.url(), requests };
            report.push(result);
            fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
            console.log('PASS', phase, result.elapsedMs + 'ms');
        }
        // The parent cannot use the background-only download bridge.
        assert(await main.evaluate(async () => { try { await ipcRenderer.invoke('socialstream:fetch-background-script', './background.js'); return false; } catch (_) { return true; } }));
        await frame.locator('.flow-item[data-id="recovery-flow"]').click({ position: { x: 75, y: 25 } });
        await main.screenshot({ path: path.join(profile, 'recovered-editor.png'), animations: 'disabled' });
    } finally {
        console.log('Evidence:', profile);
        await app.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
