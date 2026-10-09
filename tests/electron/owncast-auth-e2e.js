'use strict';

// Real SSApp windows/sessions/IPC against loopback HTTP challenges and chat markup.
// Optional OWNCAST_TEST_URL points to a local Owncast 0.3 server for the final phase.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-owncast-auth-'));
const requests = [];
const password = 'local-904-password';
let otherOrigin;
const markup = `<!doctype html><title>Owncast fixture</title><div id="chat-container"></div>
<div id="chat-input-content-editable" contenteditable="true" role="textbox"></div>
<script>
var index = 0;
setInterval(function () { requestAnimationFrame(function () {
    var wrap = document.createElement('div'); wrap.dataset.index = ++index;
    wrap.innerHTML = '<div class="chat-message_user"><span class="ChatUserMessage-module-scss-module__fixture__userName">Local tester</span><span class="ChatUserMessage-module-scss-module__fixture__message">fixture message ' + index + '</span></div>';
    document.getElementById('chat-container').appendChild(wrap);
}); }, 300);
</script>`;

function server() {
    return http.createServer((req, res) => {
        requests.push({ url: req.url, host: req.headers.host, authenticated: !!req.headers.authorization });
        if (req.url.startsWith('/redirect')) {
            res.writeHead(302, { Location: otherOrigin + '/protected' }); res.end(); return;
        }
        if (!req.url.startsWith('/public') && req.headers.authorization !==
            'Basic ' + Buffer.from('tester:' + password).toString('base64')) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Owncast local test"' });
            res.end('Authentication required'); return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(markup);
    });
}
async function until(fn, label, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const value = await fn();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out: ' + label);
}

