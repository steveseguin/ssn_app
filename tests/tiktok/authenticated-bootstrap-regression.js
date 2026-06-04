'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createTikTokEnvironment } = require('../../tiktok/connection-manager.js');

function createFakeConnector(attempts) {
	class FakeEulerSigner {
		constructor(overrides = {}) {
			this.configuration = {
				basePath: overrides.basePath || 'https://signer.invalid',
				apiKey: overrides.apiKey || null
			};
			this.webcast = {};
		}
	}

	class FakeBaseConnection extends EventEmitter {
		constructor(username, options = {}, customSigner = null) {
			super();
			this.username = username;
			this.options = options;
			this.customSigner = customSigner;
			this.isConnected = false;
			this.webClient = {
				clientParams: {},
				roomId: '',
				cookieJar: {
					setSession() { },
					getCookieString() { return ''; }
				},
				webSigner: customSigner || new FakeEulerSigner()
			};
		}

		async connect() {
			attempts.push({
				authenticateWs: this.options && this.options.authenticateWs === true,
				whitelistHost: process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST || null,
				signedWebSocketProvider: typeof this.options?.signedWebSocketProvider === 'function',
				wsIdentity: this.options?.wsClientParams?.identity || null
			});
			this.isConnected = true;
			this.emit('websocketConnected');
			return true;
		}

		async setupWebsocket(_wsUrl, wsParams) {
			this.lastSetupWebsocketParams = wsParams;
			return {
				sendBytes() { return true; },
				sendHeartbeat() { },
				webSocketPingIntervalMs: 10000
			};
		}

		async disconnect() {
			this.isConnected = false;
			return true;
		}
	}

	class FakeTikTokLiveConnection extends FakeBaseConnection { }
	class FakeWebcastPushConnection extends FakeBaseConnection { }

	return {
		EulerSigner: FakeEulerSigner,
		TikTokLiveConnection: FakeTikTokLiveConnection,
		WebcastPushConnection: FakeWebcastPushConnection
	};
}

function createManager(options = {}) {
	const attempts = [];
	const connector = createFakeConnector(attempts);
	const env = createTikTokEnvironment({
		connector,
		connectionStates: new Map(),
		getMainWindow: () => null,
		localSigner: options.localSigner || null
	});
	const manager = new env.ConnectionManager(
		'tester',
		9201,
		options.sessionId || null,
		options.ttTargetIdc || null,
		{
			signingProvider: options.signingProvider || 'custom',
			signing: options.signing || null
		}
	);
	manager.logDebug = () => { };
	manager.startHealthCheck = () => { };
	manager.startViewerUpdateInterval = () => { };
	manager.closeLogWriter = () => { };
	manager.handleConnect = () => { };
	return { manager, attempts };
}

async function test(name, fn) {
	try {
		await fn();
		console.log(`PASS: ${name}`);
	} catch (error) {
		console.error(`FAIL: ${name}`);
		console.error(error && error.stack ? error.stack : error);
		process.exitCode = 1;
	}
}

function restoreEnv(key, value) {
	if (typeof value === 'string') {
		process.env[key] = value;
	} else {
		delete process.env[key];
	}
}

