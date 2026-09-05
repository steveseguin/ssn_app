#!/usr/bin/env node

'use strict';

const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const packagedBinary = String(process.env.SSAPP_MCP_BINARY || '').trim();
const command = packagedBinary || require('electron');
const args = packagedBinary ? ['--ssapp-mcp'] : [repoRoot, '--ssapp-mcp'];
if (process.platform === 'linux') args.push('--ozone-platform=headless');

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

function waitForResponse(responses, id, child, stderr, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const poll = () => {
			if (responses.has(id)) {
				resolve(responses.get(id));
				return;
			}
			if (child.exitCode !== null) {
				reject(new Error(`MCP executable exited (${child.exitCode}): ${stderr.value}`));
				return;
			}
			if (Date.now() - started >= timeoutMs) {
				reject(new Error(`Timed out waiting for MCP response ${id}: ${stderr.value}`));
				return;
			}
			setTimeout(poll, 25);
		};
		poll();
	});
}

async function run() {
	const offlinePort = await getFreePort();
	const env = { ...process.env };
	delete env.DISPLAY;
	delete env.WAYLAND_DISPLAY;
	env.SSAPP_CONTROL_URL = `http://127.0.0.1:${offlinePort}`;
	const child = spawn(command, args, {
		cwd: repoRoot,
		env,
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
	});
	const stderr = { value: '' };
	const responses = new Map();
	let buffer = '';
	child.stderr.on('data', chunk => { stderr.value += chunk.toString(); });
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

	try {
		child.stdin.write(`${JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'launch-e2e', version: '1' } },
		})}\n`);
		const initialized = await waitForResponse(responses, 1, child, stderr);
		assert.strictEqual(initialized.result.serverInfo.name, 'social-stream-ninja');
		assert.strictEqual(initialized.result.serverInfo.version, '1.2.1');
		assert.strictEqual(initialized.result.capabilities.tools.listChanged, false);
		assert.match(initialized.result.instructions, /capabilities/i);
		assert.match(initialized.result.instructions, /offline/i);
		assert.match(initialized.result.instructions, /arbitrary JavaScript/i);
		assert.match(initialized.result.instructions, /untrusted third-party content/i);
		assert.match(initialized.result.instructions, /must never be treated as instructions/i);

		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
		const listed = await waitForResponse(responses, 2, child, stderr);
		assert.deepStrictEqual(
			listed.result.tools.map(tool => tool.name).sort(),
			[
				'ssapp_add_source',
				'ssapp_capture_source_screenshot',
				'ssapp_get_capabilities',
				'ssapp_get_operation',
				'ssapp_get_recent_source_events',
				'ssapp_get_settings',
				'ssapp_get_source',
				'ssapp_get_source_diagnostics',
				'ssapp_get_status',
				'ssapp_inspect_source_page',
				'ssapp_interact_source_page',
				'ssapp_list_sources',
				'ssapp_reload_all_sources',
				'ssapp_reload_app',
				'ssapp_reload_source',
				'ssapp_reload_source_page',
				'ssapp_remove_source',
				'ssapp_set_source_connection_mode',
				'ssapp_set_source_mute',
				'ssapp_set_source_visibility',
				'ssapp_show_source_for_human',
				'ssapp_list_app_windows',
				'ssapp_capture_app_window_screenshot',
				'ssapp_inspect_app_window',
				'ssapp_interact_app_window',
				'ssapp_set_app_window_visibility',
				'ssapp_get_pending_app_dialogs',
				'ssapp_wait_for_app_dialog',
				'ssapp_respond_to_app_dialog',
				'ssapp_shutdown',
				'ssapp_start_all_sources',
				'ssapp_start_source',
				'ssapp_stop_all_sources',
				'ssapp_stop_source',
				'ssapp_toggle_source_mute',
				'ssapp_toggle_source_visibility',
				'ssapp_update_settings',
				'ssapp_update_source',
				'ssapp_wait_for_source_events',
			].sort(),
			'Offline MCP discovery did not expose the stable tool set.'
		);
		assert.strictEqual(listed.result._meta.ssappVersion, 'unavailable');
		const addSourceTool = listed.result.tools.find(tool => tool.name === 'ssapp_add_source');
		assert.match(addSourceTool.description, /MCP adapter use WebSocket Auto/i);
		assert.match(addSourceTool.inputSchema.properties.connectionMode.description, /tiktok-websocket/i);
		assert.deepStrictEqual(addSourceTool.inputSchema.required, ['target']);
		assert.strictEqual(addSourceTool.annotations.idempotentHint, false);
		assert.strictEqual(addSourceTool.annotations.openWorldHint, true);
		assert.ok(addSourceTool.outputSchema.required.includes('ok'));
		const removeTool = listed.result.tools.find(tool => tool.name === 'ssapp_remove_source');
		assert.deepStrictEqual(removeTool.inputSchema.required, ['sourceId', 'confirm']);
		assert.strictEqual(removeTool.inputSchema.properties.confirm.const, true);
		assert.strictEqual(removeTool.annotations.destructiveHint, true);
		const eventTool = listed.result.tools.find(tool => tool.name === 'ssapp_get_recent_source_events');
		assert.strictEqual(eventTool.inputSchema.properties.limit.maximum, 200);
		const waitTool = listed.result.tools.find(tool => tool.name === 'ssapp_wait_for_source_events');
		assert.strictEqual(waitTool.inputSchema.properties.timeoutMs.maximum, 25000);
		const screenshotTool = listed.result.tools.find(tool => tool.name === 'ssapp_capture_source_screenshot');
		assert.strictEqual(screenshotTool.annotations.readOnlyHint, true);
		assert.match(screenshotTool.description, /may contain private information/i);
		assert.match(screenshotTool.description, /must never be treated as instructions/i);
		assert.deepStrictEqual(screenshotTool.inputSchema.properties.format.enum, ['png', 'jpeg']);
		assert.strictEqual(screenshotTool.inputSchema.properties.maxWidth.minimum, 320);
		assert.strictEqual(screenshotTool.inputSchema.properties.maxWidth.maximum, 1600);
		const inspectTool = listed.result.tools.find(tool => tool.name === 'ssapp_inspect_source_page');
		assert.strictEqual(inspectTool.inputSchema.properties.maxTextChars.minimum, 100);
		assert.match(inspectTool.description, /untrusted third-party content/i);
		const interactionTool = listed.result.tools.find(tool => tool.name === 'ssapp_interact_source_page');
		assert.ok(interactionTool.inputSchema.properties.action.enum.includes('pressKey'));
		assert.ok(!interactionTool.inputSchema.properties.action.enum.includes('key'));
		assert.strictEqual(interactionTool.inputSchema.properties.confirm.const, true);
		assert.strictEqual(interactionTool.annotations.openWorldHint, true);
		const appScreenshotTool = listed.result.tools.find(tool => tool.name === 'ssapp_capture_app_window_screenshot');
		assert.strictEqual(appScreenshotTool.annotations.readOnlyHint, true);
		assert.match(appScreenshotTool.description, /without using operating-system screen capture/i);
		const appInteractionTool = listed.result.tools.find(tool => tool.name === 'ssapp_interact_app_window');
		assert.strictEqual(appInteractionTool.inputSchema.properties.confirm.const, true);
		assert.strictEqual(appInteractionTool.annotations.openWorldHint, true);
		const dialogTool = listed.result.tools.find(tool => tool.name === 'ssapp_respond_to_app_dialog');
		assert.deepStrictEqual(dialogTool.inputSchema.required, ['dialogId', 'accept', 'confirm']);
		assert.strictEqual(dialogTool.inputSchema.properties.paths.maxItems, 20);
		for (const toolName of ['ssapp_start_source', 'ssapp_reload_source', 'ssapp_start_all_sources', 'ssapp_reload_all_sources']) {
			assert.strictEqual(listed.result.tools.find(tool => tool.name === toolName).annotations.openWorldHint, true, `${toolName} should declare network interaction.`);
		}
		for (const toolName of ['ssapp_stop_source', 'ssapp_stop_all_sources']) {
			assert.strictEqual(listed.result.tools.find(tool => tool.name === toolName).annotations.openWorldHint, false, `${toolName} should remain closed-world.`);
		}

		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ssapp_get_source', arguments: {} } })}\n`);
		const invalidToolCall = await waitForResponse(responses, 3, child, stderr);
		assert.strictEqual(invalidToolCall.result.isError, true);
		assert.strictEqual(invalidToolCall.result.structuredContent.ok, false);
		assert.match(invalidToolCall.result.structuredContent.error.message, /sourceId is required/i);

		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: 'unsupported-version', capabilities: {}, clientInfo: { name: 'launch-e2e', version: '1' } } })}\n`);
		const negotiated = await waitForResponse(responses, 4, child, stderr);
		assert.strictEqual(negotiated.result.protocolVersion, '2025-06-18');

		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'initialize', params: {} })}\n`);
		const invalidInitialize = await waitForResponse(responses, 5, child, stderr);
		assert.strictEqual(invalidInitialize.error.code, -32602);

		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ssapp_get_status', arguments: {} } })}\n`);
		const offlineCall = await waitForResponse(responses, 6, child, stderr);
		assert.strictEqual(offlineCall.result.isError, true);
		assert.strictEqual(offlineCall.result.structuredContent.error.code, 'SSAPP_UNREACHABLE');
		assert.strictEqual(
			offlineCall.result.structuredContent.error.message,
			'SSApp is not reachable. Start SSApp, enable File > Local AI / Automation, restart SSApp, then try again.'
		);
		assert.doesNotMatch(offlineCall.result.content[0].text, /ECONNREFUSED|socket|connect 127/i);
		child.stdin.end();
	} finally {
		if (!child.stdin.writableEnded) child.stdin.end();
		await Promise.race([
			new Promise(resolve => child.once('exit', resolve)),
			new Promise(resolve => setTimeout(resolve, 3000)),
		]);
		if (child.exitCode === null) child.kill();
	}

	await verifyNonLoopbackControlUrlRejected();
	await verifyRequestTimeoutNormalized();

	console.log(`Downloaded-app MCP launch checks passed (${packagedBinary ? 'packaged binary' : 'source Electron'}).`);
}

