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
const { SourceObservationService } = require('../../resources/source-observation-service');

const electronPath = require('electron');
const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const socialStreamUrl = pathToFileURL(socialStreamRoot + path.sep).href;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-mcp-page-control-'));

const REQUIRED_TOOLS = [
	'ssapp_get_status', 'ssapp_get_capabilities', 'ssapp_list_sources', 'ssapp_get_source',
	'ssapp_get_operation', 'ssapp_add_source', 'ssapp_update_source', 'ssapp_remove_source',
	'ssapp_get_settings', 'ssapp_update_settings', 'ssapp_start_source', 'ssapp_stop_source',
	'ssapp_reload_source', 'ssapp_start_all_sources', 'ssapp_stop_all_sources',
	'ssapp_reload_all_sources', 'ssapp_set_source_mute', 'ssapp_toggle_source_mute',
	'ssapp_set_source_visibility', 'ssapp_toggle_source_visibility',
	'ssapp_set_source_connection_mode', 'ssapp_reload_app', 'ssapp_shutdown',
	'ssapp_get_source_diagnostics', 'ssapp_get_recent_source_events',
	'ssapp_wait_for_source_events', 'ssapp_capture_source_screenshot',
	'ssapp_inspect_source_page', 'ssapp_interact_source_page', 'ssapp_reload_source_page',
	'ssapp_show_source_for_human',
];

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
	const request = async (method, params = {}, timeoutMs = 30000) => {
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
	const call = async (name, args = {}, options = {}) => {
		const response = await request('tools/call', { name, arguments: args }, options.timeoutMs || 40000);
		assert.ok(!response.error, `${name}: ${JSON.stringify(response)}`);
		if (!options.allowError) {
			assert.notStrictEqual(response.result?.isError, true, `${name}: ${JSON.stringify(response.result)}`);
		}
		return response.result;
	};
	const close = async () => {
		if (!child.stdin.writableEnded) child.stdin.end();
		await Promise.race([
			new Promise(resolve => child.once('exit', resolve)),
			new Promise(resolve => setTimeout(resolve, 2000)),
		]);
		if (child.exitCode === null) child.kill();
	};
	return { child, request, call, close };
}

function normalizedResult(toolResult) {
	const structured = toolResult && toolResult.structuredContent;
	if (structured && structured.result) return structured.result;
	return structured || {};
}

function payloadOf(toolResult) {
	const normalized = normalizedResult(toolResult);
	return normalized.payload || normalized.result?.payload || {};
}

async function waitForMcpApp(mcp, timeoutMs = 60000) {
	const started = Date.now();
	let lastResult;
	while (Date.now() - started < timeoutMs) {
		lastResult = await mcp.call('ssapp_get_status', {}, { allowError: true });
		if (!lastResult.isError && normalizedResult(lastResult).ok !== false) return lastResult;
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`SSApp did not become available to MCP: ${JSON.stringify(lastResult)}`);
}

