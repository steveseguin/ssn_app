'use strict';

const assert = require('assert');
const {
	createStrategyResult,
	exitCodeForResults,
} = require('./runner-result');

const connected = createStrategyResult('websocket', true, { status: 'connected' }, null);
assert.deepStrictEqual(connected, {
	strategy: 'websocket',
	connected: true,
	everConnected: true,
	status: 'connected',
	error: null,
});
assert.strictEqual(exitCodeForResults([connected]), 0);

const transient = createStrategyResult(
	'websocket',
	true,
	{ status: 'reconnecting' },
	null
);
assert.strictEqual(transient.connected, false);
assert.strictEqual(transient.everConnected, true);
assert.strictEqual(transient.status, 'reconnecting');
assert.match(transient.error, /ended with status: reconnecting/);
assert.strictEqual(exitCodeForResults([transient]), 1);

const offline = createStrategyResult(
	'legacy',
	false,
	{ status: 'failed', error: "The requested user isn't online :(" },
	null
);
assert.strictEqual(offline.connected, false);
assert.strictEqual(offline.everConnected, false);
assert.strictEqual(offline.status, 'failed');
assert.match(offline.error, /isn't online/);
assert.strictEqual(exitCodeForResults([connected, offline]), 1);

const initializationFailure = createStrategyResult(
	'websocket',
	false,
	{ status: 'connecting' },
	new Error('signing failed')
);
assert.strictEqual(initializationFailure.error, 'signing failed');
assert.strictEqual(exitCodeForResults([initializationFailure]), 1);
assert.strictEqual(exitCodeForResults([]), 1);

console.log('tiktok-runner-result-regression: all checks passed');
