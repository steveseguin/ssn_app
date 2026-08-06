#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const electronPath = require('electron');
const repoRoot = path.resolve(__dirname, '..', '..');
const expectedSsappVersion = require(path.join(repoRoot, 'package.json')).version;
const expectedApiVersion = '1.1.5';
const sourceUrlSecret = 'CONTROL_API_SOURCE_SECRET';
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const socialStreamUrl = pathToFileURL(socialStreamRoot + path.sep).href;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-headless-control-'));

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

async function createSourceFixtureServer() {
	const server = http.createServer((_request, response) => {
		response.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
		});
		response.end('<!doctype html><html><body><div id="chat">Headless source fixture</div></body></html>');
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	return {
		server,
		url: `http://127.0.0.1:${address.port}/chat`,
	};
}

function requestJson(port, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : JSON.stringify(body);
		const req = http.request({
			host: '127.0.0.1',
			port,
			path: pathname,
			method: payload === null ? 'GET' : 'POST',
			headers: payload === null ? {} : {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload),
			},
		}, (res) => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', chunk => { text += chunk; });
			res.on('end', () => {
				let data = {};
				try { data = text ? JSON.parse(text) : {}; } catch (error) { reject(error); return; }
				resolve({ statusCode: res.statusCode, data });
			});
		});
		req.on('error', reject);
		if (payload !== null) req.write(payload);
		req.end();
	});
}

function waitForEvent(port, eventType, trigger, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		let triggered = false;
		const req = http.request({
			host: '127.0.0.1', port, path: '/api/v1/events', method: 'GET',
		});
		let buffer = '';
		const timer = setTimeout(() => {
			req.destroy();
			reject(new Error(`Timed out waiting for SSE event ${eventType}.`));
		}, timeoutMs);
		req.on('response', res => {
			res.setEncoding('utf8');
			res.on('data', chunk => {
				buffer += chunk;
				const packets = buffer.split('\n\n');
				buffer = packets.pop();
				for (const packet of packets) {
					if (!triggered || !packet.includes(`event: ${eventType}`)) continue;
					clearTimeout(timer);
					req.destroy();
					resolve(packet);
				}
			});
			Promise.resolve().then(() => {
				triggered = true;
				return trigger();
			}).catch(error => {
				clearTimeout(timer);
				req.destroy();
				reject(error);
			});
		});
		req.on('error', error => {
			if (error.code !== 'ECONNRESET') reject(error);
		});
		req.end();
	});
}

