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

  // contentimg should be reserved for explicit sticker/media payloads, not generic gift icons.
  assert.strictEqual(
    __test.resolveTikTokGiftContentImage({
      giftDetails: { giftImage: { urlList: ['https://cdn.example.com/gift-icon.webp'] } }
    }),
    null,
    'generic gift icon should not be treated as content image'
  );
  assert.strictEqual(
    __test.resolveTikTokGiftContentImage({
      mTrayInfo: {
        mDynamicImg: {
          uri: 'webcast://dynamic_internal_only',
          urlList: ['https://cdn.example.com/sticker-dynamic.webp']
        }
      }
    }),
    'https://cdn.example.com/sticker-dynamic.webp',
    'explicit tray dynamic image should map to content image even with internal uri present'
  );
  assert.strictEqual(
    __test.resolveTikTokGiftContentImage({
      asset: {
        stickerAssetVariant: 1,
        videoResourceList: [{ videoUrl: { urlList: ['https://cdn.example.com/sticker-asset.mp4'] } }],
        resourceModel: { urlList: ['https://cdn.example.com/sticker-asset.webp'] }
      }
    }),
    'https://cdn.example.com/sticker-asset.webp',
    'sticker-variant asset should prefer still image url over video url for content image'
  );
  assert.strictEqual(
    __test.resolveTikTokGiftContentImage({
      asset: {
        stickerAssetVariant: 1,
        videoResourceList: [{ videoUrl: { uri: 'webcast://video_internal_only' } }],
        resourceModel: { urlList: ['https://cdn.example.com/sticker-asset.webp'] }
      }
    }),
    'https://cdn.example.com/sticker-asset.webp',
    'sticker-variant asset should keep scanning past internal uri to find public media url'
  );
  assert.strictEqual(
    __test.resolveTikTokGiftContentImage({
      textonly: true,
      asset: {
        stickerAssetVariant: 1,
        resourceModel: { urlList: ['https://cdn.example.com/sticker-asset.webp'] }
      }
    }),
    'https://cdn.example.com/sticker-asset.webp',
    'helper remains transport-focused; text-only suppression is handled in sendGiftMessage'
  );

  // Gift identity fallback when giftId is missing.
  assert.deepStrictEqual(
    __test.resolveGiftStreakIdentity({ giftName: 'Galaxy', giftType: 1 }),
    { giftId: null, keyFragment: 'name:galaxy' }
  );
  assert.deepStrictEqual(
    __test.resolveGiftStreakIdentity({ giftId: '5656', giftName: 'Rose', giftType: 1 }),
    { giftId: '5656', keyFragment: 'id:5656' }
  );
  assert.strictEqual(
    __test.resolveGiftId({ id: '12345', id_str: '98765', giftName: 'Rose' }),
    null,
    'top-level id/id_str should not be treated as gift id'
  );
  assert.strictEqual(
    __test.resolveGiftId({ id: '12345', gift: { gift_id: '42' } }),
    '42',
    'nested gift id should still resolve'
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

  // Processing should continue even if one queued gift throws while forwarding.
  {
    const gp = createGiftProcessorHarness();
    const originalSetTimeout = global.setTimeout;
    let sendAttempts = 0;
    global.setTimeout = (fn) => {
      fn();
      return 0;
    };
    try {
      gp.sendGiftMessage = () => {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          throw new Error('synthetic send failure');
        }
      };
      gp.queue.push({ data: buildGiftEvent({ gift_id: '111' }), count: 1 });
      gp.queue.push({ data: buildGiftEvent({ gift_id: '222' }), count: 1 });
      gp.processQueue();
      assert.strictEqual(sendAttempts, 2, 'expected queue to continue after first send failure');
      assert.strictEqual(gp.queue.length, 0, 'expected queue to drain');
      assert.strictEqual(gp.isProcessing, false, 'expected processor to stop once queue is empty');
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  }

  console.log('gift-count-regression: all checks passed');
}

try {
  run();
  process.exit(0);
} catch (error) {
  console.error('gift-count-regression: failed');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
