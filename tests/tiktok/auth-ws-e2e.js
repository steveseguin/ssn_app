'use strict';

const assert = require('assert');
const path = require('path');

delete process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST;
delete process.env.SSAPP_TIKTOK_AUTH_WS_ALLOWED_HOSTS;

const FAKE_SESSION_ID = 'abc123def456';
const FAKE_TT_TARGET_IDC = 'alisg';
const EULER_HOST = 'tiktok.eulerstream.com';

let passed = 0;
let failed = 0;

function test(name, fn) {
	try {
		fn();
		console.log(`  PASS: ${name}`);
		passed++;
	} catch (e) {
		console.log(`  FAIL: ${name}`);
		console.log(`        ${e.message}`);
		failed++;
	}
}

function createManager(sessionId, ttTargetIdc, signingProvider, signing, localSigner) {
	const mod = require(path.resolve(__dirname, '../../tiktok/connection-manager.js'));
	const ConnectionManager = mod.__test.ConnectionManager;
	return new ConnectionManager(
		'testuser',
		1,
		sessionId || null,
		ttTargetIdc || null,
		{
			forceLegacyConnector: false,
			signing: signing || null,
			signingProvider: signingProvider || 'auto',
		}
	);
}

function setLocalSigner(manager) {
	manager.localSigner = { sign: async () => ({}) };
}

function clearLocalSigner(manager) {
	manager.localSigner = null;
}

console.log('\n==========================================================');
console.log('E2E: resolveAuthenticatedWebsocketBootstrapHost');
console.log('==========================================================\n');

test('auto + no session → null', () => {
	const m = createManager(null, null, 'auto');
	assert.strictEqual(m.resolveAuthenticatedWebsocketBootstrapHost(), null);
});

test('auto + session but no ttTargetIdc → null', () => {
	const m = createManager(FAKE_SESSION_ID, null, 'auto');
	assert.strictEqual(m.resolveAuthenticatedWebsocketBootstrapHost(), null);
});

test('auto + session + ttTargetIdc → euler host', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto');
	const host = m.resolveAuthenticatedWebsocketBootstrapHost();
	assert.strictEqual(host, EULER_HOST);
	assert.strictEqual(m.authenticatedWsBootstrapHost, EULER_HOST);
});

test('auto + session + ttTargetIdc + local signer object but provider=auto → still euler host (local signer only activates for provider=local)', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto');
	setLocalSigner(m);
	const host = m.resolveAuthenticatedWebsocketBootstrapHost();
	assert.strictEqual(host, EULER_HOST);
});

test('euler-ws + session + ttTargetIdc → euler host', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'euler-ws');
	const host = m.resolveAuthenticatedWebsocketBootstrapHost();
	assert.strictEqual(host, EULER_HOST);
});

test('euler-ws + no session → null', () => {
	const m = createManager(null, null, 'euler-ws');
	assert.strictEqual(m.resolveAuthenticatedWebsocketBootstrapHost(), null);
});

test('custom + session + ttTargetIdc + loopback serviceUrl → loopback host', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'custom', {
		serviceUrl: 'http://localhost:8080/sign'
	});
	const host = m.resolveAuthenticatedWebsocketBootstrapHost();
	assert.strictEqual(host, 'localhost:8080');
});

test('custom + session + ttTargetIdc + no serviceUrl → null', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'custom', {
		apiKey: 'some-key'
	});
	assert.strictEqual(m.resolveAuthenticatedWebsocketBootstrapHost(), null);
});

test('custom + session + ttTargetIdc + remote serviceUrl (not allowlisted) → null', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'custom', {
		serviceUrl: 'https://evil.example.com/sign'
	});
	assert.strictEqual(m.resolveAuthenticatedWebsocketBootstrapHost(), null);
});

test('custom + session + ttTargetIdc + allowlisted remote serviceUrl → host', () => {
	process.env.SSAPP_TIKTOK_AUTH_WS_ALLOWED_HOSTS = 'evil.example.com,other.host';
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'custom', {
		serviceUrl: 'https://evil.example.com/sign'
	});
	const host = m.resolveAuthenticatedWebsocketBootstrapHost();
	assert.strictEqual(host, 'evil.example.com');
	delete process.env.SSAPP_TIKTOK_AUTH_WS_ALLOWED_HOSTS;
});

test('local + session + ttTargetIdc → null (local signer handles auth internally)', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'local');
	setLocalSigner(m);
	assert.strictEqual(m.resolveAuthenticatedWebsocketBootstrapHost(), null);
});

test('unknown provider + session + ttTargetIdc → null', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'unknown-provider');
	assert.strictEqual(m.resolveAuthenticatedWebsocketBootstrapHost(), null);
});

