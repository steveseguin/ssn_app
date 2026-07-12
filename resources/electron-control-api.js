'use strict';

const crypto = require('crypto');

const CONTROL_API_VERSION = '1.1.2';
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_OPERATIONS = 200;
const MAX_EVENTS = 500;

const COMMAND_DEFINITIONS = Object.freeze({
	getCapabilities: definition('Discover commands, schemas, settings, and version compatibility.', 'read-only', {}),
	getSources: definition('List normalized sources.', 'read-only', { filters: 'object?' }),
	getSource: definition('Get one source by stable ID.', 'read-only', { sourceId: 'string' }),
	getSettings: definition('Get approved settings and definitions.', 'read-only', { keys: 'string[]?' }),
	getOperation: definition('Get a completed or pending operation.', 'read-only', { operationId: 'string' }),
	addSource: definition('Add an inactive source.', 'mutating', { target: 'string', username: 'string?', url: 'http-url?', idempotencyKey: 'string?' }),
	updateSource: definition('Update approved properties on an inactive source.', 'mutating', { sourceId: 'string', updates: 'object' }),
	removeSource: definition('Stop and remove a source.', 'destructive', { sourceId: 'string', confirm: 'boolean' }, true),
	updateSettings: definition('Update approved settings.', 'mutating', { settings: 'object' }),
	startSource: definition('Start one source.', 'mutating', { sourceId: 'string' }),
	stopSource: definition('Stop one source.', 'disruptive', { sourceId: 'string' }),
	restartSource: definition('Stop and start one source.', 'disruptive', { sourceId: 'string', confirm: 'boolean' }, true),
	startAllSources: definition('Start sources matching optional filters.', 'mutating', { filters: 'object?' }),
	stopAllSources: definition('Stop sources matching optional filters.', 'disruptive', { confirm: 'boolean' }, true),
	restartAllSources: definition('Reload sources matching optional filters.', 'disruptive', { confirm: 'boolean' }, true),
	setSourceMute: definition('Set source mute state.', 'mutating', { sourceId: 'string', isMuted: 'boolean' }),
	toggleSourceMute: definition('Toggle source mute state.', 'mutating', { sourceId: 'string' }),
	setSourceVisibility: definition('Set source-window visibility.', 'mutating', { sourceId: 'string', isVisible: 'boolean' }),
	toggleSourceVisibility: definition('Toggle source-window visibility.', 'mutating', { sourceId: 'string' }),
	setSourceConnectionMode: definition('Set connection mode while a source is stopped.', 'mutating', { sourceId: 'string', mode: 'string' }),
	reloadApp: definition('Reload the SSApp renderer.', 'disruptive', { confirm: 'boolean' }, true),
	shutdownApp: definition('Gracefully shut down SSApp.', 'disruptive', { confirm: 'boolean' }, true),
});

function definition(description, risk, properties, confirmationRequired = false) {
	return Object.freeze({
		description,
		risk,
		readOnly: risk === 'read-only',
		confirmationRequired,
		minimumSsappVersion: '0.4.2',
		inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({ ...properties }) }),
	});
}

function readBodyLimited(req, maxBytes = MAX_BODY_BYTES) {
	return new Promise((resolve, reject) => {
		let body = '';
		let bytes = 0;
		let tooLarge = false;
		req.on('data', chunk => {
			if (tooLarge) return;
			bytes += chunk.length;
			if (bytes > maxBytes) {
				tooLarge = true;
				return;
			}
			body += chunk;
		});
		req.on('end', () => {
			if (tooLarge) {
				const error = new Error('Request body too large.');
				error.code = 'REQUEST_TOO_LARGE';
				reject(error);
				return;
			}
			resolve(body);
		});
		req.on('error', reject);
	});
}

function statusForError(error) {
	const code = error && error.code;
	if (code === 'SSAPP_UNAVAILABLE' || code === 'SSAPP_TIMEOUT') return 503;
	if (code === 'SOURCE_ACTIVE' || code === 'STATE_CONFLICT') return 409;
	if (code === 'SOURCE_NOT_FOUND' || code === 'OPERATION_NOT_FOUND') return 404;
	if (code === 'REQUEST_TOO_LARGE') return 413;
	return 400;
}

