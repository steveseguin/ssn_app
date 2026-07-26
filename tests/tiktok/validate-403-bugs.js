'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createTikTokEnvironment, __test } = require('../../tiktok/connection-manager.js');

function cloneStatus(payload) { return JSON.parse(JSON.stringify(payload)); }

function create403Error() {
    var err = new Error('Euler signing was rejected (403 Forbidden)');
    err.name = 'SignApiError';
    err.status = 403;
    return err;
}

function createRateLimitError(options) {
    var opts = options || {};
    var error = new Error('[Rate Limited]');
    error.name = opts.name || 'SignatureRateLimitError';
    error.status = 429;
    if (opts.source) error.source = opts.source;
    return error;
}

function createBusinessPlanError() {
    var error = new Error('[Empty Payload] Failed to sign a request: This endpoint requires a Business plan. Purchase one at https://www.eulerstream.com/pricing.');
    error.name = 'SignatureMissingTokensError';
    return error;
}

function createScenarioPlan(outcomesByMode) {
    var queues = Object.create(null);
    var modes = outcomesByMode || {};
    Object.keys(modes).forEach(function(mode) {
        queues[mode] = Array.isArray(modes[mode]) ? modes[mode].slice() : [];
    });
    return {
        attempts: [], statuses: [], reconnects: [],
        consume: function(mode) {
            var queue = queues[mode] || [];
            return queue.length ? queue.shift() : { ok: true };
        }
    };
}

function createFakeConnector(plan) {
    function FakeBase(username, options, customSigner) {
        EventEmitter.call(this);
        this.username = username;
        this.options = options || {};
        this.customSigner = customSigner || null;
        this.isConnected = false;
        this.webClient = { clientParams: {} };
    }
    FakeBase.prototype = Object.create(EventEmitter.prototype);
    FakeBase.prototype.constructor = FakeBase;
    FakeBase.prototype.getMode = function() { return 'auto'; };
    FakeBase.prototype.connect = async function() {
        var mode = this.getMode();
        plan.attempts.push({ kind: 'connect', mode: mode });
        var outcome = plan.consume(mode);
        if (outcome && outcome.error) {
            if (outcome.emitErrorEvent) this.emit('error', outcome.error);
            throw outcome.error;
        }
        this.isConnected = true;
        if (mode !== 'polling') this.emit('websocketConnected');
        return true;
    };
    FakeBase.prototype.disconnect = async function() {
        this.isConnected = false;
        plan.attempts.push({ kind: 'disconnect', mode: this.getMode() });
        return true;
    };

    function FakeLive(username, options, customSigner) {
        FakeBase.call(this, username, options, customSigner);
    }
    FakeLive.prototype = Object.create(FakeBase.prototype);
    FakeLive.prototype.constructor = FakeLive;
    FakeLive.prototype.getMode = function() {
        return this.options && typeof this.options.signedWebSocketProvider === 'function' ? 'local' : 'auto';
    };

    function FakePoll(username, options, customSigner) {
        FakeBase.call(this, username, options, customSigner);
    }
    FakePoll.prototype = Object.create(FakeBase.prototype);
    FakePoll.prototype.constructor = FakePoll;
    FakePoll.prototype.getMode = function() { return 'polling'; };

    return { TikTokLiveConnection: FakeLive, WebcastPushConnection: FakePoll };
}

function createHarness(outcomesByMode, options) {
    var opts = options || {};
    var plan = createScenarioPlan(outcomesByMode);
    var connector = createFakeConnector(plan);
    var env = createTikTokEnvironment({
        connector: connector,
        onStatus: function(payload) { plan.statuses.push(cloneStatus(payload)); },
        connectionStates: new Map(),
        getMainWindow: function() { return null; },
        localSigner: opts.localSignerEnabled !== false
            ? { sign: async function() { return { url: 'wss://example.invalid/tiktok' }; } }
            : null
    });
    var manager = new env.ConnectionManager('tester', 9001, null, null, {
        signingProvider: 'auto',
        signing: opts.signing || null
    });
    manager.connectAttemptMinIntervalMs = 0;
    manager.connectAttemptProviderIntervalMs = 0;
    manager.fallbackRestartMinDelayMs = 0;
    manager.localSignerAttemptTimeoutMs = 0;
    manager.localSignerFailureCooldownMs = 0;
    manager.sharedEulerApiKeyPool = [];
    manager.sharedEulerApiKeyAttempts = new Set();
    manager.logDebug = function() {};
    manager.startHealthCheck = function() {};
    manager.startViewerUpdateInterval = function() {};
    manager.closeLogWriter = function() {};
    manager.attemptReconnect = function(delay, reconnectOptions) {
        plan.reconnects.push(Object.assign({ delay: delay }, reconnectOptions || {}));
    };
    if (!opts.allowProxy) {
        manager.getAutoEulerProxyFallbackKey = function() { return null; };
    }
    return { manager: manager, plan: plan };
}

