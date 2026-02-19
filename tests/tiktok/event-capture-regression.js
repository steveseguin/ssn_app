'use strict';

const assert = require('assert');
const {
  createTikTokEnvironment
} = require('../../tiktok/connection-manager.js');

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

function createHarness({ captureLikedEvent = false } = {}) {
  const emitted = [];
  const websocketConnections = {};

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
    isCaptureLikedEventEnabled: () => captureLikedEvent,
    isViewerUpdateAllowed: () => false,
    isTextOnlyModeEnabled: () => false,
    connectionStates: new Map()
  });

  const manager = new env.ConnectionManager('unit_test', 1, null, null, {});
  manager.virtualTabId = 900001;
  websocketConnections[1] = manager;

  return { emitted, manager };
}

function runCanonicalizationAssertions() {
  const { emitted, manager } = createHarness({ captureLikedEvent: true });

  manager.sendEventMessage(
    { uniqueId: 'alice', nickname: 'Alice' },
    'follow',
    'Alice followed!'
  );

  manager.sendEventMessage(
    { uniqueId: 'bob', nickname: 'Bob', displayType: 'share_message' },
    'share',
    'Bob shared the live stream!'
  );

  manager.sendEventMessage(
    { uniqueId: 'carol', nickname: 'Carol' },
    'like',
    'Carol liked the stream!'
  );

  assert.strictEqual(emitted.length, 3, 'expected three captured events');
  assert.strictEqual(emitted[0].event, 'followed', 'follow should normalize to followed');
  assert.strictEqual(emitted[1].event, 'shared', 'share should normalize to shared');
  assert.strictEqual(emitted[2].event, 'liked', 'like should normalize to liked');
}

function runLikeGateAssertions() {
  const { emitted, manager } = createHarness({ captureLikedEvent: false });

  manager.sendEventMessage(
    { uniqueId: 'dave', nickname: 'Dave' },
    'liked',
    'Dave liked the stream!'
  );

  assert.strictEqual(emitted.length, 0, 'liked events should be gated when capturelikeevent is disabled');
}

function runFollowShareDedupeAssertions() {
  const { emitted, manager } = createHarness({ captureLikedEvent: true });

  manager.sendEventMessage(
    { uniqueId: 'eve', nickname: 'Eve', displayType: 'follow_message' },
    'followed',
    'Eve followed!'
  );
  manager.sendEventMessage(
    { uniqueId: 'eve', nickname: 'Eve', displayType: 'follow_message' },
    'followed',
    'Eve followed!'
  );

  manager.sendEventMessage(
    { uniqueId: 'frank', nickname: 'Frank', displayType: 'share_message' },
    'share',
    'Frank shared the live stream!'
  );
  manager.sendEventMessage(
    { uniqueId: 'frank', nickname: 'Frank', displayType: 'share_message' },
    'shared',
    'Frank shared the live stream!'
  );

  const followedCount = emitted.filter((event) => event.event === 'followed').length;
  const sharedCount = emitted.filter((event) => event.event === 'shared').length;
  assert.strictEqual(followedCount, 1, 'duplicate followed events should be suppressed');
  assert.strictEqual(sharedCount, 1, 'duplicate shared events should be suppressed');
}

function runLikePassthroughAssertions() {
  const { emitted, manager } = createHarness({ captureLikedEvent: true });

  manager.sendEventMessage(
    { uniqueId: 'grace', nickname: 'Grace' },
    'liked',
    'Grace liked the stream!'
  );
  manager.sendEventMessage(
    { uniqueId: 'grace', nickname: 'Grace' },
    'liked',
    'Grace liked the stream!'
  );

  assert.strictEqual(emitted.length, 2, 'liked events should pass through without dedupe suppression');
}

function runSparseSharePayloadAssertions() {
  const { emitted, manager } = createHarness({ captureLikedEvent: true });

  const sparseSharePayload = {
    common: {
      displayText: {
        displayType: 'pm_mt_guidance_share',
        defaultPattern: 'shared the LIVE with friends'
      }
    }
  };

  manager.sendEventMessage(
    sparseSharePayload,
    'shared',
    'Viewer shared the live stream!'
  );
  manager.sendEventMessage(
    sparseSharePayload,
    'shared',
    'Viewer shared the live stream!'
  );

  assert.strictEqual(
    emitted.length,
    2,
    'sparse share payloads without stable identity/id should not be deduped'
  );
}

function run() {
  runCanonicalizationAssertions();
  runLikeGateAssertions();
  runFollowShareDedupeAssertions();
  runLikePassthroughAssertions();
  runSparseSharePayloadAssertions();
  console.log('event-capture-regression: all checks passed');
}

try {
  run();
  process.exit(0);
} catch (error) {
  console.error('event-capture-regression: failed');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
