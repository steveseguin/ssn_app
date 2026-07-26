#!/usr/bin/env node

'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const packagedBinary = String(process.env.SSAPP_MCP_BINARY || '').trim();
const command = packagedBinary || require('electron');
const args = packagedBinary ? ['--ssapp-mcp'] : [repoRoot, '--ssapp-mcp'];
if (process.platform === 'linux') args.push('--ozone-platform=headless');

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
	const env = { ...process.env };
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
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'launch-e2e', version: '1' } },
		})}\n`);
		const initialized = await waitForResponse(responses, 1, child, stderr);
		assert.strictEqual(initialized.result.serverInfo.name, 'social-stream-ninja');
		assert.strictEqual(initialized.result.serverInfo.version, '1.0.4');
		assert.match(initialized.result.instructions, /capabilities/i);

		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
		child.stdin.end();
		const listed = await waitForResponse(responses, 2, child, stderr);
		assert.ok(listed.result.tools.some(tool => tool.name === 'ssapp_get_capabilities'));
		assert.ok(listed.result.tools.some(tool => tool.name === 'ssapp_get_status'));
	} finally {
		if (!child.stdin.writableEnded) child.stdin.end();
		await Promise.race([
			new Promise(resolve => child.once('exit', resolve)),
			new Promise(resolve => setTimeout(resolve, 3000)),
		]);
		if (child.exitCode === null) child.kill();
	}

	console.log(`Downloaded-app MCP launch checks passed (${packagedBinary ? 'packaged binary' : 'source Electron'}).`);
}

run().catch(error => {
	console.error(error.stack || error);
	process.exitCode = 1;
});