async function waitForReady(port, child, timeoutMs = 60000) {
	const started = Date.now();
	let lastResponse = null;
	while (Date.now() - started < timeoutMs) {
		if (child.exitCode !== null) throw new Error(`SSApp exited before the control API became ready (code ${child.exitCode}).`);
		try {
			const response = await requestJson(port, '/api/v1/status');
			lastResponse = response;
			if (response.statusCode === 200 && response.data.ok) return response.data;
		} catch (error) { lastResponse = { error: error.message }; }
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out waiting for the headless SSApp control API. Last response: ${JSON.stringify(lastResponse)}`);
}

async function startApp(port) {
	const child = spawn(electronPath, [
		'.', '--running-from-source', '--multiinstance', '--filesource', socialStreamUrl,
		'--ssapp-headless-control', '--ssapp-control-api', `--ssapp-control-port=${port}`, '--no-hwa',
		...linuxLaunchArgs(),
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDir,
			SSAPP_CONTROL_API: '0',
			SSAPP_HEADLESS_CONTROL: '0',
			SSAPP_CONTROL_PORT: String(port),
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
			SSAPP_DEBUG_LOGS: process.env.SSAPP_E2E_DEBUG || '0',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let output = '';
	child.stdout.on('data', chunk => { output += chunk.toString(); });
	child.stderr.on('data', chunk => { output += chunk.toString(); });
	try {
		const status = await waitForReady(port, child);
		return { child, status, getOutput: () => output };
	} catch (error) {
		child.kill();
		throw new Error(`${error.message}\n${output.slice(-5000)}`);
	}
}

async function assertHeadlessDoesNotEnableControlApi(port) {
	const headlessOnlyProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-headless-no-api-'));
	const child = spawn(electronPath, [
		'.', '--running-from-source', '--multiinstance', '--filesource', socialStreamUrl,
		// Headless on, control API deliberately off — the point of this check.
		'--ssapp-headless-control', `--ssapp-control-port=${port}`, '--no-hwa',
		...linuxLaunchArgs(),
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: headlessOnlyProfile,
			SSAPP_CONTROL_API: '0',
			SSAPP_HEADLESS_CONTROL: '0',
			SSAPP_CONTROL_PORT: String(port),
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
			SSAPP_DEBUG_LOGS: process.env.SSAPP_E2E_DEBUG || '0',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let output = '';
	child.stdout.on('data', chunk => { output += chunk.toString(); });
	child.stderr.on('data', chunk => { output += chunk.toString(); });
	try {
		await new Promise(resolve => setTimeout(resolve, 3000));
		assert.strictEqual(child.exitCode, null, `Headless SSApp exited unexpectedly.\n${output.slice(-5000)}`);
		await assert.rejects(
			requestJson(port, '/api/v1/status'),
			error => error && (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET'),
			'Headless mode unexpectedly enabled the local control API.'
		);
	} finally {
		await stopApp(child);
		fs.rmSync(headlessOnlyProfile, { recursive: true, force: true });
	}
}

async function stopApp(child) {
	if (!child || child.exitCode !== null) return;
	child.kill();
	await Promise.race([
		new Promise(resolve => child.once('exit', resolve)),
		new Promise(resolve => setTimeout(resolve, 5000)),
	]);
}

async function shutdownApp(port, child) {
	const response = await requestJson(port, '/api/v1/command', { action: 'shutdownApp', value: { confirm: true } });
	assert.strictEqual(response.statusCode, 200, JSON.stringify(response.data));
	await Promise.race([
		new Promise(resolve => child.once('exit', resolve)),
		new Promise((_, reject) => setTimeout(() => reject(new Error('SSApp did not shut down gracefully.')), 10000)),
	]);
}

async function command(port, action, value) {
	const response = await requestJson(port, '/api/v1/command', { action, value });
	assert.strictEqual(response.statusCode, 200, `${action}: ${JSON.stringify(response.data)}`);
	assert.strictEqual(response.data.ok, true, JSON.stringify(response.data));
	return { ...response.data.payload, _meta: response.data.meta || {}, _versions: { ssapp: response.data.ssappVersion, api: response.data.apiVersion } };
}

async function waitForSource(port, sourceId, predicate, timeoutMs = 15000) {
	const started = Date.now();
	let lastSource = null;
	while (Date.now() - started < timeoutMs) {
		const response = await requestJson(port, '/api/v1/command', {
			action: 'getSource',
			value: { sourceId },
		});
		if (response.statusCode === 200 && response.data.ok) {
			lastSource = response.data.payload.source;
			if (predicate(lastSource)) return lastSource;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for source ${sourceId}. Last state: ${JSON.stringify(lastSource)}`);
}

