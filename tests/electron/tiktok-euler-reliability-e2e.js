'use strict';

// Real Electron UI/IPC, installed connector, HTTP signing requests and captured
// protobuf chat. Only remote room/gift lookups are replaced. No real API keys.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const WebSocket = require('ws');
const connector = require('tiktok-live-connector');
const { chatFrame, freePort, waitFor } = require('./tiktok-disconnect-validation-e2e');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const root = path.resolve(__dirname, '../..');

async function run() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-euler-e2e-'));
    const scenarios = new Map();
    const sockets = new Set();
    const received = [];
    const evidence = [];
    let app, page, relay, sendTimer;
    let messageId = 60000;
    const chatServer = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 });
    const signServer = http.createServer((request, response) => {
        const roomId = new URL(request.url, 'http://fixture').pathname.split('/')[3];
        const scenario = scenarios.get(roomId);
        assert.ok(scenario, `Unexpected signing room: ${roomId}`);
        const record = { at: Date.now(), key: request.headers['x-api-key'] || null, closedAt: null };
        scenario.requests.push(record);
        response.on('close', () => { record.closedAt = Date.now(); });
        if (scenario.mode === 'stall') return;
        if (scenario.mode === 'rate') {
            response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
            response.end(JSON.stringify({ message: 'Rate limit', limit_label: 'rate_limit_room_id_hour' }));
            return;
        }
        const body = Object.assign(connector.ProtoMessageFetchResult.decode(Buffer.alloc(0)), {
            messages: [], cursor: 'fixture-cursor', internalExt: '', routeParams: {},
            pushServer: `ws://127.0.0.1:${chatServer.address().port}/`,
        });
        response.writeHead(200, {
            'Content-Type': 'application/octet-stream', 'x-set-tt-cookie': 'ttwid=fixture; Path=/', 'x-room-id': roomId,
        });
        response.end(Buffer.from(connector.ProtoMessageFetchResult.encode(body).finish()));
    });
    let proxyMode = 'ok';
    const proxyRequests = [];
    const proxyServer = http.createServer();
    const proxyWs = new WebSocket.WebSocketServer({ noServer: true });
    proxyServer.on('upgrade', (request, socket, head) => {
        const record = { at: Date.now(), key: new URL(request.url, 'http://fixture').searchParams.get('apiKey'), closedAt: null };
        proxyRequests.push(record);
        socket.on('close', () => { record.closedAt = Date.now(); });
        if (proxyMode === 'stall') {
            // Consume EOF so the fixture observes the client's aborted socket.
            // HTTP upgrade sockets allow half-open connections on the server.
            socket.on('end', () => { record.closedAt = Date.now(); socket.end(); });
            socket.resume();
            return;
        }
        proxyWs.handleUpgrade(request, socket, head, ws => proxyWs.emit('connection', ws, request));
    });
    for (const server of [signServer, proxyServer]) server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    function record(name, details) {
        evidence.push({ name, ...details });
        fs.writeFileSync(path.join(profile, 'results.json'), JSON.stringify(evidence, null, 2));
        console.log('[euler-e2e] ' + name + ': ' + JSON.stringify(details));
    }
    try {
        await new Promise(resolve => chatServer.once('listening', resolve));
        await new Promise(resolve => signServer.listen(0, '127.0.0.1', resolve));
        await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
        sendTimer = setInterval(() => {
            for (const socket of chatServer.clients) if (socket.readyState === WebSocket.OPEN) socket.send(chatFrame(++messageId));
        }, 500);
        const relayPort = await freePort();
        const room = 'euler_e2e_' + Date.now();
        fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
            streamID: room, password: 'false', state: true, settings: { server2: { setting: true } }, wsServer: true,
        }));
        app = await _electron.launch({
            executablePath: require('electron'), cwd: root,
            args: ['.', '--running-from-source', '--multiinstance',
                '--filesource=' + pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href,
                '--ssapp-local-server-port=' + relayPort, ...linuxLaunchArgs()],
            env: { ...process.env, SSAPP_USER_DATA_DIR: profile,
                SIGN_API_URL: `http://127.0.0.1:${signServer.address().port}`, SIGN_API_KEY: '',
                EULER_WS_URL: `ws://127.0.0.1:${proxyServer.address().port}` },
            timeout: 60000,
        });
        page = await app.firstWindow();
        await page.waitForFunction(() => window.stateManager?.initialized && configReady);
        await page.waitForTimeout(6000);
        await app.evaluate((_, root) => {
            const req = process.getBuiltinModule('module').createRequire(root + '/package.json');
            const c = req('tiktok-live-connector');
            const { ConnectionManager } = req('./tiktok/connection-manager').__test;
            global.__eulerTest = { managers: [], errors: [], rooms: {} };
            c.RouteConfig.fetchRoomIdComposite = async ({ uniqueId }) => global.__eulerTest.rooms[uniqueId];
            const init = ConnectionManager.prototype.initializeConnectionInstance;
            ConnectionManager.prototype.initializeConnectionInstance = function (...args) {
                const result = init.apply(this, args);
                if (!global.__eulerTest.managers.includes(this)) global.__eulerTest.managers.push(this);
                this.connection.on('error', event => {
                    const error = event?.exception || event;
                    global.__eulerTest.errors.push({ username: this.username, name: error?.name,
                        message: error?.message, retryAfterSeconds: this.getRetryAfterSeconds(error) });
                });
                if (this.signingProvider !== 'euler-ws') {
                    this.connection.fetchRoomInfo = async () => ({ data: { status: 2 } });
                    this.connection.fetchAvailableGifts = async () => [];
                }
                return result;
            };
        }, root);
        relay = new WebSocket(`ws://127.0.0.1:${relayPort}`);
        await new Promise((resolve, reject) => { relay.once('open', resolve); relay.once('error', reject); });
        relay.send(JSON.stringify({ join: room, out: 3, in: 4 }));
        relay.on('message', raw => {
            try {
                const message = JSON.parse(raw);
                if (message.type === 'tiktok' && String(message.chatmessage).startsWith('disconnect fixture')) received.push(message);
            } catch (_) { }
        });
        async function add(name, preset = 'custom', mode = 'ok') {
            const roomId = String(123456 + scenarios.size);
            const scenario = { name, roomId, mode, requests: [] };
            scenarios.set(roomId, scenario);
            await app.evaluate((_, s) => { global.__eulerTest.rooms[s.name] = s.roomId; }, scenario);
            scenario.id = await page.evaluate(name => stateManager.addSource({
                target: 'tiktok', username: name, url: `https://www.tiktok.com/@${name}/live`, autoActivate: false,
                connectionMode: 'tiktok-websocket', tiktokSigningProvider: 'auto', disableTikTokAutoFallback: true,
            }), name);
            await page.locator(`[data-source-id="${scenario.id}"] .tiktok-connection-select`).selectOption(preset);
            return scenario;
        }
        async function setKey(s, key) {
            await page.evaluate(id => showTikTokSignInMenu(id), s.id);
            await page.locator(`[id="tiktok-signing-api-key-${s.id}"]`).fill(key);
            await page.locator(`button[onclick="saveTikTokSigningConfig('${s.id}')"]`).click();
            await page.evaluate(() => closeModal());
        }
        async function start(s) {
            await page.locator(`[data-source-id="${s.id}"] [data-activatehtml]`).press('Enter');
        }
        async function manager(s) {
            return app.evaluate((_, name) => {
                const m = global.__eulerTest.managers.filter(m => m.username === name).at(-1);
                return m && { stopped: m.isStopped, pending: !!m.activeConnectPromise, retry: !!m.reconnectTimer,
                    connected: !!m.connection?.isConnected, rateCount: m.tiktokRateLimitCount,
                    timeout: m.connection?.apiClient?.configuration?.baseOptions?.timeout };
            }, s.name);
        }
        async function stop(s) {
            await page.locator(`[data-source-id="${s.id}"] [data-activatehtml]`).press('Enter');
            await waitFor(async () => (await manager(s))?.stopped, s.name + ' backend stopped');
            assert.strictEqual(await page.evaluate(id => stateManager.getSource(id).status, s.id), 'inactive');
        }
        async function captured(s) {
            const startIndex = received.length;
            await waitFor(async () => {
                const tid = await page.evaluate(id => stateManager.getSource(id).vid, s.id);
                return tid && received.slice(startIndex).some(m => m.tid === tid);
            }, s.name + ' captured chat at relay');
        }
        if (!process.argv.includes('--proxy-only')) {
            const first = await add('euler_first', 'auto');
            await start(first); await captured(first);
            assert.strictEqual(first.requests.at(-1).key, null);
            await stop(first);
            await setKey(first, 'synthetic-A'); await start(first); await captured(first);
            assert.strictEqual(first.requests.at(-1).key, 'synthetic-A');
            await stop(first);
            await setKey(first, 'synthetic-B'); await start(first); await captured(first);
            assert.strictEqual(first.requests.at(-1).key, 'synthetic-B');
            const second = await add('euler_second');
            await setKey(second, 'synthetic-C'); await start(second); await captured(second);
            assert.strictEqual(second.requests.at(-1).key, 'synthetic-C');
            const beforeReconnect = first.requests.length;
            for (const socket of chatServer.clients) socket.close(1012, 'fixture reconnect');
            await waitFor(() => first.requests.length > beforeReconnect && second.requests.length > 1, 'independent reconnects');
            assert.strictEqual(first.requests.at(-1).key, 'synthetic-B');
            assert.strictEqual(second.requests.at(-1).key, 'synthetic-C');
            await captured(first); await captured(second);
            await stop(first); await stop(second);
            await setKey(first, ''); await start(first); await captured(first);
            assert.strictEqual(first.requests.at(-1).key, null);
            await stop(first);
            record('keys follow saved settings across sources and reconnects', { requests: first.requests.map(r => r.key) });

            const rate = await add('euler_rate', 'custom', 'rate');
            await setKey(rate, 'synthetic-rate'); await start(rate);
            await waitFor(async () => (await manager(rate))?.rateCount === 1, '429 classified as rate limit');
            const error = await app.evaluate((_, name) => global.__eulerTest.errors.find(e => e.username === name), rate.name);
            assert.strictEqual(error.name, 'SignatureRateLimitError');
            assert.strictEqual(error.retryAfterSeconds, 30);
            rate.mode = 'ok';
            await waitFor(() => rate.requests.length === 2, 'scheduled rate-limit retry', 45000);
            const retryDelay = rate.requests[1].at - rate.requests[0].at;
            assert.ok(retryDelay >= 32000 && retryDelay < 44000, 'retry delay: ' + retryDelay);
            await captured(rate); await stop(rate);
            record('429 wait then successful capture', { retryDelay, error });

            const stall = await add('euler_timeout', 'custom', 'stall');
            await setKey(stall, 'synthetic-timeout'); await start(stall);
            await waitFor(() => stall.requests.length === 1, 'stalled signing HTTP request');
            await waitFor(() => stall.requests[0].closedAt !== null, 'signing timeout closes HTTP request', 35000);
            const timeoutDelay = stall.requests[0].closedAt - stall.requests[0].at;
            assert.ok(timeoutDelay >= 24000 && timeoutDelay < 34000, 'sign timeout: ' + timeoutDelay);
            stall.mode = 'ok';
            await captured(stall); await stop(stall);
            record('signing timeout recovers capture', { timeoutDelay });

            const cancel = await add('euler_cancel', 'custom', 'stall');
            await setKey(cancel, 'synthetic-cancel'); await start(cancel);
            await waitFor(() => cancel.requests.length === 1, 'request before Stop');
            await stop(cancel);
            await waitFor(() => cancel.requests[0].closedAt !== null, 'Stop aborts HTTP request');
            assert.strictEqual((await manager(cancel)).pending, false);
            const cancelRequestCount = cancel.requests.length;
            await page.waitForTimeout(3500);
            assert.strictEqual(cancel.requests.length, cancelRequestCount, 'no retry after Stop');
            cancel.mode = 'ok'; await start(cancel); await captured(cancel); await stop(cancel);
            record('Stop cancels signing and allows restart', { requests: cancel.requests.length });
        }

        const proxy = await add('euler_proxy', 'euler-ws');
        await setKey(proxy, 'synthetic-proxy'); await start(proxy);
        await waitFor(async () => (await manager(proxy))?.connected, 'proxy connected');
        assert.strictEqual(proxyRequests.at(-1).key, 'synthetic-proxy');
        await stop(proxy);
        proxyMode = 'stall'; const beforeProxy = proxyRequests.length;
        await start(proxy);
        await waitFor(() => proxyRequests.length > beforeProxy, 'proxy stalled handshake');
        await waitFor(async () => (await app.evaluate(() => global.__eulerTest.errors)).some(e => /handshake.*timed out/i.test(e.message)), 'proxy handshake timeout', 35000);
        const proxyAttempt = proxyRequests[beforeProxy];
        await waitFor(() => proxyAttempt.closedAt !== null, 'timed-out proxy socket closed');
        const proxyTimeoutDelay = proxyAttempt.closedAt - proxyAttempt.at;
        assert.ok(proxyTimeoutDelay >= 24000 && proxyTimeoutDelay < 34000, 'proxy timeout: ' + proxyTimeoutDelay);
        proxyMode = 'ok';
        await waitFor(async () => (await manager(proxy))?.connected, 'proxy recovery', 45000);
        await stop(proxy);
        proxyMode = 'stall'; const beforeCancel = proxyRequests.length;
        await start(proxy); await waitFor(() => proxyRequests.length > beforeCancel, 'proxy handshake before Stop');
        await stop(proxy);
        await waitFor(() => proxyRequests[beforeCancel].closedAt !== null, 'Stop closes proxy handshake');
        assert.strictEqual((await manager(proxy)).pending, false);
        await page.waitForTimeout(3500);
        assert.strictEqual(proxyRequests.length, beforeCancel + 1, 'no proxy retry after Stop');
        record('proxy keys, deadline, recovery and Stop', { proxyTimeoutDelay });
        console.log('[euler-e2e] All checks passed. Evidence: ' + profile);
    } catch (error) {
        record('FAILED', { error: error.stack });
        throw error;
    } finally {
        clearInterval(sendTimer);
        relay?.terminate();
        if (app) {
            const child = app.process();
            await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/index.html'))?.close()).catch(() => { });
            await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'app shutdown', 10000).catch(() => child.kill());
            await app.close().catch(() => { });
        }
        for (const socket of sockets) socket.destroy();
        for (const server of [chatServer, proxyWs]) {
            for (const socket of server.clients) socket.terminate();
            await new Promise(resolve => server.close(resolve));
        }
        for (const server of [signServer, proxyServer]) await new Promise(resolve => server.close(resolve));
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