function startApp(port, options = {}) {
	const apiEnabled = options.apiEnabled !== false;
	const args = [
		'.', '--running-from-source', '--multiinstance', '--filesource', socialStreamUrl,
		...(apiEnabled ? ['--ssapp-control-api', `--ssapp-control-port=${port}`] : []),
		'--no-hwa', ...linuxLaunchArgs(),
	];
	const child = spawn(electronPath, args, {
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
	return { child, getOutput: () => output };
}

async function stopApp(appInstance) {
	const child = appInstance && appInstance.child;
	if (!child || child.exitCode !== null) return;
	child.kill();
	await Promise.race([
		new Promise(resolve => child.once('exit', resolve)),
		new Promise(resolve => setTimeout(resolve, 5000)),
	]);
}

async function createFixtureServer() {
	let requests = 0;
	const secret = 'MCP_FIXTURE_PASSWORD_MUST_NOT_LEAK';
	const hiddenSecret = 'MCP_FIXTURE_HIDDEN_TEXT_MUST_NOT_LEAK';
	const textareaSecret = 'MCP_FIXTURE_TEXTAREA_MUST_NOT_LEAK';
	const editableSecret = 'MCP_FIXTURE_EDITABLE_MUST_NOT_LEAK';
	const controlErrorPathSecret = 'MCP_CONTROL_ERROR_PATH_SECRET';
	const controlErrorQuerySecret = 'MCP_CONTROL_ERROR_QUERY_SECRET';
	const server = http.createServer((_request, response) => {
		requests += 1;
		response.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
		});
		response.end(`<!doctype html>
<html><head><title>MCP source fixture</title></head>
<body>
  <main aria-label="MCP fixture controls">
    <h1>Semantic source fixture</h1>
    <button id="increment" aria-label="Increase fixture count">Increase</button>
    <output id="count" aria-live="polite">Count 0</output>
    <label for="safe-input">Safe reply text</label>
    <input id="safe-input" type="text">
    <output id="typed" aria-live="polite">Typed nothing</output>
    <output id="last-key" aria-live="polite">Key none</output>
    <a href="#details">Fixture details</a>
    <input id="password" type="password" aria-label="Private password" value="${secret}">
    <input id="private-file" type="file" aria-label="Private file upload">
    <textarea aria-label="Private draft">${textareaSecret}</textarea>
    <div contenteditable="true" aria-label="Private editor">${editableSecret}</div>
    <div hidden>${hiddenSecret}</div>
    <iframe id="churn-frame" title="Background frame churn" srcdoc="<p>frame 0</p>"></iframe>
  </main>
  <section class="chat-room__content" aria-label="Fixture chat"><div class="fixture-message-list"></div></section>
  <script>
    document.getElementById('increment').addEventListener('click', function () {
      var output = document.getElementById('count');
      var value = parseInt(output.textContent.replace(/\\D/g, ''), 10) || 0;
      output.textContent = 'Count ' + (value + 1);
    });
    document.getElementById('safe-input').addEventListener('input', function (event) {
      document.getElementById('typed').textContent = 'Typed ' + event.target.value;
    });
    document.getElementById('safe-input').addEventListener('keydown', function (event) {
      document.getElementById('last-key').textContent = 'Key ' + event.key;
    });
    (function emitStatusCounterFixtures() {
      if (!window.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
        setTimeout(emitStatusCounterFixtures, 100);
        return;
      }
      chrome.runtime.sendMessage({ wssStatus: { platform: 'qa', status: 'active', error: null, reconnecting: false } });
      chrome.runtime.sendMessage({ wssStatus: { platform: 'qa', status: 'active', error: null, reconnecting: false } });
      chrome.runtime.sendMessage({ wssStatus: { platform: 'qa', status: 'error', reconnecting: true,
        message: 'Failed at https://errors.example.test/token/${controlErrorPathSecret}/chat?secret=${controlErrorQuerySecret}' } });
      chrome.runtime.sendMessage({ wssStatus: { platform: 'qa', status: 'connected', error: null, reconnecting: false } });
    })();
    var frameSequence = 0;
    setInterval(function () {
      frameSequence += 1;
      document.getElementById('churn-frame').srcdoc = '<p>frame ' + frameSequence + '</p>';
    }, 300);
    var sequence = 0;
    setTimeout(function emitFixtureMessage() {
      sequence += 1;
      var row = document.createElement('div');
      row.className = 'chat-line__message';
      row.innerHTML = '<span class="chat-author__display-name" style="color:#9147ff">FixtureUser</span>' +
        '<span data-a-target="chat-line-message-body">MCP fixture message ' + sequence + '</span>';
      document.querySelector('.fixture-message-list').appendChild(row);
      if (sequence < 30) setTimeout(emitFixtureMessage, 250);
    }, 2500);
  </script>
</body></html>`);
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	return {
		server,
		secret,
		hiddenSecret,
		textareaSecret,
		editableSecret,
		controlErrorPathSecret,
		controlErrorQuerySecret,
		url: `http://127.0.0.1:${server.address().port}/fixture-channel/MCP_PATH_SECRET/chat`,
		getRequests: () => requests,
	};
}

function assertPortClosed(port) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: '127.0.0.1', port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Control port ${port} did not refuse the connection.`));
		}, 3000);
		socket.once('connect', () => {
			clearTimeout(timer);
			socket.destroy();
			reject(new Error(`Control port ${port} was open while the API was disabled.`));
		});
		socket.once('error', error => {
			clearTimeout(timer);
			if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') resolve();
			else reject(error);
		});
	});
}

async function waitFor(predicate, label, timeoutMs = 30000, intervalMs = 100) {
	const started = Date.now();
	let lastValue;
	while (Date.now() - started < timeoutMs) {
		lastValue = await predicate();
		if (lastValue) return lastValue;
		await new Promise(resolve => setTimeout(resolve, intervalMs));
	}
	throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

async function assertBoundedEventsAndVirtualSourceBehavior() {
	const virtualView = { isTikTokVirtual: true };
	const service = new SourceObservationService({ resolveView: () => virtualView });
	const redactionService = new SourceObservationService();
	const sourceId = 'virtual-source-e2e';
	try {
		redactionService.recordCapture({
			chatmessage: 'safe text <img src="https://media.example.test/image.png?token=EVENT_SECRET">',
			contentimg: 'https://media.example.test/avatar.png?signature=IMAGE_SECRET',
			meta: { authorization: 'HEADER_SECRET' },
		}, { sourceId: 'redaction-source' });
		const redacted = JSON.stringify(redactionService.eventsResult({ sourceId: 'redaction-source' }));
		for (const secret of ['EVENT_SECRET', 'IMAGE_SECRET', 'HEADER_SECRET']) {
			assert.strictEqual(redacted.includes(secret), false, `Source event leaked ${secret}.`);
		}
		redactionService.recordStatus({ status: 'active', error: null, reconnecting: false }, { sourceId: 'signal-source' });
		redactionService.recordStatus({ status: 'active', failed: false, reconnecting: false }, { sourceId: 'signal-source' });
		redactionService.recordStatus({ status: 'qa-counter-only', error: true, reconnecting: true }, { sourceId: 'signal-source' });
		const signalCounters = redactionService.eventsResult({ sourceId: 'signal-source' }).counters;
		assert.strictEqual(signalCounters.errorSignals, 1, 'Status error signals counted null/false fields.');
		assert.strictEqual(signalCounters.reconnectSignals, 1, 'Status reconnect signals counted false fields.');

		for (let index = 1; index <= 1005; index += 1) {
			service.recordCapture({ chatmessage: `bounded fixture message ${index}` }, { sourceId, tabId: 900001 });
		}
		const recent = service.eventsResult({ sourceId, afterId: 1, limit: 200 });
		assert.strictEqual(recent.events.length, 200);
		assert.strictEqual(recent.historyLost, true);
		assert.strictEqual(recent.hasMore, true);
		assert.strictEqual(recent.counters.emittedCaptures, 1005);
		assert.strictEqual(recent.counters.buffered, 1000);
		assert.strictEqual(recent.counters.historyEvicted, 5);

		const source = { id: sourceId, target: 'tiktok', tabId: 900001, connectionMode: 'tiktok-websocket' };
		const diagnostics = await service.execute('getSourceDiagnostics', { sourceId }, source);
		assert.strictEqual(diagnostics.payload.hasWindow, false);
		assert.strictEqual(diagnostics.payload.windowKind, 'virtual');
		for (const action of ['captureSourceScreenshot', 'inspectSourcePage', 'reloadSourcePage']) {
			const result = await service.execute(action, { sourceId }, source);
			assert.strictEqual(result.ok, false, `${action} unexpectedly worked for a virtual source.`);
			assert.strictEqual(result.error.code, 'SOURCE_WINDOW_UNAVAILABLE');
		}
	} finally {
		service.close();
		redactionService.close();
	}
}

async function run() {
	await assertBoundedEventsAndVirtualSourceBehavior();
	const port = await getFreePort();
	const disabledPort = await getFreePort();
	const fixture = await createFixtureServer();
	const mcp = createMcpSession(port);
	let appInstance = null;
	let sourceId = '';
	try {
		const initialized = await mcp.request('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'ssapp-mcp-page-e2e', version: '1' },
		});
		assert.strictEqual(initialized.result?.serverInfo?.name, 'social-stream-ninja');

		const offlineTools = await mcp.request('tools/list');
		const offlineToolList = offlineTools.result?.tools || [];
		const offlineNames = new Set(offlineToolList.map(tool => tool.name));
		for (const name of REQUIRED_TOOLS) assert.ok(offlineNames.has(name), `Offline MCP tool list omitted ${name}.`);
		for (const tool of offlineToolList) {
			assert.strictEqual(tool.inputSchema?.additionalProperties, false, `${tool.name} did not publish a strict schema.`);
		}
		const requiredFields = {
			ssapp_get_source: ['sourceId'],
			ssapp_get_operation: ['operationId'],
			ssapp_start_source: ['sourceId'],
			ssapp_set_source_mute: ['sourceId', 'isMuted'],
			ssapp_set_source_visibility: ['sourceId', 'isVisible'],
			ssapp_capture_source_screenshot: ['sourceId'],
			ssapp_inspect_source_page: ['sourceId'],
			ssapp_interact_source_page: ['sourceId', 'ref', 'action', 'confirm'],
		};
		for (const [name, fields] of Object.entries(requiredFields)) {
			const schema = offlineToolList.find(tool => tool.name === name)?.inputSchema;
			for (const field of fields) assert.ok(schema?.required?.includes(field), `${name} did not require ${field}.`);
		}
		const offlineCall = await mcp.call('ssapp_get_status', {}, { allowError: true });
		assert.strictEqual(offlineCall.isError, true, 'Offline MCP status unexpectedly succeeded.');
		const offlineMessage = (offlineCall.content || []).map(item => item.text || '').join(' ');
		assert.match(offlineMessage, /SSApp.*(?:not reachable|not running|start SSApp)/i);
		assert.doesNotMatch(offlineMessage, /ECONNREFUSED|ECONNRESET|connect\s+127\.0\.0\.1/i);

		appInstance = startApp(port);
		await waitForMcpApp(mcp);

		const unknownArgument = await mcp.call('ssapp_add_source', {
			target: 'twitch',
			username: 'must-not-be-added',
			unexpectedProperty: true,
		}, { allowError: true });
		assert.strictEqual(unknownArgument.isError, true, 'MCP accepted an argument excluded by its strict schema.');

		const added = await mcp.call('ssapp_add_source', {
			target: 'twitch',
			username: 'fixture-channel',
			url: fixture.url,
			connectionMode: 'classic',
			autoActivate: false,
			idempotencyKey: 'mcp-page-control-e2e',
		});
		sourceId = payloadOf(added).source?.id;
		assert.ok(sourceId, JSON.stringify(added));

		const oneSource = await mcp.call('ssapp_get_source', { sourceId });
		assert.strictEqual(payloadOf(oneSource).source?.id, sourceId);

		const started = await mcp.call('ssapp_start_source', { sourceId });
		const operationId = payloadOf(started).operationId || normalizedResult(started).meta?.operationId;
		assert.ok(operationId, `Mutating MCP result omitted operationId: ${JSON.stringify(started)}`);
		const operation = await mcp.call('ssapp_get_operation', { operationId });
		assert.ok(payloadOf(operation).operation, JSON.stringify(operation));

		await waitFor(async () => {
			const source = payloadOf(await mcp.call('ssapp_get_source', { sourceId })).source;
			if (source?.status === 'error') throw new Error(`Fixture source failed: ${JSON.stringify(source)}`);
			return source?.status === 'active' ? source : false;
		}, 'fixture source to become active');

		const waitedEvents = await mcp.call('ssapp_wait_for_source_events', {
			sourceId,
			afterId: 0,
			limit: 100,
			timeoutMs: 15000,
		}, { timeoutMs: 25000 });
		const firstEvents = payloadOf(waitedEvents).events || [];
		assert.ok(firstEvents.some(event => event.sourceId === sourceId), JSON.stringify(waitedEvents));

		const capturedMessageEvent = await waitFor(async () => {
			const result = payloadOf(await mcp.call('ssapp_get_recent_source_events', {
				sourceId,
				afterId: 0,
				limit: 100,
			}));
			return result.events?.find(event => JSON.stringify(event.data).includes('MCP fixture message')) || false;
		}, 'captured fixture chat message through MCP', 20000, 250);
		assert.strictEqual(capturedMessageEvent.sourceId, sourceId);

		const recent = await mcp.call('ssapp_get_recent_source_events', { sourceId, afterId: 0, limit: 100 });
		const recentPayload = payloadOf(recent);
		assert.ok(Array.isArray(recentPayload.events));
		assert.ok(Number.isInteger(recentPayload.cursor));
		assert.ok(recentPayload.events.every(event => event.sourceId === sourceId));
		const timeoutStartedAt = Date.now();
		const emptyWait = payloadOf(await mcp.call('ssapp_wait_for_source_events', {
			sourceId,
			afterId: recentPayload.latestCursor || recentPayload.cursor,
			limit: 10,
			types: ['qa-event-type-that-never-occurs'],
			timeoutMs: 150,
		}, { timeoutMs: 5000 }));
		assert.deepStrictEqual(emptyWait.events, []);
		assert.ok(Date.now() - timeoutStartedAt < 3000, 'Bounded source-event wait exceeded its requested timeout.');

		const diagnostics = await waitFor(async () => {
			const result = payloadOf(await mcp.call('ssapp_get_source_diagnostics', { sourceId }));
			return Number(result.counters?.byType?.status || 0) >= 4 ? result : false;
		}, 'real source status counter fixtures', 10000, 100);
		assert.strictEqual(diagnostics.sourceId, sourceId);
		assert.strictEqual(diagnostics.hasWindow, true);
		assert.ok(diagnostics.counters && typeof diagnostics.counters === 'object');
		assert.ok(Number.isInteger(diagnostics.process?.pid) && diagnostics.process.pid > 0, `Diagnostics omitted renderer PID: ${JSON.stringify(diagnostics.process)}`);
		assert.ok(typeof diagnostics.process?.type === 'string' && diagnostics.process.type, `Diagnostics omitted renderer process type: ${JSON.stringify(diagnostics.process)}`);
		assert.ok(Number.isFinite(diagnostics.process?.privateKb), `Diagnostics omitted private renderer memory in KiB: ${JSON.stringify(diagnostics.process)}`);
		assert.ok(Number.isFinite(diagnostics.process?.residentSetKb), `Diagnostics omitted resident-set renderer memory in KiB: ${JSON.stringify(diagnostics.process)}`);
		assert.strictEqual(diagnostics.counters.errorSignals, 1, 'Real status flow counted error:null as an error signal.');
		assert.strictEqual(diagnostics.counters.reconnectSignals, 1, 'Real status flow counted reconnecting:false as a reconnect signal.');
		assert.strictEqual(JSON.stringify(diagnostics.page).includes('MCP_PATH_SECRET'), false, 'Diagnostics leaked a secret URL path segment.');
		const controlSource = payloadOf(await mcp.call('ssapp_get_source', { sourceId })).source;
		assert.strictEqual(controlSource.status, 'active', JSON.stringify(controlSource));
		assert.ok(String(controlSource.error || '').includes('https://errors.example.test'), 'Fixture source error did not reach the MCP response.');
		const controlResponses = [
			controlSource,
			payloadOf(await mcp.call('ssapp_list_sources')),
			payloadOf(await mcp.call('ssapp_get_status')),
		];
		for (const response of controlResponses) {
			const serialized = JSON.stringify(response);
			assert.strictEqual(serialized.includes(fixture.controlErrorPathSecret), false, 'Control response leaked a secret URL path.');
			assert.strictEqual(serialized.includes(fixture.controlErrorQuerySecret), false, 'Control response leaked a secret URL query.');
		}

		const screenshot = await mcp.call('ssapp_capture_source_screenshot', {
			sourceId,
			format: 'png',
			maxWidth: 800,
		});
		const image = (screenshot.content || []).find(item => item.type === 'image');
		assert.ok(image && image.data && image.mimeType === 'image/png', 'Screenshot did not return MCP image content.');
		assert.ok(Buffer.from(image.data, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));

		const inspection = payloadOf(await mcp.call('ssapp_inspect_source_page', {
			sourceId,
			maxElements: 100,
			maxTextChars: 10000,
		}));
		const serializedInspection = JSON.stringify(inspection);
		assert.ok(serializedInspection.includes('Semantic source fixture'));
		assert.ok(/untrusted/i.test(JSON.stringify(inspection.contentSafety)), 'Inspection omitted the untrusted-content warning.');
		assert.ok(/private/i.test(JSON.stringify(inspection.contentSafety)), 'Inspection omitted the private-content warning.');
		assert.strictEqual(serializedInspection.includes(fixture.secret), false, 'Page inspection leaked a password value.');
		assert.strictEqual(serializedInspection.includes(fixture.hiddenSecret), false, 'Page inspection leaked hidden text.');
		assert.strictEqual(serializedInspection.includes(fixture.textareaSecret), false, 'Page inspection leaked textarea text.');
		assert.strictEqual(serializedInspection.includes(fixture.editableSecret), false, 'Page inspection leaked editable text.');
		const button = (inspection.elements || []).find(element =>
			element.role === 'button' && /increase fixture count/i.test(element.name || '')
		);
		const safeInput = (inspection.elements || []).find(element =>
			element.role === 'textbox' && /safe reply text/i.test(element.name || '')
		);
		const passwordInput = (inspection.elements || []).find(element =>
			element.role === 'textbox' && /private password/i.test(element.name || '')
		);
		const fileInput = (inspection.elements || []).find(element => /private file upload/i.test(element.name || ''));
		assert.ok(button?.ref, JSON.stringify(inspection));
		assert.ok(safeInput?.ref && safeInput.fillable === true, JSON.stringify(inspection));
		assert.ok(passwordInput && !passwordInput.ref, 'Password input received an actionable ref.');
		assert.ok(fileInput && !fileInput.ref, 'File input received an actionable ref.');

		const missingConfirmation = await mcp.call('ssapp_interact_source_page', {
			sourceId,
			ref: button.ref,
			action: 'click',
		}, { allowError: true });
		assert.strictEqual(missingConfirmation.isError, true, 'Page action worked without confirm:true.');
		await new Promise(resolve => setTimeout(resolve, 700)); // The 300ms iframe churn must not invalidate this main-page ref.

		const interaction = payloadOf(await mcp.call('ssapp_interact_source_page', {
			sourceId,
			ref: button.ref,
			action: 'click',
			confirm: true,
		}));
		assert.strictEqual(interaction.performed, true);

		for (const privateInput of [passwordInput, fileInput]) {
			if (!privateInput.ref) continue;
			for (const action of ['click', 'focus', 'fill', 'pressKey']) {
				const blocked = await mcp.call('ssapp_interact_source_page', {
					sourceId,
					ref: privateInput.ref,
					action,
					...(action === 'fill' ? { text: 'must-not-work' } : {}),
					...(action === 'pressKey' ? { key: 'Enter' } : {}),
					confirm: true,
				}, { allowError: true });
				assert.strictEqual(blocked.isError, true, `MCP ${action} worked on a private input.`);
			}
		}

		const safeFill = payloadOf(await mcp.call('ssapp_interact_source_page', {
			sourceId,
			ref: safeInput.ref,
			action: 'fill',
			text: 'hello from MCP',
			confirm: true,
		}));
		assert.strictEqual(safeFill.performed, true);

		const afterClick = payloadOf(await mcp.call('ssapp_inspect_source_page', { sourceId }));
		assert.ok(JSON.stringify(afterClick).includes('Count 1'), JSON.stringify(afterClick));
		assert.ok(JSON.stringify(afterClick).includes('Typed hello from MCP'), JSON.stringify(afterClick));

		const staleRef = await mcp.call('ssapp_interact_source_page', {
			sourceId,
			ref: button.ref,
			action: 'click',
			confirm: true,
		}, { allowError: true });
		assert.strictEqual(staleRef.isError, true, 'An opaque ref survived a newer page inspection.');

		const safeInputAfterFill = (afterClick.elements || []).find(element =>
			element.role === 'textbox' && /safe reply text/i.test(element.name || '')
		);
		assert.ok(safeInputAfterFill?.ref, JSON.stringify(afterClick));
		const pressedKey = payloadOf(await mcp.call('ssapp_interact_source_page', {
			sourceId,
			ref: safeInputAfterFill.ref,
			action: 'pressKey',
			key: 'Enter',
			confirm: true,
		}));
		assert.strictEqual(pressedKey.performed, true);
		const afterKey = payloadOf(await mcp.call('ssapp_inspect_source_page', { sourceId }));
		assert.ok(JSON.stringify(afterKey).includes('Key Enter'), JSON.stringify(afterKey));
		const buttonBeforeMainReload = (afterKey.elements || []).find(element =>
			element.role === 'button' && /increase fixture count/i.test(element.name || '')
		);
		assert.ok(buttonBeforeMainReload?.ref);

		const foreignSource = payloadOf(await mcp.call('ssapp_add_source', {
			target: 'twitch',
			username: 'fixture-foreign',
			url: fixture.url,
			connectionMode: 'classic',
			autoActivate: false,
			idempotencyKey: 'mcp-page-control-foreign-e2e',
		})).source;
		assert.ok(foreignSource?.id);
		const foreignRef = await mcp.call('ssapp_interact_source_page', {
			sourceId: foreignSource.id,
			ref: safeInputAfterFill.ref,
			action: 'focus',
			confirm: true,
		}, { allowError: true });
		assert.strictEqual(foreignRef.isError, true, 'An opaque ref worked for a different source.');
		await mcp.call('ssapp_remove_source', { sourceId: foreignSource.id, confirm: true });

		const reloadedPage = payloadOf(await mcp.call('ssapp_reload_source_page', { sourceId, confirm: true }));
		assert.strictEqual(reloadedPage.reloaded, true);
		const staleAfterMainReload = await mcp.call('ssapp_interact_source_page', {
			sourceId,
			ref: buttonBeforeMainReload.ref,
			action: 'click',
			confirm: true,
		}, { allowError: true });
		assert.strictEqual(staleAfterMainReload.isError, true, 'A main-document reload did not invalidate its refs.');

		const muted = payloadOf(await mcp.call('ssapp_set_source_mute', { sourceId, isMuted: true }));
		assert.strictEqual(muted.source?.isMuted, true);
		const unmuted = payloadOf(await mcp.call('ssapp_toggle_source_mute', { sourceId }));
		assert.strictEqual(unmuted.source?.isMuted, false);
		const hidden = payloadOf(await mcp.call('ssapp_set_source_visibility', { sourceId, isVisible: false }));
		assert.strictEqual(hidden.source?.isVisible, false);
		const humanHandoff = payloadOf(await mcp.call('ssapp_show_source_for_human', { sourceId, confirm: true }));
		assert.strictEqual(humanHandoff.humanActionRequired, true);
		assert.strictEqual(humanHandoff.shown, true);
		const toggledVisibility = payloadOf(await mcp.call('ssapp_toggle_source_visibility', { sourceId }));
		assert.strictEqual(typeof toggledVisibility.source?.isVisible, 'boolean');

		await mcp.call('ssapp_reload_source', { sourceId, confirm: true });
		await waitFor(async () => {
			const source = payloadOf(await mcp.call('ssapp_get_source', { sourceId })).source;
			return source?.status === 'active' ? source : false;
		}, 'fixture source to reload');

		await mcp.call('ssapp_stop_source', { sourceId });
		await waitFor(async () => {
			const source = payloadOf(await mcp.call('ssapp_get_source', { sourceId })).source;
			return source?.status === 'inactive' ? source : false;
		}, 'fixture source to stop');
		const mode = payloadOf(await mcp.call('ssapp_set_source_connection_mode', { sourceId, mode: 'classic' }));
		assert.strictEqual(mode.source?.connectionMode, 'classic');

		await mcp.call('ssapp_start_all_sources', { target: 'twitch' });
		await waitFor(async () => {
			const source = payloadOf(await mcp.call('ssapp_get_source', { sourceId })).source;
			return source?.status === 'active' ? source : false;
		}, 'bulk source start');
		await mcp.call('ssapp_reload_all_sources', { target: 'twitch', confirm: true });
		await waitFor(async () => {
			const source = payloadOf(await mcp.call('ssapp_get_source', { sourceId })).source;
			return source?.status === 'active' ? source : false;
		}, 'bulk source reload');
		await mcp.call('ssapp_stop_all_sources', { target: 'twitch', confirm: true });
		await waitFor(async () => {
			const source = payloadOf(await mcp.call('ssapp_get_source', { sourceId })).source;
			return source?.status === 'inactive' ? source : false;
		}, 'bulk source stop');

		await mcp.call('ssapp_reload_app', { confirm: true });
		await waitForMcpApp(mcp);
		await mcp.call('ssapp_update_source', { sourceId, updates: { autoActivate: true } });
		await mcp.call('ssapp_shutdown', { confirm: true });
		await Promise.race([
			new Promise(resolve => appInstance.child.once('exit', resolve)),
			new Promise((_, reject) => setTimeout(() => reject(new Error('MCP shutdown did not exit SSApp.')), 10000)),
		]);
		appInstance = null;

		const requestsBeforeDisabledLaunch = fixture.getRequests();
		appInstance = startApp(disabledPort, { apiEnabled: false });
		await waitFor(() => appInstance.child.exitCode === null, 'API-disabled app to remain running', 5000);
		await new Promise(resolve => setTimeout(resolve, 3000));
		await assertPortClosed(disabledPort);
		await waitFor(
			() => fixture.getRequests() > requestsBeforeDisabledLaunch,
			'persisted source to auto-activate with control API disabled',
			30000,
			250
		);
		assert.strictEqual(appInstance.child.exitCode, null, appInstance.getOutput().slice(-5000));

		console.log('MCP-only page control and API-disabled real Electron checks passed.');
	} catch (error) {
		throw new Error(`${error.message}\nElectron output:\n${appInstance ? appInstance.getOutput().slice(-12000) : ''}`);
	} finally {
		await stopApp(appInstance);
		await mcp.close();
		if (fixture.server.listening) await new Promise(resolve => fixture.server.close(resolve));
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

run().catch(error => {
	console.error(error.stack || error.message);
	process.exit(1);
});
