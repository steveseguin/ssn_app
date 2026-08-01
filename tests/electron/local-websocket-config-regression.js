#!/usr/bin/env node

'use strict';

const assert = require('assert');
const {
	DEFAULT_LOCAL_WEBSOCKET_HOST,
	DEFAULT_LOCAL_WEBSOCKET_PORT,
	LEGACY_LOCAL_WEBSOCKET_PORT,
	isLoopbackHost,
	normalizeLocalWebSocketHost,
	normalizeLocalWebSocketPort,
	resolveLocalWebSocketConfig,
	resolveLocalWebSocketHost,
	resolveLocalWebSocketPort,
} = require('../../resources/local-websocket-config');

assert.strictEqual(DEFAULT_LOCAL_WEBSOCKET_HOST, '127.0.0.1');
// New installs bind 3003; installs that already had the server enabled are
// migrated back to the legacy 3000 by migrateLegacyLocalServerPort in main.js.
assert.strictEqual(DEFAULT_LOCAL_WEBSOCKET_PORT, 3003);
assert.strictEqual(LEGACY_LOCAL_WEBSOCKET_PORT, 3000);
assert.notStrictEqual(DEFAULT_LOCAL_WEBSOCKET_PORT, LEGACY_LOCAL_WEBSOCKET_PORT);
assert.strictEqual(normalizeLocalWebSocketPort('3003'), 3003);
assert.strictEqual(normalizeLocalWebSocketPort('3000'), 3000);
assert.strictEqual(normalizeLocalWebSocketPort(65535), 65535);

for (const value of ['', '80', '1023', '65536', '3003/path', '3003@example.com', '3.5', null]) {
	assert.strictEqual(normalizeLocalWebSocketPort(value), null, `accepted invalid port: ${value}`);
}

assert.deepStrictEqual(
	resolveLocalWebSocketPort({ argv: [], env: {}, storedPort: undefined }),
	{ port: 3003, source: 'default', invalidSources: [] }
);
// An upgraded install has 3000 pinned into the store, so it must still resolve
// to 3000 rather than drifting onto the new default.
assert.deepStrictEqual(
	resolveLocalWebSocketPort({ argv: [], env: {}, storedPort: 3000 }),
	{ port: 3000, source: 'stored setting', invalidSources: [] }
);
assert.strictEqual(resolveLocalWebSocketPort({
	argv: ['electron', '.', '--ssapp-local-server-port=3004'],
	env: { SSAPP_LOCAL_SERVER_PORT: '3005' },
	storedPort: 3006,
}).port, 3004);
assert.strictEqual(resolveLocalWebSocketPort({
	argv: ['electron', '.', '--ssapp-ws-port', '3005'],
	env: {},
}).port, 3005);
assert.strictEqual(resolveLocalWebSocketPort({
	argv: ['electron', '.', '--ssapp-local-server-port=invalid'],
	env: { SSAPP_LOCAL_SERVER_PORT: '3007' },
	storedPort: 3008,
}).port, 3007);
assert.strictEqual(resolveLocalWebSocketPort({ argv: [], env: {}, storedPort: '3009' }).port, 3009);

assert.strictEqual(normalizeLocalWebSocketHost('loopback'), '127.0.0.1');
assert.strictEqual(normalizeLocalWebSocketHost('localhost'), '127.0.0.1');
assert.strictEqual(normalizeLocalWebSocketHost('LAN'), '0.0.0.0');
assert.strictEqual(normalizeLocalWebSocketHost('10.0.0.20'), '10.0.0.20');
assert.strictEqual(normalizeLocalWebSocketHost('example.com'), null);
assert.strictEqual(isLoopbackHost('127.0.0.2'), true);
assert.strictEqual(isLoopbackHost('0.0.0.0'), false);
assert.deepStrictEqual(
	resolveLocalWebSocketHost({ argv: [], env: {}, storedHost: undefined }),
	{ host: '127.0.0.1', source: 'default', invalidSources: [] }
);
assert.strictEqual(resolveLocalWebSocketHost({
	argv: ['electron', '.', '--ssapp-local-server-host=lan'],
	env: { SSAPP_LOCAL_SERVER_HOST: '127.0.0.1' },
	storedHost: '10.0.0.20',
}).host, '0.0.0.0');
assert.strictEqual(resolveLocalWebSocketHost({
	argv: ['electron', '.', '--ssapp-local-server-host=invalid'],
	env: { SSAPP_LOCAL_SERVER_HOST: '10.0.0.20' },
}).host, '10.0.0.20');
assert.deepStrictEqual(resolveLocalWebSocketConfig({
	argv: ['electron', '.', '--ssapp-ws-port=3010', '--ssapp-ws-host=loopback'],
	env: {},
}), {
	port: 3010,
	host: '127.0.0.1',
	portSource: '--ssapp-ws-port',
	hostSource: '--ssapp-ws-host',
	invalidSources: [],
});

console.log('Local WebSocket configuration regression checks passed.');