async function run() {
	await test('loopback custom signer enables authenticated websocket bootstrap and restores env', async () => {
		const previousWhitelist = process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST;
		const previousAllowed = process.env.SSAPP_TIKTOK_AUTH_WS_ALLOWED_HOSTS;
		try {
			delete process.env.SSAPP_TIKTOK_AUTH_WS_ALLOWED_HOSTS;
			process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST = 'previous.example';

			const { manager, attempts } = createManager({
				sessionId: 'session123',
				ttTargetIdc: 'useast1a',
				signingProvider: 'custom',
				signing: { serviceUrl: 'http://127.0.0.1:3000' }
			});

			manager.initializeConnectionInstance();
			assert.strictEqual(manager.connection.options.authenticateWs, true);
			assert.strictEqual(manager.resolveAuthenticatedWebsocketBootstrapHost(), '127.0.0.1:3000');

			await manager.connect();

			assert.strictEqual(attempts.length, 1);
			assert.strictEqual(attempts[0].authenticateWs, true);
			assert.strictEqual(attempts[0].whitelistHost, '127.0.0.1:3000');
			assert.strictEqual(process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST, 'previous.example');
		} finally {
			restoreEnv('WHITELIST_AUTHENTICATED_SESSION_ID_HOST', previousWhitelist);
			restoreEnv('SSAPP_TIKTOK_AUTH_WS_ALLOWED_HOSTS', previousAllowed);
		}
	});

	await test('remote custom signer stays unauthenticated unless explicitly allowlisted', async () => {
		const previousAllowed = process.env.SSAPP_TIKTOK_AUTH_WS_ALLOWED_HOSTS;
		try {
			delete process.env.SSAPP_TIKTOK_AUTH_WS_ALLOWED_HOSTS;

			const { manager } = createManager({
				sessionId: 'session123',
				ttTargetIdc: 'useast1a',
				signingProvider: 'custom',
				signing: { serviceUrl: 'https://signer.example.com:8443' }
			});

			manager.initializeConnectionInstance();
			assert.notStrictEqual(manager.connection.options.authenticateWs, true);
			assert.strictEqual(manager.resolveAuthenticatedWebsocketBootstrapHost(), null);
		} finally {
			restoreEnv('SSAPP_TIKTOK_AUTH_WS_ALLOWED_HOSTS', previousAllowed);
		}
	});

	await test('allowlisted custom signer host enables authenticated websocket bootstrap', async () => {
		const previousAllowed = process.env.SSAPP_TIKTOK_AUTH_WS_ALLOWED_HOSTS;
		const previousWhitelist = process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST;
		try {
			process.env.SSAPP_TIKTOK_AUTH_WS_ALLOWED_HOSTS = 'signer.example.com:8443';
			delete process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST;

			const { manager, attempts } = createManager({
				sessionId: 'session123',
				ttTargetIdc: 'useast1a',
				signingProvider: 'custom',
				signing: { serviceUrl: 'https://signer.example.com:8443' }
			});

			manager.initializeConnectionInstance();
			assert.strictEqual(manager.connection.options.authenticateWs, true);
			assert.strictEqual(manager.resolveAuthenticatedWebsocketBootstrapHost(), 'signer.example.com:8443');

			await manager.connect();

			assert.strictEqual(attempts.length, 1);
			assert.strictEqual(attempts[0].authenticateWs, true);
			assert.strictEqual(attempts[0].whitelistHost, 'signer.example.com:8443');
			assert.strictEqual(process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST, undefined);
		} finally {
			restoreEnv('SSAPP_TIKTOK_AUTH_WS_ALLOWED_HOSTS', previousAllowed);
			restoreEnv('WHITELIST_AUTHENTICATED_SESSION_ID_HOST', previousWhitelist);
		}
	});

	await test('local signer path keeps authenticated websocket bootstrap disabled', async () => {
		const { manager } = createManager({
			sessionId: 'session123',
			ttTargetIdc: 'useast1a',
			signingProvider: 'local',
			localSigner: {
				async sign() {
					return { url: 'wss://example.invalid/tiktok' };
				}
			}
		});

		manager.initializeConnectionInstance();
		assert.strictEqual(typeof manager.connection.options.signedWebSocketProvider, 'function');
		assert.strictEqual(manager.connection.options.disableEulerFallbacks, true);
		assert.strictEqual(manager.connection.options.wsClientParams.identity, 'audience');
		assert.notStrictEqual(manager.connection.options.authenticateWs, true);
		assert.strictEqual(manager.resolveAuthenticatedWebsocketBootstrapHost(), null);
	});

	await test('host local signer uses anchor identity per connection', async () => {
		const { manager, attempts } = createManager({
			sessionId: 'session123',
			ttTargetIdc: 'useast1a',
			signingProvider: 'local',
			localSigner: {
				async sign() {
					return { url: 'wss://example.invalid/tiktok' };
				}
			}
		});
		manager.accountRole = 'host';

		manager.initializeConnectionInstance();
		assert.strictEqual(manager.connection.options.wsClientParams.identity, 'anchor');
		assert.strictEqual(manager.connection.__ssappWebcastIdentityOverride, 'anchor');

		await manager.connect();

		assert.strictEqual(attempts.length, 1);
		assert.strictEqual(attempts[0].wsIdentity, 'anchor');
	});

	await test('explicit local signer does not activate polling fallback', async () => {
		const { manager } = createManager({
			signingProvider: 'local',
			localSigner: {
				async sign() {
					return { url: 'wss://example.invalid/tiktok' };
				}
			}
		});
		const error = new Error('TikTok did not return a WebSocket URL (wsUrl) during bootstrap.');
		error.name = 'TikTokWsUrlError';
		error.code = 'SSAPP_TIKTOK_WSURL_MISSING';

		const handled = await manager.tryFallbackToPolling(error, 'unit_local_signer');

		assert.strictEqual(handled, false);
		assert.strictEqual(manager.pollingFallbackActivated, false);
		assert.strictEqual(manager.preferredStrategy, 'websocket');
	});
}

run()
	.then(() => {
		process.exit(process.exitCode || 0);
	})
	.catch((error) => {
		console.error(error && error.stack ? error.stack : error);
		process.exit(1);
	});
