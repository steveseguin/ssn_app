'use strict';

const assert = require('assert');
const { createTikTokEnvironment } = require('../../tiktok/connection-manager.js');

class DummyConnectorConnection {
  constructor() {
    this.roomId = null;
  }
}

function buildConnectorStub() {
  return {
    WebcastPushConnection: DummyConnectorConnection,
    TikTokLiveConnection: DummyConnectorConnection,
    WebcastDeserializeConfig: {
      skipMessageTypes: []
    }
  };
}

function createHarness() {
  const emitted = [];
  const websocketConnections = {};
  const connectionStates = new Map();

  const env = createTikTokEnvironment({
    connector: buildConnectorStub(),
    shouldEnableTikTokLogging: false,
    resolveLogDirectory: () => null,
    getMainWindow: () => null,
    websocketConnections,
    browserViews: {},
    log: () => { },
    onStatus: () => { },
    onEvent: (event) => emitted.push(event),
    getCachedSettings: () => ({}),
    isCaptureEventsEnabled: () => true,
    isCaptureJoinedEventEnabled: () => true,
    isCaptureLikedEventEnabled: () => true,
    isViewerUpdateAllowed: () => true,
    isTextOnlyModeEnabled: () => false,
    connectionStates
  });

  const makeManager = (wssID) => {
    const manager = new env.ConnectionManager('unit_test', wssID, null, null, {});
    manager.sourceId = 'source-tiktok-1';
    manager.virtualTabId = 900000 + wssID;
    manager.logDebug = () => { };
    manager.closeLogWriter = () => { };
    return manager;
  };

  return {
    emitted,
    websocketConnections,
    connectionStates,
    env,
    makeManager
  };
}

function registerManager(harness, manager) {
  harness.websocketConnections[manager.wssID] = manager;
  harness.connectionStates.set(manager.wssID, {
    isConnected: false,
    lastAttempt: Date.now(),
    isReconnecting: false,
    attemptInProgress: false
  });
  harness.env.registerActiveTikTokSourceConnection(manager, 'test');
}

function runReplacementSuppressesOldEventsAssertion() {
  const harness = createHarness();
  const first = harness.makeManager(1);
  registerManager(harness, first);

  const second = harness.makeManager(2);
  harness.env.registerActiveTikTokSourceConnection(second, 'test_replacement');
  harness.websocketConnections[2] = second;

  assert.strictEqual(first.isStopped, true, 'old manager should be stopped when replacement is registered');
  assert.strictEqual(harness.websocketConnections[1], undefined, 'old manager should be removed from active connections');

  first.sendEventMessage({ uniqueId: 'old-user', nickname: 'Old User' }, 'followed', 'Old User followed!');
  second.sendEventMessage({ uniqueId: 'new-user', nickname: 'New User' }, 'followed', 'New User followed!');

  assert.strictEqual(harness.emitted.length, 1, 'only the replacement manager should forward events');
  assert.strictEqual(harness.emitted[0].tid, 900002, 'forwarded event should belong to replacement manager');
  assert.strictEqual(harness.emitted[0].chatname, 'New User');
}

function runFinalForwarderDropsStaleVirtualTabsAssertion() {
  const harness = createHarness();
  const first = harness.makeManager(1);
  registerManager(harness, first);

  const second = harness.makeManager(2);
  harness.env.registerActiveTikTokSourceConnection(second, 'test_replacement');
  harness.websocketConnections[2] = second;

  harness.env.sendToBackground({
    type: 'tiktok',
    event: 'chat',
    tid: 900001,
    chatname: 'Old User',
    chatmessage: 'stale'
  });

  harness.env.sendBatchToBackground([
    {
      type: 'tiktok',
      event: 'chat',
      tid: 900001,
      chatname: 'Old User',
      chatmessage: 'stale batch'
    },
    {
      type: 'tiktok',
      event: 'chat',
      tid: 900002,
      chatname: 'New User',
      chatmessage: 'active batch'
    }
  ]);

  assert.strictEqual(harness.emitted.length, 1, 'stale virtual tab messages should be dropped');
  assert.strictEqual(harness.emitted[0].tid, 900002, 'batch should retain the active manager message');
  assert.strictEqual(harness.emitted[0].chatmessage, 'active batch');
}

function runStaleQueueFlushAssertion() {
  const harness = createHarness();
  const first = harness.makeManager(1);
  registerManager(harness, first);

  const second = harness.makeManager(2);
  harness.env.registerActiveTikTokSourceConnection(second, 'test_replacement');
  harness.websocketConnections[2] = second;

  first.messageProcessor.pendingBatch = [{
    type: 'tiktok',
    event: 'chat',
    tid: 900001,
    chatname: 'Old User',
    chatmessage: 'queued stale'
  }];
  first.messageProcessor.flushPendingBatch();

  assert.strictEqual(harness.emitted.length, 0, 'stale queued chat should not flush after replacement');
  assert.deepStrictEqual(first.messageProcessor.pendingBatch, [], 'stale pending batch should be cleared');
}

function run() {
  runReplacementSuppressesOldEventsAssertion();
  runFinalForwarderDropsStaleVirtualTabsAssertion();
  runStaleQueueFlushAssertion();
  console.log('single-active-connection-regression: all checks passed');
}

try {
  run();
  process.exit(0);
} catch (error) {
  console.error('single-active-connection-regression: failed');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
