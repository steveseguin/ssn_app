'use strict';

// Real SSApp settings/background/dock and profile persistence, with a local
// NinjaChatter protocol fixture. Does not sign in or post to a production room.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { WebSocketServer, WebSocket } = require('ws');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const appRoot = path.resolve(__dirname, '../..');
const sourceRoot = path.resolve(appRoot, '../social_stream');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-ninjachatter-e2e-'));
const room = 'ssapp-local-audience-room';
const credential = 'local-fixture-credential';
const secondaryRoom = 'ssapp-local-secondary-room';
const secondaryCredential = 'local-fixture-secondary-credential';
const roomCredentials = new Map([[room, credential], [secondaryRoom, secondaryCredential]]);
let pairingRoom = room;
const clients = new Set();
const deliveries = [];
let approved = false;
let pairRequests = 0;
let sessions = 0;
let app;
let popup;
let background;
let dock;
let dockCdp;
let relayPort;
let relayObserver;
fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
    streamID: 'ninjachatter_local_e2e', password: 'false', state: true,
    wsServer: true, settings: { server2: { setting: true } }
}));

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.end();
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    let result;
    if (req.url === '/community/pair') {
        pairRequests++;
        result = { code: 'LOCAL123', polling_secret: 'local-poll-secret' };
    } else if (req.url === '/community/pair/LOCAL123') {
        assert.equal(body.polling_secret, 'local-poll-secret');
        result = approved ? { credential: roomCredentials.get(pairingRoom), room: pairingRoom } : {};
    } else if (/^\/community\/rooms\/[^/]+\/session$/.test(req.url)) {
        const requestedRoom = req.url.split('/')[3];
        assert.ok(roomCredentials.has(requestedRoom));
        assert.equal(req.headers.authorization, `Bearer ${roomCredentials.get(requestedRoom)}`);
        sessions++;
        result = { token: 'local-session-token' };
    } else {
        res.statusCode = 404;
        result = {};
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', (ws, req) => {
    assert.ok([...roomCredentials.keys()].some(id => req.url === `/community/rooms/${id}/socket`));
    ws.on('message', raw => {
        if (raw.toString() === 'local-session-token') {
            clients.add(ws);
            ws.send(JSON.stringify({ type: 'community_ready', requests: [] }));
        }
    });
    ws.on('close', () => clients.delete(ws));
});

async function until(check, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`Timed out: ${label}`);
}

async function status() {
    let result;
    // SSApp can reload its background while restoring the saved session.
    await until(async () => {
        try {
            result = await popup.evaluate(() => ipcRenderer.invoke('ninjachatter:audience-room', {
                op: 'command', command: { op: 'status' }
            }));
            return true;
        } catch (_) { return false; }
    }, 'audience status after background startup');
    return result;
}

async function click(op) {
    const button = popup.locator(`[data-nc-op="${op}"]`);
    await button.waitFor({ state: 'visible' });
    await until(() => button.isEnabled(), `${op} control enabled`);
    await button.focus();
    await button.press('Enter');
}

async function launch(api, withDock = true) {
    app = await _electron.launch({
        executablePath: require('electron'),
        cwd: appRoot,
        args: ['.', '--multiinstance', '--preferlocalassets',
            `--filesource=${sourceRoot.replace(/\\/g, '/')}/`,
            `--ssapp-local-server-port=${relayPort}`,
            '--host-rules=MAP api.ninjachatter.com ~NOTFOUND', ...linuxLaunchArgs()],
        env: { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_DIAGNOSTICS_SAFE_GPU: '1', SSAPP_DEBUG_LOGS: '0' },
        timeout: 60000
    });
    // Only substitute the service address. The connector, storage, IPC, UI,
    // delivery path and dock all run their actual application code.
    await app.context().addInitScript(origin => {
        let original;
        Object.defineProperty(window, 'NCAudienceConnector', {
            configurable: true,
            get() { return original; },
            set(Connector) {
                original = function(options) { return new Connector(Object.assign({}, options, { api: origin })); };
                original.prototype = Connector.prototype;
            }
        });
    }, api);
    const main = await app.firstWindow();
    await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady);
    await main.reload();
    await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady);
    await main.evaluate(() => ensurePopupPanelLoaded(true));
    await until(() => {
        popup = main.frames().find(f => /\/popup\.html/.test(f.url()));
        background = main.frames().find(f => /\/background\.html/.test(f.url()));
        return popup && background;
    }, 'settings and background frames');
    await background.waitForFunction(() => window.ncAudience && typeof setupSocketDock === 'function', null, { timeout: 60000 });
    await popup.waitForFunction(() => !!document.querySelector('[data-nc-op="pair"]')?.onclick);
    if (await main.locator('#popup-handle').getAttribute('aria-expanded') === 'false') {
        await main.locator('#popup-handle').click();
    }
    if (!await popup.locator('#wrapper-audience-room-options').isChecked()) {
        await popup.locator('label[for="wrapper-audience-room-options"]').click();
    }
    await status();
    if (!withDock) return;
    await background.waitForFunction(() => socketserverDock && socketserverDock.readyState === 1);
    relayObserver = new WebSocket(`ws://127.0.0.1:${relayPort}`);
    relayObserver.on('message', raw => deliveries.push(JSON.parse(raw)));
    await new Promise((resolve, reject) => {
        relayObserver.once('error', reject);
        relayObserver.once('open', () => {
            relayObserver.send(JSON.stringify({ join: 'ninjachatter_local_e2e', out: 3, in: 4 }));
            resolve();
        });
    });
    const dockUrl = pathToFileURL(path.join(sourceRoot, 'dock.html'));
    dockUrl.searchParams.set('session', 'ninjachatter_local_e2e');
    dockUrl.searchParams.set('password', 'false');
    dockUrl.searchParams.set('server2', '');
    dockUrl.searchParams.set('localserver', '');
    dockUrl.searchParams.set('localserverport', relayPort);
    const dockEvent = app.waitForEvent('window');
    await main.evaluate(url => window.open(url), dockUrl.href);
    dock = await dockEvent;
    dockCdp = await app.context().newCDPSession(dock);
    await until(async () => {
        const result = await dockCdp.send('Runtime.evaluate', {
            expression: 'typeof socketserverExtension !== "undefined" && socketserverExtension.readyState === 1', returnByValue: true
        });
        return result.result.value;
    }, 'dock relay connection');
}

