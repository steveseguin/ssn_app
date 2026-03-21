'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createTikTokEnvironment, __test } = require('../../tiktok/connection-manager.js');

function cloneStatus(payload) {
	return JSON.parse(JSON.stringify(payload));
}

function firstNonEmptyLine(value) {
	if (typeof value !== 'string') return '';
	return value.split(/\r?\n/).find(line => line.trim().length) || '';
}

function createRateLimitError(options = {}) {
	const {
		name = 'SignatureRateLimitError',
		source = null
	} = options;
	const error = new Error([
		'[Rate Limited] (rate_limit_room_id_day) Too many connections started, try again later.',
		'|                                                                                                     |',
		'+---------------------------------------- SIGN SERVER MESSAGE ----------------------------------------+',
		'| You have reached the rate limit. Sign up for a free API key at https://www.eulerstream.com/pricing. |',
		'+-----------------------------------------------------------------------------------------------------+'
	].join('\n'));
	error.name = name;
	error.status = 429;
	if (source) {
		error.source = source;
	}
	return error;
}

function createUserNotFoundLookupError() {
	const error = new Error();
	error.errors = [
		new TypeError("Cannot read properties of undefined (reading 'liveRoomUserInfo')"),
		Object.assign(new Error('API Error 19881007 (user_not_found)'), { name: 'InvalidResponseError' })
	];
	return error;
}

function createScenarioPlan(outcomesByMode = {}) {
	const queues = Object.create(null);
	for (const [mode, outcomes] of Object.entries(outcomesByMode)) {
		queues[mode] = Array.isArray(outcomes) ? outcomes.slice() : [];
	}
	return {
		attempts: [],
		statuses: [],
		reconnects: [],
		consume(mode) {
			const queue = queues[mode] || [];
			if (!queue.length) {
				return { ok: true };
			}
			return queue.shift();
		}
	};
}

function createFakeConnector(plan) {
	class FakeBaseConnection extends EventEmitter {
		constructor(username, options = {}, customSigner = null) {
			super();
			this.username = username;
			this.options = options;
			this.customSigner = customSigner;
			this.isConnected = false;
			this.webClient = { clientParams: {} };
		}

		getMode() {
			return 'auto';
		}

		async connect() {
			const mode = this.getMode();
			plan.attempts.push({ kind: 'connect', mode });
			const outcome = plan.consume(mode);
			if (outcome && outcome.error) {
				if (outcome.emitErrorEvent) {
					this.emit('error', outcome.error);
				}
				throw outcome.error;
			}
			this.isConnected = true;
			if (mode !== 'polling') {
				this.emit('websocketConnected');
			}
			return true;
		}

		async disconnect() {
			this.isConnected = false;
			plan.attempts.push({ kind: 'disconnect', mode: this.getMode() });
			return true;
		}
	}

	class FakeTikTokLiveConnection extends FakeBaseConnection {
		getMode() {
			if (this.options && typeof this.options.signedWebSocketProvider === 'function') {
				return 'local';
			}
			return 'auto';
		}
	}

	class FakeWebcastPushConnection extends FakeBaseConnection {
		getMode() {
			return 'polling';
		}
	}

	return {
		TikTokLiveConnection: FakeTikTokLiveConnection,
		WebcastPushConnection: FakeWebcastPushConnection
	};
}

function createHarness(outcomesByMode, options = {}) {
	const {
		allowProxy = true,
		localSignerEnabled = true,
		signing = null
	} = options;
	const plan = createScenarioPlan(outcomesByMode);
	const connector = createFakeConnector(plan);
	const env = createTikTokEnvironment({
		connector,
		onStatus: (payload) => plan.statuses.push(cloneStatus(payload)),
		connectionStates: new Map(),
		getMainWindow: () => null,
		localSigner: localSignerEnabled
			? {
				async sign() {
					return { url: 'wss://example.invalid/tiktok' };
				}
			}
			: null
	});
	const manager = new env.ConnectionManager('tester', 9001, null, null, {
		signingProvider: 'auto',
		signing
	});

	manager.sharedEulerApiKeyPool = [];
	manager.sharedEulerApiKeyAttempts = new Set();
	manager.logDebug = () => {};
	manager.startHealthCheck = () => {};
	manager.startViewerUpdateInterval = () => {};
	manager.closeLogWriter = () => {};
	manager.attemptReconnect = (delay, reconnectOptions = {}) => {
		plan.reconnects.push({
			delay,
			...reconnectOptions
		});
	};
	if (!allowProxy) {
		manager.getAutoEulerProxyFallbackKey = () => null;
	}

	return { manager, plan };
}

