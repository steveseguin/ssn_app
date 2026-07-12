#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const electronPath = require('electron');
const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-popup-fallback-links-'));
const token = `popup-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

function requestJson(port, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : JSON.stringify(body);
		const request = http.request({
			host: '127.0.0.1',
			port,
			path: `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
			method: payload === null ? 'GET' : 'POST',
			headers: payload === null ? {} : {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload),
			},
		}, response => {
			let text = '';
			response.setEncoding('utf8');
			response.on('data', chunk => { text += chunk; });
			response.on('end', () => {
				try {
					const parsed = text ? JSON.parse(text) : {};
					if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
					else reject(new Error(`HTTP ${response.statusCode}: ${text}`));
				} catch (error) { reject(error); }
			});
		});
		request.on('error', reject);
		if (payload !== null) request.write(payload);
		request.end();
	});
}

async function waitForControl(port, child, timeoutMs = 60000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (child.exitCode !== null) throw new Error(`SSApp exited early with code ${child.exitCode}.`);
		try {
			const ping = await requestJson(port, '/ping');
			if (ping && ping.ok) return;
		} catch (_) { }
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('Timed out waiting for SSApp remote control.');
}

async function stopApp(child) {
	if (!child || child.exitCode !== null) return;
	child.kill();
	await Promise.race([
		new Promise(resolve => child.once('exit', resolve)),
		new Promise(resolve => setTimeout(resolve, 5000)),
	]);
}

async function run() {
	const port = await getFreePort();
	const child = spawn(electronPath, [
		'.',
		'--multiinstance',
		'--preferlocalassets',
		`--filesource=${socialStreamRoot}`,
		'--remote-control',
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDir,
			SSAPP_REMOTE_CONTROL: '1',
			SSAPP_REMOTE_CONTROL_PORT: String(port),
			SSAPP_REMOTE_CONTROL_TOKEN: token,
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
			SSAPP_DEBUG_LOGS: '0',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let output = '';
	child.stdout.on('data', chunk => { output += chunk.toString(); });
	child.stderr.on('data', chunk => { output += chunk.toString(); });
	try {
		await waitForControl(port, child);
		const windowStarted = Date.now();
		let windows = null;
		let mainWindow = null;
		while (Date.now() - windowStarted < 30000) {
			windows = await requestJson(port, '/windows');
			mainWindow = (windows.windows || []).find(item => String(item.url || '').includes('index.html'));
			if (mainWindow) break;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.ok(mainWindow, `Main SSApp window was not found: ${JSON.stringify(windows)}`);
		const result = await requestJson(port, '/exec', {
			windowId: mainWindow.id,
			code: `(async () => {
				const started = Date.now();
				while (typeof ensurePopupPanelLoaded !== 'function') {
					if (Date.now() - started > 30000) return { ready: false, mainUrl: location.href };
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				const frame = document.getElementById('frame1');
				while (frame && (!frame.src || frame.src === 'about:blank')) {
					if (Date.now() - started > 30000) return { ready: false, mainUrl: location.href };
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				await new Promise(resolve => setTimeout(resolve, 1000));
				await ensurePopupPanelLoaded(true);
				while (frame && !frame.src.includes('generatedlinkbase=')) {
					if (Date.now() - started > 30000) return { ready: false, mainUrl: location.href, popupUrl: frame.src };
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				while (frame && !String(frame.contentWindow?.location?.href || '').includes('generatedlinkbase=')) {
					if (Date.now() - started > 30000) return { ready: false, mainUrl: location.href, popupUrl: frame.src };
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				let featuredUrl = '';
				let dockUrl = '';
				while (Date.now() - started <= 30000) {
					try {
						featuredUrl = frame && frame.contentDocument && frame.contentDocument.getElementById('overlaylink')?.href || '';
						dockUrl = frame && frame.contentDocument && frame.contentDocument.getElementById('docklink')?.href || '';
						if (featuredUrl && dockUrl) break;
					} catch (_) { }
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				return {
					ready: true,
					mainUrl: location.href,
					popupUrl: frame && frame.src,
					origin: frame && frame.dataset.ssappOrigin,
					featuredUrl,
					dockUrl,
				};
			})()`,
		});
		assert.strictEqual(result.ok, true, JSON.stringify(result));
		assert.strictEqual(result.result.ready, true, JSON.stringify(result.result));
		const mainUrl = new URL(result.result.mainUrl);
		const popupUrl = new URL(result.result.popupUrl);
		assert.strictEqual(mainUrl.searchParams.has('hostedlinks'), true, result.result.mainUrl);
		assert.strictEqual(popupUrl.protocol, 'file:', result.result.popupUrl);
		assert.ok(popupUrl.pathname.endsWith('/social_stream/popup.html'), result.result.popupUrl);
		assert.strictEqual(popupUrl.searchParams.get('generatedlinkbase'), 'https://socialstream.ninja/', JSON.stringify(result.result));
		assert.strictEqual(popupUrl.searchParams.get('sourcemode'), 'https://socialstream.ninja/', result.result.popupUrl);
		assert.strictEqual(new URL(result.result.featuredUrl).origin, 'https://socialstream.ninja', JSON.stringify(result.result));
		assert.ok(new URL(result.result.featuredUrl).pathname.endsWith('/featured.html'), result.result.featuredUrl);
		assert.strictEqual(new URL(result.result.dockUrl).origin, 'https://socialstream.ninja', result.result.dockUrl);
		assert.ok(new URL(result.result.dockUrl).pathname.endsWith('/dock.html'), result.result.dockUrl);
		console.log('Popup fallback link Electron end-to-end checks passed.');
	} catch (error) {
		throw new Error(`${error.message}\n${output.slice(-5000)}`);
	} finally {
		await stopApp(child);
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

run().catch(error => {
	console.error(error);
	process.exit(1);
});
