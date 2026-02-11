'use strict';

const assert = require('assert');
const { __test } = require('../../tiktok/connection-manager.js');

function buildGiftEvent(overrides = {}) {
  return {
    uniqueId: 'tester',
    nickname: 'Tester',
    giftType: 1,
    repeatCount: 1,
    giftName: 'Rose',
    repeatEnd: false,
    ...overrides
  };
}

function createGiftProcessorHarness() {
  const gp = new __test.GiftProcessor({
    virtualTabId: 900001,
    isReplayActive: () => false
  });
  // Keep tests fully synchronous.
  gp.startProcessing = () => {};
  return gp;
}

function run() {
  // Metric parsing coverage: camel + snake + nested
  assert.strictEqual(__test.resolveGiftMetricCount({ repeatCount: 7 }, 'repeat'), 7);
  assert.strictEqual(__test.resolveGiftMetricCount({ repeat_count: 8 }, 'repeat'), 8);
  assert.strictEqual(__test.resolveGiftMetricCount({ gift: { combo_count: 4 } }, 'combo'), 4);
  assert.strictEqual(__test.resolveGiftMetricCount({ giftDetails: { groupCount: 3 } }, 'group'), 3);
  assert.strictEqual(__test.resolveGiftMetricCount({ extendedGiftInfo: { repeat_count: 9 } }, 'repeat'), 9);
  assert.strictEqual(__test.resolveGiftAggregatedCount({ combo_count: 12 }), 12);

  // Gift identity fallback when giftId is missing.
  assert.deepStrictEqual(
    __test.resolveGiftStreakIdentity({ giftName: 'Galaxy', giftType: 1 }),
    { giftId: null, keyFragment: 'name:galaxy' }
  );
  assert.deepStrictEqual(
    __test.resolveGiftStreakIdentity({ giftId: '5656', giftName: 'Rose', giftType: 1 }),
    { giftId: '5656', keyFragment: 'id:5656' }
  );

  // Basic streak count flow with snake_case payloads.
  {
    const gp = createGiftProcessorHarness();
    gp.addToQueue(buildGiftEvent({ repeat_count: 1, gift_id: '111' }));
    gp.addToQueue(buildGiftEvent({ repeat_count: 3, gift_id: '111' }));
    gp.addToQueue(buildGiftEvent({ repeat_count: 3, gift_id: '111', repeatEnd: true }));
    assert.strictEqual(gp.queue.length, 1, 'expected exactly one flushed gift');
    assert.strictEqual(gp.queue[0].count, 3, 'expected final combo count to be 3');
  }

  // Ensure missing giftId streaks do not merge across gift names for same user.
  {
    const gp = createGiftProcessorHarness();
    gp.addToQueue(buildGiftEvent({ giftName: 'Rose', repeatCount: 1, giftId: undefined }));
    gp.addToQueue(buildGiftEvent({ giftName: 'Heart', repeatCount: 1, giftId: undefined }));
    gp.addToQueue(buildGiftEvent({ giftName: 'Rose', repeatCount: 2, repeatEnd: true, giftId: undefined }));
    gp.addToQueue(buildGiftEvent({ giftName: 'Heart', repeatCount: 3, repeatEnd: true, giftId: undefined }));
    assert.strictEqual(gp.queue.length, 2, 'expected two flushed gifts');
    const counts = gp.queue.map((entry) => entry.count).sort((a, b) => a - b);
    assert.deepStrictEqual(counts, [2, 3], 'expected independent streak totals per gift name');
  }

  console.log('gift-count-regression: all checks passed');
}

run();