async function withPatchedEulerProxy(plan, fn) {
	const proto = __test.EulerWebsocketServerConnection.prototype;
	const originalConnect = proto.connect;
	const originalDisconnect = proto.disconnect;

	proto.connect = async function patchedEulerConnect() {
		plan.attempts.push({ kind: 'connect', mode: 'proxy' });
		const outcome = plan.consume('proxy');
		if (outcome && outcome.error) {
			throw outcome.error;
		}
		this.isConnected = true;
		this.emit('websocketConnected');
		return true;
	};

	proto.disconnect = async function patchedEulerDisconnect() {
		this.isConnected = false;
		plan.attempts.push({ kind: 'disconnect', mode: 'proxy' });
		return true;
	};

	try {
		return await fn();
	} finally {
		proto.connect = originalConnect;
		proto.disconnect = originalDisconnect;
	}
}

function getConnectModes(plan) {
	return plan.attempts.filter(entry => entry.kind === 'connect').map(entry => entry.mode);
}

function getReconnectingReasons(plan) {
	return plan.statuses
		.filter(entry => entry.status === 'reconnecting')
		.map(entry => entry.reason || null);
}

function countStatuses(plan, predicate) {
	return plan.statuses.filter(predicate).length;
}

function getLastStatus(plan, status) {
	for (let i = plan.statuses.length - 1; i >= 0; i -= 1) {
		if (plan.statuses[i].status === status) {
			return plan.statuses[i];
		}
	}
	return null;
}

async function withMutedConsole(fn) {
	const original = {
		log: console.log,
		info: console.info,
		warn: console.warn,
		error: console.error
	};
	console.log = () => {};
	console.info = () => {};
	console.warn = () => {};
	console.error = () => {};
	try {
		return await fn();
	} finally {
		console.log = original.log;
		console.info = original.info;
		console.warn = original.warn;
		console.error = original.error;
	}
}

async function testAutoFallsBackToLocalSigner() {
	const { manager, plan } = createHarness({
		auto: [{ error: createRateLimitError() }],
		local: [{ ok: true }]
	}, {
		allowProxy: false
	});

	const result = await withPatchedEulerProxy(plan, () => manager.initialize());

	assert.strictEqual(result, true);
	assert.deepStrictEqual(getConnectModes(plan), ['auto', 'local']);
	assert.deepStrictEqual(getReconnectingReasons(plan), ['Sign server unavailable. Trying local signer.']);
	assert.strictEqual(plan.reconnects.length, 0);

	const connected = getLastStatus(plan, 'connected');
	assert(connected, 'expected a connected status');
	assert.strictEqual(connected.connectionMethod, 'Local signer');
	assert.strictEqual(connected.connectionLabel, 'Websocket connected via local signer');
}

async function testAutoFallsBackFromLocalSignerToEulerProxy() {
	const { manager, plan } = createHarness({
		auto: [{ error: createRateLimitError() }],
		local: [{ error: createRateLimitError({ name: 'TikTokRateLimitError', source: 'local_signer' }) }],
		proxy: [{ ok: true }]
	});

	const result = await withPatchedEulerProxy(plan, () => manager.initialize());

	assert.strictEqual(result, true);
	assert.deepStrictEqual(getConnectModes(plan), ['auto', 'local', 'proxy']);
	assert.deepStrictEqual(getReconnectingReasons(plan), [
		'Sign server unavailable. Trying local signer.',
		'Sign server unavailable. Trying Euler Proxy with shared Euler proxy key.'
	]);
	assert.strictEqual(plan.reconnects.length, 0);

	const connected = getLastStatus(plan, 'connected');
	assert(connected, 'expected a connected status');
	assert.strictEqual(connected.connectionMethod, 'Euler WS relay (API key)');
	assert.strictEqual(connected.connectionLabel, 'Websocket connected via Euler WS relay (API key)');
}

