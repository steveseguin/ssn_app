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

  // resolveTikTokGiftContentImage is sticker/media only — generic icons are excluded.
  assert.strictEqual(
    __test.resolveTikTokGiftContentImage({
      giftDetails: { giftImage: { urlList: ['https://cdn.example.com/gift-icon.webp'] } }
    }),
    null,
    'generic gift icon should not be treated as sticker content image'
  );

  // Normal gift icons are rendered inline in chatmessage, not as content images.
  assert.strictEqual(
    __test.resolveTikTokGiftInlineImage(
      {},
      { iconUrl: 'https://cdn.example.com/gift-icon.webp' },
      {},
      {}
    ),
    'https://cdn.example.com/gift-icon.webp',
    'inline image should resolve a generic gift icon'
  );
  assert.strictEqual(
    __test.resolveTikTokGiftInlineImage(
      { mTrayInfo: { mDynamicImg: { urlList: ['https://cdn.example.com/sticker.webp'] } } },
      { iconUrl: 'https://cdn.example.com/gift-icon.webp' },
      {},
      {}
    ),
    'https://cdn.example.com/gift-icon.webp',
    'inline image resolver should ignore rich sticker media'
  );
  assert.strictEqual(
    __test.resolveTikTokGiftInlineImage({}, {}, {}, {}),
    null,
    'inline image should return null when no gift icon is available'
  );
  // Object-shaped icon with internal uri must resolve to the public urlList entry,
  // not the non-renderable webcast:// uri.
  assert.strictEqual(
    __test.resolveTikTokGiftInlineImage(
      {},
      { giftPictureUrl: { uri: 'webcast://internal_only', urlList: ['https://cdn.example.com/gift-icon.webp'] } },
      {},
      {}
    ),
    'https://cdn.example.com/gift-icon.webp',
    'inline image should skip internal uri and use public urlList entry'
  );
  assert.strictEqual(
    __test.resolveTikTokGiftInlineImage(
      {},
      {},
      { giftImage: { uri: 'webcast://internal_only', urlList: ['https://cdn.example.com/gift-icon.webp'] } },
      {}
    ),
    'https://cdn.example.com/gift-icon.webp',
    'inline giftImage should still resolve its public URL'
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
    gp.stop('test_cleanup');
  }

  // A combo remains streakable when giftType is absent but TikTok supplies its
  // explicit combo marker and group ID.
  {
    const gp = createGiftProcessorHarness();
    gp.addToQueue(buildGiftEvent({
      giftType: 0,
      giftDetails: { combo: true },
      groupId: 'combo-1',
      repeat_count: 1,
      gift_id: '111'
    }));
    gp.addToQueue(buildGiftEvent({
      giftType: 0,
      giftDetails: { combo: true },
      groupId: 'combo-1',
      repeat_count: 3,
      gift_id: '111'
    }));
    gp.addToQueue(buildGiftEvent({
      giftType: 0,
      giftDetails: { combo: true },
      groupId: 'combo-1',
      repeat_count: 3,
      gift_id: '111',
      repeatEnd: true
    }));
    assert.strictEqual(gp.queue.length, 1, 'explicit combo should merge without leaking a separate x1');
    assert.strictEqual(gp.queue[0].count, 3, 'expected merged combo count to be 3');
    gp.stop('test_cleanup');
  }

  // A genuine single gift must not be delayed just because it lacks combo flags.
  {
    const gp = createGiftProcessorHarness();
    gp.addToQueue(buildGiftEvent({ giftType: 0, repeat_count: 1, gift_id: '222' }));
    assert.strictEqual(gp.queue.length, 1, 'single gift should be emitted immediately');
    assert.strictEqual(gp.queue[0].count, 1, 'single gift should keep count of 1');
    assert.strictEqual(gp.streaks.size, 0, 'single gift should not create a pending streak');
    gp.stop('test_cleanup');
  }

  // An active combo must refresh its safety timer. Otherwise a long streak is
  // emitted every 30 seconds and TTS reads the same donation several times.
  {
    const gp = createGiftProcessorHarness();
    gp.addToQueue(buildGiftEvent({ gift_id: 'timer-gift', repeat_count: 1, groupId: 'timer-group' }));
    const key = gp.streaks.keys().next().value;
    const firstTimer = gp.streaks.get(key).timer;
    gp.addToQueue(buildGiftEvent({ gift_id: 'timer-gift', repeat_count: 2, groupId: 'timer-group' }));
    const refreshedTimer = gp.streaks.get(key).timer;
    assert.notStrictEqual(refreshedTimer, firstTimer, 'active streak should refresh its inactivity timer');
    assert.strictEqual(gp.queue.length, 0, 'active streak should remain pending');
    gp.stop('test_cleanup');
  }

  // A duplicate repeatEnd for an already-flushed streak must not re-announce.
  {
    const gp = createGiftProcessorHarness();
    gp.addToQueue(buildGiftEvent({ gift_id: '333', repeat_count: 2, groupId: 'g1' }));
    gp.addToQueue(buildGiftEvent({ gift_id: '333', repeat_count: 2, repeatEnd: true, groupId: 'g1' }));
    assert.strictEqual(gp.queue.length, 1, 'expected one flushed gift for the streak');
    gp.addToQueue(buildGiftEvent({ gift_id: '333', repeat_count: 2, repeatEnd: true, groupId: 'g1' }));
    assert.strictEqual(gp.queue.length, 1, 'duplicate repeatEnd for flushed streak should be dropped');
    gp.stop('test_cleanup');
  }

  // A late repeatEnd arriving after the safety-timer flush must not re-announce,
  // but a new streak (different groupId) must still emit in full.
  {
    const gp = createGiftProcessorHarness();
    gp.addToQueue(buildGiftEvent({ gift_id: '444', repeat_count: 5, groupId: 'g2' }));
    const key = gp.streaks.keys().next().value;
    gp.flushStreak(key);
    assert.strictEqual(gp.queue.length, 1, 'safety flush should emit once');
    assert.strictEqual(gp.queue[0].count, 5, 'safety flush should keep the combo count');
    gp.addToQueue(buildGiftEvent({ gift_id: '444', repeat_count: 5, repeatEnd: true, groupId: 'g2' }));
    assert.strictEqual(gp.queue.length, 1, 'late repeatEnd after safety flush should not re-announce');
    gp.addToQueue(buildGiftEvent({ gift_id: '444', repeat_count: 3, repeatEnd: true, groupId: 'g3' }));
    assert.strictEqual(gp.queue.length, 2, 'new streak with different groupId should still emit');
    assert.strictEqual(gp.queue[1].count, 3, 'new streak should emit its full count');
    gp.stop('test_cleanup');
  }

  // A new streak from the same user with the same gift must not be suppressed
  // when TikTok assigns a different groupId.
  {
    const gp = createGiftProcessorHarness();
    gp.addToQueue(buildGiftEvent({ gift_id: '555', repeat_count: 2, repeatEnd: true, groupId: 'g4' }));
    gp.addToQueue(buildGiftEvent({ gift_id: '555', repeat_count: 2, repeatEnd: true, groupId: 'g5' }));
    assert.strictEqual(gp.queue.length, 2, 'different group IDs should produce separate gifts');
    assert.strictEqual(gp.queue[0].count, 2);
    assert.strictEqual(gp.queue[1].count, 2);
    gp.stop('test_cleanup');
  }

  // Sparse legacy payloads without group IDs cannot safely share flush memory;
  // two same-user gifts are distinct and must both pass.
  {
    const gp = createGiftProcessorHarness();
    gp.addToQueue(buildGiftEvent({ gift_id: '666', repeat_count: 1, repeatEnd: true, groupId: undefined }));
    gp.addToQueue(buildGiftEvent({ gift_id: '666', repeat_count: 1, repeatEnd: true, groupId: undefined }));
    assert.strictEqual(gp.queue.length, 2, 'group-less gifts should not be collapsed');
    gp.stop('test_cleanup');
  }

  // Some adapters serialize numeric repeatEnd values as strings. "0" must
  // remain in-progress and "1" must flush the final total.
  {
    const gp = createGiftProcessorHarness();
    gp.addToQueue(buildGiftEvent({ gift_id: '777', repeat_count: 1, repeatEnd: '0', groupId: 'g6' }));
    assert.strictEqual(gp.queue.length, 0, 'string repeatEnd=0 should not flush');
    gp.addToQueue(buildGiftEvent({ gift_id: '777', repeat_count: 4, repeatEnd: '1', groupId: 'g6' }));
    assert.strictEqual(gp.queue.length, 1, 'string repeatEnd=1 should flush once');
    assert.strictEqual(gp.queue[0].count, 4);
    gp.stop('test_cleanup');
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