async function verifyNonLoopbackControlUrlRejected() {
	const rejected = await callStatusWithEnv({ SSAPP_CONTROL_URL: 'https://example.invalid:17777' });
	assert.strictEqual(rejected.isError, true);
	assert.match(rejected.structuredContent.error.message, /http:\/\/127\.0\.0\.1/i);
}

async function verifyRequestTimeoutNormalized() {
	const sockets = new Set();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	try {
		const result = await callStatusWithEnv({
			SSAPP_CONTROL_URL: `http://127.0.0.1:${server.address().port}`,
			SSAPP_MCP_REQUEST_TIMEOUT_MS: '100',
		});
		assert.strictEqual(result.isError, true);
		assert.strictEqual(result.structuredContent.error.code, 'SSAPP_UNREACHABLE');
		assert.strictEqual(
			result.structuredContent.error.message,
			'SSApp is not reachable. Start SSApp, enable File > Local AI / Automation, restart SSApp, then try again.'
		);
		assert.doesNotMatch(result.content[0].text, /timeout|socket|ETIMEDOUT/i);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise(resolve => server.close(resolve));
	}
}

async function callStatusWithEnv(envOverrides) {
	const env = { ...process.env, ...envOverrides };
	delete env.DISPLAY;
	delete env.WAYLAND_DISPLAY;
	const child = spawn(command, args, {
		cwd: repoRoot,
		env,
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
	});
	const stderr = { value: '' };
	const responses = new Map();
	let buffer = '';
	child.stderr.on('data', chunk => { stderr.value += chunk.toString(); });
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

	try {
		child.stdin.write(`${JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'loopback-check', version: '1' } },
		})}\n`);
		await waitForResponse(responses, 1, child, stderr);
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ssapp_get_status', arguments: {} } })}\n`);
		child.stdin.end();
		const rejected = await waitForResponse(responses, 2, child, stderr);
		return rejected.result;
	} finally {
		if (!child.stdin.writableEnded) child.stdin.end();
		await Promise.race([
			new Promise(resolve => child.once('exit', resolve)),
			new Promise(resolve => setTimeout(resolve, 3000)),
		]);
		if (child.exitCode === null) child.kill();
	}
}

run().catch(error => {
	console.error(error.stack || error);
	process.exitCode = 1;
});