async function testConfiguredEulerApiKeyIsReusedForProxyFallback() {
	const configuredKey = 'user-euler-key';
	const { manager, plan } = createHarness({
		auto: [{ error: createRateLimitError() }],
		proxy: [{ ok: true }]
	}, {
		localSignerEnabled: false,
		signing: { apiKey: configuredKey }
	});

	const result = await withPatchedEulerProxy(plan, () => manager.initialize());

	assert.strictEqual(result, true);
	assert.deepStrictEqual(getConnectModes(plan), ['auto', 'proxy']);
	assert.deepStrictEqual(getReconnectingReasons(plan), [
		'Sign server unavailable. Trying Euler Proxy with configured Euler API key.'
	]);
	assert.strictEqual(countStatuses(plan, entry => entry.sharedKeyRetry === true), 0);
	assert.strictEqual(manager.signingConfig.apiKey, configuredKey);

	const connected = getLastStatus(plan, 'connected');
	assert(connected, 'expected a connected status');
	assert.strictEqual(connected.connectionMethod, 'Euler WS relay (API key)');
}

async function testAutoFallsBackFromProxyToPolling() {
	const proxyRateLimit = createRateLimitError();
	const { manager, plan } = createHarness({
		auto: [{ error: createRateLimitError() }],
		local: [{ error: createRateLimitError({ name: 'TikTokRateLimitError', source: 'local_signer' }) }],
		proxy: [{ error: proxyRateLimit }],
		polling: [{ ok: true }]
	});

	const result = await withPatchedEulerProxy(plan, () => manager.initialize());

	assert.strictEqual(result, true);
	assert.deepStrictEqual(getConnectModes(plan), ['auto', 'local', 'proxy', 'polling']);
	assert.deepStrictEqual(getReconnectingReasons(plan), [
		'Sign server unavailable. Trying local signer.',
		'Sign server unavailable. Trying Euler Proxy with shared Euler proxy key.'
	]);
	assert.strictEqual(plan.reconnects.length, 0);

	const pollingFallback = getLastStatus(plan, 'fallback_polling');
	assert(pollingFallback, 'expected a polling fallback status');
	assert.strictEqual(pollingFallback.error, proxyRateLimit.message);

	const connected = getLastStatus(plan, 'connected');
	assert(connected, 'expected a connected status');
	assert.strictEqual(connected.connectionMethod, 'Polling (legacy fallback)');
	assert.strictEqual(connected.connectionLabel, 'Connected via polling (legacy fallback)');
}

async function testAutoExhaustionSurfacesFailureMessage() {
	const pollingRateLimit = createRateLimitError();
	const { manager, plan } = createHarness({
		auto: [{ error: createRateLimitError() }],
		local: [{ error: createRateLimitError({ name: 'TikTokRateLimitError', source: 'local_signer' }) }],
		proxy: [{ error: createRateLimitError() }],
		polling: [{ error: pollingRateLimit }]
	});

	const result = await withPatchedEulerProxy(plan, () => manager.initialize());

	assert.strictEqual(result, false);
	assert.deepStrictEqual(getConnectModes(plan), ['auto', 'local', 'proxy', 'polling']);

	const failed = getLastStatus(plan, 'failed');
	assert(failed, 'expected a failed status');
	assert.strictEqual(failed.error, firstNonEmptyLine(pollingRateLimit.message));

	const pollingFallback = getLastStatus(plan, 'fallback_polling');
	assert(pollingFallback, 'expected a polling fallback status before final failure');

	assert.strictEqual(plan.reconnects.length, 1);
	assert.strictEqual(plan.reconnects[0].reason, 'Rate limited by TikTok');
	assert.strictEqual(plan.reconnects[0].fixed, true);
	assert.strictEqual(plan.reconnects[0].immediate, true);
}

async function testBlankRoomLookupErrorsBecomeUsefulMessages() {
	const { manager } = createHarness({}, {
		allowProxy: false,
		localSignerEnabled: false
	});

	const lookupError = createUserNotFoundLookupError();

	const message = manager.getUserFriendlyErrorMessage(lookupError, '');
	assert.strictEqual(message, 'TikTok user not found. Check the username and try again.');
}

async function testUserNotFoundStopsWithoutReconnectSpam() {
	const { manager, plan } = createHarness({
		auto: [{ error: createUserNotFoundLookupError() }]
	}, {
		allowProxy: false,
		localSignerEnabled: false
	});

	const result = await manager.initialize();

	assert.strictEqual(result, false);
	assert.deepStrictEqual(getConnectModes(plan), ['auto']);
	assert.strictEqual(plan.reconnects.length, 0);
	assert.strictEqual(countStatuses(plan, entry => entry.status === 'failed'), 0);

	const fatal = getLastStatus(plan, 'fatal_error');
	assert(fatal, 'expected a fatal_error status');
	assert.strictEqual(fatal.error, 'TikTok user not found. Check the username and try again.');
}