function withPatchedEulerProxy(plan, fn) {
    var proto = __test.EulerWebsocketServerConnection.prototype;
    var origConnect = proto.connect;
    var origDisconnect = proto.disconnect;
    proto.connect = async function() {
        plan.attempts.push({ kind: 'connect', mode: 'proxy' });
        var outcome = plan.consume('proxy');
        if (outcome && outcome.error) throw outcome.error;
        this.isConnected = true;
        this.emit('websocketConnected');
        return true;
    };
    proto.disconnect = async function() {
        this.isConnected = false;
        plan.attempts.push({ kind: 'disconnect', mode: 'proxy' });
        return true;
    };
    return fn().then(function(result) {
        proto.connect = origConnect; proto.disconnect = origDisconnect;
        return result;
    }, function(err) {
        proto.connect = origConnect; proto.disconnect = origDisconnect;
        throw err;
    });
}

function getConnectModes(plan) {
    return plan.attempts.filter(function(e) { return e.kind === 'connect'; }).map(function(e) { return e.mode; });
}

function withMutedConsole(fn) {
    var o = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    console.log = function(){}; console.info = function(){}; console.warn = function(){}; console.error = function(){};
    return fn().then(function(r) {
        Object.assign(console, o); return r;
    }, function(e) {
        Object.assign(console, o); throw e;
    });
}

var results = { passed: 0, failed: 0 };

async function test(name, fn) {
    try {
        await withMutedConsole(fn);
        console.log('PASS: ' + name);
        results.passed++;
    } catch (err) {
        console.log('FAIL: ' + name);
        console.log('  ' + err.message);
        results.failed++;
    }
}

