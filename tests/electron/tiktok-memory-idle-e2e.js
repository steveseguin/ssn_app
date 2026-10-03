'use strict';

// Live diagnostic: detach all Playwright debugger sessions during idle.
// An attached service-worker debugger can change renderer shutdown behavior.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const { freePort, waitFor } = require('./tiktok-disconnect-validation-e2e');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const exec = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function memory(rootPid) {
    assert.ok(Number.isInteger(rootPid) && rootPid > 0);
    if (process.platform === 'linux') {
        const rows = [];
        const pending = [rootPid];
        while (pending.length) {
            const pid = pending.pop();
            try {
                const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
                if (children) pending.push(...children.split(/\s+/).map(Number));
                const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
                const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
                const kb = (text, field) => Number(text.match(new RegExp(`^${field}:\\s+(\\d+)`, 'm'))?.[1] || 0) * 1024;
                rows.push({ Id: pid, PrivateMemorySize64: kb(rollup, 'Private_Clean') + kb(rollup, 'Private_Dirty'),
                    WorkingSet64: kb(status, 'VmRSS') });
            } catch (error) {
                if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
            }
        }
        return rows;
    }
    const script = `$all=Get-CimInstance Win32_Process; $ids=@(${rootPid}); do { ` +
        '$next=@($all | Where-Object {$ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId} | ForEach-Object {$_.ProcessId}); ' +
        '$ids+=$next } while($next.Count); ' +
        '$rows=@(Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,PrivateMemorySize64,WorkingSet64); ConvertTo-Json -InputObject $rows -Compress';
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
    return JSON.parse(stdout);
}

async function run() {
    assert.ok(['win32', 'linux'].includes(process.platform));
    const username = process.env.SSAPP_LIVE_USERS?.split(',')[0];
    assert.ok(username && /^[a-z0-9_.]+$/i.test(username) && !/camcam66gaming/i.test(username));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-tiktok-detached-memory-'));
    const debugPort = await freePort();
    const relayPort = await freePort();
    const room = 'memory_idle_' + Date.now();
    fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
        streamID: room, password: 'false', state: true, wsServer: true,
        settings: { server2: { setting: true } },
    }));
    const env = { ...process.env, SSAPP_USER_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), ['.', '--multiinstance', '--running-from-source',
        '--filesource=' + pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href,
        '--remote-debugging-port=' + debugPort, '--ssapp-local-server-port=' + relayPort, ...linuxLaunchArgs()],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let browser, relay, log = '';
    const report = { profile, cycles: [], complete: false,
        memoryMetric: process.platform === 'win32' ? 'private committed bytes' : 'private resident bytes' };
    const counts = {};
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-100000); });
    try {
        await waitFor(async () => fetch(`http://127.0.0.1:${debugPort}/json/version`).then(r => r.ok).catch(() => false), 'debugger startup', 60000);
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 90000 });
        let page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/index.html'));
        assert.ok(page);
        await page.waitForFunction(() => window.stateManager?.initialized && configReady);
        await pause(6000);
        relay = new WebSocket('ws://127.0.0.1:' + relayPort);
        await new Promise((resolve, reject) => { relay.once('open', resolve); relay.once('error', reject); });
        relay.send(JSON.stringify({ join: room, out: 3, in: 4 }));
        relay.on('message', raw => {
            const message = JSON.parse(raw);
            if (message.type === 'tiktok' && !message.event && !message.hasDonation) {
                counts[message.tid] = (counts[message.tid] || 0) + 1;
            }
        });
        const ids = [];
        for (const mode of ['tiktok-websocket', 'classic']) {
            ids.push(await page.evaluate(({ username, mode }) => stateManager.addSource({
                id: `detached-memory-${mode}`,
                target: 'tiktok', username, url: `https://www.tiktok.com/@${username}/live`,
                connectionMode: mode, tiktokSigningProvider: 'local',
                autoActivate: false, isVisible: false, isMuted: true,
            }), { username, mode }));
        }
        report.baseline = await memory(child.pid);
        for (let cycle = 1; cycle <= 2; cycle++) {
            if (!browser) {
                browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 90000 });
                page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/index.html'));
            }
            Object.keys(counts).forEach(key => delete counts[key]);
            for (const id of ids) {
                await page.locator(`[data-source-id="${id}"] [data-activatehtml]`).click({ force: true, noWaitAfter: true });
                await pause(15000);
            }
            await waitFor(async () => {
                const vids = await page.evaluate(ids => ids.map(id => stateManager.getSource(id).vid), ids);
                return vids.every(vid => counts[vid] >= 10);
            }, 'live chat on both capture paths', 300000);
            await pause(30000);
            const result = { cycle, chats: { ...counts }, active: await memory(child.pid), idle: [] };
            report.cycles.push(result);
            for (let i = 0; i < ids.length; i++) await page.locator(`[data-source-id="${ids[i]}"] ${i ? '[data-stophtml]' : '[data-activatehtml]'}`).click({ force: true });
            await page.evaluate(id => showTikTokSignInMenu(id), ids[0]);
            await page.locator(`#tiktok-signing-stop-${ids[0]}`).click();
            await page.locator('button[onclick="closeModal()"]:visible').click();
            await pause(3000);
            const session = await browser.newBrowserCDPSession();
            result.targetsAfterClose = (await session.send('Target.getTargets')).targetInfos.map(t => ({
                type: t.type, tiktok: /^https:\/\/(www\.)?tiktok.com\//.test(t.url), attached: t.attached,
            }));
            assert.ok(!result.targetsAfterClose.some(t => t.type === 'page' && t.tiktok));
            await session.detach();
            // For connectOverCDP, close disconnects this client, leaving the app running.
            await browser.close();
            browser = null;
            const stopped = JSON.stringify(counts);
            for (let seconds = 0; seconds <= 120; seconds += 30) {
                if (seconds) await pause(30000);
                const processes = await memory(child.pid);
                assert.ok(processes.length, 'App exited during detached observation');
                assert.strictEqual(JSON.stringify(counts), stopped, 'Live chat arrived after Stop');
                result.idle.push({ seconds, processes });
                console.log(JSON.stringify({ cycle, seconds, processes: processes.length,
                    privateMB: Math.round(processes.reduce((sum, p) => sum + p.PrivateMemorySize64, 0) / 1048576) }));
                fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
            }
        }
        report.complete = true;
    } catch (error) {
        report.error = error.message;
        throw error;
    } finally {
        if (relay) relay.terminate();
        if (browser) await browser.close().catch(() => {});
        // The numeric PID belongs only to the isolated app spawned above.
        if (child.exitCode === null) {
            if (process.platform === 'win32') await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
            else child.kill('SIGTERM');
        }
        fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
        fs.writeFileSync(path.join(profile, 'electron.log'), log);
        console.log('Evidence: ' + profile);
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
