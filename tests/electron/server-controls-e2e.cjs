'use strict';
// Real source capture and overlay windows in an isolated SSApp profile.
// Opt-in live WebRTC uses the normal Electron session and compatibility flags.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-server-controls-'));
const room = 'controls_' + Date.now();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { output, room, completed: false, cases: [] };
const wait = (page, fn, arg, options) => page.waitForFunction(fn, arg, { polling: 100, ...options });
async function run() {
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const local = process.env.SSAPP_TEST_HOSTED !== '1';
    fs.writeFileSync(path.join(output, 'savedSync.json'), JSON.stringify({ streamID: room, password: 'false', state: true,
        settings: { socketserver: true, server2: true, server3: true }, wsServer: local }));
    const wrapper = path.join(output, 'bootstrap.cjs');
    fs.writeFileSync(wrapper, `require(${JSON.stringify(path.join(__dirname, 'outage-bootstrap.js'))});global.__outage.phase='online';`);
    const app = await _electron.launch({ executablePath: require('electron'), cwd: root,
        args: [wrapper, '--multiinstance', '--no-hwa', ...(local ? [`--ssapp-local-server-port=${port}`] : []),
            ...(local && process.env.SSAPP_TEST_LIVE_WEBRTC !== '1' ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] : [])],
        env: { ...process.env, SSAPP_USER_DATA_DIR: output, SSAPP_PREFER_LOCAL_ASSETS: '0', SSAPP_DIAGNOSTICS_SAFE_GPU: '1' }, timeout: 60000 });
    try {
        const main = await app.firstWindow();
        await main.waitForFunction(() => document.getElementById('frame1')?.src.includes('popup.html'), null, { timeout: 60000 });
        async function frame(name) {
            for (let n = 0; n < 180; n++) {
                const found = main.frames().find(f => f.url().includes('/' + name + '.html'));
                if (found) return found;
                await delay(250);
            }
            throw new Error('Missing ' + name);
        }
        let background = await frame('background');
        let popup = await frame('popup');
        await wait(background, () => window.ssappBackgroundLoadState?.status === 'ready' && window.eventFlowSystem?.db, null, { timeout: 60000 });
        await wait(background, () => typeof socketserverDock !== 'undefined' && socketserverDock?.readyState === 1 && socketserver?.readyState === 1, null, { timeout: 30000 });
        console.log('READY ' + (local ? 'local' : 'hosted') + ' background');
        async function createWindow(url, options = {}) {
            const pending = app.waitForEvent('window');
            await main.evaluate(options => ipcRenderer.sendSync('createWindow', options), { url, visible: true, size: { width: 1100, height: 800 }, ...options });
            const page = await pending;
            page.setDefaultTimeout(15000);
            await page.waitForLoadState('domcontentloaded');
            return page;
        }
        const source = await createWindow(pathToFileURL(path.join(__dirname, 'fixtures/hidden-capture.html')).href + '?platform=youtube&manual=1', { sourceFiles: ['sources/youtube.js'] });
        await delay(4500);
        const capture = async (command, name = 'Controls QA') => source.evaluate(({ command, name }) => {
            window.__hiddenCaptureFixture.appendRows([Date.now()]);
            const row = document.querySelector('.ssn-chat-row:last-child');
            row.querySelector('#author-name').textContent = name;
            row.querySelector('#message').textContent = command;
        }, { command, name });
        if (process.env.SSAPP_TEST_ADDITIVE_CHAT === '1') {
            assert.equal(process.env.SSAPP_TEST_LIVE_WEBRTC, '1', 'Additive chat test requires real WebRTC');
            await popup.evaluate(() => chrome.runtime.sendMessage({ cmd: 'saveSetting', setting: 'server2additivedelivery', type: 'setting', value: true }));
            await wait(background, () => getSettingFlag('server2additivedelivery'));
            const relayQuery = '&server2' + (local ? '&localserver&localserverport=' + port : '');
            const base = 'https://socialstream.ninja/sampleoverlay.html?session=' + room;
            const displays = [
                await createWindow(base),
                await createWindow(base + relayQuery + '&v=3.52.0'),
                await createWindow(base + relayQuery)
            ];
            await wait(background, () => {
                const peers = ninjaBridge && ninjaBridge.isReady() ? ninjaBridge.getPeers() : connectedPeers;
                return Object.values(peers || {}).filter(label => label === 'dock').length >= 2;
            }, null, { timeout: 90000 });
            await delay(2000);
            for (const marker of ['Additive captured one', 'Additive captured two']) {
                await capture(marker, 'Additive Fixture');
                for (const display of displays) await display.getByText(marker, { exact: true }).waitFor();
                await delay(1500);
                for (const display of displays) assert.equal(await display.getByText(marker, { exact: true }).count(), 1);
            }
            report.cases.push({ name: 'experimental additive toggle: actual captured chat reaches P2P-only, relay-only and mixed maintained displays once', passed: true });
            report.completed = true;
            console.log('PASS actual additive captured chat across three display modes');
            return;
        }
        await background.evaluate(async () => eventFlowSystem.saveFlow({ id: 'transport-qa', name: 'Transport QA', active: true,
            nodes: [{ id: 'trigger', type: 'trigger', triggerType: 'messageContains', config: { text: 'Transport-QA ' } },
                { id: 'action', type: 'action', actionType: 'showText', config: { text: '{message}', duration: 60000 } }],
            connections: [{ from: 'trigger', to: 'action' }] }));
        let rtc;
        if (process.env.SSAPP_TEST_LIVE_WEBRTC === '1') {
            rtc = await createWindow('https://socialstream.ninja/actions.html?session=' + room);
            await wait(background, () => Object.values(connectedPeers).includes('actions') ||
                (ninjaBridge && Object.values(ninjaBridge.getPeers() || {}).includes('actions')), null, { timeout: 90000 });
            await capture('Transport-QA rtc-only');
            await delay(3000);
            const count = await rtc.getByText('Transport-QA rtc-only', { exact: true }).count();
            report.cases.push({ name: 'local relay open, WebRTC-only actions display', count });
            console.log(JSON.stringify(report.cases[report.cases.length - 1]));
            if (process.env.SSAPP_TEST_EXPECT_REGRESSION === '1') {
                assert.equal(count, 0);
                report.completed = true;
                return;
            }
            assert.equal(count, 1);
        }
        const query = '?session=' + room + '&server2' + (local ? '&localserver&localserverport=' + port : '');
        const actions = await createWindow('https://socialstream.ninja/actions.html' + query);
        await wait(actions, () => socketserver?.readyState === 1);
        if (rtc) await wait(actions, () => Object.keys(connectedPeers).length > 0, null, { timeout: 90000 });
        await delay(1500);
        await capture('Transport-QA relay');
        await actions.getByText('Transport-QA relay', { exact: true }).waitFor();
        await delay(2000);
        assert.equal(await actions.getByText('Transport-QA relay', { exact: true }).count(), 1);
        if (rtc) assert.equal(await rtc.getByText('Transport-QA relay', { exact: true }).count(), 1);
        report.cases.push({ name: 'captured Flow Action via relay; no duplicate', passed: true });
        console.log('PASS captured relay action');

        await popup.locator('#pollType').selectOption('yesno', { force: true });
        await delay(600);
        await popup.evaluate(() => { const input = document.getElementById('pollQuestion'); input.value = 'Server controls question'; input.dispatchEvent(new Event('change', { bubbles: true })); });
        await wait(background, () => settings.pollQuestion?.textsetting === 'Server controls question');
        await popup.evaluate(() => { const input = document.querySelector('input[data-setting="pollEnabled"]'); if (!input.checked) input.click(); });
        const poll = await createWindow('https://socialstream.ninja/poll.html' + query + '&pollTally');
        await poll.getByText('Server controls question', { exact: true }).waitFor();
        if (process.env.SSAPP_TEST_POLL_REPEAT === '1') {
            await wait(background, () => Object.values(connectedPeers).includes('poll') ||
                (ninjaBridge && Object.values(ninjaBridge.getPeers() || {}).includes('poll')),
                null, { timeout: 90000 });
            await popup.evaluate(() => { const input = document.querySelector('[data-setting="pollSpam"]'); if (!input.checked) input.click(); });
            await wait(poll, () => settings.pollSpam);
            await capture('yes', 'Repeat Voter');
            await delay(2000);
            const tallies = await poll.locator('.option-tally').allTextContents();
            report.cases.push({ name: 'repeat-voting enabled, one captured message over mixed transports', tallies });
            console.log('REPEAT VOTE ' + JSON.stringify(tallies));
            assert.equal(await poll.getByText('1 votes', { exact: true }).count(), 1);
            await capture('yes', 'Repeat Voter');
            await delay(2000);
            await poll.getByText('2 votes', { exact: true }).waitFor();
            report.completed = true;
            return;
        }
        await capture('yes', 'Poll One');
        await capture('no', 'Poll Two');
        await poll.getByText('1 votes', { exact: true }).first().waitFor();
        await delay(5500);
        assert.equal(await poll.getByText('1 votes', { exact: true }).count(), 2, 'Snapshots preserve votes');
        await popup.evaluate(() => document.querySelector('[data-action="closepoll"]').click());
        await poll.getByText('Server controls question (Closed)', { exact: true }).waitFor();
        await capture('yes', 'Poll Three');
        await delay(1500);
        assert.equal(await poll.getByText('1 votes', { exact: true }).count(), 2);
        await popup.evaluate(() => document.querySelector('[data-action="resetpoll"]').click());
        await wait(poll, () => !document.getElementById('poll-title').textContent.includes('(Closed)'));
        await capture('yes', 'Poll Four');
        await poll.getByText('1 votes', { exact: true }).waitFor();
        report.cases.push({ name: 'Poll initial settings, votes, snapshot retention, End and Reset', passed: true });
        console.log('PASS poll controls');

        await popup.evaluate(() => { const input = document.getElementById('creditsTriggerModeSelect'); input.value = 'background'; input.dispatchEvent(new Event('change', { bubbles: true })); });
        await wait(background, () => isBackgroundCreditsModeEnabled());
        await delay(1000);
        await capture('Credits collected with display closed', 'Credits Viewer');
        await delay(1500);
        console.log('CREDITS COLLECTION ' + JSON.stringify(await background.evaluate(() => ({ users: Array.from(backgroundCreditsUsers.values()), mode: getCreditsTriggerModeSetting(), loaded: backgroundCreditsLoaded }))));
        await wait(background, () => Array.from(backgroundCreditsUsers.values()).some(user => user.name === 'Credits Viewer'));
        const creditsUrl = await popup.evaluate(() => document.getElementById('credits').raw);
        const credits = await createWindow(creditsUrl);
        await delay(1500);
        await popup.evaluate(() => document.getElementById('creditsStartBtn').click());
        await credits.locator('#credits-content').getByText('Credits Viewer', { exact: true }).waitFor();
        await popup.evaluate(() => document.getElementById('creditsBackgroundTestBtn').click());
        await credits.locator('#credits-content').getByText('Test Participant', { exact: true }).waitFor();
        await wait(popup, () => !document.getElementById('creditsBackgroundTestBtn').textContent.includes('Testing...'));
        await popup.evaluate(() => document.getElementById('creditsPreviewBtn').click());
        await credits.locator('#credits-content').getByText('Credits Viewer', { exact: true }).waitFor();
        await popup.evaluate(() => document.getElementById('creditsResetBtn').click());
        await wait(credits, () => !document.getElementById('credits-content').textContent.includes('Credits Viewer'));
        if (!rtc) {
            for (const key of ['server2', 'server3', 'socketserver']) {
                await popup.evaluate(key => { const input = document.querySelector('input[data-setting="' + key + '"],input[data-both="' + key + '"]'); if (input.checked) input.click(); }, key);
            }
            await wait(background, () => !settings.server2 && !settings.server3 && !settings.socketserver);
            await wait(popup, () => !document.getElementById('creditsBackgroundTestBtn').disabled);
            await popup.evaluate(() => document.getElementById('creditsBackgroundTestBtn').click());
            await wait(popup, () => document.getElementById('creditsBackgroundTestBtn').textContent.includes('No credits source connected'));
            assert.equal(await credits.locator('#credits-content').getByText('Test Participant', { exact: true }).count(), 0);
            for (const key of ['server2', 'server3', 'socketserver']) {
                await popup.evaluate(key => { const input = document.querySelector('input[data-setting="' + key + '"],input[data-both="' + key + '"]'); if (!input.checked) input.click(); }, key);
            }
            await wait(background, () => socketserver?.readyState === 1 && socketserverDock?.readyState === 1);
            await wait(popup, () => !document.getElementById('creditsBackgroundTestBtn').disabled);
            await popup.evaluate(() => document.getElementById('creditsBackgroundTestBtn').click());
            await credits.locator('#credits-content').getByText('Test Participant', { exact: true }).waitFor();
            report.cases.push({ name: 'disabled receivers prevent control delivery; re-enable recovers', passed: true });
        }
        report.cases.push({ name: 'Credits background collection, Start and Test', status: await popup.locator('#creditsBackgroundTestBtn').textContent(), passed: true });
        console.log('PASS credits controls');

        await popup.evaluate(() => { const input = document.querySelector('input[data-setting="hypemode"]'); if (!input.checked) input.click(); });
        const hype = await createWindow(await popup.evaluate(() => document.getElementById('hypemeter').raw));
        await capture('Hype captured', 'Hype Viewer');
        await hype.locator('#hype .sourceStatHolder').first().waitFor({ timeout: 25000 });
        await hype.reload({ waitUntil: 'domcontentloaded' });
        await hype.locator('#hype .sourceStatHolder').first().waitFor();
        report.cases.push({ name: 'Hype captured chatter, initial snapshot after reload', passed: true });
        console.log('PASS hype snapshots');

        const timer = await createWindow('https://socialstream.ninja/timer.html' + query);
        await background.evaluate(() => applyTimerAction('settimer', { label: 'Transport timer', seconds: 90, running: false }));
        await timer.locator('#label').getByText('Transport timer', { exact: true }).waitFor();
        await timer.reload({ waitUntil: 'domcontentloaded' });
        await timer.locator('#label').getByText('Transport timer', { exact: true }).waitFor();
        const ticker = await createWindow('https://socialstream.ninja/ticker.html' + query);
        await background.evaluate(() => sendTickerP2P(['Transport ticker']));
        await ticker.getByText('Transport ticker', { exact: true }).first().waitFor();
        await ticker.reload({ waitUntil: 'domcontentloaded' });
        await ticker.getByText('Transport ticker', { exact: true }).first().waitFor();
        const map = await createWindow('https://socialstream.ninja/map.html' + query);
        await popup.evaluate(() => chrome.runtime.sendMessage({ cmd: 'saveSetting', setting: 'mapTitle', type: 'textsetting', value: 'Transport map' }));
        await map.locator('#title').getByText('Transport map', { exact: true }).waitFor();
        report.cases.push({ name: 'Timer and Ticker state/reload recovery; Map popup settings', passed: true });
        console.log('PASS additional state controls');

        const reply = await timer.evaluate(({ room, endpoint }) => new Promise((resolve, reject) => {
            const socket = new WebSocket(endpoint);
            const timeout = setTimeout(() => { socket.close(); reject(new Error('Negotiated timer reply timed out')); }, 15000);
            socket.onopen = () => {
                socket.send(JSON.stringify({ join: room, out: 1, in: 2 }));
                socket.send(JSON.stringify({ action: 'gettimerstate', get: 'transport-timer-query', replyFormat: 'commandResult' }));
            };
            socket.onmessage = event => {
                const data = JSON.parse(event.data);
                if (data.type === 'commandResult' && data.get === 'transport-timer-query') { clearTimeout(timeout); socket.close(); resolve(data); }
            };
        }), { room, endpoint: local ? 'ws://127.0.0.1:' + port : 'wss://io.socialstream.ninja/api' });
        assert.equal(reply.result.label, 'Transport timer');
        report.cases.push({ name: 'negotiated controller reply from actual SSApp background', passed: true });

        // Opening the actual manager must preserve the generated server mode.
        const managerWindow = app.waitForEvent('window');
        await popup.evaluate(() => document.getElementById('giveaway-manage').click());
        const manager = await managerWindow;
        await manager.waitForLoadState('domcontentloaded');
        assert(new URL(manager.url()).searchParams.has('server'));
        report.managerWire = [];
        manager.on('websocket', socket => {
            socket.on('framesent', event => report.managerWire.push({ sent: String(event.payload) }));
            socket.on('framereceived', event => report.managerWire.push({ received: String(event.payload) }));
        });
        await manager.reload({ waitUntil: 'domcontentloaded' });
        await wait(manager, () => document.getElementById('status').textContent.includes('default:'));
        await manager.locator('[data-action="startgiveaway"]').click();
        await capture('!enter', 'Giveaway Viewer');
        for (let attempt = 0; attempt < 20; attempt++) {
            await delay(500);
            await manager.locator('#entries-refresh').click();
            if (await manager.getByText('Remove and refund', { exact: true }).count()) break;
        }
        await manager.getByText('Remove and refund', { exact: true }).waitFor();
        assert.match(await manager.locator('#entries').textContent(), /Giveaway Viewer/);
        await manager.locator('[data-action="closegiveaway"]').click();
        await manager.locator('[data-action="drawgiveaway"]').click();
        await manager.getByText('Giveaway Viewer', { exact: true }).first().waitFor();
        await manager.locator('[data-action="resetgiveaway"]').click();
        report.cases.push({ name: 'generated Giveaway Manager server connection, entries, close, draw and reset', passed: true });
        console.log('PASS giveaway manager');

        for (const enabled of ['server2', 'socketserver', 'server3']) {
            await popup.evaluate(enabled => {
                for (const key of ['server2', 'server3', 'socketserver']) {
                    const input = document.querySelector('input[data-setting="' + key + '"],input[data-both="' + key + '"]');
                    if (input.checked !== (key === enabled)) input.click();
                }
            }, enabled);
            await wait(background, enabled => ['server2', 'server3', 'socketserver'].every(key => !!settings[key] === (key === enabled)), enabled);
            await delay(1200);
            const generated = await popup.evaluate(() => document.getElementById('flowactions').raw);
            const oneRoute = await createWindow(generated);
            await wait(oneRoute, () => socketserver?.readyState === 1);
            await capture('Transport-QA route-' + enabled);
            await oneRoute.getByText('Transport-QA route-' + enabled, { exact: true }).waitFor();
            await oneRoute.close();
            report.cases.push({ name: 'generated Flow Actions with only ' + enabled, passed: true });
        }
        await popup.evaluate(() => {
            for (const key of ['server2', 'server3', 'socketserver']) {
                const input = document.querySelector('input[data-setting="' + key + '"],input[data-both="' + key + '"]');
                if (!input.checked) input.click();
            }
        });
        await wait(background, () => socketserver?.readyState === 1 && socketserverDock?.readyState === 1);

        const customUrl = new URL('https://socialstream.ninja/poll.html' + query);
        customUrl.searchParams.set('pollTally', '');
        customUrl.searchParams.set('server2', local ? 'ws://127.0.0.1:' + port : 'wss://io.socialstream.ninja/extension');
        if (local) customUrl.searchParams.set('localserverport', String(port === 65535 ? port - 1 : port + 1));
        const custom = await createWindow(customUrl.href);
        await custom.getByText('Server controls question', { exact: true }).waitFor();
        await capture('yes', 'Custom Relay Voter');
        await custom.getByText('1 votes', { exact: true }).waitFor();
        await custom.close();
        report.cases.push({ name: 'explicit relay address overrides defaults for Poll settings and captured voting', passed: true });

        // Disconnect the real host sockets, without reloading the displays.
        const pollTime = await poll.evaluate(() => performance.timeOrigin);
        const pollTallies = await poll.locator('.option-tally').allTextContents();
        await background.evaluate(() => { socketserver.close(); socketserverDock.close(); });
        await wait(background, () => socketserver?.readyState === 1 && socketserverDock?.readyState === 1);
        await delay(5500);
        assert.equal(await poll.evaluate(() => performance.timeOrigin), pollTime);
        assert.deepEqual(await poll.locator('.option-tally').allTextContents(), pollTallies);
        await capture('Transport-QA reconnect');
        await actions.getByText('Transport-QA reconnect', { exact: true }).waitFor();
        assert.equal(await actions.getByText('Transport-QA reconnect', { exact: true }).count(), 1);
        report.cases.push({ name: 'host relay reconnect: votes retained, no replayed action', passed: true });

        if (local && process.env.SSAPP_TEST_RELAY_RESTART === '1') {
            await popup.evaluate(() => document.querySelector('[data-action="closepoll"]').click());
            await poll.getByText('Server controls question (Closed)', { exact: true }).waitFor();
            report.beforeRelayRestart = {
                host: await background.evaluate(() => ({ timeOrigin: performance.timeOrigin, state: pollControlState, pollSettings: pollControlSettings(settings) })),
                display: await poll.evaluate(() => ({ timeOrigin: performance.timeOrigin, settings, results, totalVotes }))
            };
            await credits.evaluate(() => {
                window.__creditsContentWrites = 0;
                new MutationObserver(records => { window.__creditsContentWrites += records.length; })
                    .observe(document.getElementById('credits-content'), { childList: true });
            });
            for (const prefix of ['Stop Local Server', 'Enable Local Server']) {
                await app.evaluate(({ Menu }, prefix) => {
                    function find(menu) {
                        for (const item of menu.items) {
                            if (item.label.startsWith(prefix)) return item;
                            if (item.submenu) { const result = find(item.submenu); if (result) return result; }
                        }
                    }
                    const item = find(Menu.getApplicationMenu());
                    if (!item) throw new Error('Missing relay menu command');
                    item.click(item);
                }, prefix);
                await delay(1500);
            }
            background = await frame('background');
            popup = await frame('popup');
            await wait(background, () => typeof socketserver !== 'undefined' && socketserver?.readyState === 1 && socketserverDock?.readyState === 1);
            await delay(5500);
            report.afterRelayRestart = {
                host: await background.evaluate(() => ({ timeOrigin: performance.timeOrigin, state: pollControlState, pollSettings: pollControlSettings(settings) })),
                display: await poll.evaluate(() => ({ timeOrigin: performance.timeOrigin, settings, results, totalVotes }))
            };
            assert.deepEqual(await poll.locator('.option-tally').allTextContents(), pollTallies);
            await poll.getByText('Server controls question (Closed)', { exact: true }).waitFor();
            assert.equal(await credits.evaluate(() => window.__creditsContentWrites), 0, 'Relay restart must not restart or replace the Credits roll');
            await capture('Transport-QA relay-restarted');
            await actions.getByText('Transport-QA relay-restarted', { exact: true }).waitFor();
            await popup.evaluate(() => document.querySelector('[data-action="resetpoll"]').click());
            await wait(poll, () => !document.getElementById('poll-title').textContent.includes('(Closed)'));
            report.cases.push({ name: 'real local relay stop/start: closed poll and votes retained, Credits not replayed, controls recover', passed: true });
        }

        for (const nextRoom of [room + '_next', room]) {
            await popup.evaluate(value => { const input = document.getElementById('sessionid'); input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); }, nextRoom);
            await wait(background, value => streamID === value && socketserver?.readyState === 1 && socketserverDock?.readyState === 1, nextRoom);
            const second = await createWindow('https://socialstream.ninja/actions.html' + query.replace(room, nextRoom));
            await wait(second, () => socketserver?.readyState === 1);
            await delay(1000);
            const marker = 'Transport-QA session-' + nextRoom;
            await capture(marker);
            await second.getByText(marker, { exact: true }).waitFor();
            if (nextRoom !== room) assert.equal(await actions.getByText(marker, { exact: true }).count(), 0, 'Old room receives no new-session actions');
            await second.close();
        }
        report.cases.push({ name: 'two popup session changes with action delivery and previous-room isolation', passed: true });
        console.log('PASS reconnect and session changes');
        report.completed = true;
    } finally {
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
        await app.close();
        console.log(output);
    }
}
run().catch(error => {
    report.error = error.stack;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.error(error); process.exitCode = 1;
});