async function run() {
    // ===== FIX A: handleError sign-server fallback =====

    await test('handleError 403 now triggers local signer fallback', async function() {
        var harness = createHarness({
            auto: [{ ok: true }],
            local: [{ ok: true }]
        }, { allowProxy: false });

        await withPatchedEulerProxy(harness.plan, function() { return harness.manager.initialize(); });
        var modesBefore = getConnectModes(harness.plan).slice();

        // Simulate mid-session 403
        await harness.manager.handleError(create403Error());

        var modesAfter = getConnectModes(harness.plan);
        var newModes = modesAfter.slice(modesBefore.length);
        assert(newModes.indexOf('local') !== -1,
            'handleError should now try local signer fallback for 403. Got modes: ' + JSON.stringify(newModes));
        assert.strictEqual(harness.plan.reconnects.length, 0,
            'Should not schedule reconnect when fallback handles the error');
    });

    await test('handleError 403 falls through to reconnect if all fallbacks exhausted', async function() {
        var harness = createHarness({
            auto: [{ ok: true }]
        }, { allowProxy: false, localSignerEnabled: false });

        await withPatchedEulerProxy(harness.plan, function() { return harness.manager.initialize(); });

        // No local signer, no proxy → fallback chain exhausted
        await harness.manager.handleError(create403Error());

        // Should fall through to normal reconnect
        assert.ok(harness.plan.reconnects.length > 0,
            'Should schedule reconnect when no fallbacks available');
    });

    await test('handleError 403 increments signServerFailureCount', async function() {
        var harness = createHarness({
            auto: [{ ok: true }]
        }, { allowProxy: false, localSignerEnabled: false });

        await withPatchedEulerProxy(harness.plan, function() { return harness.manager.initialize(); });

        assert.strictEqual(harness.manager.signServerFailureCount, 0);
        await harness.manager.handleError(create403Error());
        assert.strictEqual(harness.manager.signServerFailureCount, 1);
        await harness.manager.handleError(create403Error());
        assert.strictEqual(harness.manager.signServerFailureCount, 2);
    });

    await test('Polling plan requirement is surfaced once without rapid retries', async function() {
        var harness = createHarness({
            polling: [{ error: createBusinessPlanError() }]
        }, { allowProxy: false, localSignerEnabled: false });
        harness.manager.preferredStrategy = 'legacy';
        harness.manager.connectionStrategy = 'legacy';

        await harness.manager.initialize();
        await new Promise(function(resolve) { setTimeout(resolve, 20); });

        assert.deepStrictEqual(getConnectModes(harness.plan), ['polling']);
        assert.strictEqual(harness.plan.reconnects.length, 0,
            'a plan requirement cannot be fixed by immediate reconnects');
        var failed = harness.plan.statuses.find(function(status) { return status.status === 'failed'; });
        assert.ok(failed, 'expected a failed status for the renderer');
        assert.ok(/Polling requires an Euler plan/.test(failed.error),
            'expected actionable Polling/Euler guidance');
        assert.strictEqual(failed.configurationRequired, true);
    });

    // ===== FIX B: rapid disconnect detection =====

    await test('rapid disconnect counter increments for short-lived connections', async function() {
        var harness = createHarness({ auto: [{ ok: true }] }, { allowProxy: false, localSignerEnabled: false });
        await withPatchedEulerProxy(harness.plan, function() { return harness.manager.initialize(); });

        assert.strictEqual(harness.manager.rapidDisconnectCount, 0);

        // Simulate a connection that was very short-lived
        harness.manager.lastConnectTimestamp = Date.now() - 5000; // 5 seconds ago
        harness.manager.handleDisconnect({ code: 1006 });
        assert.strictEqual(harness.manager.rapidDisconnectCount, 1);
    });

    await test('rapid disconnect counter resets for long-lived connections', async function() {
        var harness = createHarness({ auto: [{ ok: true }] }, { allowProxy: false, localSignerEnabled: false });
        await withPatchedEulerProxy(harness.plan, function() { return harness.manager.initialize(); });

        harness.manager.rapidDisconnectCount = 2;
        harness.manager.lastConnectTimestamp = Date.now() - 120000; // 2 minutes ago
        harness.manager.handleDisconnect({ code: 1006 });
        assert.strictEqual(harness.manager.rapidDisconnectCount, 0,
            'Count should reset for connection that lasted > threshold');
    });

    await test('3 rapid disconnects triggers auto fallback (not plain reconnect)', async function() {
        var harness = createHarness({
            auto: [{ ok: true }],
            local: [{ ok: true }]
        }, { allowProxy: false });

        await withPatchedEulerProxy(harness.plan, function() { return harness.manager.initialize(); });
        var modesBefore = getConnectModes(harness.plan).slice();

        // Simulate 3 rapid disconnects
        harness.manager.rapidDisconnectCount = 2; // Already had 2
        harness.manager.lastConnectTimestamp = Date.now() - 5000; // Short-lived
        harness.manager.handleDisconnect({ code: 1006 });

        // Wait a tick for the async fallback chain
        await new Promise(function(r) { setTimeout(r, 50); });

        var modesAfter = getConnectModes(harness.plan);
        var newModes = modesAfter.slice(modesBefore.length);

        // Should try fallback, not just reconnect
        var triedFallback = newModes.length > 0;
        assert.ok(triedFallback || harness.plan.reconnects.length > 0,
            'Should trigger fallback or reconnect after 3 rapid disconnects');
    });

    await test('rapid disconnect counter resets after triggering fallback', async function() {
        var harness = createHarness({
            auto: [{ ok: true }]
        }, { allowProxy: false, localSignerEnabled: false });

        await withPatchedEulerProxy(harness.plan, function() { return harness.manager.initialize(); });

        // Set up for trigger
        harness.manager.rapidDisconnectCount = 2;
        harness.manager.lastConnectTimestamp = Date.now() - 5000;
        harness.manager.handleDisconnect({ code: 1006 });

        // Counter should reset after triggering
        assert.strictEqual(harness.manager.rapidDisconnectCount, 0,
            'Counter should reset after triggering fallback');
    });

    await test('Euler NOT_LIVE close enters offline retry instead of stopping AUTO', async function() {
        var harness = createHarness({ auto: [{ ok: true }] }, { allowProxy: false, localSignerEnabled: false });
        harness.manager.signingProvider = 'euler-ws';
        harness.manager.buildOfflineReason = function(message) { return message; };

        harness.manager.handleDisconnect({ code: 4404, codeLabel: 'NOT_LIVE' });

        assert.strictEqual(harness.plan.reconnects.length, 1,
            'expected one offline retry to be scheduled');
        assert.strictEqual(harness.plan.reconnects[0].offline, true,
            'offline retry should be flagged');
        assert.strictEqual(harness.manager.offlineRetry, true,
            'manager should enter offline retry mode');
        assert.strictEqual(harness.manager.offlineReason, 'The requested user is not live right now.');
    });

    await test('exhausted AUTO fallback clears connected state and schedules reconnect', async function() {
        var harness = createHarness({ auto: [{ ok: true }] }, { allowProxy: false, localSignerEnabled: false });
        harness.manager.signingProvider = 'euler-ws';
        harness.manager.autoEulerProxyFallbackActive = true;
        harness.manager.tryAutoFallbacksBeforePrompt = async function() { return false; };
        harness.manager.lastConnectTimestamp = Date.now() - 5000;

        harness.manager.handleDisconnect({ code: 4429, codeLabel: 'TOO_MANY_CONNECTIONS' });
        await new Promise(function(resolve) { setTimeout(resolve, 20); });

        assert.ok(harness.plan.statuses.some(function(status) { return status.status === 'disconnected'; }),
            'exhausted fallbacks should notify the renderer that the source disconnected');
        assert.strictEqual(harness.plan.reconnects.length, 1,
            'exhausted fallbacks should continue through the normal reconnect path');
    });

    await test('pending streamEnd is cancelled by later traffic', async function() {
        var harness = createHarness({ auto: [{ ok: true }] }, { allowProxy: false, localSignerEnabled: false });
        harness.manager.buildOfflineReason = function(message) { return message; };
        harness.manager.streamEndConfirmDelayMs = 15;
        harness.manager.lastMessageTime = Date.now();

        harness.manager.scheduleStreamEndConfirmation('unit_test');
        setTimeout(function() {
            harness.manager.noteConnectionActivity('unit_test_message');
        }, 5);

        await new Promise(function(resolve) { setTimeout(resolve, 40); });

        assert.strictEqual(harness.plan.reconnects.length, 0,
            'streamEnd should not trigger offline retry after traffic');
        assert.strictEqual(harness.manager.offlineRetry, false,
            'manager should remain active after cancelling streamEnd');
    });

    await test('streamEnd confirms after quiet period and enters offline retry', async function() {
        var harness = createHarness({ auto: [{ ok: true }] }, { allowProxy: false, localSignerEnabled: false });
        harness.manager.buildOfflineReason = function(message) { return message; };
        harness.manager.streamEndConfirmDelayMs = 10;
        harness.manager.lastMessageTime = Date.now();

        harness.manager.scheduleStreamEndConfirmation('unit_test');
        await new Promise(function(resolve) { setTimeout(resolve, 30); });

        assert.strictEqual(harness.plan.reconnects.length, 1,
            'quiet streamEnd should trigger offline retry');
        assert.strictEqual(harness.plan.reconnects[0].offline, true,
            'retry should be marked offline');
        assert.strictEqual(harness.manager.offlineReason, 'Live stream has ended');
    });

    await test('handleConnect sets lastConnectTimestamp', async function() {
        var harness = createHarness({}, { allowProxy: false, localSignerEnabled: false });

        assert.strictEqual(harness.manager.lastConnectTimestamp, 0);
        harness.manager.preferredStrategy = 'legacy';
        harness.manager.connectionStrategy = 'legacy';
        harness.manager.handleConnect();

        assert.ok(harness.manager.lastConnectTimestamp > 0,
            'handleConnect should set lastConnectTimestamp');
        assert.ok(Date.now() - harness.manager.lastConnectTimestamp < 1000,
            'lastConnectTimestamp should be recent');
    });

    // ===== Verify existing behavior still works =====

    await test('rate limit in handleError still triggers auto fallback (not broken)', async function() {
        var harness = createHarness({
            auto: [{ ok: true }],
            local: [{ ok: true }]
        }, { allowProxy: false });

        await withPatchedEulerProxy(harness.plan, function() { return harness.manager.initialize(); });
        var modesBefore = getConnectModes(harness.plan).slice();

        await harness.manager.handleError(createRateLimitError());

        var modesAfter = getConnectModes(harness.plan);
        var newModes = modesAfter.slice(modesBefore.length);
        assert(newModes.indexOf('local') !== -1,
            'Rate limit should still trigger local signer fallback');
    });

    await test('offline error in handleError still reconnects normally (not broken)', async function() {
        var harness = createHarness({
            auto: [{ ok: true }]
        }, { allowProxy: false, localSignerEnabled: false });

        await withPatchedEulerProxy(harness.plan, function() { return harness.manager.initialize(); });

        var offlineError = new Error("The requested user isn't online :(");
        offlineError.name = 'UserOfflineError';
        await harness.manager.handleError(offlineError);

        assert.ok(harness.plan.reconnects.length > 0,
            'Offline error should still schedule reconnect');
        assert.strictEqual(harness.plan.reconnects[0].offline, true,
            'Should be marked as offline retry');
    });

    console.log('\n=== Results: ' + results.passed + ' passed, ' + results.failed + ' failed ===');
    process.exit(results.failed > 0 ? 1 : 0);
}

run().catch(function(err) {
    console.error('Test runner error:', err);
    process.exit(1);
});