async function message(id, text) {
    for (const ws of clients) ws.send(JSON.stringify({ type: 'audience_chat', id, name: 'Local viewer', text, provider: 'guest' }));
    await dock.getByText(text, { exact: true }).first().waitFor();
    await until(() => deliveries.some(d => d.id === id), 'dock transport');
}

async function testConnectorStartup() {
    const main = await app.firstWindow();
    const errors = [];
    const onError = error => errors.push(error.message);
    main.on('pageerror', onError);
    await background.evaluate(() => {
        window.audienceStartupTestConnector = window.ncAudience;
        delete window.ncAudience;
    });
    try {
        for (const op of ['status', 'pair']) {
            const error = await popup.evaluate(async op => {
                try {
                    await ipcRenderer.invoke('ninjachatter:audience-room', { op: 'command', command: { op } });
                    return '';
                } catch (error) { return error.message; }
            }, op);
            assert.match(error, /Audience room is still starting/, `${op} must report startup without executing a command`);
        }
        assert.equal(pairRequests, 0, 'an early pairing command must not be sent or queued');
        assert.deepEqual(errors, [], 'startup polling must not throw inside the background renderer');
    } finally {
        await background.evaluate(() => {
            window.ncAudience = window.audienceStartupTestConnector;
            delete window.audienceStartupTestConnector;
        });
        main.off('pageerror', onError);
    }
    assert.equal((await status()).state, 'disconnected', 'status recovers once the connector is ready');
    assert.equal(pairRequests, 0, 'recovering readiness must not replay an early pairing command');
    console.log('Audience startup polling and command rejection recover without renderer errors or replay.');
}

async function switchSession(api, sessionId, withDock) {
    // Let the real switch handler save and exit; Playwright owns the relaunch
    // so the next process retains the local service fixture and isolated profile.
    await app.evaluate(({ app }) => { app.relaunch = () => {}; });
    const child = app.process();
    const main = await app.firstWindow();
    await main.evaluate(id => require('electron').ipcRenderer.invoke('switchSession', id), sessionId).catch(() => {});
    await until(() => child.exitCode !== null, 'session switch exit');
    await launch(api, withDock);
}

