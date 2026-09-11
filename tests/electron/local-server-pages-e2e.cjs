'use strict';

// Real SSApp, its actual local relay and source windows; isolated profile and
// local HTTPS fixtures. External DNS is disabled only for this test process.
const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');
const { _electron } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-local-pages-'));
const room = 'local_pages_' + Date.now();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { output, cases: [] };

async function freePort() {
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    return port;
}

async function run() {
    let port = await freePort();
    fs.writeFileSync(path.join(output, 'savedSync.json'), JSON.stringify({ streamID: room, password: 'false', state: true,
        settings: { socketserver: true, server2: true, server3: true }, wsServer: true }));
    const wrapper = path.join(output, 'bootstrap.cjs');
    fs.writeFileSync(wrapper, `require(${JSON.stringify(path.join(__dirname, 'outage-bootstrap.js'))});global.__outage.phase='online';`);
    const launch = (initial) => _electron.launch({ executablePath: require('electron'), cwd: root,
        args: [wrapper, '--multiinstance', '--no-hwa', ...(initial ? [`--ssapp-local-server-port=${port}`] : []),
            ...(process.env.SSAPP_LOCAL_MEDIA_WORKFLOWS === '1' ? ['--filesource', pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href] : []),
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
        env: { ...process.env, SSAPP_USER_DATA_DIR: output, SSAPP_PREFER_LOCAL_ASSETS: '0', SSAPP_DIAGNOSTICS_SAFE_GPU: '1' }, timeout: 60000 });
    let app = await launch(true);
    let publisher;
    try {
        let main = await app.firstWindow();
        main.setDefaultTimeout(30000);
        await main.waitForFunction(() => document.getElementById('frame1')?.src.includes('popup.html'));
        async function findFrame(name) {
            for (let n = 0; n < 120; n++) {
                const frame = main.frames().find(frame => frame.url().includes('/' + name + '.html'));
                if (frame) return frame;
                await delay(250);
            }
            throw new Error('Missing frame: ' + name);
        }
        let popup = await findFrame('popup');
        let background = await findFrame('background');
        await background.waitForFunction(() => window.ssappBackgroundLoadState?.status === 'ready' && window.eventFlowSystem?.db, null, { timeout: 60000 });
        await popup.waitForFunction(() => document.getElementById('games')?.raw?.includes('session='));
        report.background = await background.evaluate(() => ({ url: location.href, serverURL, serverURLDock, ready: ssappBackgroundLoadState.status }));
        publisher = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise((resolve, reject) => { publisher.once('open', resolve); publisher.once('error', reject); });
        publisher.send(JSON.stringify({ join: room, out: 1, in: 2 }));
        async function createWindow(url, options = {}) {
            const pendingWindow = app.waitForEvent('window');
            await main.evaluate(options => ipcRenderer.sendSync('createWindow', options), { url, visible: true, size: { width: 1100, height: 800 }, ...options });
            return pendingWindow;
        }
        const sourceUrl = pathToFileURL(path.join(__dirname, 'fixtures/hidden-capture.html')).href + '?platform=youtube&manual=1';
        let source = await createWindow(sourceUrl, { sourceFiles: ['sources/youtube.js'] });
        await source.waitForLoadState('domcontentloaded');
        await delay(4500);
        const capture = async (command, name = 'Local Relay QA') => {
            await source.evaluate(({ command, name }) => {
                window.__hiddenCaptureFixture.appendRows([Date.now()]);
                const row = document.querySelector('.ssn-chat-row:last-child');
                row.querySelector('#author-name').textContent = name;
                row.querySelector('#message').textContent = command;
            }, { command, name });
        };
        const pending = app.waitForEvent('window');
        await main.evaluate(() => ipcRenderer.sendSync('createWindow', { url: 'about:blank', visible: true }));
        let page = await pending;
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const games = [['chickenroyale', '!join'], ['memoryparade', '!ready']];
        if (process.env.SSAPP_LOCAL_GAME_WORKFLOWS === '1') games.push(
            ['tugofwar', '!join'], ['signallock', '!code 1234'], ['crowdquest', '!vote 1'],
            ['minorityclub', '!pick sun'], ['crewkitchen', '!cook dough'], ['beaconrelay', '!pass'],
            ['meteorshield', '!shield red'], ['oddoneout', '!odd 1'], ['sumsquad', '!add 5'],
            ['rockpapershowdown', '!throw rock'], ['numberhunt', '!guess 50'], ['quickcall', '!quick']);
        for (const [game, command] of games) {
            await popup.locator('#games-preset-select').selectOption(`games/${game}.html`, { force: true });
            const generated = await popup.evaluate(() => document.getElementById('games').raw);
            const url = new URL(generated);
            const row = { game, generated, localFlagRetained: url.searchParams.has('localserver'), portRetained: url.searchParams.get('localserverport') === String(port) };
            await page.goto(url.href, { waitUntil: 'domcontentloaded' });
            await delay(1200);
            const capturedCommand = game === 'crewkitchen' ? await page.locator('#teamplay-stage code').first().textContent() : command;
            await capture(capturedCommand);
            await page.waitForFunction(() => document.body.innerText.includes('Local Relay QA') || document.getElementById('participants')?.textContent === '1' || document.getElementById('queue')?.textContent === '1 waiting', null, { timeout: 10000 });
            row.capturedChatReceived = true;
            if (game === 'memoryparade' && process.env.SSAPP_LOCAL_GAME_WORKFLOWS === '1') {
                // Play the actual timed match using only the displayed sequence
                // and captured chat. Keep both the short and legacy commands working.
                await capture('!ready', 'Memory Friend');
                await page.waitForFunction(() => document.getElementById('participants').textContent === '2');
                for (let sequence = 1; sequence <= 4; sequence++) {
                    await page.waitForFunction(sequence => document.getElementById('puzzle-score').textContent === `Sequence ${sequence} / 4`
                        && document.getElementById('puzzle-title').textContent === 'Watch the parade.', sequence, { timeout: 20000 });
                    const answer = (await page.locator('.memory-tile').allTextContents()).join('');
                    assert.match(answer, new RegExp('^[1-4]{' + (sequence + 2) + '}$'));
                    await page.waitForFunction(() => document.getElementById('puzzle-title').textContent === 'What was the sequence?');
                    await capture('!mem ' + answer);
                    await delay(350);
                    await capture('!remember ' + answer, 'Memory Friend');
                }
                await page.waitForFunction(() => document.getElementById('result').textContent.includes('Top score: 4 / 4'), null, { timeout: 15000 });
                const result = await page.locator('#result').textContent();
                assert(result.includes('Local Relay QA') && result.includes('Memory Friend'), 'Both viewers finish with full scores');
                await page.locator('#next').click();
                await page.waitForFunction(() => document.getElementById('participants').textContent === '0');
                await capture('!ready', 'Next Match Viewer');
                await page.waitForFunction(() => document.getElementById('participants').textContent === '1');
                row.completedMatch = { result, nextMatchJoin: true };
                console.log('PASS full Memory Parade match, both answer commands and next match');
            }
            // Separately verify that a correctly formed local URL is honored.
            url.searchParams.delete('server2');
            url.searchParams.delete('server3');
            url.searchParams.set('server', '');
            url.searchParams.set('localserver', '');
            url.searchParams.set('localserverport', port);
            await page.goto(url.href, { waitUntil: 'domcontentloaded' });
            await delay(1800);
            const directCommand = game === 'crewkitchen' ? await page.locator('#teamplay-stage code').first().textContent() : command;
            publisher.send(JSON.stringify({ type: 'youtube', chatname: 'Local Relay QA', chatmessage: directCommand, textonly: true, id: game + '-1' }));
            await delay(800);
            row.state = await page.evaluate(() => ({ participants: document.getElementById('participants')?.textContent,
                queue: document.getElementById('queue')?.textContent,
                text: document.body.innerText.includes('Local Relay QA'), connection: document.getElementById('connection')?.textContent || document.getElementById('connection-line')?.textContent }));
            row.received = row.state.participants === '1' || row.state.queue === '1 waiting' || row.state.text;
            row.errors = errors.splice(0);
            report.cases.push(row);
            console.log(JSON.stringify(row));
            await page.screenshot({ path: path.join(output, game + '.png') });
        }
        // A real background API request must return its callback through the
        // local relay; merely seeing the command arrive is insufficient.
        const response = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Local API callback was swallowed')), 5000);
            publisher.on('message', value => {
                const packet = JSON.parse(value.toString());
                if (packet.callback?.get === 'local-timer-state') { clearTimeout(timeout); resolve(packet.callback.result); }
            });
        });
        publisher.send(JSON.stringify({ action: 'gettimerstate', get: 'local-timer-state' }));
        report.timerCallback = await response;
        console.log('PASS local API timer callback');

        if (process.env.SSAPP_LOCAL_RELAY_OVERRIDE === '1') {
            const unusedPort = await freePort();
            report.explicitGameRelay = [];
            for (const parameter of ['server', 'server2']) {
                await popup.locator('#games-preset-select').selectOption('games/memoryparade.html', { force: true });
                const url = new URL(await popup.evaluate(() => document.getElementById('games').raw));
                url.searchParams.set('localserverport', unusedPort);
                url.searchParams.set(parameter, `ws://127.0.0.1:${port}`);
                const row = { parameter, url: url.href };
                report.explicitGameRelay.push(row);
                await page.goto(url.href, { waitUntil: 'domcontentloaded' });
                await delay(1500);
                if (parameter === 'server') publisher.send(JSON.stringify({ type: 'youtube', chatname: 'Explicit Relay Viewer', chatmessage: '!ready', textonly: true, id: 'explicit-relay-' + parameter }));
                else await capture('!ready', 'Explicit Relay Viewer');
                await page.waitForFunction(() => document.getElementById('participants').textContent === '1');
                row.joinedViaExplicitEndpoint = true;
                console.log('PASS game explicit relay override: ' + parameter);
            }
        }

        if (process.env.SSAPP_LOCAL_DOCK_WORKFLOWS === '1') {
            // Manual featuring uses the separate "Dock publish via API" switch.
            await popup.evaluate(() => { const input = document.getElementById('server'); if (!input.checked) input.click(); });
            await popup.waitForFunction(() => new URL(document.getElementById('dock').raw).searchParams.has('server'), null, { polling: 100 });
            const dockUrl = await popup.evaluate(() => document.getElementById('dock').raw);
            await popup.locator('#featured-preset-select').selectOption('themes/featured-styles/featured-modern.html?style=glass', { force: true });
            const featuredUrl = await popup.evaluate(() => document.getElementById('overlay').raw);
            const dock = await createWindow(dockUrl);
            await dock.waitForLoadState('domcontentloaded');
            await page.goto(featuredUrl, { waitUntil: 'domcontentloaded' });
            report.dockFeaturing = { dockUrl, featuredUrl, messages: [] };
            await delay(1800);
            for (let sequence = 1; sequence <= 2; sequence++) {
                const message = 'Dock feature QA ' + sequence;
                await capture(message, 'Dock Viewer');
                await dock.getByText(message, { exact: true }).waitFor();
                assert.equal(await dock.getByText(message, { exact: true }).count(), 1, 'One captured message per Dock row');
                assert.equal(await page.getByText(message, { exact: true }).count(), 0, 'Manual featured overlay waits for selection');
                await dock.screenshot({ path: path.join(output, 'dock-before-selection.png') });
                await dock.getByText(message, { exact: true }).click();
                await page.getByText(message, { exact: true }).waitFor();
                await dock.locator('#clear_overlay').click();
                await page.getByText(message, { exact: true }).waitFor({ state: 'detached' });
                report.dockFeaturing.messages.push({ message, featuredAndCleared: true });
            }
            console.log('PASS generated Dock and featured links: captured chat, selection, clear and repeat');
            await dock.close();
        }

        async function checkFlowAction(label) {
            await page.goto(`https://socialstream.ninja/actions.html?session=${room}&server&localserver&localserverport=${port}`, { waitUntil: 'domcontentloaded' });
            await delay(1200);
            await capture('LocalFlow-QA ' + label);
            await page.getByText('Flow action LocalFlow-QA ' + label, { exact: true }).waitFor();
            await delay(1200);
            assert.equal(await page.getByText('Flow action LocalFlow-QA ' + label, { exact: true }).count(), 1, 'One action per captured message');
            assert.equal(await page.getByText('Inactive flow must stay off', { exact: true }).count(), 0);
        }
        if (process.env.SSAPP_LOCAL_LIFECYCLE === '1' || process.env.SSAPP_LOCAL_ROUTING_WORKFLOWS === '1' || process.env.SSAPP_LOCAL_PORT_CONFLICT === '1' || process.env.SSAPP_LOCAL_SESSION_CHANGE === '1') {
            await background.evaluate(async () => {
                const flow = { id: 'local-active-flow', name: 'Captured chat action', active: true,
                    nodes: [
                        { id: 'trigger', type: 'trigger', triggerType: 'messageContains', config: { text: 'LocalFlow-QA ' } },
                        { id: 'action', type: 'action', actionType: 'showText', config: { text: '{message}', duration: 10000 } }
                    ], connections: [{ from: 'trigger', to: 'action' }] };
                // Keep the displayed text tied to the incoming chat rather than
                // invoking the action directly from this test.
                flow.nodes[1].config.text = 'Flow action {message}';
                await eventFlowSystem.saveFlow(flow);
                await eventFlowSystem.saveFlow({ ...flow, id: 'local-inactive-flow', name: 'Stay disabled', active: false,
                    nodes: [flow.nodes[0], { ...flow.nodes[1], config: { text: 'Inactive flow must stay off', duration: 10000 } }] });
            });
            // The message template preserves the full trigger text.
            await checkFlowAction('initial');
            report.flowActionBeforeChanges = true;
        }

        if (process.env.SSAPP_LOCAL_GIVEAWAY_WORKFLOWS === '1') {
            async function giveawayButton(action) {
                await popup.locator('[data-giveaway-action="' + action + '"]:enabled').waitFor({ state: 'attached' });
                await popup.evaluate(action => document.querySelector('[data-giveaway-action="' + action + '"]').click(), action);
                await popup.waitForFunction(() => !document.querySelector('[data-giveaway-action]').disabled, null, { polling: 100 });
            }
            await giveawayButton('startgiveaway');
            await popup.waitForFunction(() => document.getElementById('giveaway-control-status').textContent.includes('Entries open'), null, { polling: 100 });
            const generated = await popup.evaluate(() => document.getElementById('giveaway').raw);
            report.managedGiveaway = { generated };
            await page.goto(generated, { waitUntil: 'domcontentloaded' });
            await page.getByText('0 eligible entries', { exact: true }).waitFor();
            await capture('!enter', 'State Viewer One');
            await page.getByText('1 eligible entry', { exact: true }).waitFor();
            await capture('!enter', 'State Viewer Two');
            await page.getByText('2 eligible entries', { exact: true }).waitFor();
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.getByText('2 eligible entries', { exact: true }).waitFor();
            await giveawayButton('closegiveaway');
            await page.getByText('Entries closed', { exact: true }).waitFor();
            await giveawayButton('drawgiveaway');
            await page.waitForFunction(() => /State Viewer (One|Two) wins!/.test(document.querySelector('.giveaway-result')?.textContent || ''));
            const winner = await page.locator('.giveaway-result').textContent();
            const apiUrl = new URL(generated);
            apiUrl.searchParams.delete('server2');
            apiUrl.searchParams.delete('server3');
            apiUrl.searchParams.set('server', '');
            const second = await createWindow(apiUrl.href);
            await second.waitForLoadState('domcontentloaded');
            await second.getByText(winner, { exact: true }).waitFor();
            await giveawayButton('resetgiveaway');
            for (const display of [page, second]) {
                await display.getByText('0 eligible entries', { exact: true }).waitFor();
                assert.equal(await display.locator('.giveaway-result').textContent(), 'Good luck!');
            }
            report.managedGiveaway.snapshotAfterReload = true;
            report.managedGiveaway.apiSnapshotAndReset = true;
            const manageWindow = app.waitForEvent('window');
            await popup.evaluate(() => document.getElementById('giveaway-manage').click());
            const manager = await manageWindow;
            await manager.waitForLoadState('domcontentloaded');
            report.managedGiveaway.manager = await manager.evaluate(() => ({ url: location.href, status: document.getElementById('status').textContent,
                native: typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage, appBridge: typeof window.ninjafy?.sendMessage }));
            console.log('Giveaway manager: ' + JSON.stringify(report.managedGiveaway.manager));
            await manager.waitForFunction(() => document.getElementById('status').textContent.includes('default:'));
            await manager.locator('#history-refresh').click();
            await manager.getByText(winner.replace(' wins!', ''), { exact: true }).waitFor();
            report.managedGiveaway.managerHistory = true;
            await manager.locator('[data-action="startgiveaway"]').click();
            await page.getByText('Type !enter to enter', { exact: true }).waitFor();
            await capture('!enter', 'Manager Viewer');
            await page.getByText('1 eligible entry', { exact: true }).waitFor();
            await manager.locator('#entries-refresh').click();
            await manager.getByText('Remove and refund', { exact: true }).waitFor();
            assert.match(await manager.locator('#entries').textContent(), /Manager Viewer/);
            await manager.getByText('Remove and refund', { exact: true }).click();
            await page.getByText('0 eligible entries', { exact: true }).waitFor();
            await manager.locator('[data-action="closegiveaway"]').click();
            await page.getByText('Entries closed', { exact: true }).waitFor();
            report.managedGiveaway.managerControls = true;
            console.log('PASS managed giveaway: entries, reload, draw, reset, manager history, open/remove/close');
            report.managedGiveaway.explicitRelays = [];
            const unusedPort = await freePort();
            for (const parameter of ['server2', 'server']) {
                const overridden = new URL(generated);
                overridden.searchParams.set(parameter, `ws://127.0.0.1:${port}`);
                overridden.searchParams.set('localserverport', String(unusedPort));
                await second.goto(overridden.href, { waitUntil: 'domcontentloaded' });
                await second.getByText('0 eligible entries', { exact: true }).waitFor();
                await manager.locator('[data-action="startgiveaway"]').click();
                await second.getByText('Type !enter to enter', { exact: true }).waitFor();
                await capture('!enter', 'Override Viewer ' + parameter);
                await second.getByText('1 eligible entry', { exact: true }).waitFor();
                await manager.locator('[data-action="resetgiveaway"]').click();
                await second.getByText('0 eligible entries', { exact: true }).waitFor();
                report.managedGiveaway.explicitRelays.push(parameter);
                console.log('PASS managed giveaway explicit relay: ' + parameter);
            }
            const managerOrigin = await manager.evaluate(() => performance.timeOrigin);
            let managerJoins = 0;
            manager.on('websocket', socket => socket.on('framesent', event => {
                try { if (JSON.parse(event.payload).join === room) managerJoins++; } catch (_) {}
            }));
            for (let cycle = 1; cycle <= 2; cycle++) {
                for (const prefix of ['Stop Local Server', 'Enable Local Server']) {
                    await app.evaluate(({ Menu }, prefix) => {
                        function find(menu) {
                            for (const item of menu.items) {
                                if (item.label.startsWith(prefix)) return item;
                                if (item.submenu) { const result = find(item.submenu); if (result) return result; }
                            }
                        }
                        const item = find(Menu.getApplicationMenu());
                        if (!item) throw new Error('Missing local server menu command');
                        item.click(item);
                    }, prefix);
                    await delay(1500);
                }
                background = await findFrame('background');
                popup = await findFrame('popup');
                await background.waitForFunction(() => ssappBackgroundLoadState?.status === 'ready' && socketserver?.readyState === 1, null, { polling: 100 });
                await manager.waitForFunction(() => document.getElementById('status').textContent.includes('default:'));
                await manager.locator('[data-action="startgiveaway"]').click();
                await page.getByText('Type !enter to enter', { exact: true }).waitFor();
                await capture('!enter', 'Reconnected Manager Viewer ' + cycle);
                await page.getByText('1 eligible entry', { exact: true }).waitFor();
                await manager.locator('[data-action="resetgiveaway"]').click();
                await page.getByText('0 eligible entries', { exact: true }).waitFor();
                assert.equal(await manager.evaluate(() => performance.timeOrigin), managerOrigin, 'Manager reconnects without reloading');
                console.log('PASS giveaway manager reconnect ' + cycle);
            }
            assert(managerJoins >= 2, 'Manager joined again after both relay restarts');
            report.managedGiveaway.reconnects = managerJoins;
            await popup.evaluate(() => document.querySelector('input[data-setting="socketserver"]').click());
            await background.waitForFunction(() => !settings.socketserver, null, { polling: 100 });
            await manager.locator('#refresh').click();
            await manager.getByText(/Enable remote API control of extension/).waitFor();
            await popup.evaluate(() => document.querySelector('input[data-setting="socketserver"]').click());
            await background.waitForFunction(() => settings.socketserver && socketserver?.readyState === 1, null, { polling: 100 });
            await manager.locator('#refresh').click();
            await manager.waitForFunction(() => document.getElementById('status').textContent.includes('default:'));
            report.managedGiveaway.disabledApiRecovery = true;
            await second.close();
            await manager.close();
        }

        if (process.env.SSAPP_LOCAL_SESSION_CHANGE === '1') {
            const secondRoom = room + '_b';
            const receivers = [];
            report.sessionChanges = [];
            try {
                for (const receiverRoom of [room, secondRoom]) {
                    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
                    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
                    const packets = [];
                    socket.on('message', data => { packets.push(JSON.parse(data.toString())); });
                    socket.send(JSON.stringify({ join: receiverRoom, out: 3, in: 4 }));
                    receivers.push({ room: receiverRoom, socket, packets });
                }
                const game = await createWindow('about:blank');
                for (const [index, nextRoom] of [secondRoom, room].entries()) {
                    await popup.evaluate(value => {
                        const input = document.getElementById('sessionid');
                        input.value = value;
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    }, nextRoom);
                    await background.waitForFunction(value => streamID === value, nextRoom, { polling: 100 });
                    await popup.waitForFunction(value => new URL(document.getElementById('games').raw).searchParams.get('session') === value, nextRoom, { polling: 100 });
                    await popup.locator('#games-preset-select').selectOption('games/memoryparade.html', { force: true });
                    const gameUrl = await popup.evaluate(() => document.getElementById('games').raw);
                    await game.goto(gameUrl, { waitUntil: 'domcontentloaded' });
                    await delay(1500);
                    const viewer = 'Session Switch Viewer ' + index;
                    await capture('!ready', viewer);
                    await delay(1200);
                    const row = { room: nextRoom, gameUrl, destinations: receivers.map(receiver => ({ room: receiver.room,
                        messages: receiver.packets.filter(packet => packet.chatname === viewer).length })) };
                    report.sessionChanges.push(row);
                    assert.equal(row.destinations.find(dest => dest.room !== nextRoom).messages, 0, 'Captured chat must leave the previous local session');
                    await game.waitForFunction(() => document.getElementById('participants').textContent === '1');
                    await page.goto(await popup.evaluate(() => document.getElementById('flowactions').raw), { waitUntil: 'domcontentloaded' });
                    await delay(1200);
                    await capture('LocalFlow-QA session-' + index);
                    await page.getByText('Flow action LocalFlow-QA session-' + index, { exact: true }).waitFor();
                    const api = new WebSocket(`ws://127.0.0.1:${port}`);
                    try {
                        await new Promise((resolve, reject) => { api.once('open', resolve); api.once('error', reject); });
                        api.send(JSON.stringify({ join: nextRoom, out: 1, in: 2 }));
                        const token = 'session-timer-' + index;
                        const reply = new Promise((resolve, reject) => {
                            const timeout = setTimeout(() => reject(new Error('API receiver stayed in the previous session')), 5000);
                            api.on('message', data => { if (JSON.parse(data.toString()).callback?.get === token) { clearTimeout(timeout); resolve(); } });
                        });
                        api.send(JSON.stringify({ action: 'gettimerstate', get: token }));
                        await reply;
                    } finally { api.terminate(); }
                    row.gameActionAndApiPassed = true;
                    console.log('PASS local session change: ' + nextRoom);
                }
                await game.close();
            } finally { receivers.forEach(receiver => receiver.socket.terminate()); }
        }

        if (process.env.SSAPP_LOCAL_GAME_WORKFLOWS === '1' || process.env.SSAPP_LOCAL_CONTROL_WORKFLOWS === '1') {
            // Test page-owned callback routing and the unchanged room/channel boundaries.
            const receivers = [];
            try {
                for (const [receiverRoom, channel] of [[room, 77], [room + '_other', 77], [room, 78]]) {
                    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
                    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
                    const received = [];
                    socket.on('message', data => received.push(JSON.parse(data.toString())));
                    socket.send(JSON.stringify({ join: receiverRoom, in: channel, out: 79 }));
                    receivers.push({ socket, received });
                }
                await delay(100);
                publisher.send(JSON.stringify({ out: 77, callback: { get: 'page-owned-callback', result: 'delivered' } }));
                await delay(300);
                assert.equal(receivers[0].received.length, 1);
                assert.equal(receivers[1].received.length, 0, 'Callback must not cross rooms');
                assert.equal(receivers[2].received.length, 0, 'Callback must not cross channels');
                report.callbackIsolation = true;
            } finally { receivers.forEach(({ socket }) => socket.terminate()); }

            const base = `https://socialstream.ninja/`;
            const query = `?session=${room}&server&localserver&localserverport=${port}`;
            const timer = await createWindow(base + 'timer.html' + query);
            await timer.waitForLoadState('domcontentloaded');
            const obsDockUrl = await popup.locator('#obs_control_dock_url').getAttribute('href');
            assert.equal(new URL(obsDockUrl).searchParams.get('localserverport'), String(port));
            await page.goto(obsDockUrl, { waitUntil: 'domcontentloaded' });
            await delay(1200);
            await page.locator('summary').filter({ hasText: /^Timer$/ }).click();
            await page.locator('[data-action="starttimer"]').click();
            await page.locator('#commandStatus.success').waitFor();
            await timer.waitForFunction(() => document.getElementById('stateBadge').textContent === 'Running');
            await page.locator('[data-action="pausetimer"]').click();
            await page.locator('#commandStatus.success').waitFor();
            await timer.waitForFunction(() => document.getElementById('stateBadge').textContent === 'Paused');
            report.obsTimerControl = true;
            const apiLink = await page.locator('a[href*="sampleapi.html"]').getAttribute('href');
            assert.equal(new URL(apiLink, page.url()).searchParams.get('localserverport'), String(port));
            await page.goto(base + 'actions.html' + query, { waitUntil: 'domcontentloaded' });
            await delay(1000);
            publisher.send(JSON.stringify({ out: 6, actionType: 'show_text', text: 'Local action rendered', duration: 10000 }));
            await page.getByText('Local action rendered', { exact: true }).waitFor();
            report.actionsRendered = true;
            await page.goto(base + 'monetization.html' + query + '&server2&mode=commerce', { waitUntil: 'domcontentloaded' });
            await delay(1000);
            publisher.send(JSON.stringify({ out: 4, id: 'local-commerce-test', type: 'youtube', chatname: 'Local Supporter', chatmessage: 'Thank you', hasDonation: '$5.00', textonly: true }));
            await page.waitForFunction(() => document.body.innerText.includes('Local Supporter'));
            report.monetizationRendered = true;
            await page.goto(base + 'sampleapi.html' + query, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.getElementById('connectionStatus').textContent.includes('Connected'));
            assert(await page.getByRole('button', { name: 'Send via HTTPS GET', exact: true }).isDisabled());
            assert(await page.getByRole('button', { name: 'Send via HTTPS POST', exact: true }).isDisabled());
            report.sampleApiLocal = true;
            const importerUrl = await popup.locator('#streamelements_importer_link').getAttribute('href');
            assert.equal(new URL(importerUrl).searchParams.get('localserverport'), String(port));
            await page.goto(importerUrl, { waitUntil: 'domcontentloaded' });
            await page.setInputFiles('#fileInput', [
                { name: 'html.txt', mimeType: 'text/plain', buffer: Buffer.from('<div id="messages"></div>') },
                { name: 'js.txt', mimeType: 'text/plain', buffer: Buffer.from('window.addEventListener("onEventReceived",function(e){if(e.detail.listener==="message")document.getElementById("messages").textContent=e.detail.event.data.text;});') }
            ]);
            await page.locator('#exportBtn:enabled').waitFor();
            const exportedFile = path.join(output, 'exported-local-widget.html');
            await app.evaluate(({ BrowserWindow }, file) => {
                const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('streamelements-importer.html'));
                window.webContents.session.once('will-download', (_event, item) => item.setSavePath(file));
            }, exportedFile);
            await page.locator('#exportBtn').click();
            for (let n = 0; n < 100 && !fs.existsSync(exportedFile); n++) await delay(100);
            assert(fs.existsSync(exportedFile), 'Importer exports a standalone file');
            await page.goto(pathToFileURL(exportedFile).href, { waitUntil: 'domcontentloaded' });
            await delay(1200);
            await capture('Standalone local widget receives chat');
            await page.getByText('Standalone local widget receives chat', { exact: true }).waitFor();
            report.importedWidgetLocal = true;
            console.log('PASS isolated callbacks, OBS timer controls, action/monetization rendering and API controls');

            if (fs.existsSync(path.resolve(root, '../social_stream/combine.html'))) {
                await page.goto(base + 'combine.html', { waitUntil: 'domcontentloaded' });
                await page.locator('.url-input').nth(0).fill(base + 'dock.html' + query + '&server2');
                await page.locator('.url-input').nth(1).fill(base + 'actions.html' + query);
                const editable = await page.locator('#edit-link').getAttribute('href');
                await page.goto(editable, { waitUntil: 'domcontentloaded' });
                const editedActionUrl = base + 'actions.html' + query + '&scale=95';
                await page.locator('.url-input').nth(1).fill(editedActionUrl);
                await page.reload({ waitUntil: 'domcontentloaded' });
                assert.equal(await page.locator('.url-input').nth(1).inputValue(), editedActionUrl, 'Reload keeps edits to a shared layout');
                await page.locator('#preview-button').click();
                assert.equal(await page.locator('#preview-stage iframe').count(), 2);
                await page.locator('#show-qr').click();
                await page.locator('#qr-code canvas').waitFor({ state: 'attached' });
                const combined = await page.locator('#combined-url').inputValue();
                await page.goto(combined, { waitUntil: 'domcontentloaded' });
                assert(await page.locator('#editor').isHidden());
                for (const src of await page.locator('#output iframe').evaluateAll(frames => frames.map(frame => frame.src))) {
                    assert(new URL(src).searchParams.has('localserver'));
                    assert.equal(new URL(src).searchParams.get('localserverport'), String(port));
                }
                await delay(2000);
                await capture('Combined local chat');
                await page.frameLocator('#output iframe').nth(0).getByText('Combined local chat', { exact: true }).waitFor();
                publisher.send(JSON.stringify({ out: 6, actionType: 'show_text', text: 'Combined local action', duration: 10000 }));
                await page.frameLocator('#output iframe').nth(1).getByText('Combined local action', { exact: true }).waitFor();
                await page.reload({ waitUntil: 'domcontentloaded' });
                await delay(1800);
                await capture('Combined chat after reload');
                await page.frameLocator('#output iframe').nth(0).getByText('Combined chat after reload', { exact: true }).waitFor();
                report.combinedLocalPages = true;
                console.log('PASS combined local chat/actions, generated link, QR creation and reload');
            }
        }

        if (process.env.SSAPP_LOCAL_ROUTING_WORKFLOWS === '1') {
            async function setRoutes(names) {
                await popup.evaluate(names => {
                    for (const name of ['socketserver', 'server2', 'server3']) {
                        const input = document.querySelector('input[data-setting="' + name + '"], input[data-both="' + name + '"]');
                        if (!input) throw new Error('Missing route setting: ' + name);
                        if (input.checked !== names.includes(name)) input.click();
                    }
                }, names);
                await delay(1500);
                await background.waitForFunction(names => ['socketserver', 'server2', 'server3'].every(name => !!settings[name] === names.includes(name)), names, { polling: 100 });
            }
            await background.evaluate(async () => {
                for (const [id, command, actionType, config] of [
                    ['local-media-flow', 'LocalMedia-QA', 'playTenorGiphy', { sourceType: 'url', mediaUrl: 'https://socialstream.ninja/icons/logo.svg', mediaType: 'image', useLayer: true, duration: 0 }],
                    ['local-clear-flow', 'LocalClear-QA', 'clearLayer', { layer: 'all' }]
                ]) await eventFlowSystem.saveFlow({ id, name: id, active: true,
                    nodes: [{ id: 'trigger', type: 'trigger', triggerType: 'messageContains', config: { text: command } },
                        { id: 'action', type: 'action', actionType, config }], connections: [{ from: 'trigger', to: 'action' }] });
            });
            report.singleRoutes = [];
            for (const names of [['server2'], ['socketserver'], ['server3']]) {
                await setRoutes(names);
                const generated = await popup.evaluate(() => document.getElementById('flowactions').raw);
                const row = { routes: names, generated };
                report.singleRoutes.push(row);
                await page.goto(generated, { waitUntil: 'domcontentloaded' });
                await delay(1500);
                await capture('LocalFlow-QA ' + names[0]);
                await page.getByText('Flow action LocalFlow-QA ' + names[0], { exact: true }).waitFor();
                await capture('LocalMedia-QA ' + names[0]);
                await page.waitForFunction(() => Array.from(document.images).some(img => img.src === 'https://socialstream.ninja/icons/logo.svg' && img.naturalWidth > 0));
                await capture('LocalClear-QA ' + names[0]);
                await page.waitForFunction(() => !Array.from(document.images).some(img => img.src === 'https://socialstream.ninja/icons/logo.svg'));
                row.textMediaAndClear = true;
                console.log('PASS generated Flow Actions link with only ' + names[0]);
            }
            await setRoutes(['socketserver', 'server2', 'server3']);

            await main.locator('a[data-page="event-flow-editor"]').click();
            await background.waitForFunction(() => window.flowEditor, null, { polling: 100 });
            report.embeddedLocalMedia = await background.evaluate(async () => {
                const api = flowEditor.getLocalMediaApi();
                let status;
                try { status = api ? await api.status() : 'No local media bridge'; } catch (error) { status = error.message; }
                return { hasApi: !!api, session: flowEditor.getCurrentSessionId(), search: flowEditor.getCurrentFlowActionsSearch(), status };
            });
            assert.equal(report.embeddedLocalMedia.session, room, 'Embedded editor uses the active app session');
            assert.equal(report.embeddedLocalMedia.status.running, true, 'Media service remains independent of relay routing');
            if (process.env.SSAPP_LOCAL_MEDIA_WORKFLOWS === '1') {
                const fixtureImage = path.join(output, 'local-media.svg');
                fs.writeFileSync(fixtureImage, '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="orange"/></svg>');
                // Supply only the native picker result. File registration, IPC,
                // editor controls, persistence, HTTP serving and playback stay real.
                await app.evaluate(({ dialog }, fixtureImage) => {
                    const original = dialog.showOpenDialog;
                    dialog.showOpenDialog = async () => {
                        dialog.showOpenDialog = original;
                        return { canceled: false, filePaths: [fixtureImage] };
                    };
                }, fixtureImage);
                await background.evaluate(() => {
                    const node = { id: 'action', type: 'action', actionType: 'playTenorGiphy',
                        config: { sourceType: 'url', mediaUrl: '', mediaType: 'image', useLayer: true, duration: 0 } };
                    flowEditor.currentFlow = { id: 'local-file-flow', name: 'Local file capture', active: true,
                        nodes: [{ id: 'trigger', type: 'trigger', triggerType: 'messageContains', config: { text: 'LocalFile-QA ' } }, node],
                        connections: [{ from: 'trigger', to: 'action' }] };
                    flowEditor.showNodeProperties(node);
                    // Observe the copy request without replacing the user's OS clipboard.
                    navigator.clipboard.writeText = async text => { window.__copiedLocalFlowUrl = text; };
                });
                await background.locator('#chooseLocalMediaBtn').click();
                await background.waitForFunction(() => flowEditor.currentFlow.nodes[1].config.localAssetId, null, { polling: 100 });
                await background.evaluate(async () => eventFlowSystem.saveFlow(flowEditor.currentFlow));
                await background.locator('#copyLocalFlowActionsUrlBtn').click();
                await background.waitForFunction(() => window.__copiedLocalFlowUrl, null, { polling: 100 });
                const copied = await background.evaluate(() => window.__copiedLocalFlowUrl);
                report.copiedLocalMedia = { url: copied };
                const copiedUrl = new URL(copied);
                assert.equal(copiedUrl.searchParams.get('session'), room, 'Copied OBS link keeps the app session');
                assert.equal(copiedUrl.searchParams.get('localserverport'), String(port));
                assert(copiedUrl.searchParams.has('localserver'));
                const assetId = await background.evaluate(() => flowEditor.currentFlow.nodes[1].config.localAssetId);
                await page.goto(copied, { waitUntil: 'domcontentloaded' });
                await delay(1500);
                await capture('LocalFile-QA copied-obs-link');
                await page.waitForFunction(assetId => Array.from(document.images).some(img => img.src.includes('/media/' + assetId) && img.naturalWidth === 80), assetId);
                await capture('LocalClear-QA copied-obs-link');
                await page.waitForFunction(assetId => !Array.from(document.images).some(img => img.src.includes('/media/' + assetId)), assetId);
                report.copiedLocalMedia.capturedFilePlaybackAndClear = true;
                console.log('PASS embedded Local Media picker, copied OBS link, captured-chat file playback and clear');
            }

            const game = await createWindow('about:blank');
            const featured = await createWindow('about:blank');
            function trackJoins(target) {
                const state = { joins: 0, navigations: 0, endpoints: [], relayEndpoints: [] };
                target.on('framenavigated', frame => { if (frame === target.mainFrame()) state.navigations++; });
                target.on('websocket', socket => {
                    state.endpoints.push(socket.url());
                    socket.on('framesent', event => { try {
                        if (JSON.parse(event.payload).join === room) { state.joins++; state.relayEndpoints.push(socket.url()); }
                    } catch (_) {} });
                });
                return state;
            }
            const gameJoins = trackJoins(game), featuredJoins = trackJoins(featured), actionJoins = trackJoins(page);
            await popup.locator('#games-preset-select').selectOption('games/memoryparade.html', { force: true });
            await game.goto(await popup.evaluate(() => document.getElementById('games').raw), { waitUntil: 'domcontentloaded' });
            await featured.goto(`https://socialstream.ninja/themes/featured-styles/featured-modern.html?session=${room}&server2&localserver&localserverport=${port}`, { waitUntil: 'domcontentloaded' });
            await page.goto(await popup.evaluate(() => document.getElementById('flowactions').raw), { waitUntil: 'domcontentloaded' });
            async function waitForJoins(previous) {
                for (let n = 0; n < 150; n++) {
                    if ([gameJoins, featuredJoins, actionJoins].every((state, i) => state.joins > previous[i])) return;
                    await delay(100);
                }
                throw new Error('An existing page did not reconnect: ' + JSON.stringify({ gameJoins, featuredJoins, actionJoins }));
            }
            await waitForJoins([0, 0, 0]);
            for (let cycle = 1; cycle <= 3; cycle++) {
                const before = [gameJoins.joins, featuredJoins.joins, actionJoins.joins];
                for (const prefix of ['Stop Local Server', 'Enable Local Server']) {
                    await app.evaluate(({ Menu }, prefix) => {
                        function find(menu) {
                            for (const item of menu.items) {
                                if (item.label.startsWith(prefix)) return item;
                                if (item.submenu) { const result = find(item.submenu); if (result) return result; }
                            }
                        }
                        const item = find(Menu.getApplicationMenu());
                        if (!item) throw new Error('Missing local server menu command');
                        item.click(item);
                    }, prefix);
                    await delay(1200);
                }
                await waitForJoins(before);
                background = await findFrame('background');
                await background.waitForFunction(() => new URLSearchParams(location.search).has('localserver')
                    && window.ssappBackgroundLoadState?.status === 'ready' && socketserverDock?.readyState === 1,
                null, { polling: 100 });
                popup = await findFrame('popup');
                await capture('!ready', 'Reconnect Viewer ' + cycle);
                await game.waitForFunction(name => document.body.innerText.includes(name), 'Reconnect Viewer ' + cycle);
                await featured.waitForFunction(name => document.body.innerText.toLowerCase().includes(name), 'reconnect viewer ' + cycle);
                await capture('LocalFlow-QA reconnect-' + cycle);
                await page.getByText('Flow action LocalFlow-QA reconnect-' + cycle, { exact: true }).waitFor();
                await delay(500);
                assert.equal(await page.getByText('Flow action LocalFlow-QA reconnect-' + cycle, { exact: true }).count(), 1);
                console.log('PASS existing game, featured template and action page reconnect ' + cycle);
            }
            assert.equal(await game.locator('#participants').textContent(), '3', 'Game state survives every reconnect');
            report.existingPageReconnects = { cycles: 3, gameJoins, featuredJoins, actionJoins, gameStatePreserved: true };
            for (const state of [gameJoins, featuredJoins, actionJoins]) {
                assert.equal(state.navigations, 1, 'Reconnecting does not reload the page');
                assert(state.relayEndpoints.every(url => url === `ws://127.0.0.1:${port}/` || url === `ws://127.0.0.1:${port}`), JSON.stringify(state));
            }
            publisher.terminate();
            publisher = new WebSocket(`ws://127.0.0.1:${port}`);
            await new Promise((resolve, reject) => { publisher.once('open', resolve); publisher.once('error', reject); });
            publisher.send(JSON.stringify({ join: room, out: 1, in: 2 }));
            assert.deepEqual(errors, [], 'Routing workflows produce no page errors');
        }

        if (process.env.SSAPP_LOCAL_PORT_CONFLICT === '1') {
            async function localMenu(prefix) {
                return app.evaluate(({ Menu }, prefix) => {
                    function find(menu) {
                        for (const item of menu.items) {
                            if (item.label.startsWith(prefix)) return item;
                            if (item.submenu) { const result = find(item.submenu); if (result) return result; }
                        }
                    }
                    const item = find(Menu.getApplicationMenu());
                    if (!item) throw new Error('Missing menu item: ' + prefix);
                    void item.click(item);
                }, prefix);
            }
            report.portConflicts = [];
            for (const initiallyRunning of [true, false]) {
                const blocker = net.createServer(socket => socket.destroy());
                await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
                try {
                    port = blocker.address().port;
                    if (!initiallyRunning) await localMenu('Stop Local Server');
                    const promptWindow = app.waitForEvent('window');
                    await localMenu('Set Local Server Port');
                    const prompt = await promptWindow;
                    await prompt.locator('input').fill(String(port));
                    await prompt.locator('#ok').click();
                    // The Save button closes its window before the menu's async
                    // handler has finished updating the selected port.
                    await delay(750);
                    if (!initiallyRunning) await localMenu('Enable Local Server');
                    await delay(2500);
                    background = await findFrame('background');
                    await background.waitForFunction(() => !new URLSearchParams(location.search).has('localserver')
                        && window.ssappBackgroundLoadState?.status === 'ready'
                        && eventFlowSystem.flows.some(flow => flow.id === 'local-active-flow' && flow.active), null, { polling: 100 });
                    const stableUrl = background.url();
                    const documentStartedAt = await background.evaluate(() => performance.timeOrigin);
                    assert.equal(new URL(stableUrl).origin, new URL(report.background.url).origin);
                    await delay(16000);
                    assert.equal(background.url(), stableUrl, 'A port conflict does not cause a delayed reload loop');
                    assert.equal(await background.evaluate(() => performance.timeOrigin), documentStartedAt, 'Background does not silently reload the same URL');
                } finally {
                    await new Promise(resolve => blocker.close(resolve));
                }
                await localMenu('Enable Local Server');
                background = await findFrame('background');
                await background.waitForFunction(port => new URLSearchParams(location.search).get('localserverport') === String(port)
                    && new URLSearchParams(location.search).has('localserver') && window.ssappBackgroundLoadState?.status === 'ready'
                    && socketserverDock?.readyState === 1, port, { polling: 100 });
                popup = await findFrame('popup');
                await checkFlowAction('recovered-port-' + initiallyRunning);
                report.portConflicts.push({ initiallyRunning, port, flowPreserved: true, recoveredCapturedAction: true });
                console.log('PASS occupied port, stable saved flows and recovery; initially running=' + initiallyRunning);
            }
        }

        if (process.env.SSAPP_LOCAL_LIFECYCLE === '1') {
            async function menuCommand(prefix) {
                await app.evaluate(({ Menu }, prefix) => {
                    function find(menu) {
                        for (const item of menu.items) {
                            if (item.label.startsWith(prefix)) return item;
                            if (item.submenu) { const found = find(item.submenu); if (found) return found; }
                        }
                    }
                    const item = find(Menu.getApplicationMenu());
                    if (!item) throw new Error('Missing menu command: ' + prefix);
                    void item.click(item);
                }, prefix);
            }
            async function readyAndFlow() {
                background = await findFrame('background');
                // Startup briefly creates a bundled background before selecting
                // the saved HTTPS origin. Wait for that document and its saved
                // flows together, instead of reading the outgoing frame.
                await background.waitForFunction(origin => location.origin === origin
                    && window.ssappBackgroundLoadState?.status === 'ready' && window.eventFlowSystem?.db
                    && eventFlowSystem.flows.some(flow => flow.id === 'local-relay-flow')
                    && eventFlowSystem.flows.find(flow => flow.id === 'local-active-flow')?.active
                    && eventFlowSystem.flows.find(flow => flow.id === 'local-inactive-flow')?.active === false,
                new URL(report.background.url).origin, { timeout: 60000 });
                popup = await findFrame('popup');
                await popup.waitForFunction(() => document.getElementById('games')?.raw?.includes('session='));
            }
            const originalUrl = await main.evaluate(() => document.getElementById('frame2').src);
            await background.evaluate(async () => eventFlowSystem.saveFlow({ id: 'local-relay-flow', name: 'Keep across relay changes', active: false, nodes: [], connections: [] }));
            await app.evaluate(() => { global.__outage.phase = 'partial'; });
            await menuCommand('Stop Local Server');
            await delay(8000);
            const afterUrl = await main.evaluate(() => document.getElementById('frame2').src);
            report.localToggleOutage = { originalUrl, afterUrl };
            assert.equal(new URL(afterUrl).origin, new URL(originalUrl).origin, 'A local server toggle must not select a different Event Flow database');
            background = await findFrame('background');
            await background.waitForFunction(() => window.ssappBackgroundLoadState?.status === 'failed');
            await main.locator('[data-page="event-flow-editor"]').click();
            await app.evaluate(() => { global.__outage.phase = 'online'; });
            await main.locator('#background-load-retry').click();
            await readyAndFlow();
            for (let cycle = 0; cycle < 2; cycle++) {
                await menuCommand('Enable Local Server');
                await delay(1500);
                await readyAndFlow();
                await menuCommand('Stop Local Server');
                await delay(1500);
                await readyAndFlow();
            }
            // Change the port with the real File-menu dialog while stopped.
            port = await freePort();
            const promptWindow = app.waitForEvent('window');
            await menuCommand('Set Local Server Port');
            const prompt = await promptWindow;
            await prompt.locator('input').fill(String(port));
            await prompt.locator('#ok').click();
            await menuCommand('Enable Local Server');
            await delay(1500);
            await readyAndFlow();
            // Also change it while running, exercising restart without a stop notification.
            port = await freePort();
            const runningPromptWindow = app.waitForEvent('window');
            await menuCommand('Set Local Server Port');
            const runningPrompt = await runningPromptWindow;
            await runningPrompt.locator('input').fill(String(port));
            await runningPrompt.locator('#ok').click();
            await delay(1500);
            await readyAndFlow();
            await popup.locator('#games-preset-select').selectOption('games/memoryparade.html', { force: true });
            const generated = await popup.evaluate(() => document.getElementById('games').raw);
            assert.equal(new URL(generated).searchParams.get('localserverport'), String(port));
            await page.goto(generated, { waitUntil: 'domcontentloaded' });
            await delay(1500);
            await capture('!ready', 'After Port Change');
            await page.waitForFunction(() => document.body.innerText.includes('After Port Change'));
            const stableUrl = background.url();
            await delay(20000);
            assert.equal(background.url(), stableUrl, 'No delayed navigation after the old 15-second timeout');
            await readyAndFlow();
            report.lifecycle = { cycles: 2, stoppedAndRunningPortChange: port, flowPersisted: true, chatAfterPortChange: true, stableAfter20Seconds: true };
            await checkFlowAction('after-port-change');
            // Restart the actual application with the same isolated profile and
            // no CLI port override; the File-menu choice must survive on disk.
            publisher.terminate();
            await app.close();
            app = await launch(false);
            main = await app.firstWindow();
            main.setDefaultTimeout(30000);
            await main.waitForFunction(() => document.getElementById('frame2')?.src.startsWith('https:'));
            await readyAndFlow();
            const restartUrl = new URL(background.url());
            assert(restartUrl.searchParams.has('localserver'));
            assert.equal(restartUrl.searchParams.get('localserverport'), String(port));
            source = await createWindow(sourceUrl, { sourceFiles: ['sources/youtube.js'] });
            await source.waitForLoadState('domcontentloaded');
            await delay(4500);
            page = await createWindow('about:blank');
            page.setDefaultTimeout(8000);
            page.on('pageerror', error => errors.push(error.message));
            await checkFlowAction('after-app-restart');
            report.lifecycle.appRestart = { savedPort: port, activeFlowRenderedOnce: true, inactiveFlowStayedOff: true };
            publisher = new WebSocket(`ws://127.0.0.1:${port}`);
            await new Promise((resolve, reject) => { publisher.once('open', resolve); publisher.once('error', reject); });
            publisher.send(JSON.stringify({ join: room, out: 1, in: 2 }));
            console.log('PASS relay toggles, retry, flow persistence and stopped/running port changes');
        }

        if (process.env.SSAPP_LOCAL_PAGE_SWEEP === '1') {
            const site = path.resolve(root, '../social_stream');
            const files = [];
            function collect(dir) {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const file = path.join(dir, entry.name);
                    if (entry.isDirectory()) collect(file);
                    else if (entry.name.endsWith('.html')) files.push(file);
                }
            }
            for (const entry of fs.readdirSync(site)) if (entry.endsWith('.html')) files.push(path.join(site, entry));
            collect(path.join(site, 'games'));
            collect(path.join(site, 'themes'));
            const sockets = [];
            page.on('websocket', socket => {
                const record = { url: socket.url(), joins: [], messages: 0 };
                sockets.push(record);
                socket.on('framesent', event => { try { const data = JSON.parse(event.payload); if (data.join) record.joins.push(data); } catch (_) {} });
                socket.on('framereceived', event => { if (String(event.payload).includes('LocalPageSurvey')) record.messages++; });
            });
            report.sweep = [];
            for (const file of files.sort()) {
                const html = fs.readFileSync(file, 'utf8');
                if (!/new WebSocket|connectLocalRelay|audience-page\.js|ambient-page\.js|quickcall\.js|multi-alerts\.js|shared\/monetization\/overlay\.js/.test(html)) continue;
                const relative = path.relative(site, file).replace(/\\/g, '/');
                if (['background.html', 'popup.html'].includes(relative)) continue;
                if (process.env.SSAPP_LOCAL_SWEEP_FILTER && !new RegExp(process.env.SSAPP_LOCAL_SWEEP_FILTER).test(relative)) continue;
                if (['waitlist.html', 'input.html'].includes(relative)) {
                    report.sweep.push({ page: relative, separateTransport: relative === 'waitlist.html' ? 'Legacy WebRTC waitlist protocol (not advertised as relay-capable)' : 'User-specified external source WebSocket' });
                    continue;
                }
                sockets.length = 0;
                errors.length = 0;
                const url = `https://socialstream.ninja/${relative}?session=${room}&sessionId=${room}&server&server2&server3&localserver&localserverport=${port}`;
                const row = { page: relative };
                try {
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
                    if (relative === 'simple_api_client.html') {
                        await page.locator('#sessionID').fill(room);
                        await page.getByRole('button', { name: 'Connect', exact: true }).click();
                    }
                    if (relative === 'createtestmessage.html') {
                        await page.locator('#payload').fill(JSON.stringify({ type: 'youtube', chatname: 'LocalPageSurvey', chatmessage: 'LocalPageSurvey test tool', textonly: true }));
                        await page.locator('button[onclick="submitData()" ]').click();
                    }
                    for (let attempt = 0; attempt < 50 && !sockets.some(socket => socket.joins.length); attempt++) await delay(200);
                    const channels = new Set(sockets.flatMap(socket => socket.joins.map(join => join.in)));
                    // Shop uses the relay's path-based join syntax.
                    if (relative === 'shop_the_stream.html') channels.add(1);
                    for (const out of channels) publisher.send(JSON.stringify({ out, id: 'survey-' + relative, type: 'youtube',
                        chatname: 'LocalPageSurvey', chatmessage: '!join', textonly: true }));
                    await delay(300);
                    if (relative.startsWith('themes/featured-styles/') || relative.includes('LuckyLootTube')) {
                        await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('localpagesurvey'));
                        row.rendered = true;
                        if (relative.endsWith('featured-modern.html') || relative.includes('LuckyLootTube')) {
                            let captureUrl = new URL(url);
                            captureUrl.searchParams.delete('server');
                            captureUrl.searchParams.delete('server3');
                            if (relative.includes('LuckyLootTube')) {
                                await popup.locator('#overlay-preset-select').selectOption(relative, { force: true });
                                const generated = await popup.evaluate(() => document.getElementById('chatoverlaytemplate').raw);
                                captureUrl = new URL(generated);
                                assert.equal(captureUrl.searchParams.get('localserverport'), String(port));
                                assert(captureUrl.searchParams.has('server2'));
                                row.generated = generated;
                            }
                            await page.goto(captureUrl.href, { waitUntil: 'domcontentloaded' });
                            await delay(1200);
                            await capture('Template capture verified', 'LocalPageSurvey');
                            await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('template capture verified'));
                            row.capturedChatRendered = true;
                        }
                    }
                    row.sockets = JSON.parse(JSON.stringify(sockets));
                    row.received = sockets.some(socket => socket.messages > 0);
                    row.errors = errors.slice();
                } catch (error) { row.error = error.message; }
                report.sweep.push(row);
                console.log('SURVEY ' + relative + ' ' + (row.received && !row.errors?.length ? 'PASS' : JSON.stringify(row)));
                fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
            }
            const failures = report.sweep.filter(row => !row.separateTransport && (row.error || !row.received || row.errors.length || row.sockets.some(socket => !socket.url.startsWith(`ws://127.0.0.1:${port}`))));
            assert.deepEqual(failures, [], 'Every relay-capable page must connect locally and receive its channel');
            await page.goto(`https://socialstream.ninja/themes/featured-styles/featured-modern.html?session=${room}&server2`, { waitUntil: 'domcontentloaded' });
            assert.equal(await page.locator('iframe').count(), 1, 'Hosted legacy template still uses its existing bridge');
        }
        if (!process.env.SSAPP_LOCAL_REVIEW_BASELINE) {
            for (const row of report.cases) {
                assert(row.localFlagRetained && row.portRetained, row.game + ': generated connection settings');
                assert(row.received, row.game + ': chat reaches game through the app local server');
                assert.deepEqual(row.errors, [], row.game + ': no page runtime errors');
            }
        }
    } finally {
        if (publisher) publisher.terminate();
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
        console.log('Evidence: ' + output);
        await app.close();
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
