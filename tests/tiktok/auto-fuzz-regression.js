'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createTikTokEnvironment, __test } = require('../../tiktok/connection-manager.js');

function cloneStatus(payload) {
	return JSON.parse(JSON.stringify(payload));
}

function createSeededRandom(seed) {
	let state = (seed >>> 0) || 1;
	return function next() {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

function pick(rng, values) {
	return values[Math.floor(rng() * values.length)];
}

function maybe(rng, probability) {
	return rng() < probability;
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

function createOfflineError() {
	const error = new Error("The requested user isn't online :(");
	error.name = 'UserOfflineError';
	return error;
}

function createSignServerError() {
	const error = new Error('Failed to connect to sign server');
	error.code = 'ECONNREFUSED';
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
	const manager = new env.ConnectionManager('tester', 9101, null, null, {
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

function buildScenario(seed) {
	const rng = createSeededRandom(seed);
	const kind = pick(rng, [
		'success',
		'rate_limit_local',
		'rate_limit_proxy',
		'rate_limit_polling',
		'user_not_found',
		'offline',
		'sign_then_local'
	]);
	const duplicateErrorEvent = maybe(rng, 0.35);

	switch (kind) {
		case 'success':
			return {
				kind,
				outcomesByMode: { auto: [{ ok: true }] },
				options: {}
			};
		case 'rate_limit_local':
			return {
				kind,
				outcomesByMode: {
					auto: [{ error: createRateLimitError({ source: 'signing' }), emitErrorEvent: duplicateErrorEvent }],
					local: [{ ok: true }]
				},
				options: { allowProxy: false }
			};
		case 'rate_limit_proxy':
			return {
				kind,
				outcomesByMode: {
					auto: [{ error: createRateLimitError({ source: 'signing' }), emitErrorEvent: duplicateErrorEvent }],
					local: [{ error: createRateLimitError({ name: 'TikTokRateLimitError', source: 'local_signer' }) }],
					proxy: [{ ok: true }]
				},
				options: {}
			};
		case 'rate_limit_polling':
			return {
				kind,
				outcomesByMode: {
					auto: [{ error: createRateLimitError({ source: 'signing' }), emitErrorEvent: duplicateErrorEvent }],
					local: [{ error: createRateLimitError({ name: 'TikTokRateLimitError', source: 'local_signer' }) }],
					proxy: [{ error: createRateLimitError({ source: 'proxy' }) }],
					polling: [{ ok: true }]
				},
				options: {}
			};
		case 'user_not_found':
			return {
				kind,
				outcomesByMode: {
					auto: [{ error: createUserNotFoundLookupError(), emitErrorEvent: duplicateErrorEvent }]
				},
				options: {}
			};
		case 'offline':
			return {
				kind,
				outcomesByMode: {
					auto: [{ error: createOfflineError(), emitErrorEvent: duplicateErrorEvent }]
				},
				options: {}
			};
		case 'sign_then_local':
			return {
				kind,
				outcomesByMode: {
					auto: [{ error: createSignServerError(), emitErrorEvent: duplicateErrorEvent }],
					local: [{ ok: true }]
				},
				options: { allowProxy: false }
			};
		default:
			throw new Error(`Unknown scenario kind: ${kind}`);
	}
}

async function runScenario(seed) {
	const scenario = buildScenario(seed);
	const { manager, plan } = createHarness(scenario.outcomesByMode, scenario.options);

	const result = await withMutedConsole(() =>
		withPatchedEulerProxy(plan, () => manager.initialize())
	);

	assert.ok(
		countStatuses(plan, entry => entry.status === 'connected') <= 1,
		`seed ${seed}: expected at most one connected status`
	);
	assert.ok(
		countStatuses(plan, entry => entry.status === 'fatal_error') <= 1,
		`seed ${seed}: expected at most one fatal_error status`
	);

	switch (scenario.kind) {
		case 'success':
			assert.strictEqual(result, true, `seed ${seed}: success scenario should connect`);
			assert.deepStrictEqual(getConnectModes(plan), ['auto']);
			assert.strictEqual(plan.reconnects.length, 0);
			break;
		case 'rate_limit_local':
			assert.strictEqual(result, true, `seed ${seed}: local fallback scenario should connect`);
			assert.deepStrictEqual(getConnectModes(plan), ['auto', 'local']);
			assert.strictEqual(plan.reconnects.length, 0);
			break;
		case 'rate_limit_proxy':
			assert.strictEqual(result, true, `seed ${seed}: proxy fallback scenario should connect`);
			assert.deepStrictEqual(getConnectModes(plan), ['auto', 'local', 'proxy']);
			assert.strictEqual(plan.reconnects.length, 0);
			break;
		case 'rate_limit_polling':
			assert.strictEqual(result, true, `seed ${seed}: polling fallback scenario should connect`);
			assert.deepStrictEqual(getConnectModes(plan), ['auto', 'local', 'proxy', 'polling']);
			assert.strictEqual(plan.reconnects.length, 0);
			break;
		case 'user_not_found': {
			const fatal = getLastStatus(plan, 'fatal_error');
			assert.strictEqual(result, false, `seed ${seed}: user_not_found should stop`);
			assert.deepStrictEqual(getConnectModes(plan), ['auto']);
			assert.strictEqual(plan.reconnects.length, 0);
			assert.ok(fatal, `seed ${seed}: expected fatal_error for user_not_found`);
			assert.strictEqual(fatal.error, 'TikTok user not found. Check the username and try again.');
			break;
		}
		case 'offline':
			assert.strictEqual(result, false, `seed ${seed}: offline should not connect`);
			assert.deepStrictEqual(getConnectModes(plan), ['auto']);
			assert.strictEqual(plan.reconnects.length, 1);
			assert.strictEqual(plan.reconnects[0].offline, true);
			assert.strictEqual(countStatuses(plan, entry => entry.status === 'fatal_error'), 0);
			break;
		case 'sign_then_local':
			assert.strictEqual(result, true, `seed ${seed}: sign-server fallback should connect`);
			assert.deepStrictEqual(getConnectModes(plan), ['auto', 'local']);
			assert.strictEqual(plan.reconnects.length, 0);
			break;
		default:
			throw new Error(`Unhandled scenario kind: ${scenario.kind}`);
	}
}

async function main() {
	const seeds = 80;
	for (let seed = 1; seed <= seeds; seed += 1) {
		await runScenario(seed);
	}
	console.log(`auto-fuzz-regression: ${seeds} seeded AUTO scenarios passed`);
	process.exit(0);
}

main().catch((error) => {
	console.error('auto-fuzz-regression: failed');
	console.error(error && error.stack ? error.stack : error);
	process.exit(1);
});
