'use strict';

const net = require('net');

// New installs bind 3003 so the relay does not collide with other tools that
// claim 3000 (Buzz's dev relay among them). Installs that already had the local
// server enabled keep 3000 — see migrateLegacyLocalServerPort in main.js, which
// pins the legacy value into the store on first run after upgrade.
const DEFAULT_LOCAL_WEBSOCKET_PORT = 3003;
const LEGACY_LOCAL_WEBSOCKET_PORT = 3000;
const DEFAULT_LOCAL_WEBSOCKET_HOST = '127.0.0.1';
const LAN_LOCAL_WEBSOCKET_HOST = '0.0.0.0';
const MIN_LOCAL_WEBSOCKET_PORT = 1024;
const MAX_LOCAL_WEBSOCKET_PORT = 65535;
const PORT_CLI_FLAGS = ['--ssapp-local-server-port', '--ssapp-ws-port'];
const HOST_CLI_FLAGS = ['--ssapp-local-server-host', '--ssapp-ws-host'];

function normalizeLocalWebSocketPort(value) {
	if (typeof value === 'number') {
		if (!Number.isInteger(value)) return null;
	} else if (typeof value === 'string') {
		value = value.trim();
		if (!/^\d+$/.test(value)) return null;
		value = Number.parseInt(value, 10);
	} else {
		return null;
	}

	if (value < MIN_LOCAL_WEBSOCKET_PORT || value > MAX_LOCAL_WEBSOCKET_PORT) return null;
	return value;
}

function readCliValue(argv = [], flags = []) {
	for (const flag of flags) {
		const inline = argv.find(value => typeof value === 'string' && value.startsWith(`${flag}=`));
		if (inline) return { value: inline.slice(flag.length + 1), source: flag };
		const index = argv.indexOf(flag);
		if (index >= 0) return { value: argv[index + 1], source: flag };
	}
	return null;
}

function resolveLocalWebSocketPort(options = {}) {
	const argv = Array.isArray(options.argv) ? options.argv : [];
	const env = options.env && typeof options.env === 'object' ? options.env : {};
	const cli = readCliValue(argv, PORT_CLI_FLAGS);
	const candidates = [
		cli,
		{ value: env.SSAPP_LOCAL_SERVER_PORT, source: 'SSAPP_LOCAL_SERVER_PORT' },
		{ value: env.SSAPP_WS_PORT, source: 'SSAPP_WS_PORT' },
		{ value: options.storedPort, source: 'stored setting' },
	];
	const invalidSources = [];

	for (const candidate of candidates) {
		if (!candidate || candidate.value === undefined || candidate.value === null || candidate.value === '') continue;
		const port = normalizeLocalWebSocketPort(candidate.value);
		if (port !== null) return { port, source: candidate.source, invalidSources };
		invalidSources.push(candidate.source);
	}

	return { port: DEFAULT_LOCAL_WEBSOCKET_PORT, source: 'default', invalidSources };
}

function normalizeLocalWebSocketHost(value) {
	const candidate = String(value || '').trim().toLowerCase();
	if (!candidate) return null;
	if (['loopback', 'localhost', '127.0.0.1', '::1'].includes(candidate)) {
		return DEFAULT_LOCAL_WEBSOCKET_HOST;
	}
	if (['lan', 'all', '0.0.0.0', '::'].includes(candidate)) {
		return LAN_LOCAL_WEBSOCKET_HOST;
	}
	return net.isIP(candidate) ? candidate : null;
}

function isLoopbackHost(value) {
	const candidate = String(value || '').trim().toLowerCase();
	if (['loopback', 'localhost', '::1'].includes(candidate)) return true;
	return /^127(?:\.\d{1,3}){3}$/.test(candidate);
}

function resolveLocalWebSocketHost(options = {}) {
	const argv = Array.isArray(options.argv) ? options.argv : [];
	const env = options.env && typeof options.env === 'object' ? options.env : {};
	const cli = readCliValue(argv, HOST_CLI_FLAGS);
	const candidates = [
		cli,
		{ value: env.SSAPP_LOCAL_SERVER_HOST, source: 'SSAPP_LOCAL_SERVER_HOST' },
		{ value: env.SSAPP_WS_HOST, source: 'SSAPP_WS_HOST' },
		{ value: options.storedHost, source: 'stored setting' },
	];
	const invalidSources = [];

	for (const candidate of candidates) {
		if (!candidate || candidate.value === undefined || candidate.value === null || candidate.value === '') continue;
		const host = normalizeLocalWebSocketHost(candidate.value);
		if (host !== null) return { host, source: candidate.source, invalidSources };
		invalidSources.push(candidate.source);
	}

	return { host: DEFAULT_LOCAL_WEBSOCKET_HOST, source: 'default', invalidSources };
}

function resolveLocalWebSocketConfig(options = {}) {
	const port = resolveLocalWebSocketPort(options);
	const host = resolveLocalWebSocketHost(options);
	return {
		port: port.port,
		host: host.host,
		portSource: port.source,
		hostSource: host.source,
		invalidSources: [...port.invalidSources, ...host.invalidSources],
	};
}

module.exports = {
	DEFAULT_LOCAL_WEBSOCKET_HOST,
	DEFAULT_LOCAL_WEBSOCKET_PORT,
	LEGACY_LOCAL_WEBSOCKET_PORT,
	LAN_LOCAL_WEBSOCKET_HOST,
	MAX_LOCAL_WEBSOCKET_PORT,
	MIN_LOCAL_WEBSOCKET_PORT,
	isLoopbackHost,
	normalizeLocalWebSocketHost,
	normalizeLocalWebSocketPort,
	resolveLocalWebSocketConfig,
	resolveLocalWebSocketHost,
	resolveLocalWebSocketPort,
};
