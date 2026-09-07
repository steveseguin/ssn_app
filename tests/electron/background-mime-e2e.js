'use strict';

// Real TLS/HTTP responses exercise Electron's onHeadersReceived hook, which
// protocol.handle fixtures do not traverse. All connections terminate locally.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const { execFileSync } = require('child_process');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const site = path.resolve(root, '../social_stream');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

(async () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-background-mime-'));
    const key = path.join(output, 'fixture-key.pem'), cert = path.join(output, 'fixture-cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
        '-days', '1', '-subj', '/CN=cache.socialstream.ninja'], { stdio: 'ignore', windowsHide: true });
    let phase = 'page-mime';
    const seen = [];
    const sockets = new Set();
    const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
        const url = new URL(req.url, 'https://' + req.headers.host);
        const relative = decodeURIComponent(url.pathname).replace(/^\/steveseguin\/social_stream\/(main|beta)\//, '/').replace(/^\/(?:beta\/)?/, '');
        const file = path.resolve(site, relative || 'index.html');
        if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
        const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
        const wrong = phase === 'page-mime' && relative === 'background.html' || phase === 'loader-mime' && relative === 'loader.js';
        const type = wrong ? 'application/octet-stream' : types[path.extname(file)] || 'application/octet-stream';
        seen.push({ phase, path: relative, type });
        res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
        res.end(fs.readFileSync(file));
    });
    const port = await listen(server);
    const proxy = http.createServer((req, res) => { res.writeHead(503); res.end(); });
    proxy.on('connect', (req, socket, head) => {
        if (!/^(cache\.socialstream\.ninja|socialstream\.ninja|beta\.socialstream\.ninja|raw\.githubusercontent\.com):443$/.test(req.url)) { socket.end('HTTP/1.1 503 Unavailable\r\n\r\n'); return; }
        const upstream = net.connect(port, '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            upstream.pipe(socket); socket.pipe(upstream);
        });
        sockets.add(upstream); sockets.add(socket);
        upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    const profile = path.join(output, 'profile'); fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({ streamID: 'mimefixture', password: 'false', state: false, settings: {}, wsServer: false }));
    let app;
    try {
        app = await _electron.launch({ executablePath: require('electron'), cwd: root,
            args: [path.join(__dirname, 'outage-bootstrap.js'), '--multiinstance', '--no-hwa', '--ignore-certificate-errors'],
            env: { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_PREFER_LOCAL_ASSETS: '0' } });
        const main = await app.firstWindow();
        await main.waitForFunction(() => document.getElementById('frame2').src.startsWith('file:'));
        await app.evaluate(async ({ BrowserWindow, session }, proxyPort) => {
            const sessions = new Set([session.defaultSession, ...BrowserWindow.getAllWindows().map(w => w.webContents.session)]);
            for (const s of sessions) {
                s.protocol.unhandle('https');
                await s.setProxy({ proxyRules: 'http://127.0.0.1:' + proxyPort });
            }
        }, proxyPort);
        for (phase of ['page-mime', 'loader-mime']) {
            await main.reload({ waitUntil: 'domcontentloaded' });
            await main.waitForFunction(async () => {
                const src = document.getElementById('frame2').src;
                if (!src.startsWith('https:')) return false;
                const state = await ipcRenderer.invoke('socialstream:background-dependencies', src);
                return state?.loader?.status === 'ready';
            }, null, { timeout: 45000 });
            const frame = main.frames().find(f => f.url().startsWith('https:') && f.url().includes('/background.html'));
            await frame.waitForFunction(() => typeof streamID === 'string' && window.ssappBackgroundLoadState?.status === 'ready' && window.eventFlowSystem?.db, null, { timeout: 45000 });
            assert.equal(await frame.evaluate(() => streamID), 'mimefixture');
            assert.equal(await frame.evaluate(() => document.contentType), 'text/html');
            await main.locator('[data-page="event-flow-editor"]').click();
            assert(seen.some(row => row.phase === phase && row.type === 'application/octet-stream'), 'Wrong MIME traversed actual HTTPS');
            console.log('PASS real HTTPS', phase);
        }
        await main.screenshot({ path: path.join(output, 'editor.png') });
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(seen, null, 2));
    } finally {
        if (app) await app.close();
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections(); server.close(); proxy.closeAllConnections(); proxy.close();
        console.log('Evidence:', output);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