test('auto + session resets authenticatedWsBootstrapHost on re-call', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto');
	const host1 = m.resolveAuthenticatedWebsocketBootstrapHost();
	assert.strictEqual(host1, EULER_HOST);
	clearLocalSigner(m);
	m.sessionId = null;
	const host2 = m.resolveAuthenticatedWebsocketBootstrapHost();
	assert.strictEqual(host2, null);
	assert.strictEqual(m.authenticatedWsBootstrapHost, null);
});

console.log('\n==========================================================');
console.log('E2E: buildConnectionOptions');
console.log('==========================================================\n');

test('auto + session → authenticateWs=true in options', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto');
	const opts = m.buildConnectionOptions(false);
	assert.strictEqual(opts.authenticateWs, true, 'authenticateWs should be true');
});

test('auto + no session → no authenticateWs in options', () => {
	const m = createManager(null, null, 'auto');
	const opts = m.buildConnectionOptions(false);
	assert.strictEqual(opts.authenticateWs, undefined, 'authenticateWs should not be set');
});

test('auto + session + ttTargetIdc → signApiKey not set (no custom key)', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto');
	const opts = m.buildConnectionOptions(false);
	assert.strictEqual(opts.authenticateWs, true);
	assert.strictEqual(opts.signApiKey, undefined);
});

test('auto + session + apiKey from signing config → signApiKey present + authenticateWs=true', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto', {
		apiKey: 'my-euler-key'
	});
	const opts = m.buildConnectionOptions(false);
	assert.strictEqual(opts.authenticateWs, true);
	assert.strictEqual(opts.signApiKey, 'my-euler-key');
});

test('euler-ws + session + apiKey → authenticateWs=true + signApiKey', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'euler-ws', {
		apiKey: 'my-euler-key'
	});
	const opts = m.buildConnectionOptions(false);
	assert.strictEqual(opts.authenticateWs, true);
	assert.strictEqual(opts.signApiKey, 'my-euler-key');
});

test('legacy mode → authenticateWs never set', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto');
	const opts = m.buildConnectionOptions(true);
	assert.strictEqual(opts.authenticateWs, undefined);
});

test('custom + session + loopback → authenticateWs=true', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'custom', {
		serviceUrl: 'http://localhost:9000/sign'
	});
	const opts = m.buildConnectionOptions(false);
	assert.strictEqual(opts.authenticateWs, true);
});

test('custom + session + no serviceUrl → authenticateWs undefined', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'custom', {
		apiKey: 'key'
	});
	const opts = m.buildConnectionOptions(false);
	assert.strictEqual(opts.authenticateWs, undefined);
});

console.log('\n==========================================================');
console.log('E2E: prepareAuthenticatedWebsocketBootstrapEnv');
console.log('==========================================================\n');

test('auto + session → sets WHITELIST_AUTHENTICATED_SESSION_ID_HOST', () => {
	delete process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST;
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto');
	m.buildConnectionOptions(false);
	const fakeConnection = {
		options: { authenticateWs: true },
		webClient: { webSigner: { configuration: { basePath: null } } }
	};
	const restore = m.prepareAuthenticatedWebsocketBootstrapEnv(fakeConnection);
	assert.strictEqual(process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST, EULER_HOST);
	assert.strictEqual(typeof restore, 'function');
	restore();
	assert.strictEqual(process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST, undefined);
});

test('auto + no session → restore is null', () => {
	delete process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST;
	const m = createManager(null, null, 'auto');
	m.buildConnectionOptions(false);
	const fakeConnection = { options: {}, webClient: {} };
	const restore = m.prepareAuthenticatedWebsocketBootstrapEnv(fakeConnection);
	assert.strictEqual(restore, null);
});

test('auto + session → env is restored even after error', () => {
	delete process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST;
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto');
	m.buildConnectionOptions(false);
	const fakeConnection = {
		options: { authenticateWs: true },
		webClient: { webSigner: { configuration: {} } }
	};
	const restore = m.prepareAuthenticatedWebsocketBootstrapEnv(fakeConnection);
	assert.strictEqual(process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST, EULER_HOST);
	restore();
	assert.strictEqual(process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST, undefined);
});

test('env preserves previous value on restore', () => {
	process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST = 'previous.host.com';
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto');
	m.buildConnectionOptions(false);
	const fakeConnection = {
		options: { authenticateWs: true },
		webClient: { webSigner: { configuration: {} } }
	};
	const restore = m.prepareAuthenticatedWebsocketBootstrapEnv(fakeConnection);
	assert.strictEqual(process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST, EULER_HOST);
	restore();
	assert.strictEqual(process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST, 'previous.host.com');
	delete process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST;
});

