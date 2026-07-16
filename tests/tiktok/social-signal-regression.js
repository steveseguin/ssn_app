'use strict';

const assert = require('assert');
const { WebcastEvent } = require('tiktok-live-connector');
const { __test } = require('../../tiktok/connection-manager.js');

function createEventCapture(connection) {
  const trackedEvents = [WebcastEvent.FOLLOW, WebcastEvent.SHARE, WebcastEvent.SOCIAL, WebcastEvent.LIKE, 'subscribe'];
  const counts = Object.create(null);
  trackedEvents.forEach((eventName) => {
    counts[eventName] = 0;
    connection.on(eventName, () => {
      counts[eventName] += 1;
    });
  });
  return { trackedEvents, counts };
}

function runRoutingCase(data, expectedEvent, forbiddenEvents = [], messageType = 'WebcastSocialMessage') {
  const connection = new __test.EulerWebsocketServerConnection('unit-test');
  const { trackedEvents, counts } = createEventCapture(connection);

  connection.forwardDecodedData({
    type: messageType,
    data
  });

  trackedEvents.forEach((eventName) => {
    const expectedCount = eventName === expectedEvent ? 1 : 0;
    assert.strictEqual(
      counts[eventName],
      expectedCount,
      `expected ${expectedEvent} routing, received ${eventName}=${counts[eventName]}`
    );
  });

  forbiddenEvents.forEach((eventName) => {
    assert.strictEqual(counts[eventName], 0, `expected ${eventName} to remain un-emitted`);
  });
}

function run() {
  // Subscribe signal helper: positive and boundary-negative coverage.
  assert.strictEqual(__test.isLikelySubscribeSignal('subscribe now'), true);
  assert.strictEqual(__test.isLikelySubscribeSignal('New MEMBERSHIP tier unlocked'), true);
  assert.strictEqual(__test.isLikelySubscribeSignal('sub'), true);
  assert.strictEqual(__test.isLikelySubscribeSignal('subtle reaction'), false);
  assert.strictEqual(__test.isLikelySubscribeSignal(''), false);
  assert.strictEqual(__test.isLikelySubscribeSignal(null), false);

  // Routing by displayType/defaultPattern.
  runRoutingCase(
    { common: { displayText: { displayType: 'unknown', defaultPattern: 'started following this host' } } },
    WebcastEvent.FOLLOW,
    ['subscribe']
  );

  runRoutingCase(
    { common: { displayText: { displayType: '', defaultPattern: 'shared the LIVE with friends' } } },
    WebcastEvent.SHARE,
    ['subscribe']
  );

  runRoutingCase(
    { common: { displayText: { displayType: 'misc', defaultPattern: 'welcome to membership tier 1' } } },
    'subscribe',
    [WebcastEvent.SOCIAL]
  );

  runRoutingCase(
    { common: { displayText: { displayType: 'subtle wave', defaultPattern: 'subtle wave' } } },
    WebcastEvent.SOCIAL,
    ['subscribe']
  );

  runRoutingCase(
    { count: 1, user: { uniqueId: 'tester' } },
    WebcastEvent.LIKE,
    ['subscribe', WebcastEvent.FOLLOW, WebcastEvent.SHARE],
    'WebcastLikeMessage'
  );

  console.log('social-signal-regression: all checks passed');
}

try {
  run();
  process.exit(0);
} catch (error) {
  console.error('social-signal-regression: failed');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
