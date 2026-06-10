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

function createLocalSignerTimeoutError() {
	const error = new Error('TikTok local signer timed out after 10ms');
	error.name = 'TikTokLocalSignerTimeoutError';
	error.code = 'SSAPP_TIKTOK_LOCAL_SIGNER_TIMEOUT';
	error.source = 'local_signer_timeout';
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

function createOfflineError() {
	const error = new Error("The requested user isn't online :(");
	error.name = 'UserOfflineError';
	return error;
}

function createInvalidBootstrapUrlError() {
	const error = new SyntaxError('Invalid URL: ?version_code=180800&aid=1988&room_id=1234567890');
	error.code = 'SSAPP_TIKTOK_WSURL_INVALID';
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
	manager.connectAttemptMinIntervalMs = 0;
	manager.connectAttemptProviderIntervalMs = 0;
	manager.fallbackRestartMinDelayMs = 0;
	manager.localSignerAttemptTimeoutMs = 0;
	manager.localSignerFailureCooldownMs = 0;

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

async function testInstalledConnectorHasNoRuntimePollingPath() {
	const clientPath = path.join(__dirname, '..', '..', 'node_modules', 'tiktok-live-connector', 'dist', 'lib', 'client.js');
	const legacyPath = path.join(__dirname, '..', '..', 'node_modules', 'tiktok-live-connector', 'dist', 'lib', '_legacy', 'legacy-client.js');
	const clientSrc = fs.readFileSync(clientPath, 'utf8');
	const legacySrc = fs.readFileSync(legacyPath, 'utf8');

	const connectStart = clientSrc.indexOf('async _connect');
	const disconnectStart = clientSrc.indexOf('\n    async disconnect', connectStart);
	assert.ok(connectStart >= 0 && disconnectStart > connectStart, 'expected to find TikTokLiveConnection._connect body');

	const connectBody = clientSrc.slice(connectStart, disconnectStart);
	assert.ok(
		connectBody.includes('signedWebSocketProvider') && connectBody.includes('fetchSignedWebSocketFromEuler'),
		'expected installed connector to bootstrap through signed websocket provider/Euler'
	);
	assert.ok(
		connectBody.includes('setupWebsocket'),
		'expected installed connector runtime path to open a websocket'
	);
	assert.ok(
		!/enableRequestPolling|requestPollingIntervalMs/.test(connectBody),
		'installed connector _connect should not have a runtime request-polling branch'
	);
	assert.ok(
		/extends\s+lib_1\.TikTokLiveConnection/.test(legacySrc),
		'legacy WebcastPushConnection should be a wrapper over TikTokLiveConnection'
	);
}

async function testAutoFallsBackFromLocalSignerToEulerProxy() {
	const { manager, plan } = createHarness({
		auto: [{ error: createRateLimitError() }, { error: createRateLimitError() }],
		local: [{ error: createRateLimitError({ name: 'TikTokRateLimitError', source: 'local_signer' }) }],
		proxy: [{ ok: true }]
	});

	const result = await withPatchedEulerProxy(plan, () => manager.initialize());

	assert.strictEqual(result, true);
	assert.deepStrictEqual(getConnectModes(plan), ['auto', 'local', 'auto', 'proxy']);
	assert.deepStrictEqual(getReconnectingReasons(plan), [
		'Sign server unavailable. Trying local signer.',
		'Local signer failed. Trying Euler signing.',
		'Sign server unavailable. Trying Euler Proxy with shared Euler proxy key.'
	]);
	assert.strictEqual(plan.reconnects.length, 0);

	const connected = getLastStatus(plan, 'connected');
	assert(connected, 'expected a connected status');
	assert.strictEqual(connected.connectionMethod, 'Euler WS relay (API key)');
	assert.strictEqual(connected.connectionLabel, 'Websocket connected via Euler WS relay (API key)');
}

async function testAutoRestoresEulerSigningAfterLocalSignerFailure() {
	const { manager, plan } = createHarness({
		auto: [{ error: createRateLimitError() }, { ok: true }],
		local: [{ error: createLocalSignerTimeoutError() }]
	}, {
		allowProxy: false
	});

	const result = await withPatchedEulerProxy(plan, () => manager.initialize());

	assert.strictEqual(result, true);
	assert.deepStrictEqual(getConnectModes(plan), ['auto', 'local', 'auto']);
	assert.strictEqual(manager.signingProvider, 'auto');
	assert.strictEqual(manager.autoLocalSignerFallbackActive, false);
	assert.strictEqual(manager.autoLocalSignerFallbackAttempted, true);
	assert.strictEqual(plan.reconnects.length, 0);

	const reasons = getReconnectingReasons(plan);
	assert.ok(reasons.includes('Sign server unavailable. Trying local signer.'));
	assert.ok(reasons.includes('Local signer failed. Trying Euler signing.'));

	const connected = getLastStatus(plan, 'connected');
	assert(connected, 'expected a connected status');
	assert.strictEqual(connected.connectionMethod, 'Euler signing (auto)');
}

async function testAutoCanUseSharedEulerAfterLocalSignerFailure() {
	const { manager, plan } = createHarness({
		auto: [
			{ error: createRateLimitError() },
			{ error: createRateLimitError() },
			{ ok: true }
		],
		local: [{ error: createLocalSignerTimeoutError() }]
	}, {
		allowProxy: false
	});
	manager.sharedEulerApiKeyPool = [
		{ key: 'shared-signing-key', label: 'shared Euler signing key', scope: 'signing' }
	];

	const result = await withPatchedEulerProxy(plan, () => manager.initialize());

	assert.strictEqual(result, true);
	assert.deepStrictEqual(getConnectModes(plan), ['auto', 'local', 'auto', 'auto']);
	assert.strictEqual(countStatuses(plan, entry => entry.sharedKeyRetry === true), 1);
	assert.strictEqual(manager.signingConfig.apiKey, 'shared-signing-key');
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
		auto: [{ error: createRateLimitError() }, { error: createRateLimitError() }],
		local: [{ error: createRateLimitError({ name: 'TikTokRateLimitError', source: 'local_signer' }) }],
		proxy: [{ error: proxyRateLimit }],
		polling: [{ ok: true }]
	});

	const result = await withPatchedEulerProxy(plan, () => manager.initialize());

	assert.strictEqual(result, true);
	assert.deepStrictEqual(getConnectModes(plan), ['auto', 'local', 'auto', 'proxy', 'polling']);
	assert.deepStrictEqual(getReconnectingReasons(plan), [
		'Sign server unavailable. Trying local signer.',
		'Local signer failed. Trying Euler signing.',
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
		auto: [{ error: createRateLimitError() }, { error: createRateLimitError() }],
		local: [{ error: createRateLimitError({ name: 'TikTokRateLimitError', source: 'local_signer' }) }],
		proxy: [{ error: createRateLimitError() }],
		polling: [{ error: pollingRateLimit }]
	});

	const result = await withPatchedEulerProxy(plan, () => manager.initialize());

	assert.strictEqual(result, false);
	assert.deepStrictEqual(getConnectModes(plan), ['auto', 'local', 'auto', 'proxy', 'polling']);

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

async function testOfflineFailureStatusCarriesOfflineFlag() {
	const { manager, plan } = createHarness({
		auto: [{ error: createOfflineError() }]
	}, {
		allowProxy: false,
		localSignerEnabled: false
	});

	const result = await manager.initialize();

	assert.strictEqual(result, false);
	assert.deepStrictEqual(getConnectModes(plan), ['auto']);
	assert.strictEqual(plan.reconnects.length, 1);
	assert.strictEqual(plan.reconnects[0].fixed, true);
	assert.strictEqual(plan.reconnects[0].offline, true);

	const failed = getLastStatus(plan, 'failed');
	assert(failed, 'expected an offline failed status');
	assert.strictEqual(failed.offline, true);
	assert.strictEqual(failed.rateLimited, false);
	assert.strictEqual(failed.connectionMethod, 'Euler signing (auto)');
	assert.strictEqual(failed.error, "The requested user isn't online :(");
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

async function testInvalidBootstrapUrlGetsUsefulMessages() {
	const { manager } = createHarness({}, {
		allowProxy: false,
		localSignerEnabled: false
	});

	const bootstrapError = createInvalidBootstrapUrlError();

	assert.strictEqual(manager.isSignServerError(bootstrapError, bootstrapError.message), true);
	assert.strictEqual(
		manager.getUserFriendlyErrorMessage(bootstrapError, ''),
		'TikTok returned invalid websocket bootstrap data. Trying another mode may help.'
	);
	assert.strictEqual(
		manager.getSanitizedFallbackMessage(bootstrapError),
		'TikTok returned invalid websocket bootstrap data. Switching to compatibility mode.'
	);
}

async function testInvalidBootstrapUrlFallsBackToPollingImmediately() {
	const bootstrapError = createInvalidBootstrapUrlError();
	const { manager, plan } = createHarness({
		auto: [{ error: bootstrapError }],
		polling: [{ ok: true }]
	}, {
		allowProxy: false,
		localSignerEnabled: false
	});

	const result = await manager.initialize();

	assert.strictEqual(result, true);
	assert.deepStrictEqual(getConnectModes(plan), ['auto', 'polling']);
	assert.strictEqual(plan.reconnects.length, 0);

	const pollingFallback = getLastStatus(plan, 'fallback_polling');
	assert(pollingFallback, 'expected a polling fallback status');
	assert.strictEqual(
		pollingFallback.error,
		'TikTok returned invalid websocket bootstrap data. Switching to compatibility mode.'
	);

	const connected = getLastStatus(plan, 'connected');
	assert(connected, 'expected a connected status');
	assert.strictEqual(connected.connectionMethod, 'Polling (legacy fallback)');
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

async function testUiDoesNotAutoFallbackAfterOfflineFailure() {
	const indexPath = path.join(__dirname, '..', '..', 'index.html');
	const src = fs.readFileSync(indexPath, 'utf8');

	assert.ok(
		src.includes('function isTikTokOfflineFailureStatus'),
		'expected renderer-side offline failure guard helper'
	);
	assert.ok(
		src.includes("normalizedMessage.includes(\"isn't online\")"),
		'expected renderer to recognize TikTok offline text'
	);
	assert.ok(
		src.includes('const offlineFailure = isTikTokOfflineFailureStatus(data)'),
		'expected failed status handler to classify offline failures'
	);
	assert.ok(
		src.includes('const shouldAdvanceToNextMode = !offlineFailure && !hasRetryScheduled && hasAlternateMode'),
		'expected offline failures to suppress Auto fallback to the next mode'
	);
}

async function testManualStandardFatalDoesNotAutoCloseClassicWindow() {
	const indexPath = path.join(__dirname, '..', '..', 'index.html');
	const src = fs.readFileSync(indexPath, 'utf8');

	assert.ok(
		src.includes('function shouldKeepTikTokClassicWindowOpenOnFatal'),
		'expected manual-standard classic-window guard helper'
	);
	assert.ok(
		src.includes("return preferredMode === 'classic'"),
		'expected helper to key off explicit Standard mode'
	);
	assert.ok(
		src.includes('source.autoActivate !== true'),
		'expected helper to keep auto-activate behavior separate from manual standard mode'
	);
	assert.ok(
		src.includes("const classicTabId = normalizeNumericId(data.tabID) || normalizeNumericId(currentState.vid)")
			&& src.includes("if (!keepClassicWindowOpen && !data.wssID && classicTabId && ipcRenderer)"),
		'expected fatal_error closeWindow call to be skipped for manual classic mode'
	);
}

async function testClassicTerminalStatusesReleaseStaleHandles() {
	const indexPath = path.join(__dirname, '..', '..', 'index.html');
	const src = fs.readFileSync(indexPath, 'utf8');

	assert.ok(
		src.includes('function shouldReleaseTikTokClassicHandles'),
		'expected helper for clearing stale classic handles'
	);
	assert.ok(
		src.includes("if (shouldReleaseTikTokClassicHandles(currentState, data, hasRetryScheduled))"),
		'expected terminal status handlers to clear stale classic handles'
	);
	assert.ok(
		src.includes('updatePayload.tiktokWssId = null;'),
		'expected stale TikTok websocket IDs to be cleared when releasing handles'
	);
}

async function testTikTokActivationHandleDoesNotOverwritePendingStatus() {
	const indexPath = path.join(__dirname, '..', '..', 'index.html');
	const src = fs.readFileSync(indexPath, 'utf8');

	assert.ok(
		src.includes('const tiktokWaitingForConnect = resolvedTarget === \'tiktok\''),
		'expected TikTok activation to distinguish virtual handles from connected status'
	);
	assert.ok(
		src.includes('error: tiktokWaitingForConnect ? tiktokErrorAfterCreate : null'),
		'expected pending TikTok activation to preserve offline/retry errors'
	);
	assert.ok(
		src.includes("} else if (tiktokStatusAfterCreate === 'error' && tiktokErrorAfterCreate)"),
		'expected pending TikTok activation to keep retry/error UI instead of showing connected'
	);
	assert.ok(
		src.includes("} else if (!entry._tiktokRetryEndAt)"),
		'expected retry countdown UI not to be overwritten by a generic connecting label'
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

async function testFallbackRestartDelayIsApplied() {
	const { manager, plan } = createHarness({
		auto: [{ ok: true }]
	}, {
		allowProxy: false,
		localSignerEnabled: false
	});
	manager.fallbackRestartMinDelayMs = 25;

	const startedAt = Date.now();
	const result = await manager.restartConnectionAttempt(null, 'unit_restart_delay');
	const elapsedMs = Date.now() - startedAt;

	assert.strictEqual(result, true);
	assert.ok(elapsedMs >= 20, `expected restart delay, got ${elapsedMs}ms`);
	assert.deepStrictEqual(getConnectModes(plan), ['auto']);
}

async function testLocalSignerProviderTimesOut() {
	const { manager } = createHarness({}, {
		allowProxy: false,
		localSignerEnabled: true
	});
	manager.localSigner = {
		sign: () => new Promise(() => {})
	};
	manager.localSignerAttemptTimeoutMs = 10;

	await assert.rejects(
		() => manager.fetchSignedWebSocketViaLocalSigner({ uniqueId: 'tester' }),
		(error) => error && error.code === 'SSAPP_TIKTOK_LOCAL_SIGNER_TIMEOUT'
	);
}

async function run() {
	const tests = [
		{
			name: 'installed connector has no runtime polling path',
			fn: testInstalledConnectorHasNoRuntimePollingPath
		},
		{
			name: 'auto falls back to local signer',
			fn: testAutoFallsBackToLocalSigner
		},
		{
			name: 'auto falls back from local signer to Euler proxy',
			fn: testAutoFallsBackFromLocalSignerToEulerProxy
		},
		{
			name: 'auto restores Euler signing after local signer failure',
			fn: testAutoRestoresEulerSigningAfterLocalSignerFailure
		},
		{
			name: 'auto can use shared Euler after local signer failure',
			fn: testAutoCanUseSharedEulerAfterLocalSignerFailure
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
			name: 'offline failure status carries offline flag',
			fn: testOfflineFailureStatusCarriesOfflineFlag
		},
		{
			name: 'blank room lookup errors become useful messages',
			fn: testBlankRoomLookupErrorsBecomeUsefulMessages
		},
		{
			name: 'invalid bootstrap URL gets useful messages',
			fn: testInvalidBootstrapUrlGetsUsefulMessages
		},
		{
			name: 'invalid bootstrap URL falls back to polling immediately',
			fn: testInvalidBootstrapUrlFallsBackToPollingImmediately
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
			name: 'ui does not auto fallback after offline failure',
			fn: testUiDoesNotAutoFallbackAfterOfflineFailure
		},
		{
			name: 'manual standard fatal does not auto close classic window',
			fn: testManualStandardFatalDoesNotAutoCloseClassicWindow
		},
		{
			name: 'classic terminal statuses release stale handles',
			fn: testClassicTerminalStatusesReleaseStaleHandles
		},
		{
			name: 'TikTok activation handle does not overwrite pending status',
			fn: testTikTokActivationHandleDoesNotOverwritePendingStatus
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
		},
		{
			name: 'fallback restart delay is applied',
			fn: testFallbackRestartDelayIsApplied
		},
		{
			name: 'local signer provider times out',
			fn: testLocalSignerProviderTimesOut
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
