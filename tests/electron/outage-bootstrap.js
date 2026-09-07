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
		if (!['socialstream.ninja', 'beta.socialstream.ninja', 'cache.socialstream.ninja', 'raw.githubusercontent.com'].includes(url.hostname)) return new Response('', { status: 503 });
		// Explicit opt-in diagnostic only; ordinary regression runs never contact
		// live services or channels. Uses the actual app session/network stack.
		if (state.phase === 'live-assets' && process.env.SSAPP_TEST_LIVE_ASSETS === '1') {
			return target.fetch(request, { bypassCustomProtocolHandlers: true });
		}
		let relative = decodeURIComponent(url.pathname).replace(/^\/steveseguin\/social_stream\/(main|beta)\//, '/').replace(/^\/(?:beta\/)?/, '');
		if (!relative) relative = 'index.html';
		if (state.phase === 'partial' && relative === 'libs/objects.js') return new Response('', { status: 503 });
		if (state.phase === 'stalled' && relative === 'libs/objects.js') return new Promise(() => {});
		const targetScript = relative === 'libs/objects.js';
		const cache = url.hostname === 'cache.socialstream.ninja';
		if (relative === 'loader.js' && state.phase === 'loader-html' && cache) return new Response('<!doctype html><html>Server error</html>', { headers: { 'content-type': 'application/javascript' } });
		if (relative === 'loader.js' && state.phase === 'loader-outage') return new Response('', { status: 503 });
		if (targetScript && state.phase === 'slow') await new Promise(resolve => setTimeout(resolve, 20000));
		if (targetScript && state.phase === 'slow-cache' && cache) await new Promise(resolve => setTimeout(resolve, 20000));
		if (targetScript && state.phase === 'raw-only' && url.hostname !== 'raw.githubusercontent.com') return new Response('', { status: 503 });
		if (targetScript && state.phase === 'html' && cache) return new Response('<!doctype html><html>Server error</html>', { headers: { 'content-type': 'application/javascript' } });
		if (targetScript && state.phase === 'syntax' && cache) return new Response('function broken( {', { headers: { 'content-type': 'application/javascript' } });
		if (targetScript && state.phase === 'empty' && cache) return new Response('', { headers: { 'content-type': 'application/javascript' } });
		if (targetScript && state.phase === 'json' && cache) return new Response('{"error":"unavailable"}', { headers: { 'content-type': 'application/json' } });
		if (targetScript && state.phase === 'stalled-body' && cache) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('// incomplete')); } }));
		if (targetScript && state.phase === 'redirect' && cache) return Response.redirect('https://cache.socialstream.ninja/test-assets/objects.download');
		if (state.phase === 'redirect' && relative === 'test-assets/objects.download') {
			return new Response(fs.readFileSync(path.join(site, 'libs/objects.js'), 'utf8') + '\nwindow.__scriptRecoveryExecutions = (window.__scriptRecoveryExecutions || 0) + 1;', { headers: { 'content-type': 'application/octet-stream' } });
		}
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
		if (targetScript && state.phase === 'runtime') body = 'throw new Error("Intentional script execution failure");';
		if (targetScript) body = body.toString() + '\nwindow.__scriptRecoveryExecutions = (window.__scriptRecoveryExecutions || 0) + 1;';
		const mime = (targetScript && state.phase === 'mime') || (relative === 'loader.js' && state.phase === 'loader-mime')
			|| (relative === 'background.html' && state.phase === 'page-mime') ? 'text/plain'
			: targetScript && state.phase === 'mime-html' ? 'text/html' : types[path.extname(file)] || 'application/octet-stream';
		return new Response(body, { headers: { 'content-type': mime, 'x-content-type-options': 'nosniff' } });
	});
}
app.on('session-created', target => app.whenReady().then(() => installTransport(target)));
app.whenReady().then(() => installTransport(session.defaultSession));
require('../../bootstrap');