(async () => {
    const first = server(), second = server();
    await new Promise(resolve => first.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => second.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + first.address().port;
    otherOrigin = 'http://127.0.0.1:' + second.address().port;
    let app, realProxy, sender;
    try {
        app = await _electron.launch({
            executablePath: require('electron'), cwd: root,
            args: ['.', '--running-from-source', '--multiinstance', '--renderer-process-limit=4',
                '--filesource=' + pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href],
            env: { ...process.env, SSAPP_USER_DATA_DIR: path.join(output, 'profile'), UV_THREADPOOL_SIZE: '2' },
            timeout: 60000
        });
        const log = fs.createWriteStream(path.join(output, 'app.log'));
        app.process().stdout.on('data', data => log.write(data));
        app.process().stderr.on('data', data => log.write(data));
        const main = await app.firstWindow();
        await main.waitForFunction(() => window.stateManager?.initialized && configReady);
        assert(await app.evaluate(({ app }) => app.commandLine.hasSwitch('disable-web-security')));
        assert.equal(await main.evaluate(() => config.owncast.httpBasicAuth), true);
        const authPages = () => app.windows().filter(page => /source-basic-auth\.html/.test(page.url()));
        const auth = async () => {
            const page = await until(() => authPages()[0], 'authentication dialog');
            await page.waitForLoadState('domcontentloaded');
            return page;
        };
        const pageAt = url => until(() => app.windows().find(page => page.url() === url), url);
        async function submit(page, secret = password) {
            await page.getByLabel('Username', { exact: true }).fill('tester');
            await page.getByLabel('Password', { exact: true }).fill(secret);
            await page.getByRole('button', { name: 'Sign in', exact: true }).click();
            await until(() => page.isClosed(), 'dialog closed');
        }
        async function add(url, session, target = 'owncast', visible = true) {
            return main.evaluate(async ({ url, session, target, visible }) => {
                await newOtherSource(target, url, false, {
                    username: 'Owncast local test', connectionMode: 'classic',
                    sourceFile: 'sources/owncast.js', customSession: session,
                    isVisible: visible, autoActivate: false
                });
                return stateManager.getSources().filter(s => s.url === url).pop().id;
            }, { url, session, target, visible });
        }
        async function activate(id) {
            await main.evaluate(id => activateSource(document.querySelector('[data-source-id="' + id + '"] [data-activatehtml]')), id);
        }
        async function signIn(id) {
            await main.evaluate(id => signin(document.querySelector('[data-source-id="' + id + '"] [data-signin]'), false, { skipMethodChoice: true }), id);
        }

        const protectedUrl = origin + '/protected/embed/chat/readwrite?owncast=1';
        const id = await add(protectedUrl, 'auth-primary');
        await signIn(id);
        let dialog = await auth();
        assert.equal(await dialog.locator('#server').innerText(), origin);
        await dialog.screenshot({ path: path.join(output, 'server-signin.png') });
        await submit(dialog, 'incorrect');
        dialog = await auth();
        await dialog.locator('#source-setup-error').waitFor({ state: 'visible' });
        await submit(dialog);
        const signin = await pageAt(protectedUrl);
        await signin.locator('#chat-container').waitFor();
        await signin.close();
        console.log('PASS exact sign-in URL, wrong password feedback, retry');

        const background = await until(() => main.frames().find(frame => /background\.html/.test(frame.url())), 'background frame');
        await background.waitForFunction(() => typeof processIncomingMessage === 'function');
        await background.evaluate(() => {
            window.owncastTestMessages = [];
            const original = processIncomingMessage;
            processIncomingMessage = function (data) {
                if (data?.type === 'owncast') window.owncastTestMessages.push(JSON.parse(JSON.stringify(data)));
                return original.apply(this, arguments);
            };
        });
        await activate(id);
        const capture = await pageAt(protectedUrl);
        await capture.locator('#chat-container').waitFor();
        assert.equal(authPages().length, 0, 'Capture reuses sign-in HTTP auth cache');
        await until(() => background.evaluate(() => owncastTestMessages.length >= 4), 'visible capture');
        const count = await background.evaluate(() => owncastTestMessages.length);
        await main.evaluate(id => toggleSourceVisibility(document.querySelector('[data-source-id="' + id + '"]')), id);
        await until(() => background.evaluate(count => owncastTestMessages.length >= count + 10, count), 'hidden capture');
        console.log('PASS sign-in to capture session reuse, visible and hidden messages through SSApp IPC');

        // A second browser session on the same server must ask independently.
        const isolatedId = await add(origin + '/protected/isolated', 'auth-isolated', 'owncast', false);
        await activate(isolatedId);
        dialog = await auth();
        await dialog.keyboard.press('Escape').catch(error => { if (!dialog.isClosed()) throw error; });
        await until(() => dialog.isClosed(), 'Escape cancellation');
        assert.equal(authPages().length, 0);
        console.log('PASS separate session, hidden source dialog, Escape cancellation');

        // A second port, even with the same realm and browser session, cannot reuse the credentials.
        const otherId = await add(otherOrigin + '/protected/second', 'auth-primary');
        await activate(otherId);
        dialog = await auth();
        assert.equal(await dialog.locator('#server').innerText(), otherOrigin);
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await until(() => dialog.isClosed(), 'button cancellation');
        console.log('PASS distinct server origin, Cancel button');

        const closeId = await add(origin + '/protected/close', 'auth-close');
        await activate(closeId);
        dialog = await auth();
        await main.evaluate(id => stopThis(document.querySelector('[data-source-id="' + id + '"] [data-stophtml]')), closeId);
        await until(() => dialog.isClosed(), 'source close cleans pending prompt');
        console.log('PASS source closure cancels pending login');

        // The capability must remain opt-in, including when global config has the same key.
        await main.evaluate(() => { config.global.httpBasicAuth = true; });
        const controlId = await add(origin + '/protected/control', 'auth-control', 'custom');
        await activate(controlId);
        await until(() => requests.some(r => r.url === '/protected/control'), 'unconfigured request');
        await new Promise(resolve => setTimeout(resolve, 800));
        assert.equal(authPages().length, 0);
        await main.evaluate(() => { delete config.global.httpBasicAuth; });
        const redirectId = await add(origin + '/redirect', 'auth-redirect');
        await activate(redirectId);
        await until(() => requests.some(r => r.host === new URL(otherOrigin).host && r.url === '/protected'), 'redirect target');
        await new Promise(resolve => setTimeout(resolve, 800));
        assert.equal(authPages().length, 0, 'Cross-origin redirect cannot solicit source credentials');
        console.log('PASS unconfigured platform and cross-origin redirect excluded');

        if (process.env.OWNCAST_TEST_URL) {
            const upstream = new URL(process.env.OWNCAST_TEST_URL);
            assert(['127.0.0.1', 'localhost'].includes(upstream.hostname) && upstream.protocol === 'http:', 'Only local Owncast tests');
            // Put the actual Owncast chat behind Basic Auth, as a self-hosted reverse
            // proxy would. The password is test-only and never reaches Owncast itself.
            const authorize = req => req.headers.authorization === 'Basic ' + Buffer.from('tester:' + password).toString('base64');
            realProxy = http.createServer((req, res) => {
                if (!authorize(req)) {
                    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Owncast actual server"' });
                    res.end('Authentication required'); return;
                }
                const headers = { ...req.headers, host: upstream.host };
                delete headers.authorization;
                const next = http.request(new URL(req.url, upstream), { method: req.method, headers }, response => {
                    res.writeHead(response.statusCode, response.headers); response.pipe(res);
                });
                next.on('error', () => { res.writeHead(502); res.end(); });
                req.pipe(next);
            });
            realProxy.on('upgrade', (req, socket, head) => {
                if (!authorize(req)) {
                    socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Owncast actual server"\r\nContent-Length: 0\r\n\r\n');
                    return;
                }
                const next = net.connect(Number(upstream.port), upstream.hostname, () => {
                    let header = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
                    for (const [key, value] of Object.entries(req.headers)) {
                        if (key !== 'authorization') header += key + ': ' + (key === 'host' ? upstream.host : value) + '\r\n';
                    }
                    next.write(header + '\r\n'); if (head.length) next.write(head);
                    socket.pipe(next); next.pipe(socket);
                });
                next.on('error', () => socket.destroy());
                socket.on('error', () => next.destroy());
                socket.on('close', () => next.destroy());
            });
            await new Promise(resolve => realProxy.listen(0, '127.0.0.1', resolve));
            const realUrl = 'http://127.0.0.1:' + realProxy.address().port + '/embed/chat/readwrite/';
            const realId = await add(realUrl, 'owncast-real', 'owncast', false);
            await activate(realId);
            await submit(await auth());
            const real = await pageAt(realUrl);
            await real.locator('#chat-container').first().waitFor({ timeout: 30000 });
            await real.waitForTimeout(2500); // Let the production capture observer attach.
            await real.screenshot({ path: path.join(output, 'owncast-real.png') });
            const registration = await (await fetch(new URL('/api/chat/register', upstream), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ displayName: 'SSApp local tester' })
            })).json();
            sender = new WebSocket('ws://' + upstream.host + '/ws?accessToken=' + encodeURIComponent(registration.accessToken));
            await new Promise((resolve, reject) => { sender.once('open', resolve); sender.once('error', reject); });
            const received = [];
            sender.on('message', data => {
                for (const line of String(data).split('\n')) {
                    const message = JSON.parse(line);
                    if (message.type === 'PING') sender.send(JSON.stringify({ type: 'PONG' }));
                    if (message.type === 'CHAT') received.push(message.body);
                }
            });
            async function sendReal(label) {
                // Owncast rate-limits a user who posts messages in quick succession.
                await new Promise(resolve => setTimeout(resolve, 1250));
                const body = 'owncast-e2e-' + label + '-' + Date.now();
                sender.send(JSON.stringify({ type: 'CHAT', body }));
                await until(() => background.evaluate(body => owncastTestMessages.some(message =>
                    message.chatmessage.includes(body) && message.chatname === 'SSApp local tester'), body), label + ' real message', 20000);
            }
            assert.equal(await app.evaluate(({ BrowserWindow }, id) =>
                BrowserWindow.getAllWindows().find(win => win.args?.sourceId === id).__ss_visible, realId), false);
            await sendReal('started-hidden');
            await main.evaluate(id => toggleSourceVisibility(document.querySelector('[data-source-id="' + id + '"]')), realId);
            await sendReal('visible');
            await main.evaluate(id => toggleSourceVisibility(document.querySelector('[data-source-id="' + id + '"]')), realId);
            for (let i = 0; i < 5; i++) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                await sendReal('hidden-' + i);
            }
            await real.reload();
            await real.locator('#chat-container').first().waitFor();
            await real.waitForTimeout(2500);
            await sendReal('hidden-reload');
            assert.equal(authPages().length, 0, 'Real HTTP and WebSocket reuse authentication');
            console.log('PASS actual Owncast 0.3 behind Basic Auth: started hidden, visible, hidden, and hidden reload capture');
            if (process.env.OWNCAST_TEST_REPLY === '1') {
                const reply = 'SSApp-reply-' + Date.now();
                const tid = await main.evaluate(id => stateManager.getSource(id).vid, realId);
                assert.equal(await background.evaluate(() => isExtensionOn), true, 'SSApp service must be on for replies');
                await background.evaluate(({ tid, reply }) => sendMessageToTabs({ tid, response: reply, host: true }), { tid, reply });
                try {
                    await until(() => received.some(body => body.includes(reply)), 'reply delivered to Owncast server');
                } catch (error) {
                    console.log('Reply diagnostics:', await real.evaluate(() => ({
                        input: document.querySelector('#chat-input-content-editable')?.outerHTML,
                        active: document.activeElement?.outerHTML?.slice(0, 600)
                    })));
                    await real.screenshot({ path: path.join(output, 'reply-failed.png') });
                    throw error;
                }
                console.log('PASS SSApp reply delivered to actual Owncast chat');
            }
        }
        const saved = await main.evaluate(() => localStorage.getItem('socialStreamState'));
        assert(!saved.includes(password), 'Credentials must not enter source settings');
        console.log('PASS no credentials in saved sources');
    } finally {
        if (app) await app.close();
        if (sender) sender.terminate();
        if (realProxy) { realProxy.closeAllConnections(); realProxy.close(); }
        first.closeAllConnections(); second.closeAllConnections();
        await Promise.all([new Promise(resolve => first.close(resolve)), new Promise(resolve => second.close(resolve))]);
        console.log('Artifacts:', output);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