async function withTimeout(promise, timeoutMs, message) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function runMcpChecks(port) {
	const child = spawn(process.execPath, [path.join(repoRoot, 'resources', 'ssapp-mcp.js')], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_CONTROL_URL: `http://127.0.0.1:${port}`,
		},
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let stderr = '';
	child.stderr.on('data', chunk => { stderr += chunk.toString(); });
	const responses = new Map();
	let buffer = '';
	child.stdout.on('data', chunk => {
		buffer += chunk.toString();
		let newline;
		while ((newline = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const response = JSON.parse(line);
			responses.set(response.id, response);
		}
	});
	const call = async (id, method, params = {}) => {
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		const started = Date.now();
		while (Date.now() - started < 15000) {
			if (responses.has(id)) return responses.get(id);
			if (child.exitCode !== null) throw new Error(`MCP adapter exited (${child.exitCode}): ${stderr}`);
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		throw new Error(`Timed out waiting for MCP response ${id}: ${stderr}`);
	};
	try {
		const initialized = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ssapp-e2e', version: '1' } });
		assert.strictEqual(initialized.result.serverInfo.name, 'social-stream-ninja');
		const responseCountBeforeNotification = responses.size;
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999, reason: 'e2e' } })}\n`);
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.strictEqual(responses.size, responseCountBeforeNotification, 'MCP adapter responded to a JSON-RPC notification.');
		const listed = await call(2, 'tools/list');
		assert.ok(listed.result.tools.some(tool => tool.name === 'ssapp_get_status'));
		assert.ok(listed.result.tools.some(tool => tool.name === 'ssapp_add_source'));
		assert.strictEqual(listed.result._meta.ssappVersion, expectedSsappVersion);
		const status = await call(3, 'tools/call', { name: 'ssapp_get_status', arguments: {} });
		assert.strictEqual(status.result.structuredContent.ssappVersion, expectedSsappVersion);
		assert.strictEqual(status.result.structuredContent.apiVersion, expectedApiVersion);
	} finally {
		child.stdin.end();
		await Promise.race([
			new Promise(resolve => child.once('exit', resolve)),
			new Promise(resolve => setTimeout(resolve, 2000)),
		]);
		if (child.exitCode === null) child.kill();
	}
}

async function run() {
	const mediaPort = await getFreePort();
	fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify({
		localMediaLibrary: { token: 'c'.repeat(64), port: mediaPort, assets: {} },
	}, null, 2));

	let sourceId = '';
	let appInstance;
	let sourceFixture;
	try {
		sourceFixture = await createSourceFixtureServer();
		const firstPort = await getFreePort();
		appInstance = await startApp(firstPort);
		assert.strictEqual(appInstance.status.app.headless, true);
		assert.strictEqual(appInstance.status.app.mainWindowVisible, false);

		const capabilities = await requestJson(firstPort, '/api/v1/capabilities');
		assert.strictEqual(capabilities.statusCode, 200, JSON.stringify(capabilities.data));
		assert.strictEqual(capabilities.data.payload.sourceControls.add, true);
		assert.strictEqual(capabilities.data.payload.settings.update, true);
		assert.strictEqual(capabilities.data.ssappVersion, expectedSsappVersion);
		assert.strictEqual(capabilities.data.apiVersion, expectedApiVersion);
		assert.ok(capabilities.data.payload.commands.restartSource.confirmationRequired);
		const tokenless = await requestJson(firstPort, '/api/v1/status?token=unused');
		assert.strictEqual(tokenless.statusCode, 200);

		const legacyEndpoint = await requestJson(firstPort, '/windows');
		assert.strictEqual(legacyEndpoint.statusCode, 404, 'Headless control exposed legacy renderer execution endpoints.');
		const legacyPing = await requestJson(firstPort, '/ping');
		assert.strictEqual(legacyPing.statusCode, 404, 'Local control exposed the legacy test harness ping endpoint.');

		const added = await command(firstPort, 'addSource', {
			target: 'twitch',
			username: 'ssapp_llm_test',
			url: `${sourceFixture.url}?access_token=${sourceUrlSecret}`,
			connectionMode: 'classic',
			isMuted: true,
			autoActivate: false,
			idempotencyKey: 'headless-source-test',
		});
		sourceId = added.source.id;
		assert.ok(sourceId);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(added.source, 'url'), false);
		assert.strictEqual(added.source.tabId, null);
		assert.strictEqual(added._versions.ssapp, expectedSsappVersion);
		assert.strictEqual(added._versions.api, expectedApiVersion);
		const statusAfterAdd = await requestJson(firstPort, '/api/v1/status');
		assert.strictEqual(statusAfterAdd.statusCode, 200, JSON.stringify(statusAfterAdd.data));
		assert.strictEqual(JSON.stringify(statusAfterAdd.data).includes(sourceUrlSecret), false);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(statusAfterAdd.data.sources[0], 'url'), false);
		const operation = await requestJson(firstPort, `/api/v1/operations/${added._meta.operationId}`);
		assert.strictEqual(operation.statusCode, 200, JSON.stringify(operation.data));
		assert.strictEqual(operation.data.payload.operation.status, 'completed');
		const replayed = await command(firstPort, 'addSource', {
			target: 'twitch', username: 'ignored-retry', idempotencyKey: 'headless-source-test',
		});
		assert.strictEqual(replayed.source.id, sourceId);

		const updated = await command(firstPort, 'updateSource', {
			sourceId,
			updates: { username: 'ssapp_llm_test_updated', url: '', replyOnly: true },
		});
		assert.strictEqual(updated.source.username, 'ssapp_llm_test_updated');
		assert.strictEqual(Object.prototype.hasOwnProperty.call(updated.source, 'url'), false);

		const startedSource = await command(firstPort, 'startSource', { sourceId });
		assert.strictEqual(startedSource.accepted, true);
		const activeSource = await waitForSource(
			firstPort,
			sourceId,
			source => source.status === 'active' && Number.isFinite(source.tabId)
		);
		assert.strictEqual(activeSource.connectionMode, 'classic');

		const blockedActiveUpdates = {
			url: `${sourceFixture.url}/changed`,
			username: 'should_not_apply',
			videoId: 'should_not_apply',
			connectionMode: 'websocket',
			isVisible: false,
			isMuted: false,
			replyOnly: false,
			accountRole: 'bot',
			customSession: 'should-not-apply',
		};
		for (const [setting, settingValue] of Object.entries(blockedActiveUpdates)) {
			const response = await requestJson(firstPort, '/api/v1/command', {
				action: 'updateSource',
				value: { sourceId, updates: { [setting]: settingValue } },
			});
			assert.strictEqual(response.statusCode, 409, `${setting}: ${JSON.stringify(response.data)}`);
			assert.strictEqual(response.data.error.code, 'STATE_CONFLICT', `${setting}: ${JSON.stringify(response.data)}`);
		}

		const futureActivationUpdate = await command(firstPort, 'updateSource', {
			sourceId,
			updates: { autoActivate: true },
		});
		assert.strictEqual(futureActivationUpdate.source.autoActivate, true);
		const liveMuteUpdate = await command(firstPort, 'setSourceMute', { sourceId, isMuted: false });
		assert.strictEqual(liveMuteUpdate.source.isMuted, false);
		const liveVisibilityUpdate = await command(firstPort, 'setSourceVisibility', { sourceId, isVisible: false });
		assert.strictEqual(liveVisibilityUpdate.source.isVisible, false);

		await withTimeout(
			command(firstPort, 'stopSource', { sourceId }),
			10000,
			'Headless stopSource timed out while waiting for renderer progress.'
		);
		await waitForSource(firstPort, sourceId, source => source.status === 'inactive' && source.tabId === null);
		const resetFutureActivation = await command(firstPort, 'updateSource', {
			sourceId,
			updates: { autoActivate: false, isVisible: true },
		});
		assert.strictEqual(resetFutureActivation.source.autoActivate, false);
		assert.strictEqual(resetFutureActivation.source.isVisible, true);

		let settings;
		await waitForEvent(firstPort, 'status.changed', async () => {
			settings = await command(firstPort, 'updateSettings', { settings: { youtubeAutoCleanup: true } });
		});
		assert.strictEqual(settings.settings.youtubeAutoCleanup, true);
		const unsafeSetting = await requestJson(firstPort, '/api/v1/command', {
			action: 'updateSettings', value: { settings: { arbitrarySecret: 'blocked' } },
		});
		assert.strictEqual(unsafeSetting.statusCode, 400);
		assert.strictEqual(unsafeSetting.data.error.code, 'INVALID_TARGET');
		const reloaded = await command(firstPort, 'reloadApp', { confirm: true });
		assert.strictEqual(reloaded.accepted, true);
		await new Promise(resolve => setTimeout(resolve, 500));
		const afterReload = await waitForReady(firstPort, appInstance.child);
		assert.strictEqual(afterReload.app.mainWindowVisible, false);
		const sourcesAfterReload = await command(firstPort, 'getSources', {});
		assert.ok(sourcesAfterReload.sources.some(source => source.id === sourceId));
		await runMcpChecks(firstPort);
		await shutdownApp(firstPort, appInstance.child);
		appInstance = null;

		const secondPort = await getFreePort();
		appInstance = await startApp(secondPort);
		assert.strictEqual(appInstance.status.app.mainWindowVisible, false);
		const sources = await command(secondPort, 'getSources', {});
		assert.ok(sources.sources.some(source => source.id === sourceId && source.username === 'ssapp_llm_test_updated'));
		const persistedSettings = await command(secondPort, 'getSettings', {});
		assert.strictEqual(persistedSettings.settings.youtubeAutoCleanup, true);
		const removed = await command(secondPort, 'removeSource', { sourceId, confirm: true });
		assert.strictEqual(removed.removed, true);
		await shutdownApp(secondPort, appInstance.child);
		appInstance = null;

		const disabledPort = await getFreePort();
		await assertHeadlessDoesNotEnableControlApi(disabledPort);

		console.log('Headless launch and local LLM control API end-to-end checks passed, including API opt-in, active-source guards, stop progress, and persistence.');
	} catch (error) {
		throw new Error(`${error.message}\n${appInstance ? appInstance.getOutput().slice(-5000) : ''}`);
	} finally {
		if (appInstance) await stopApp(appInstance.child);
		if (sourceFixture && sourceFixture.server.listening) {
			await new Promise(resolve => sourceFixture.server.close(resolve));
		}
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

run().catch(error => {
	console.error(error);
	process.exit(1);
});
