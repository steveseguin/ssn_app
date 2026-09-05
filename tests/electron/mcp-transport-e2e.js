'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const root = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
	const server = net.createServer();
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

function startAdapter(port) {
	const binary = process.env.SSAPP_TEST_APP;
	const child = spawn(binary || process.execPath,
		binary ? ['--ssapp-mcp', ...(process.platform === 'linux' ? ['--ozone-platform=headless'] : [])] : [path.join(root, 'resources/ssapp-mcp.js')], {
			env: { ...process.env, SSAPP_CONTROL_URL: `http://127.0.0.1:${port}`, SSAPP_MCP_REQUEST_TIMEOUT_MS: '35000' },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	let output = '';
	let stderr = '';
	child.stdout.on('data', chunk => { output += chunk; });
	child.stderr.on('data', chunk => { stderr += chunk; });
	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
		protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'transport-e2e', version: '1' },
	} })}\n`);
	const send = (id, name, args = {}) => child.stdin.write(`${JSON.stringify({
		jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
	})}\n`);
	const response = async (id, timeoutMs = 15000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			for (const line of output.split('\n').slice(0, -1)) {
				const result = JSON.parse(line);
				if (result.id === id) return result;
			}
			await delay(25);
		}
		throw new Error(`MCP reply ${id} missing; received ${output.length} bytes. ${stderr}`);
	};
	return { child, send, response };
}

async function run() {
	const port = await freePort();
	const binary = process.env.SSAPP_TEST_APP;
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-mcp-transport-'));
	const app = await _electron.launch({
		executablePath: binary || require('electron'), cwd: root,
		args: [
			...(binary ? [] : ['.', '--running-from-source', '--filesource', pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href]),
			'--multiinstance', '--no-hwa', '--ssapp-control-api', `--ssapp-control-port=${port}`, ...linuxLaunchArgs(),
		],
		env: { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_PREFER_LOCAL_ASSETS: binary ? '1' : '0' },
		timeout: 60000,
	});
	const adapters = [];
	let proxy;
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.stateManager?.initialized, null, { polling: 100 });
		let interruptResponse = true;
		// Forward a real app response, then drop the connection after headers and a
		// partial body. This reproduces losing SSApp midway through a tool call.
		proxy = http.createServer((incoming, outgoing) => {
			const upstream = http.request({ hostname: '127.0.0.1', port, path: incoming.url, method: incoming.method }, response => {
				response.on('error', () => {});
				outgoing.writeHead(response.statusCode, response.headers);
				if (!interruptResponse) return response.pipe(outgoing);
				response.once('data', chunk => {
					outgoing.write(chunk.subarray(0, 20));
					setTimeout(() => { outgoing.destroy(); upstream.destroy(); }, 50);
				});
			});
			upstream.on('error', () => outgoing.destroy());
			incoming.pipe(upstream);
		});
		await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
		const interrupted = startAdapter(proxy.address().port);
		adapters.push(interrupted);
		assert.strictEqual((await interrupted.response(0)).result.serverInfo.version, '1.2.2');
		interrupted.send(1, 'ssapp_get_status');
		const failed = await interrupted.response(1, 5000);
		assert.strictEqual(failed.result.structuredContent.error.code, 'SSAPP_UNREACHABLE');
		interruptResponse = false;
		interrupted.send(2, 'ssapp_get_status');
		assert.strictEqual((await interrupted.response(2)).result.structuredContent.ok, true, 'Adapter could not recover after interrupted response');

		// Draw a local high-detail fixture in the real app window so the real screenshot
		// exceeds a pipe buffer. No external page or screenshot response is substituted.
		await page.evaluate(() => {
			const canvas = document.createElement('canvas');
			canvas.width = 1300;
			canvas.height = 850;
			Object.assign(canvas.style, { position: 'fixed', inset: '0', zIndex: '999999' });
			document.body.append(canvas);
			const context = canvas.getContext('2d');
			const image = context.createImageData(canvas.width, canvas.height);
			for (let offset = 0; offset < image.data.length; offset += 65536) {
				crypto.getRandomValues(image.data.subarray(offset, Math.min(offset + 65536, image.data.length)));
			}
			context.putImageData(image, 0, 0);
		});
		await delay(250);
		const screenshot = startAdapter(port);
		adapters.push(screenshot);
		screenshot.child.stdout.pause();
		screenshot.send(3, 'ssapp_capture_app_window_screenshot', { format: 'png', maxWidth: 1600 });
		screenshot.child.stdin.end();
		await delay(1500);
		screenshot.child.stdout.resume();
		const reply = await screenshot.response(3);
		assert.notStrictEqual(reply.result.isError, true, JSON.stringify(reply.result));
		const image = reply.result.content.find(item => item.type === 'image');
		assert.ok(image && image.data.length > 256 * 1024, 'Fixture screenshot did not exceed the pipe buffer');
		assert.strictEqual(Buffer.from(image.data, 'base64').subarray(1, 4).toString(), 'PNG');
		for (let attempt = 0; attempt < 100 && screenshot.child.exitCode === null; attempt++) await delay(25);
		assert.strictEqual(screenshot.child.exitCode, 0, 'Adapter did not exit after draining stdout');
		console.log(`PASS real-app interrupted response/recovery and complete screenshot after stdin EOF (${image.data.length} base64 bytes, ${binary ? 'packaged' : 'source'}).`);
	} finally {
		for (const adapter of adapters) {
			if (adapter.child.exitCode === null) adapter.child.kill();
		}
		if (proxy) {
			proxy.closeAllConnections();
			await new Promise(resolve => proxy.close(resolve));
		}
		await app.close();
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
