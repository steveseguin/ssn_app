'use strict';

// Real Electron UI/IPC and installed connector against controlled HTTP/WS
// endpoints and chat pages. Room/gift lookups are fixtures. No real API keys.
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
        if (scenario.mode === 'plan') {
            response.writeHead(402, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ code: 402, message: 'This feature requires a business plan' }));
            return;
        }
        if (scenario.mode === 'unavailable') {
            response.writeHead(503, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ message: 'Signing temporarily unavailable' }));
            return;
        }
        if (scenario.mode === 'rate') {
            response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(scenario.retryAfter || 30) });
            response.end(JSON.stringify({ message: 'Rate limit', limit_label: scenario.limitLabel ?? 'rate_limit_room_id_hour' }));
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
        if (proxyMode === 'http-quota') {
            socket.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 40773\r\nRateLimit-Policy: 1000;w=86400\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            return;
        }
        if (proxyMode === 'stall') {
            // Consume EOF so the fixture observes the client's aborted socket.
            // HTTP upgrade sockets allow half-open connections on the server.
            socket.on('end', () => { record.closedAt = Date.now(); socket.end(); });
            socket.resume();
            return;
        }
        proxyWs.handleUpgrade(request, socket, head, ws => {
            proxyWs.emit('connection', ws, request);
            if (proxyMode === 'quota') ws.close(4429, 'rate_limit_account_day');
            if (proxyMode === 'quota-unknown') ws.close(4429, 'Too many connections');
        });
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
                SSAPP_TIKTOK_SHARED_EULER_SIGNING_KEY: 'synthetic-shared-signing',
                SSAPP_TIKTOK_SHARED_EULER_PROXY_KEY: 'synthetic-shared-proxy',
                EULER_WS_URL: `ws://127.0.0.1:${proxyServer.address().port}` },
            timeout: 60000,
        });
        page = await app.firstWindow();
        for (const stream of [app.process().stdout, app.process().stderr]) {
            stream.on('data', chunk => fs.appendFileSync(path.join(profile, 'electron.log'), chunk));
        }
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
                if (this.username.startsWith('euler_autoquota')) this.localSigner = null;
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
                if (message.type === 'tiktok' && /^(disconnect fixture|hidden-capture message)/.test(message.chatmessage)) received.push(message);
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
        if (!process.argv.includes('--proxy-only') && !process.argv.includes('--quota-only')) {
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

        if (!process.argv.includes('--quota-only')) {
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
        }

        if (!process.argv.includes('--proxy-only')) {
            const plan = await add('euler_plan', 'custom', 'plan');
            await setKey(plan, 'synthetic-plan'); await start(plan);
            await waitFor(async () => await page.evaluate(id => stateManager.getSource(id).status === 'error', plan.id), 'Euler plan error');
            await page.waitForTimeout(1500);
            const planBanner = page.locator(`[data-source-id="${plan.id}"] .ws-status.error`);
            assert.strictEqual(await planBanner.isVisible(), true, 'Failed activation must keep its error banner');
            assert.match(await planBanner.innerText(), /requires a compatible plan/);
            assert.strictEqual((await manager(plan)).retry, false, 'Plan errors must not retry automatically');
            await page.evaluate(id => stopThis(document.querySelector(`[data-source-id="${id}"] [data-activatehtml]`)), plan.id);
            record('Euler plan error remains visible after activation completes', {});

            async function quotaUI(s, expected) {
                await waitFor(async () => page.locator(`[data-source-id="${s.id}"] .ws-status.retry`).filter({ hasText: expected }).count(), expected);
                return page.locator(`[data-source-id="${s.id}"] .ws-status`).innerText();
            }
            const daily = await add('euler_daily', 'custom', 'rate');
            daily.limitLabel = 'rate_limit_account_day'; daily.retryAfter = 40773;
            await setKey(daily, 'synthetic-own-daily'); await start(daily);
            const dailyText = await quotaUI(daily, 'Your Euler key has reached its daily limit.');
            assert.match(dailyText, /Euler usage/);
            const remaining = await page.evaluate(id => document.querySelector(`[data-source-id="${id}"]`)._tiktokRetryEndAt - Date.now(), daily.id);
            assert.ok(remaining > 40760000 && remaining <= 40775000, 'Euler reset deadline must not be capped at 30 minutes');
            const fresh = await add('euler_fresh');
            await setKey(fresh, 'synthetic-fresh-key'); await start(fresh); await captured(fresh); await stop(fresh);
            assert.strictEqual(daily.requests.length, 1);
            await stop(daily);
            record('personal daily quota is named, waits for reset, and does not block another key', { dailyText, remaining });

            const shared = await add('euler_shared', 'custom', 'rate');
            shared.limitLabel = 'rate_limit_account_day'; shared.retryAfter = 40773;
            await setKey(shared, 'synthetic-shared-signing'); await start(shared);
            const sharedText = await quotaUI(shared, 'The shared Euler key has reached its daily limit.');
            assert.match(sharedText, /Get your own Euler key/);
            await stop(shared);
            record('explicit shared key quota offers a personal key', { sharedText });

            const unknown = await add('euler_unknown', 'custom', 'rate');
            unknown.limitLabel = ''; await setKey(unknown, 'synthetic-unknown'); await start(unknown);
            const unknownText = await quotaUI(unknown, 'Your Euler key has reached a rate limit.');
            assert.doesNotMatch(unknownText, /daily/);
            await stop(unknown);
            record('unknown limits are not called daily', { unknownText });

            const proxyQuota = await add('euler_proxyquota', 'euler-ws');
            await setKey(proxyQuota, 'synthetic-shared-proxy'); proxyMode = 'quota'; await start(proxyQuota);
            const proxyText = await quotaUI(proxyQuota, 'The shared Euler key has reached its daily limit.');
            assert.match(proxyText, /Get your own Euler key/);
            await stop(proxyQuota);
            await setKey(proxyQuota, 'synthetic-proxy-personal'); proxyMode = 'quota-unknown'; await start(proxyQuota);
            const proxyUnknownText = await quotaUI(proxyQuota, 'Your Euler key has reached a rate limit.');
            assert.doesNotMatch(proxyUnknownText, /daily/);
            await stop(proxyQuota);
            record('proxy close codes identify ownership and known period', { proxyText, proxyUnknownText });

            proxyMode = 'http-quota'; await start(proxyQuota);
            const httpQuotaText = await quotaUI(proxyQuota, 'Your Euler key has reached its daily limit.');
            const proxyRemaining = await page.evaluate(id => document.querySelector(`[data-source-id="${id}"]`)._tiktokRetryEndAt - Date.now(), proxyQuota.id);
            assert.ok(proxyRemaining > 40760000 && proxyRemaining <= 40775000, `Proxy reset: ${proxyRemaining}; status: ${httpQuotaText}`);
            await page.waitForTimeout(1500);
            assert.match(await page.locator(`[data-source-id="${proxyQuota.id}"] .ws-status`).innerText(), /Your Euler key has reached its daily limit/);
            await stop(proxyQuota); proxyMode = 'ok';
            record('proxy HTTP quota preserves reset headers and message', { httpQuotaText, proxyRemaining });

            const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/hidden-capture.html'), 'utf8');
            await page.context().route('**www.tiktok.com/@euler_autoquota*/live**', route => route.fulfill({
                contentType: 'text/html', body: fixture.replace('var platform = query.get("platform") || "youtube";', 'var platform = "tiktok";'),
            }));
            const automatic = await add('euler_autoquota', 'auto', 'rate');
            automatic.limitLabel = 'rate_limit_account_day'; automatic.retryAfter = 40773;
            await page.evaluate(id => stateManager.updateSource(id, { disableTikTokAutoFallback: false }), automatic.id);
            const proxiesBefore = proxyRequests.length;
            await start(automatic); await captured(automatic);
            assert.strictEqual(await page.evaluate(id => stateManager.getSource(id).activeConnectionMode, automatic.id), 'classic');
            assert.deepStrictEqual(automatic.requests.map(r => r.key), [null, 'synthetic-shared-signing']);
            assert.strictEqual(proxyRequests.length, proxiesBefore, 'Auto must skip the shared proxy after shared account exhaustion');
            assert.strictEqual((await manager(automatic)).stopped, true);
            await page.locator(`[data-source-id="${automatic.id}"] [data-stophtml]`).press('Enter');
            record('Auto skips exhausted shared Euler and captures through Standard', { keys: automatic.requests.map(r => r.key) });

            const autoProxy = await add('euler_autoquota_proxy', 'auto', 'unavailable');
            await page.evaluate(id => stateManager.updateSource(id, { disableTikTokAutoFallback: false }), autoProxy.id);
            const proxyQuotaStart = proxyRequests.length;
            proxyMode = 'quota'; await start(autoProxy); await captured(autoProxy);
            assert.strictEqual(await page.evaluate(id => stateManager.getSource(id).activeConnectionMode, autoProxy.id), 'classic');
            assert.strictEqual(proxyRequests.length, proxyQuotaStart + 1);
            assert.strictEqual(proxyRequests.at(-1).key, 'synthetic-shared-proxy');
            assert.strictEqual(autoProxy.requests.length, 1, 'No return to signing after shared proxy quota');
            assert.strictEqual((await manager(autoProxy)).stopped, true);
            await page.locator(`[data-source-id="${autoProxy.id}"] [data-stophtml]`).press('Enter');
            record('Auto shared proxy quota also advances to Standard capture', {});
        }
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
