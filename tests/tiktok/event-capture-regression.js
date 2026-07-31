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

function createHarness({
  captureLikeTotals = false,
  legacyYouTubeLikeTotals = false,
  likeTotalMinIntervalMs = 5000,
  likeTotalHeartbeatMs = 90000
} = {}) {
  const emitted = [];
  const postedMessages = [];
  const websocketConnections = {};
  const cachedSettings = {};
  if (captureLikeTotals) cachedSettings.captureliketotals = { setting: true };
  if (legacyYouTubeLikeTotals) cachedSettings.captureyoutubelikes = { setting: true };
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
    getCachedSettings: () => cachedSettings,
    isCaptureEventsEnabled: () => true,
    isCaptureJoinedEventEnabled: () => true,
    isViewerUpdateAllowed: () => false,
    isTextOnlyModeEnabled: () => false,
    connectionStates: new Map()
  });

  const manager = new env.ConnectionManager('unit_test', 1, null, null, {
    likeTotalMinIntervalMs,
    likeTotalHeartbeatMs
  });
  manager.virtualTabId = 900001;
  websocketConnections[1] = manager;

  return { emitted, manager, postedMessages };
}

function runCanonicalizationAssertions() {
  const { emitted, manager } = createHarness();

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

function runBackgroundLikeRoutingAssertions() {
  const { emitted, manager, postedMessages } = createHarness();

  manager.sendEventMessage(
    { uniqueId: 'dave', nickname: 'Dave' },
    'liked',
    'Dave liked the stream!'
  );

  assert.strictEqual(emitted.length, 1, 'SSApp should emit liked events without applying the background-owned main-feed toggle');
  assert.strictEqual(postedMessages.length, 1, 'liked events should be forwarded through the background bridge');
  assert.strictEqual(postedMessages[0].channel, 'fromMain', 'liked event should use the background frame bridge');
  assert.ok(!Object.prototype.hasOwnProperty.call(postedMessages[0].payload, 'target'), 'SSApp must let background.js route individual likes');
  assert.strictEqual(postedMessages[0].payload.message.event, 'liked', 'background payload should preserve liked event type');
  assert.strictEqual(postedMessages[0].payload.message.chatname, 'Dave', 'background payload should preserve viewer name');
}

function runFollowShareDedupeAssertions() {
  const { emitted, manager } = createHarness();

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
  const { emitted, manager } = createHarness();

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

function runLikeTotalAssertions() {
  const { emitted, manager } = createHarness({ captureLikeTotals: true });

  assert.strictEqual(manager.queueLikeTotalUpdate(100), true, 'first total should send immediately');
  assert.deepStrictEqual(
    emitted[0],
    { type: 'tiktok', event: 'likes_update', meta: 100, tid: 900001 },
    'TikTok total should use the shared likes_update contract'
  );

  assert.strictEqual(manager.queueLikeTotalUpdate(105), false, 'burst updates should be coalesced');
  assert.strictEqual(manager.queueLikeTotalUpdate(110), false, 'the latest burst total should replace the pending total');
  assert.strictEqual(emitted.length, 1, 'coalesced totals should not send early');
  assert.strictEqual(manager.pendingLikeTotal, 110, 'the newest total should be retained');
  assert.strictEqual(manager.flushPendingLikeTotalUpdate(), true, 'the trailing total should send');
  assert.strictEqual(emitted.length, 2);
  assert.strictEqual(emitted[1].meta, 110, 'the trailing update should contain the newest total');

  assert.strictEqual(manager.queueLikeTotalUpdate(110), false, 'unchanged totals should be suppressed');
  assert.strictEqual(emitted.length, 2);

  manager.lastLikeTotalSentAt = Date.now() - manager.likeTotalHeartbeatMs;
  assert.strictEqual(manager.maybeHeartbeatLikeTotalUpdate(), true, 'unchanged totals should heartbeat');
  assert.strictEqual(emitted.length, 3);
  assert.strictEqual(emitted[2].meta, 110);

  manager.resetLikeTotalUpdateState();
}

function runLegacyLikeTotalGuardAssertions() {
  const { emitted, manager } = createHarness({ legacyYouTubeLikeTotals: true });
  assert.strictEqual(
    manager.queueLikeTotalUpdate(42),
    true,
    'legacy captureyoutubelikes should enable the global total-like output'
  );
  assert.strictEqual(emitted[0].event, 'likes_update');
  assert.strictEqual(emitted[0].meta, 42);
  manager.resetLikeTotalUpdateState();

  const disabled = createHarness();
  assert.strictEqual(disabled.manager.queueLikeTotalUpdate(42), false, 'totals must remain opt-in');
  assert.strictEqual(disabled.emitted.length, 0);
}

function runSparseSharePayloadAssertions() {
  const { emitted, manager } = createHarness();

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
  const { emitted, manager } = createHarness();

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
  runBackgroundLikeRoutingAssertions();
  runFollowShareDedupeAssertions();
  runLikePassthroughAssertions();
  runLikeTotalAssertions();
  runLegacyLikeTotalGuardAssertions();
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
