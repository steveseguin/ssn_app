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
  const postedMessages = [];
  const websocketConnections = {};
  const mainWindow = {
    webContents: {
      mainFrame: {
        frames: [{
          url: 'file:///background.html',
          postMessage: (channel, payload) => postedMessages.push({ channel, payload })
        }]
      }
    }
  };

  const env = createTikTokEnvironment({
    connector: buildConnectorStub(),
    shouldEnableTikTokLogging: false,
    resolveLogDirectory: () => null,
    getMainWindow: () => mainWindow,
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

  return { emitted, manager, postedMessages };
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
  const { emitted, manager, postedMessages } = createHarness({ captureLikedEvent: false });

  manager.sendEventMessage(
    { uniqueId: 'dave', nickname: 'Dave' },
    'liked',
    'Dave liked the stream!'
  );

  assert.strictEqual(emitted.length, 0, 'liked events should be gated from the main stream when capturelikeevent is disabled');
  assert.strictEqual(postedMessages.length, 1, 'liked events should still be forwarded to the reactions target');
  assert.strictEqual(postedMessages[0].channel, 'fromMain', 'liked event should use the background frame bridge');
  assert.strictEqual(postedMessages[0].payload.target, 'reactions', 'liked event should be routed to reactions only');
  assert.strictEqual(postedMessages[0].payload.message.event, 'liked', 'reactions payload should preserve liked event type');
  assert.strictEqual(postedMessages[0].payload.message.chatname, 'Dave', 'reactions payload should preserve viewer name');
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

function runEulerShareReplayDedupeAssertions() {
  const { emitted, manager } = createHarness({ captureLikedEvent: true });

  manager.sendEventMessage(
    {
      common: { msgId: 'share-copy-1', createTime: '1778445659' },
      user: { uniqueId: 'ayub1.33', nickname: '￶' },
      displayType: 'share_message'
    },
    'shared',
    '￶ shared the live stream!'
  );
  manager.sendEventMessage(
    {
      common: { msgId: 'share-copy-2', createTime: '1778445660' },
      user: { uniqueId: 'ayub1.33', nickname: '￶' },
      displayType: 'share_message'
    },
    'shared',
    '￶ shared the live stream!'
  );

  const sharedCount = emitted.filter((event) => event.event === 'shared').length;
  assert.strictEqual(
    sharedCount,
    1,
    'Euler shared-event replays from the same user should be suppressed even when msgId/createTime changes'
  );
}

function run() {
  runCanonicalizationAssertions();
  runLikeGateAssertions();
  runFollowShareDedupeAssertions();
  runLikePassthroughAssertions();
  runSparseSharePayloadAssertions();
  runEulerShareReplayDedupeAssertions();
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