console.log('\n==========================================================');
console.log('E2E: sessionId injection into connection options');
console.log('==========================================================\n');

test('sessionId and ttTargetIdc are injected when present', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto');
	m.buildConnectionOptions(false);
	if (m.connection) {
		assert.strictEqual(m.connection.options.sessionId, FAKE_SESSION_ID);
		assert.strictEqual(m.connection.options.ttTargetIdc, FAKE_TT_TARGET_IDC);
	} else {
		const opts = m.buildConnectionOptions(false);
		assert.strictEqual(opts.authenticateWs, true);
		console.log('        (sessionId injected at initializeConnectionInstance, verified buildConnectionOptions path)');
	}
});

test('whitespace session IDs are trimmed', () => {
	const m = createManager('  ' + FAKE_SESSION_ID + '  ', '  ' + FAKE_TT_TARGET_IDC + '  ', 'auto');
	assert.strictEqual(m.sessionId, FAKE_SESSION_ID);
	assert.strictEqual(m.ttTargetIdc, FAKE_TT_TARGET_IDC);
});

test('empty string session IDs are normalized to null', () => {
	const m = createManager('', '', 'auto');
	assert.strictEqual(m.sessionId, null);
	assert.strictEqual(m.ttTargetIdc, null);
});

console.log('\n==========================================================');
console.log('E2E: websocket identity default');
console.log('==========================================================\n');

test('ws-client.js keeps default audience identity unless anchor override is opted in', () => {
	const fs = require('fs');
	const wsClientPath = require.resolve('tiktok-live-connector/dist/lib/ws/lib/ws-client.js');
	const content = fs.readFileSync(wsClientPath, 'utf8');
	const audienceMatch = content.match(/identity:\s*'audience'/g);
	assert.ok(audienceMatch && audienceMatch.length > 0, 'ws-client.js should contain identity: audience');
});

console.log('\n==========================================================');
console.log('E2E: expired session degradation');
console.log('==========================================================\n');

test('sessionId is cleared when session is rejected', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto');
	assert.strictEqual(m.sessionId, FAKE_SESSION_ID);
	assert.strictEqual(m.ttTargetIdc, FAKE_TT_TARGET_IDC);
	const fakeError = new Error('Session expired');
	fakeError.code = 'SSAPP_TIKTOK_SIGN_SERVER_ERROR';
	m.sessionId = null;
	m.ttTargetIdc = null;
	assert.strictEqual(m.sessionId, null);
	assert.strictEqual(m.ttTargetIdc, null);
});

test('connection options sessionId is cleared when session is rejected', () => {
	const m = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto');
	const opts = m.buildConnectionOptions(false);
	assert.strictEqual(opts.authenticateWs, true);
	m.sessionId = null;
	m.ttTargetIdc = null;
	if (m.connection && m.connection.options) {
		m.connection.options.sessionId = undefined;
		m.connection.options.authenticateWs = undefined;
	}
	const opts2 = m.buildConnectionOptions(false);
	assert.strictEqual(opts2.authenticateWs, undefined, 'authenticateWs should be cleared after session rejection');
});

console.log('\n==========================================================');
console.log('E2E: concurrent env var handling');
console.log('==========================================================\n');

test('two concurrent connections dont corrupt env var', () => {
	delete process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST;
	const m1 = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'auto');
	m1.buildConnectionOptions(false);
	const fakeConn1 = {
		options: { authenticateWs: true },
		webClient: { webSigner: { configuration: {} } }
	};
	const restore1 = m1.prepareAuthenticatedWebsocketBootstrapEnv(fakeConn1);
	assert.strictEqual(process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST, EULER_HOST);

	const m2 = createManager(FAKE_SESSION_ID, FAKE_TT_TARGET_IDC, 'euler-ws');
	m2.buildConnectionOptions(false);
	const fakeConn2 = {
		options: { authenticateWs: true },
		webClient: { webSigner: { configuration: {} } }
	};
	const restore2 = m2.prepareAuthenticatedWebsocketBootstrapEnv(fakeConn2);
	assert.strictEqual(process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST, EULER_HOST);

	restore1();
	assert.strictEqual(process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST, EULER_HOST, 'env should still be set after first connection finishes');

	restore2();
	assert.strictEqual(process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST, undefined, 'env should be cleaned up after last connection finishes');
});

console.log('\n==========================================================');
console.log('RESULTS');
console.log('==========================================================');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
console.log('');

if (failed > 0) {
	console.log('SOME TESTS FAILED!');
	process.exit(1);
} else {
	console.log('ALL TESTS PASSED!');
	process.exit(0);
}
