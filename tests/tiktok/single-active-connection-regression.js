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
  const statuses = [];
  const websocketConnections = {};
  const browserViews = {};
  const connectionStates = new Map();

  const env = createTikTokEnvironment({
    connector: buildConnectorStub(),
    shouldEnableTikTokLogging: false,
    resolveLogDirectory: () => null,
    getMainWindow: () => null,
    websocketConnections,
    browserViews,
    log: () => { },
    onStatus: (status) => statuses.push(status),
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
    statuses,
    websocketConnections,
    browserViews,
    connectionStates,
    env,
    makeManager
  };
}

function registerManager(harness, manager) {
  harness.websocketConnections[manager.wssID] = manager;
  harness.browserViews[manager.virtualTabId] = {
    isTikTokVirtual: true,
    wssID: manager.wssID
  };
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

async function runDirectChatSendBlocksStaleManagerAssertion() {
  const harness = createHarness();
  const first = harness.makeManager(1);
  registerManager(harness, first);

  const second = harness.makeManager(2);
  harness.env.registerActiveTikTokSourceConnection(second, 'test_replacement');
  harness.websocketConnections[2] = second;

  first.isStopped = false;
  first.sessionId = 'sessionid';
  first.connection = { isConnected: true };
  harness.websocketConnections[1] = first;

  const result = await first.sendChatMessage('should not send');

  assert.strictEqual(result.success, false, 'stale manager direct chat send should be blocked');
  assert.strictEqual(result.error, 'Connection is no longer active');
}

function runCleanupAcceptsVirtualTabIdAssertion() {
  const harness = createHarness();
  const manager = harness.makeManager(1);
  let disconnected = false;
  let listenersRemoved = false;
  manager.connection = {
    disconnect: () => {
      disconnected = true;
    },
    removeAllListeners: () => {
      listenersRemoved = true;
    }
  };
  registerManager(harness, manager);

  harness.env.cleanupConnection(900001);

  assert.strictEqual(manager.isStopped, true, 'cleanup by virtual tab id should stop the manager');
  assert.strictEqual(disconnected, true, 'cleanup by virtual tab id should disconnect the real connection');
  assert.strictEqual(listenersRemoved, true, 'cleanup by virtual tab id should remove connection listeners');
  assert.strictEqual(harness.websocketConnections[1], undefined, 'real wss id should be removed');
  assert.strictEqual(harness.websocketConnections[900001], undefined, 'virtual tab id should not remain registered');
  assert.strictEqual(harness.connectionStates.has(1), false, 'real connection state should be removed');
  assert.strictEqual(harness.connectionStates.has(900001), false, 'virtual connection state should be removed');
  assert.strictEqual(harness.browserViews[900001], undefined, 'virtual browser view should be removed');
}

async function runStoppedConnectCompletionDoesNotActivateAssertion() {
  const harness = createHarness();
  const manager = harness.makeManager(1);
  registerManager(harness, manager);
  manager.connectAttemptMinIntervalMs = 0;
  manager.connectAttemptProviderIntervalMs = 0;

  let disconnected = false;
  manager.ensureConnectionInstance = () => {
    manager.connection = {
      isConnected: false,
      connect: async () => {
        manager.isStopped = true;
        return true;
      },
      disconnect: () => {
        disconnected = true;
      },
      removeAllListeners: () => { }
    };
  };

  const result = await manager.connect();

  assert.strictEqual(result, false, 'connect should not succeed after the manager is stopped mid-attempt');
  assert.strictEqual(disconnected, true, 'stopped connect completion should tear down the connector');
  assert.strictEqual(
    harness.statuses.some((status) => status && status.status === 'connected'),
    false,
    'stopped connect completion should not emit connected status'
  );
}

async function run() {
  runReplacementSuppressesOldEventsAssertion();
  runFinalForwarderDropsStaleVirtualTabsAssertion();
  runStaleQueueFlushAssertion();
  await runDirectChatSendBlocksStaleManagerAssertion();
  runCleanupAcceptsVirtualTabIdAssertion();
  await runStoppedConnectCompletionDoesNotActivateAssertion();
  console.log('single-active-connection-regression: all checks passed');
}

try {
  run()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('single-active-connection-regression: failed');
      console.error(error && error.stack ? error.stack : error);
      process.exit(1);
    });
} catch (error) {
  console.error('single-active-connection-regression: failed');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