async function run() {
    const portServer = net.createServer();
    await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
    relayPort = portServer.address().port;
    await new Promise(resolve => portServer.close(resolve));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const api = `http://127.0.0.1:${server.address().port}`;
    try {
        await launch(api);
        console.log('App settings and Dock ready.');
        await testConnectorStartup();
        assert.equal((await status()).paired, false);
        await click('pair');
        await until(async () => (await status()).code === 'LOCAL123', 'pairing code');
        assert.equal(await popup.locator('[data-nc-code]').inputValue(), 'LOCAL123');
        assert.equal(pairRequests, 1, 'pairing must not be retried by the generic popup timeout');
        approved = true;
        await until(async () => (await status()).state === 'connected', 'approved connection');
        console.log('Paired through settings UI.');
        await message('first', 'Audience message before restart');
        await dock.screenshot({ path: path.join(profile, 'audience-dock.png') });
        await message('first', 'Audience message before restart');
        await message('following', 'Second distinct audience message');
        assert.equal(deliveries.filter(d => d.id === 'first').length, 1);
        assert.equal(await dock.getByText('Audience message before restart', { exact: true }).count(), 1);
        assert.equal((await status()).credential, undefined);
        assert.ok(!fs.readFileSync(path.join(profile, 'config.json'), 'utf8').includes(credential));
        assert.ok(fs.readFileSync(path.join(profile, 'ninjachatter-audience.json'), 'utf8').includes(credential));
        for (const ws of clients) ws.close();
        await until(() => sessions >= 2 && clients.size === 1, 'automatic reconnect');
        await message('reconnected', 'Audience message after reconnect');
        console.log('Incoming chat, deduplication and reconnect passed.');
        await app.close();
        await launch(api);
        await until(async () => (await status()).state === 'connected', 'restart recovery');
        assert.equal(pairRequests, 1);
        await message('restarted', 'Audience message after app restart');
        console.log('Restart recovery passed.');
        await click('pause');
        await until(async () => (await status()).state === 'paused', 'pause');
        await popup.locator('[data-nc-sources]').fill('youtube, twitch');
        await click('save');
        await until(async () => (await status()).sources.length === 2, 'save options while paused');
        await app.close();
        await launch(api);
        assert.equal((await status()).state, 'paused');
        assert.equal(clients.size, 0);
        assert.deepEqual((await status()).sources, ['youtube', 'twitch']);
        await click('resume');
        await until(async () => (await status()).state === 'connected', 'resume');
        await message('resumed', 'Audience message after resume');

        const secondaryId = 'audience-secondary';
        let main = await app.firstWindow();
        const created = await main.evaluate(id => require('electron').ipcRenderer.invoke('createSession', {
            id, name: 'Audience secondary session'
        }), secondaryId);
        assert.equal(created.success, true);
        await switchSession(api, secondaryId, false);
        assert.equal((await status()).paired, false, 'a new User Session must not inherit the default room');
        assert.deepEqual((await status()).sources, []);
        pairingRoom = secondaryRoom;
        await click('pair');
        await until(async () => (await status()).state === 'connected', 'secondary room pairing');
        assert.equal((await status()).room, secondaryRoom);
        await popup.locator('[data-nc-sources]').fill('discord');
        await click('save');
        await until(async () => (await status()).sources[0] === 'discord', 'secondary source options');
        await click('pause');
        await until(async () => (await status()).state === 'paused', 'secondary pause');

        await switchSession(api, 'default', true);
        await until(async () => (await status()).state === 'connected', 'return to default room');
        assert.equal((await status()).room, room);
        assert.deepEqual((await status()).sources, ['youtube', 'twitch']);
        await message('session-return', 'Original room after switching User Sessions');
        await switchSession(api, secondaryId, false);
        assert.equal((await status()).state, 'paused');
        assert.equal((await status()).room, secondaryRoom);
        assert.deepEqual((await status()).sources, ['discord']);
        await click('disconnect');
        await until(async () => !(await status()).paired, 'secondary disconnect');

        await switchSession(api, 'default', true);
        await until(async () => (await status()).state === 'connected', 'default survives secondary disconnect');
        assert.equal((await status()).room, room);
        const privateFile = path.join(profile, 'ninjachatter-audience.json');
        assert.ok(fs.readFileSync(privateFile, 'utf8').includes('userSessionData'));
        main = await app.firstWindow();
        const deleted = await main.evaluate(id => require('electron').ipcRenderer.invoke('deleteSession', id), secondaryId);
        assert.equal(deleted.success, true);
        const privateConfig = JSON.parse(fs.readFileSync(privateFile, 'utf8'));
        assert.equal(privateConfig.connection.credential, credential);
        assert.ok(Object.values(privateConfig.userSessionData || {}).every(data => !data.connection));
        console.log('User Session pairing/options/pause isolation, independent disconnect, and deletion cleanup passed.');

        await click('disconnect');
        await until(async () => !(await status()).paired, 'disconnect');
        assert.ok(!fs.readFileSync(path.join(profile, 'ninjachatter-audience.json'), 'utf8').includes(credential));
        await app.close();
        await launch(api);
        assert.equal((await status()).paired, false);
        assert.equal(clients.size, 0);
        console.log('PASS: SSApp pairing, chat display, deduplication, reconnect, restart, pause/save/resume, disconnect, private persistence, User Session isolation.');
        console.log(`Isolated profile: ${profile}`);
    } finally {
        if (app) await app.close().catch(() => {});
        if (relayObserver) relayObserver.terminate();
        for (const ws of sockets.clients) ws.terminate();
        await new Promise(resolve => sockets.close(resolve));
        await new Promise(resolve => server.close(resolve));
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
