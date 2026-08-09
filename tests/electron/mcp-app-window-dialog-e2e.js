#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const { AppDialogService } = require('../../resources/app-dialog-service');

const electronPath = require('electron');
const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const socialStreamUrl = pathToFileURL(socialStreamRoot + path.sep).href;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-mcp-app-window-dialog-'));
const token = `mcp-app-window-dialog-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
		const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
		const request = http.request({
			host: '127.0.0.1', port,
			path: `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
			method: payload ? 'POST' : 'GET',
			headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
		}, response => {
			let text = '';
			response.setEncoding('utf8');
			response.on('data', chunk => { text += chunk; });
			response.on('end', () => {
				let json;
				try { json = text ? JSON.parse(text) : {}; } catch (error) { reject(error); return; }
				if (response.statusCode >= 200 && response.statusCode < 300) resolve(json);
				else reject(new Error(`HTTP ${response.statusCode}: ${text}`));
			});
		});
		request.on('error', reject);
		if (payload) request.write(payload);
		request.end();
	});
}

function createMcpSession(port) {
	const child = spawn(process.execPath, [path.join(repoRoot, 'resources', 'ssapp-mcp.js')], {
		cwd: repoRoot,
		env: { ...process.env, SSAPP_CONTROL_URL: `http://127.0.0.1:${port}` },
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let nextId = 1;
	let stderr = '';
	let buffer = '';
	const responses = new Map();
	child.stderr.on('data', chunk => { stderr += chunk.toString(); });
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
	const request = async (method, params = {}, timeoutMs = 40000) => {
		const id = nextId++;
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			if (responses.has(id)) {
				const response = responses.get(id);
				responses.delete(id);
				return response;
			}
			if (child.exitCode !== null) throw new Error(`MCP exited (${child.exitCode}): ${stderr}`);
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		throw new Error(`Timed out waiting for MCP ${method}: ${stderr}`);
	};
	const call = async (name, args = {}, allowError = false) => {
		const response = await request('tools/call', { name, arguments: args });
		assert.ok(!response.error, `${name}: ${JSON.stringify(response)}`);
		if (!allowError) assert.notStrictEqual(response.result?.isError, true, `${name}: ${JSON.stringify(response.result)}`);
		return response.result;
	};
	const close = async () => {
		if (!child.stdin.writableEnded) child.stdin.end();
		await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
		if (child.exitCode === null) child.kill();
	};
	return { request, call, close };
}

function normalizedResult(toolResult) {
	return toolResult?.structuredContent?.result || toolResult?.structuredContent || {};
}

function payloadOf(toolResult) {
	const result = normalizedResult(toolResult);
	return result.payload || result.result?.payload || {};
}

async function waitFor(predicate, label, timeoutMs = 30000) {
	const started = Date.now();
	let lastError;
	while (Date.now() - started < timeoutMs) {
		try {
			const result = await predicate();
			if (result) return result;
		} catch (error) { lastError = error; }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function removeProfile() {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try { fs.rmSync(profileDir, { recursive: true, force: true }); return; } catch (_) { }
		await new Promise(resolve => setTimeout(resolve, 200));
	}
}

async function validateUnarmedDialogFallback() {
	let nativeCalls = 0;
	const fakeDialog = {
		showMessageBox: async () => { nativeCalls += 1; return { response: 0, checkboxChecked: false }; },
		showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
		showSaveDialog: async () => ({ canceled: true }),
		showErrorBox: () => { nativeCalls += 1; },
	};
	const service = new AppDialogService({ getMainWindow: () => null });
	service.install(fakeDialog);
	assert.deepStrictEqual(await fakeDialog.showMessageBox({ message: 'normal user prompt' }), { response: 0, checkboxChecked: false });
	assert.strictEqual(nativeCalls, 1, 'An unarmed automation service changed the normal dialog path.');
	service.close();
}

async function run() {
	await validateUnarmedDialogFallback();
	const port = await getFreePort();
	const app = spawn(electronPath, [
		'.', '--running-from-source', '--multiinstance', '--filesource', socialStreamUrl,
		'--remote-control', '--ssapp-control-api', '--ssapp-headless-control', `--ssapp-control-port=${port}`, '--no-hwa', ...linuxLaunchArgs(),
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDir,
			SSAPP_REMOTE_CONTROL_TOKEN: token,
			SSAPP_CONTROL_API: '0',
			SSAPP_CONTROL_PORT: String(port),
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let output = '';
	app.stdout.on('data', chunk => { output += chunk.toString(); });
	app.stderr.on('data', chunk => { output += chunk.toString(); });
	const mcp = createMcpSession(port);
	let mainWindow;
	const execute = code => requestJson(port, '/exec', { windowId: mainWindow.id, code });
	try {
		await waitFor(async () => {
			const windows = await requestJson(port, '/windows');
			mainWindow = (windows.windows || []).find(window => /index\.html/i.test(window.url || ''));
			return mainWindow;
		}, 'main SSApp window', 60000);
		await new Promise(resolve => setTimeout(resolve, 2500));

		await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ssapp-window-dialog-e2e', version: '1.0.0' } });
		const listedTools = await mcp.request('tools/list');
		const toolNames = new Set((listedTools.result?.tools || []).map(tool => tool.name));
		for (const name of [
			'ssapp_list_app_windows', 'ssapp_capture_app_window_screenshot', 'ssapp_inspect_app_window',
			'ssapp_interact_app_window', 'ssapp_set_app_window_visibility', 'ssapp_get_pending_app_dialogs',
			'ssapp_wait_for_app_dialog', 'ssapp_respond_to_app_dialog',
		]) assert.ok(toolNames.has(name), `Missing MCP tool ${name}.`);
		const unarmed = await execute(`window.ninjafy.requestAutomationJavaScriptDialog({ type: 'prompt', message: 'unarmed audit' })`);
		assert.deepStrictEqual(unarmed.result, { intercepted: false }, 'Local AI changed prompts before MCP UI/dialog control was used.');

		const windows = payloadOf(await mcp.call('ssapp_list_app_windows')).windows;
		const main = windows.find(window => window.kind === 'main');
		assert.ok(main?.windowId, JSON.stringify(windows));
		assert.ok(!/Users|home|steve/i.test(main.redactedUrl), main.redactedUrl);

		const screenshot = await mcp.call('ssapp_capture_app_window_screenshot', { windowId: main.windowId, format: 'png', maxWidth: 800 });
		const image = (screenshot.content || []).find(item => item.type === 'image');
		const imageBuffer = image?.data ? Buffer.from(image.data, 'base64') : Buffer.alloc(0);
		assert.ok(imageBuffer.length > 1000, 'App-window screenshot was missing.');
		const imageStats = await require('sharp')(imageBuffer).stats();
		assert.ok(imageStats.channels.some(channel => channel.stdev > 2), 'App-window screenshot was blank.');
		assert.strictEqual(JSON.stringify(screenshot.structuredContent).includes(image.data), false, 'Screenshot bytes leaked into structured output.');
		const afterCapture = payloadOf(await mcp.call('ssapp_list_app_windows')).windows.find(window => window.windowId === main.windowId);
		assert.strictEqual(afterCapture.visible, false, 'Headless screenshot left the SSApp window visible.');

		await execute(`window.open('data:text/html,<title>MCP child window</title><button>Child popup control</button>'); true`);
		let childWindow;
		await waitFor(async () => {
			const current = payloadOf(await mcp.call('ssapp_list_app_windows')).windows;
			childWindow = current.find(window => window.windowId !== main.windowId && window.title === 'MCP child window');
			return childWindow;
		}, 'SSApp child window');
		const childInspection = payloadOf(await mcp.call('ssapp_inspect_app_window', { windowId: childWindow.windowId }));
		assert.ok((childInspection.elements || []).some(element => element.name === 'Child popup control'));
		const childScreenshot = await mcp.call('ssapp_capture_app_window_screenshot', { windowId: childWindow.windowId, format: 'png' });
		assert.ok((childScreenshot.content || []).some(item => item.type === 'image' && Buffer.from(item.data, 'base64').length > 1000));

		await execute(`(() => {
			const fixture = document.createElement('div');
			fixture.id = 'mcp-reverse-order-fixture';
			for (let index = 0; index < 225; index += 1) {
				const button = document.createElement('button');
				button.textContent = 'Reverse filler ' + index;
				fixture.appendChild(button);
			}
			const lateButton = document.createElement('button');
			lateButton.textContent = 'Late modal control';
			lateButton.onclick = () => { window.__mcpLateControlClicked = true; };
			fixture.appendChild(lateButton);
			document.body.appendChild(fixture);
			return true;
		})()`);
		const reverseInspection = payloadOf(await mcp.call('ssapp_inspect_app_window', {
			windowId: main.windowId,
			maxElements: 20,
			maxTextChars: 1000,
			elementOrder: 'reverse',
		}));
		const lateButton = (reverseInspection.elements || []).find(element => element.name === 'Late modal control');
		assert.ok(lateButton?.ref, JSON.stringify(reverseInspection));
		await mcp.call('ssapp_interact_app_window', {
			windowId: main.windowId,
			ref: lateButton.ref,
			action: 'click',
			confirm: true,
		});
		assert.strictEqual((await execute('window.__mcpLateControlClicked')).result, true);
		await execute(`document.getElementById('mcp-reverse-order-fixture')?.remove(); true`);

		await execute(`(() => {
			const button = document.createElement('button');
			button.textContent = 'Open MCP audit prompt';
			button.onclick = () => { window.__mcpPromptAnswer = window.prompt('MCP blocking prompt audit', 'sample'); };
			document.body.appendChild(button);
			return true;
		})()`);
		const inspection = payloadOf(await mcp.call('ssapp_inspect_app_window', { windowId: main.windowId, maxElements: 200, maxTextChars: 12000 }));
		const promptButton = (inspection.elements || []).find(element => element.name === 'Open MCP audit prompt');
		assert.ok(promptButton?.ref, JSON.stringify(inspection));
		const beforePrompt = payloadOf(await mcp.call('ssapp_get_pending_app_dialogs'));
		await mcp.call('ssapp_interact_app_window', { windowId: main.windowId, ref: promptButton.ref, action: 'click', confirm: true });
		const promptWait = payloadOf(await mcp.call('ssapp_wait_for_app_dialog', { afterId: beforePrompt.cursor, timeoutMs: 5000 }));
		const prompt = promptWait.dialogs.find(dialog => dialog.origin === 'javascript' && dialog.kind === 'prompt');
		assert.ok(prompt && prompt.message === 'MCP blocking prompt audit', JSON.stringify(promptWait));
		assert.ok(!/Users|home|steve/i.test(prompt.redactedUrl), prompt.redactedUrl);
		await mcp.call('ssapp_respond_to_app_dialog', { dialogId: prompt.dialogId, accept: true, promptText: 'answered-through-mcp', confirm: true });
		assert.strictEqual((await execute('window.__mcpPromptAnswer')).result, 'answered-through-mcp');

		const beforeMessage = payloadOf(await mcp.call('ssapp_get_pending_app_dialogs'));
		await execute(`require('electron').ipcRenderer.send('alert', { title: 'MCP native message', val: 'Native message body' }); true`);
		const messageWait = payloadOf(await mcp.call('ssapp_wait_for_app_dialog', { afterId: beforeMessage.cursor, timeoutMs: 5000 }));
		const message = messageWait.dialogs.find(dialog => dialog.origin === 'electron' && dialog.kind === 'message');
		assert.ok(message && message.title === 'MCP native message', JSON.stringify(messageWait));
		const dialogScreenshot = await mcp.call('ssapp_capture_app_window_screenshot', { windowId: main.windowId, format: 'png', maxWidth: 800 });
		assert.ok((dialogScreenshot.content || []).some(item => item.type === 'image' && Buffer.from(item.data, 'base64').length > 1000));
		const messageInspection = payloadOf(await mcp.call('ssapp_inspect_app_window', { windowId: main.windowId, maxElements: 200, maxTextChars: 12000 }));
		const okButton = (messageInspection.elements || []).find(element => element.name === 'OK');
		assert.ok(okButton?.ref, JSON.stringify(messageInspection));
		await mcp.call('ssapp_interact_app_window', { windowId: main.windowId, ref: okButton.ref, action: 'click', confirm: true });
		await waitFor(async () => {
			const pending = payloadOf(await mcp.call('ssapp_get_pending_app_dialogs'));
			return !pending.dialogs.some(dialog => dialog.dialogId === message.dialogId);
		}, 'semantic Electron-dialog click');

		const openPath = path.join(profileDir, 'mcp-selected-input.txt');
		fs.writeFileSync(openPath, 'MCP dialog input fixture');
		const beforeOpen = payloadOf(await mcp.call('ssapp_get_pending_app_dialogs'));
		await execute(`window.__mcpOpenResult = null; require('electron').ipcRenderer.invoke('ssapp:choose-ticker-file').then(value => { window.__mcpOpenResult = value; }); true`);
		const openWait = payloadOf(await mcp.call('ssapp_wait_for_app_dialog', { afterId: beforeOpen.cursor, timeoutMs: 5000 }));
		const open = openWait.dialogs.find(dialog => dialog.origin === 'electron' && dialog.kind === 'open');
		assert.ok(open?.allowsPathEntry, JSON.stringify(openWait));
		await mcp.call('ssapp_respond_to_app_dialog', { dialogId: open.dialogId, accept: true, paths: [openPath], confirm: true });
		await waitFor(async () => (await execute('window.__mcpOpenResult?.filePath')).result === openPath, 'renderer open-dialog result');

		const savePath = path.join(profileDir, 'mcp-selected-output.txt');
		const beforeSave = payloadOf(await mcp.call('ssapp_get_pending_app_dialogs'));
		await execute(`window.__mcpSaveResult = null; require('electron').ipcRenderer.invoke('show-save-dialog', {
			title: 'MCP save dialog', defaultPath: ${JSON.stringify(savePath)}
		}).then(value => { window.__mcpSaveResult = value; }); true`);
		const saveWait = payloadOf(await mcp.call('ssapp_wait_for_app_dialog', { afterId: beforeSave.cursor, timeoutMs: 5000 }));
		const save = saveWait.dialogs.find(dialog => dialog.origin === 'electron' && dialog.kind === 'save');
		assert.ok(save?.allowsPathEntry, JSON.stringify(saveWait));
		const badPath = path.join(profileDir, 'missing-folder', 'output.txt');
		const rejectedPath = await mcp.call('ssapp_respond_to_app_dialog', { dialogId: save.dialogId, accept: true, paths: [badPath], confirm: true }, true);
		assert.strictEqual(rejectedPath.isError, true, 'A save path with a missing parent was accepted.');
		await mcp.call('ssapp_respond_to_app_dialog', { dialogId: save.dialogId, accept: true, paths: [savePath], confirm: true });
		await waitFor(async () => (await execute('window.__mcpSaveResult')).result === savePath, 'renderer save-dialog result');

		const visibility = payloadOf(await mcp.call('ssapp_set_app_window_visibility', { windowId: main.windowId, isVisible: false, confirm: true }));
		assert.strictEqual(visibility.window.visible, false);
		await mcp.call('ssapp_shutdown', { confirm: true });
		await Promise.race([
			new Promise(resolve => app.once('exit', resolve)),
			new Promise((_, reject) => setTimeout(() => reject(new Error('SSApp did not shut down.')), 10000)),
		]);
		console.log('MCP app-window capture, semantic control, JavaScript prompts, and Electron dialog checks passed.');
	} catch (error) {
		throw new Error(`${error.message}\nElectron output:\n${output.slice(-12000)}`);
	} finally {
		await mcp.close();
		if (app.exitCode === null) app.kill();
		await removeProfile();
	}
}

run().catch(error => {
	console.error(error.stack || error.message);
	process.exit(1);
});