function createControlApiRouter(options = {}) {
	const getSsappVersion = options.getSsappVersion || (() => '0.0.0');
	const executeCommand = options.executeCommand;
	const getStatus = options.getStatus;
	const reloadApp = options.reloadApp;
	const shutdownApp = options.shutdownApp;
	const commandTimeoutMs = Number.isFinite(options.commandTimeoutMs) ? options.commandTimeoutMs : DEFAULT_COMMAND_TIMEOUT_MS;
	const operations = new Map();
	const eventClients = new Set();
	const events = [];
	let eventId = 0;

	function sendJson(res, statusCode, payload, requestId) {
		const response = {
			...payload,
			apiVersion: CONTROL_API_VERSION,
			ssappVersion: getSsappVersion(),
			requestId,
		};
		res.writeHead(statusCode, {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'X-SSApp-Request-Id': requestId,
		});
		res.end(JSON.stringify(response));
	}

	function publish(type, data = {}) {
		const event = { id: ++eventId, type, at: new Date().toISOString(), data };
		events.push(event);
		if (events.length > MAX_EVENTS) events.shift();
		const packet = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
		for (const client of eventClients) {
			try { client.write(packet); } catch (_) { eventClients.delete(client); }
		}
		return event;
	}

	function openEventStream(req, res) {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-store',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no',
		});
		res.write(': connected\n\n');
		const lastId = Number.parseInt(req.headers['last-event-id'], 10) || 0;
		for (const event of events) {
			if (event.id <= lastId) continue;
			res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		}
		eventClients.add(res);
		const heartbeat = setInterval(() => {
			try { res.write(': heartbeat\n\n'); } catch (_) { }
		}, 15000);
		const close = () => {
			clearInterval(heartbeat);
			eventClients.delete(res);
		};
		req.on('close', close);
		res.on('close', close);
	}

	async function withTimeout(promise) {
		let timeoutId;
		const timeout = new Promise(resolve => {
			timeoutId = setTimeout(() => resolve({
				ok: false,
				error: { code: 'SSAPP_TIMEOUT', message: `SSApp command exceeded ${commandTimeoutMs} ms.` },
			}), commandTimeoutMs);
		});
		try {
			return await Promise.race([Promise.resolve(promise), timeout]);
		} finally {
			clearTimeout(timeoutId);
		}
	}

	function storeOperation(operation) {
		operations.set(operation.id, operation);
		while (operations.size > MAX_OPERATIONS) operations.delete(operations.keys().next().value);
	}

	async function invoke(command) {
		const definition = COMMAND_DEFINITIONS[command.action];
		if (!definition) return { ok: false, error: { code: 'UNSUPPORTED_ACTION', message: 'Unsupported control action.' } };
		if (definition.confirmationRequired && (!command.value || command.value.confirm !== true)) {
			return { ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: `${command.action} requires confirm: true.` } };
		}
		if (command.action === 'getOperation') {
			const operation = operations.get(String(command.value && command.value.operationId || ''));
			return operation
				? { ok: true, payload: { operation } }
				: { ok: false, error: { code: 'OPERATION_NOT_FOUND', message: 'Operation was not found.' } };
		}
		if (command.action === 'reloadApp' || command.action === 'shutdownApp') {
			const result = { ok: true, payload: { accepted: true, action: command.action } };
			setTimeout(() => command.action === 'reloadApp' ? reloadApp() : shutdownApp(), 100);
			return result;
		}

		const operation = definition.readOnly ? null : {
			id: `op_${crypto.randomUUID().replace(/-/g, '')}`,
			action: command.action,
			status: 'running',
			startedAt: new Date().toISOString(),
		};
		if (operation) {
			storeOperation(operation);
			publish('operation.started', operation);
		}
		const result = await withTimeout(executeCommand(command));
		if (operation) {
			operation.status = result && result.ok ? 'completed' : 'failed';
			operation.finishedAt = new Date().toISOString();
			operation.result = result && result.ok ? result.payload : undefined;
			operation.error = result && !result.ok ? result.error : undefined;
			publish(`operation.${operation.status}`, operation);
			if (operation.status === 'completed') {
				publish('status.changed', { action: command.action, operationId: operation.id });
			}
			result.meta = { ...(result.meta || {}), operationId: operation.id };
		}
		return result;
	}

	async function handle(req, res, parsedUrl) {
		const pathname = parsedUrl.pathname;
		if (!pathname.startsWith('/api/v1/')) return false;
		const requestId = crypto.randomUUID();
		if (pathname === '/api/v1/events' && req.method === 'GET') {
			openEventStream(req, res);
			return true;
		}
		if (pathname === '/api/v1/capabilities' && req.method === 'GET') {
			const renderer = await withTimeout(executeCommand({ action: 'getCapabilities' }));
			if (!renderer || !renderer.ok) {
				sendJson(res, 503, renderer || { ok: false, error: { code: 'SSAPP_UNAVAILABLE', message: 'SSApp controller is unavailable.' } }, requestId);
				return true;
			}
			sendJson(res, 200, {
				ok: true,
				payload: {
					...renderer.payload,
					apiVersion: CONTROL_API_VERSION,
					ssappVersion: getSsappVersion(),
					commands: COMMAND_DEFINITIONS,
					events: { available: true, endpoint: '/api/v1/events' },
				},
			}, requestId);
			return true;
		}
		if (pathname === '/api/v1/status' && req.method === 'GET') {
			const status = await getStatus();
			sendJson(res, status && status.ok ? 200 : 503, status, requestId);
			return true;
		}
		if (pathname.startsWith('/api/v1/operations/') && req.method === 'GET') {
			const operationId = decodeURIComponent(pathname.slice('/api/v1/operations/'.length));
			const result = await invoke({ action: 'getOperation', value: { operationId } });
			sendJson(res, result.ok ? 200 : 404, result, requestId);
			return true;
		}
		if (pathname === '/api/v1/command' && req.method === 'POST') {
			let command;
			try {
				command = JSON.parse(await readBodyLimited(req));
			} catch (error) {
				const normalized = { ok: false, error: { code: error.code || 'INVALID_REQUEST', message: error.message || 'Invalid JSON request.' } };
				sendJson(res, statusForError(normalized.error), normalized, requestId);
				return true;
			}
			const result = await invoke(command || {});
			sendJson(res, result && result.ok ? 200 : statusForError(result && result.error), result, requestId);
			return true;
		}
		sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Unsupported API path or method.' } }, requestId);
		return true;
	}

	function close() {
		for (const client of eventClients) {
			try { client.end(); } catch (_) { }
		}
		eventClients.clear();
	}

	publish('api.started', { apiVersion: CONTROL_API_VERSION, ssappVersion: getSsappVersion() });
	return { handle, publish, close, definitions: COMMAND_DEFINITIONS };
}

module.exports = {
	COMMAND_DEFINITIONS,
	CONTROL_API_VERSION,
	createControlApiRouter,
	readBodyLimited,
};
