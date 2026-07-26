#!/usr/bin/env node

'use strict';

const http = require('http');
const https = require('https');
const readline = require('readline');

const MCP_SERVER_VERSION = '1.0.4';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_URL = 'http://127.0.0.1:17777';

const TOOL_DEFINITIONS = Object.freeze({
	ssapp_get_status: tool('Read SSApp version, runtime, local-media, and source status.', {}, null, { readOnlyHint: true }),
	ssapp_get_capabilities: tool('Discover commands supported by the connected SSApp version.', {}, null, { readOnlyHint: true }),
	ssapp_list_sources: tool('List sources, optionally filtered by target, group, or status.', {
		target: stringProperty('Optional platform target.'),
		groupId: stringProperty('Optional group ID.'),
		status: stringProperty('Optional source status.'),
	}, 'getSources', { readOnlyHint: true }),
	ssapp_add_source: tool('Add an inactive source. Use capabilities.platforms before choosing fields or modes.', {
		target: stringProperty('Platform target from capabilities.platforms.'),
		username: stringProperty('Platform username or channel name.'),
		url: stringProperty('Optional HTTP(S) source URL.'),
		videoId: stringProperty('Optional YouTube video ID.'),
		connectionMode: stringProperty('Optional supported connection mode.'),
		idempotencyKey: stringProperty('Optional stable retry key.'),
	}, 'addSource', { idempotentHint: true }),
	ssapp_update_source: tool('Update approved properties on an inactive source.', {
		sourceId: stringProperty('Stable source ID.'),
		updates: objectProperty('Approved source property patch.'),
	}, 'updateSource'),
	ssapp_start_source: sourceTool('Start one source.', 'startSource', { idempotentHint: true }),
	ssapp_stop_source: sourceTool('Stop one source.', 'stopSource', { idempotentHint: true }),
	ssapp_reload_source: tool('Stop and restart one source.', {
		sourceId: stringProperty('Stable source ID.'),
		confirm: booleanProperty('Must be true.'),
	}, 'restartSource', { destructiveHint: false }),
	ssapp_remove_source: tool('Stop and permanently remove one source.', {
		sourceId: stringProperty('Stable source ID.'),
		confirm: booleanProperty('Must be true.'),
	}, 'removeSource', { destructiveHint: true }),
	ssapp_get_settings: tool('Read approved settings and their schemas.', {
		keys: { type: 'array', items: { type: 'string' }, description: 'Optional setting names.' },
	}, 'getSettings', { readOnlyHint: true }),
	ssapp_update_settings: tool('Update approved non-secret settings.', {
		settings: objectProperty('Setting-name to value mapping.'),
	}, 'updateSettings'),
	ssapp_shutdown: tool('Gracefully shut down the connected SSApp.', {
		confirm: booleanProperty('Must be true.'),
	}, 'shutdownApp', { destructiveHint: true }),
});

function stringProperty(description) {
	return { type: 'string', description };
}

function booleanProperty(description) {
	return { type: 'boolean', description };
}

function objectProperty(description) {
	return { type: 'object', additionalProperties: true, description };
}

function tool(description, properties, action, annotations = {}) {
	return Object.freeze({
		description,
		action,
		inputSchema: { type: 'object', properties, additionalProperties: false },
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
			...annotations,
		},
	});
}

function sourceTool(description, action, annotations) {
	return tool(description, { sourceId: stringProperty('Stable source ID.') }, action, annotations);
}

function apiRequest(pathname, body) {
	const baseUrl = new URL(String(process.env.SSAPP_CONTROL_URL || DEFAULT_URL));
	const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
	const transport = baseUrl.protocol === 'https:' ? https : http;
	return new Promise((resolve, reject) => {
		const req = transport.request(new URL(pathname, baseUrl), {
			method: payload ? 'POST' : 'GET',
			headers: {
				...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
			},
			timeout: 35000,
		}, res => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', chunk => { text += chunk; });
			res.on('end', () => {
				let data;
				try { data = text ? JSON.parse(text) : {}; } catch (error) { reject(error); return; }
				if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
				else reject(Object.assign(new Error(data.error && data.error.message || `SSApp returned HTTP ${res.statusCode}.`), { response: data }));
			});
		});
		req.on('timeout', () => req.destroy(new Error('SSApp control request timed out.')));
		req.on('error', reject);
		if (payload) req.write(payload);
		req.end();
	});
}

