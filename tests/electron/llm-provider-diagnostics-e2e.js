#!/usr/bin/env node

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electronPath = require('electron');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-llm-provider-diagnostics-'));
const token = `llm-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const invalidApiKey = 'sk-proj-ssapp-e2e-deliberately-invalid-key';

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
				} catch (error) {
					reject(error);
				}
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
		...linuxLaunchArgs(),
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
		let mainWindow = null;
		const windowStarted = Date.now();
		while (Date.now() - windowStarted < 30000) {
			const windows = await requestJson(port, '/windows');
			mainWindow = (windows.windows || []).find(item => String(item.url || '').includes('index.html'));
			if (mainWindow) break;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.ok(mainWindow, 'Main SSApp window was not found.');

		const result = await requestJson(port, '/exec', {
			windowId: mainWindow.id,
			code: `(async () => {
				const started = Date.now();
				while (typeof ensurePopupPanelLoaded !== 'function') {
					if (Date.now() - started > 30000) return { ready: false, stage: 'main-controller' };
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				await setupIframeSource();
				const backgroundFrame = document.getElementById('frame2');
				while (typeof backgroundFrame?.contentWindow?.callLLMAPI !== 'function') {
					if (Date.now() - started > 30000) return { ready: false, stage: 'background-service' };
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				await ensurePopupPanelLoaded(true);
				const frame = document.getElementById('frame1');
				while (
					!frame?.contentDocument?.getElementById('testSelectedLLMProvider') ||
					typeof frame.contentWindow.testSelectedLLMProvider !== 'function'
				) {
					if (Date.now() - started > 30000) return { ready: false, stage: 'popup' };
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				let providerError = null;
				try {
					await backgroundFrame.contentWindow.callLLMAPI(
						'Reply with one short sentence confirming this chatbot connection works.',
						null,
						null,
						null,
						null,
						null,
						{
							settings: {
								aiProvider: { optionsetting: 'chatgpt' },
								chatgptApiKey: { textsetting: ${JSON.stringify(invalidApiKey)} },
								chatgptmodel: { textsetting: 'gpt-5.4-mini' }
							}
						}
					);
				} catch (error) {
					providerError = {
						provider: error.provider,
						status: error.status,
						code: error.code,
						message: error.message,
						hint: error.hint,
						requestId: error.requestId,
						organization: error.organization,
						project: error.project,
						missingScope: error.missingScope
					};
				}
				const formatted = frame.contentWindow.formatLLMProviderTestError(providerError);
				const missingScopeHint = backgroundFrame.contentWindow.getLLMHint(401, 'missing_scope', {
					provider: 'chatgpt',
					missingScope: 'model.request',
					message: 'Insufficient permissions. Missing scope: model.request.'
				});
				const synthetic = frame.contentWindow.formatLLMProviderTestError({
					provider: 'chatgpt',
					status: 401,
					code: 'missing_scope',
					missingScope: 'model.request',
					message: 'Insufficient permissions.',
					requestId: 'req_missing_scope_e2e',
					hint: missingScopeHint
				});
				return {
					ready: true,
					providerError,
					formatted,
					missingScopeHint,
					synthetic,
				};
			})()`,
		});

		assert.strictEqual(result.ok, true, JSON.stringify(result));
		assert.strictEqual(result.result.ready, true, JSON.stringify(result.result));
		assert.strictEqual(result.result.providerError.provider, 'chatgpt', JSON.stringify(result.result));
		assert.strictEqual(result.result.providerError.status, 401, JSON.stringify(result.result));
		assert.match(result.result.formatted, /Provider: chatgpt/);
		assert.match(result.result.formatted, /Status: 401/);
		assert.match(result.result.formatted, /Request ID: \S+/);
		assert.strictEqual(result.result.formatted.includes(invalidApiKey), false);
		assert.match(result.result.synthetic, /Code: missing_scope/);
		assert.match(result.result.synthetic, /Missing scope: model\.request/);
		assert.match(result.result.synthetic, /Request ID: req_missing_scope_e2e/);
		assert.match(result.result.missingScopeHint, /not a missing request field/i);
		assert.match(result.result.missingScopeHint, /newly created unrestricted key/i);
		console.log('LLM provider diagnostic Electron end-to-end checks passed.');
	} catch (error) {
		throw new Error(`${error.message}\n${output.slice(-8000)}`);
	} finally {
		await stopApp(child);
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

run().catch(error => {
	console.error(error);
	process.exit(1);
});
