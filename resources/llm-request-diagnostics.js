'use strict';

const crypto = require('node:crypto');

const MAX_RECENT_REQUESTS = 10;
const SAFE_RESPONSE_HEADERS = [
	'x-request-id',
	'openai-organization',
	'openai-project',
	'openai-processing-ms',
	'openai-version',
];

const recentRequests = [];

function getHeader(headers, name) {
	if (!headers) return null;
	if (typeof headers.get === 'function') {
		const value = headers.get(name);
		return value === null || value === undefined ? null : String(value);
	}
	const target = String(name || '').toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (String(key).toLowerCase() === target && value !== null && value !== undefined) {
			return Array.isArray(value) ? value.join(', ') : String(value);
		}
	}
	return null;
}

function getSafeResponseHeaders(headers) {
	const out = {};
	for (const name of SAFE_RESPONSE_HEADERS) {
		const value = getHeader(headers, name);
		if (value) out[name] = value.slice(0, 256);
	}
	return out;
}

function getSafeEndpoint(rawUrl) {
	try {
		const parsed = new URL(String(rawUrl || ''));
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '[unsupported-url]';
		// Paths on self-hosted and proxy endpoints can contain API keys, tenant
		// tokens, or signed routing data. The origin is enough to identify the
		// service without risking disclosure of those credentials.
		return parsed.origin.slice(0, 500);
	} catch (_) {
		return '[invalid-url]';
	}
}

function getSafeIdentifier(value, fallback) {
	const text = String(value || '').trim();
	if (!text) return fallback;
	return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(text) ? text : '[invalid-value]';
}

function classifyBearerToken(token) {
	if (token.startsWith('sk-proj-')) return 'project-api-key';
	if (token.startsWith('sk-admin-')) return 'admin-api-key';
	if (token.startsWith('sk-svcacct-')) return 'service-account-api-key';
	if (token.startsWith('sk-')) return 'legacy-or-standard-api-key';
	return 'other-bearer-credential';
}

function getCredentialMetadata(headers) {
	const authorization = getHeader(headers, 'authorization');
	if (!authorization) return { present: false };
	const match = authorization.match(/^\s*([^\s]+)\s+(.+?)\s*$/);
	if (!match) return { present: true, scheme: 'unknown' };
	const scheme = match[1].toLowerCase();
	if (scheme !== 'bearer') return { present: true, scheme };
	const token = match[2];
	return {
		present: true,
		scheme: 'bearer',
		type: classifyBearerToken(token),
		fingerprint: crypto.createHash('sha256').update(token).digest('hex').slice(0, 12),
	};
}

function parseErrorPayload(body) {
	if (!body) return null;
	let payload = body;
	if (typeof payload === 'string') {
		try {
			payload = JSON.parse(payload);
		} catch (_) {
			payload = null;
		}
	}
	if (!payload || typeof payload !== 'object') return null;
	const error = payload.error && typeof payload.error === 'object' ? payload.error : payload;
	const code = getSafeIdentifier(error.code, null);
	const type = getSafeIdentifier(error.type, null);
	const param = getSafeIdentifier(error.param, null);
	const missingScopeValue = error.missing_scope || error.missingScope || null;
	let missingScope = getSafeIdentifier(missingScopeValue, null);
	if (!missingScope && typeof error.message === 'string') {
		const match = error.message.match(/missing\s+scope\s*:\s*([a-zA-Z0-9._:-]+)/i);
		if (match) missingScope = getSafeIdentifier(match[1].replace(/[.,;:]+$/, ''), null);
	}
	if (!code && !type && !param && !missingScope) return null;
	return { code, type, param, missingScope };
}

function begin(args = {}) {
	const metadata = args.diagnostics;
	if (!metadata || metadata.kind !== 'llm') return null;
	const now = Date.now();
	const body = args.body && typeof args.body === 'object' ? args.body : {};
	const entry = {
		startedAt: new Date(now).toISOString(),
		provider: getSafeIdentifier(metadata.provider, 'unknown'),
		model: getSafeIdentifier(metadata.model || body.model, 'unknown'),
		endpoint: getSafeEndpoint(args.url),
		method: getSafeIdentifier(args.method || 'GET', 'GET').toUpperCase(),
		stream: body.stream === true,
		credential: getCredentialMetadata(args.headers),
		clientRequestId: crypto.randomUUID(),
		status: 'pending',
	};
	const handle = { entry, startedAtMs: now };
	recentRequests.push(entry);
	if (recentRequests.length > MAX_RECENT_REQUESTS) recentRequests.splice(0, recentRequests.length - MAX_RECENT_REQUESTS);
	return handle;
}

function complete(handle, result = {}) {
	if (!handle || !handle.entry) return;
	handle.entry.durationMs = Math.max(0, Date.now() - handle.startedAtMs);
	handle.entry.status = Number.isFinite(result.status) ? result.status : 'completed';
	handle.entry.responseHeaders = getSafeResponseHeaders(result.headers);
	const error = parseErrorPayload(result.body);
	if (error) handle.entry.error = error;
}

function fail(handle, error) {
	if (!handle || !handle.entry) return;
	handle.entry.durationMs = Math.max(0, Date.now() - handle.startedAtMs);
	handle.entry.status = 'network-error';
	handle.entry.error = {
		code: getSafeIdentifier(error && error.code, null),
		type: getSafeIdentifier(error && error.name, 'Error'),
		param: null,
		missingScope: null,
	};
}

function cancel(handle) {
	if (!handle || !handle.entry) return;
	const entryIndex = recentRequests.indexOf(handle.entry);
	if (entryIndex >= 0) recentRequests.splice(entryIndex, 1);
	handle.entry = null;
}

function getRecent() {
	return JSON.parse(JSON.stringify(recentRequests));
}

function resetForTesting() {
	recentRequests.length = 0;
}

module.exports = {
	begin,
	cancel,
	complete,
	fail,
	getRecent,
	getSafeResponseHeaders,
	resetForTesting,
};
