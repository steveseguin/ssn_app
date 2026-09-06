'use strict';
// Test entry point: install deterministic transport failures before the real
// application starts. No application loading or injection functions are mocked.
const fs = require('fs');
const path = require('path');
const { app, session, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '../..');
const site = path.resolve(process.env.SOCIAL_STREAM_SOURCE_DIR || path.join(root, '../social_stream'));
app.setAppPath(root);
global.__outage = { phase: 'offline', requests: [] };
const installed = new WeakSet();
function installTransport(target) {
	if (installed.has(target)) return;
	installed.add(target);
	target.protocol.handle('https', async request => {
		const url = new URL(request.url);
		const state = global.__outage;
		state.requests.push(url.href);
		if (state.phase === 'offline') return new Response('', { status: 503 });
		if (!['socialstream.ninja', 'beta.socialstream.ninja', 'cache.socialstream.ninja'].includes(url.hostname)) return new Response('', { status: 503 });
		let relative = decodeURIComponent(url.pathname).replace(/^\/(?:beta\/)?/, '');
		if (!relative) relative = 'index.html';
		if (state.phase === 'partial' && relative === 'libs/objects.js') return new Response('', { status: 503 });
		if (state.phase === 'stalled' && relative === 'libs/objects.js') return new Promise(() => {});
		const file = path.resolve(site, relative);
		if (!file.startsWith(site + path.sep)) return new Response('', { status: 404 });
		const types = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };
		let body;
		if (process.env.SSAPP_TEST_SERVE_BUNDLE !== '1' && fs.existsSync(site)) {
			if (fs.existsSync(file) && fs.statSync(file).isFile()) body = fs.readFileSync(file);
		} else if (types[path.extname(file)]) {
			// CI need not check out a second repository. Retrieve the fixture through
			// the app's normal bundled-asset bridge, rather than inspecting its bundle.
			const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/index.html'));
			if (main) body = await main.webContents.executeJavaScript(`window.ssappFallback.readFile(${JSON.stringify(relative)}, {branch:'main'})`);
		}
		if (body == null) return new Response('', { status: 404 });
		return new Response(body, { headers: { 'content-type': types[path.extname(file)] || 'application/octet-stream' } });
	});
}
app.on('session-created', target => app.whenReady().then(() => installTransport(target)));
app.whenReady().then(() => installTransport(session.defaultSession));
require('../../bootstrap');