async function getCompatibility() {
	const capabilities = await apiRequest('/api/v1/capabilities');
	return {
		ssappVersion: capabilities.ssappVersion || capabilities.payload && capabilities.payload.ssappVersion || '0.0.0',
		apiVersion: capabilities.apiVersion || capabilities.payload && capabilities.payload.apiVersion || '0.0.0',
		commands: capabilities.payload && capabilities.payload.commands || {},
		capabilities,
	};
}

function supportsTool(toolDefinition, compatibility) {
	if (!toolDefinition.action) return true;
	return Object.prototype.hasOwnProperty.call(compatibility.commands, toolDefinition.action);
}

async function listTools() {
	let compatibility = { ssappVersion: 'unavailable', apiVersion: 'unavailable', commands: {} };
	try { compatibility = await getCompatibility(); } catch (_) { }
	const tools = [];
	for (const [name, definition] of Object.entries(TOOL_DEFINITIONS)) {
		if (!supportsTool(definition, compatibility) && !['ssapp_get_status', 'ssapp_get_capabilities'].includes(name)) continue;
		tools.push({
			name,
			description: `${definition.description} Connected SSApp: ${compatibility.ssappVersion}; API: ${compatibility.apiVersion}.`,
			inputSchema: definition.inputSchema,
			annotations: definition.annotations,
		});
	}
	return { tools, _meta: { ssappVersion: compatibility.ssappVersion, apiVersion: compatibility.apiVersion } };
}

async function callTool(name, args) {
	const definition = TOOL_DEFINITIONS[name];
	if (!definition) throw new Error(`Unknown tool: ${name}`);
	let result;
	if (name === 'ssapp_get_status') result = await apiRequest('/api/v1/status');
	else if (name === 'ssapp_get_capabilities') result = await apiRequest('/api/v1/capabilities');
	else {
		const compatibility = await getCompatibility();
		if (!supportsTool(definition, compatibility)) {
			throw new Error(`${definition.action} is unavailable in SSApp ${compatibility.ssappVersion} / API ${compatibility.apiVersion}.`);
		}
		result = await apiRequest('/api/v1/command', { action: definition.action, value: args || {} });
	}
	const ssappVersion = result.ssappVersion || result.app && result.app.version || 'unknown';
	const apiVersion = result.apiVersion || 'unknown';
	return {
		content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
		structuredContent: { ssappVersion, apiVersion, result },
		_meta: { ssappVersion, apiVersion },
	};
}

function write(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
	if (!message || message.jsonrpc !== '2.0') return;
	const isNotification = !Object.prototype.hasOwnProperty.call(message, 'id');
	if (isNotification) return;
	if (message.method === 'initialize') {
		write({
			jsonrpc: '2.0', id: message.id,
			result: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'social-stream-ninja', version: MCP_SERVER_VERSION },
				instructions: [
					'This controls Social Stream Ninja on the same computer through its loopback API.',
					'Start SSApp and enable File > Local AI / Automation before using these tools.',
					'Call ssapp_get_capabilities first, then ssapp_get_status, and use stable source IDs from the results.',
					'Stop an active source before changing its URL, username, video ID, or connection mode.',
					'Remove, reload, and shutdown operations require explicit user intent.',
					'Every result includes the connected SSApp and control API versions.',
				].join(' '),
			},
		});
		return;
	}
	try {
		if (message.method === 'tools/list') {
			write({ jsonrpc: '2.0', id: message.id, result: await listTools() });
			return;
		}
		if (message.method === 'tools/call') {
			const params = message.params || {};
			write({ jsonrpc: '2.0', id: message.id, result: await callTool(params.name, params.arguments || {}) });
			return;
		}
		write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found.' } });
	} catch (error) {
		write({
			jsonrpc: '2.0', id: message.id,
			result: {
				content: [{ type: 'text', text: error && error.message ? error.message : String(error) }],
				isError: true,
				structuredContent: error && error.response ? error.response : undefined,
			},
		});
	}
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pendingMessages = 0;
let inputClosed = false;

function exitWhenIdle() {
	if (inputClosed && pendingMessages === 0) process.exit(0);
}

input.on('line', line => {
	if (!line.trim()) return;
	let message;
	try { message = JSON.parse(line); } catch (_) { return; }
	pendingMessages += 1;
	handle(message).catch(error => {
		if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
		write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message || String(error) } });
	}).finally(() => {
		pendingMessages -= 1;
		exitWhenIdle();
	});
});
input.on('close', () => {
	inputClosed = true;
	exitWhenIdle();
});