async function testUiDoesNotAutoFallbackAfterFatalUserNotFound() {
	const indexPath = path.join(__dirname, '..', '..', 'index.html');
	const src = fs.readFileSync(indexPath, 'utf8');

	assert.ok(
		src.includes('function shouldSuppressTikTokUiAutoFallback'),
		'expected renderer-side fatal fallback guard helper'
	);
	assert.ok(
		src.includes("failureStatus === 'fatal_error'"),
		'expected fatal_error-specific suppression logic'
	);
	assert.ok(
		src.includes('normalizedMessage.includes(\'tiktok user not found\')'),
		'expected fatal user-not-found suppression rule'
	);
	assert.ok(
		src.includes("if (!shouldSuppressTikTokUiAutoFallback('fatal_error', data.error || null))"),
		'expected fatal_error auto fallback call to be guarded'
	);
}

async function testConnectRehydratesMissingConnectionInstance() {
	const { manager, plan } = createHarness({
		auto: [{ ok: true }]
	}, {
		allowProxy: false,
		localSignerEnabled: false
	});

	manager.initializeConnectionInstance({ forceLegacy: false, context: 'unit_missing_connection' });
	manager.connection = null;

	const result = await manager.connect();

	assert.strictEqual(result, true);
	assert.deepStrictEqual(getConnectModes(plan), ['auto']);

	const connected = getLastStatus(plan, 'connected');
	assert(connected, 'expected a connected status after rehydrating the missing connection');
}

async function testConnectErrorEventDoesNotDuplicateFallbackRecovery() {
	const configuredKey = 'user-euler-key';
	const { manager, plan } = createHarness({
		auto: [{ error: createRateLimitError(), emitErrorEvent: true }],
		proxy: [{ ok: true }]
	}, {
		localSignerEnabled: false,
		signing: { apiKey: configuredKey }
	});

	const result = await withPatchedEulerProxy(plan, () => manager.initialize());

	assert.strictEqual(result, true);
	assert.deepStrictEqual(getConnectModes(plan), ['auto', 'proxy']);
	assert.strictEqual(countStatuses(plan, entry => entry.proxyFallback === true), 1);
	assert.strictEqual(countStatuses(plan, entry => entry.status === 'connected'), 1);
}

async function testHandleConnectIgnoresDuplicateConnectedEmission() {
	const { manager, plan } = createHarness({}, {
		allowProxy: false,
		localSignerEnabled: false
	});

	manager.preferredStrategy = 'legacy';
	manager.connectionStrategy = 'legacy';
	manager.handleConnect();
	manager.handleConnect();

	assert.strictEqual(countStatuses(plan, entry => entry.status === 'connected'), 1);
}

async function run() {
	const tests = [
		{
			name: 'auto falls back to local signer',
			fn: testAutoFallsBackToLocalSigner
		},
		{
			name: 'auto falls back from local signer to Euler proxy',
			fn: testAutoFallsBackFromLocalSignerToEulerProxy
		},
		{
			name: 'configured Euler API key is reused for proxy fallback',
			fn: testConfiguredEulerApiKeyIsReusedForProxyFallback
		},
		{
			name: 'auto falls back from proxy to polling',
			fn: testAutoFallsBackFromProxyToPolling
		},
		{
			name: 'auto exhaustion surfaces a failed status message',
			fn: testAutoExhaustionSurfacesFailureMessage
		},
		{
			name: 'blank room lookup errors become useful messages',
			fn: testBlankRoomLookupErrorsBecomeUsefulMessages
		},
		{
			name: 'user not found stops without reconnect spam',
			fn: testUserNotFoundStopsWithoutReconnectSpam
		},
		{
			name: 'ui does not auto fallback after fatal user not found',
			fn: testUiDoesNotAutoFallbackAfterFatalUserNotFound
		},
		{
			name: 'connect rehydrates a missing connection instance',
			fn: testConnectRehydratesMissingConnectionInstance
		},
		{
			name: 'connect error events do not duplicate fallback recovery',
			fn: testConnectErrorEventDoesNotDuplicateFallbackRecovery
		},
		{
			name: 'handleConnect ignores duplicate connected emission',
			fn: testHandleConnectIgnoresDuplicateConnectedEmission
		}
	];

	for (const test of tests) {
		await withMutedConsole(() => test.fn());
		console.log(`auto-mode-regression: ${test.name} passed`);
	}

	console.log('auto-mode-regression: all checks passed');
	process.exit(0);
}

run().catch((error) => {
	console.error('auto-mode-regression: failed');
	console.error(error && error.stack ? error.stack : error);
	process.exit(1);
});
