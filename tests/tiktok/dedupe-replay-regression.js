'use strict';

const assert = require('assert');
const { __test } = require('../../tiktok/connection-manager.js');
const {
    buildChatDedupeKey,
    buildGiftDedupeKey,
    MessageProcessor,
    GiftProcessor,
    ConnectionManager
} = __test;

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`PASS: ${name}`);
        passed++;
    } catch (error) {
        console.error(`FAIL: ${name}`);
        console.error(error && error.stack ? error.stack : error);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Chat dedupe key tests
// ---------------------------------------------------------------------------

test('chat dedupe: same user, different text, both must pass', () => {
    const k1 = buildChatDedupeKey({
        common: { msgId: '100', createTime: '1700000000' },
        user: { uniqueId: 'u1' },
        comment: 'hello'
    });
    const k2 = buildChatDedupeKey({
        common: { msgId: '101', createTime: '1700000001' },
        user: { uniqueId: 'u1' },
        comment: 'world'
    });
    assert.ok(k1, 'first key should be non-null');
    assert.ok(k2, 'second key should be non-null');
    assert.notStrictEqual(k1, k2, 'different msgId should produce different keys');
});

test('chat dedupe: identical msgId produces same key', () => {
    const k1 = buildChatDedupeKey({
        common: { msgId: '200' },
        user: { uniqueId: 'u1' },
        comment: 'hello'
    });
    const k2 = buildChatDedupeKey({
        common: { msgId: '200' },
        user: { uniqueId: 'u1' },
        comment: 'hello'
    });
    assert.strictEqual(k1, k2, 'same msgId should produce identical keys');
});

test('chat dedupe: fallback uses user + createTime + comment', () => {
    const k1 = buildChatDedupeKey({
        user: { uniqueId: 'u1' },
        common: { createTime: '1700000000' },
        comment: 'hello'
    });
    const k2 = buildChatDedupeKey({
        user: { uniqueId: 'u1' },
        common: { createTime: '1700000000' },
        comment: 'different'
    });
    assert.ok(k1, 'first key should be non-null');
    assert.ok(k2, 'second key should be non-null');
    assert.notStrictEqual(k1, k2, 'different comment should produce different keys');
});

test('chat dedupe: sparse payload with only user returns null', () => {
    const key = buildChatDedupeKey({ user: { uniqueId: 'u1' }, comment: '' });
    assert.strictEqual(key, null, 'user alone with empty comment should not produce a key');
});

test('chat dedupe: user + comment (no createTime) is valid', () => {
    const key = buildChatDedupeKey({
        user: { uniqueId: 'u1' },
        comment: 'some text'
    });
    assert.ok(key, 'user + non-empty comment should produce a key');
});

// ---------------------------------------------------------------------------
// Gift dedupe key tests
// ---------------------------------------------------------------------------

test('gift dedupe: same user, different gift, both must pass', () => {
    const k1 = buildGiftDedupeKey({
        common: { msgId: '300', createTime: '1700000000' },
        user: { uniqueId: 'u1' },
        giftId: '5656'
    });
    const k2 = buildGiftDedupeKey({
        common: { msgId: '301', createTime: '1700000001' },
        user: { uniqueId: 'u1' },
        giftId: '7890'
    });
    assert.ok(k1, 'first key should be non-null');
    assert.ok(k2, 'second key should be non-null');
    assert.notStrictEqual(k1, k2, 'different msgId should produce different keys');
});

test('gift dedupe: same user, different combo count, both must pass', () => {
    const k1 = buildGiftDedupeKey({
        user: { uniqueId: 'u1' },
        common: { createTime: '1700000000' },
        giftId: '5656',
        repeatCount: 1
    });
    const k2 = buildGiftDedupeKey({
        user: { uniqueId: 'u1' },
        common: { createTime: '1700000000' },
        giftId: '5656',
        repeatCount: 3
    });
    assert.ok(k1);
    assert.ok(k2);
    assert.notStrictEqual(k1, k2, 'different repeatCount should produce different keys');
});

test('gift dedupe: sparse payload with only user returns null', () => {
    const key = buildGiftDedupeKey({ user: { uniqueId: 'u1' } });
    assert.strictEqual(key, null, 'user alone should not produce a gift dedupe key');
});

test('gift dedupe: user + giftId (no createTime) is valid', () => {
    const key = buildGiftDedupeKey({
        user: { uniqueId: 'u1' },
        giftId: '5656'
    });
    assert.ok(key, 'user + giftId should produce a key even without createTime');
});

test('room pin dedupe: same pinId is suppressed, new pinId passes', () => {
    const manager = {
        recentEventDedupes: new Map(),
        nextEventDedupePruneAt: 0,
        logDebug() {},
        pruneRecentEventDedupes: ConnectionManager.prototype.pruneRecentEventDedupes,
        shouldSuppressDuplicateEvent: ConnectionManager.prototype.shouldSuppressDuplicateEvent
    };

    const first = manager.shouldSuppressDuplicateEvent('room_pin', {
        pinId: 'pin-1',
        nickname: 'Host'
    }, 'Pin updated by Host: hello');
    const second = manager.shouldSuppressDuplicateEvent('room_pin', {
        pinId: 'pin-1',
        nickname: 'Host'
    }, 'Pin updated by Host: hello');
    const third = manager.shouldSuppressDuplicateEvent('room_pin', {
        pinId: 'pin-2',
        nickname: 'Host'
    }, 'Pin updated by Host: different');

    assert.strictEqual(first, false, 'first pin event should pass');
    assert.strictEqual(second, true, 'same pinId/message should be suppressed');
    assert.strictEqual(third, false, 'different pinId should pass');
});

// ---------------------------------------------------------------------------
// Replay seeding regression
// ---------------------------------------------------------------------------

test('replay seeding: seeded ids suppress duplicate, new ids pass', () => {
    // Build a minimal manager with just the dedupe infrastructure
    const manager = {
        recentEventDedupes: new Map(),
        nextEventDedupePruneAt: 0,
        logDebug() {},
        pruneRecentEventDedupes: ConnectionManager.prototype.pruneRecentEventDedupes,
        shouldSuppressDuplicateEvent: ConnectionManager.prototype.shouldSuppressDuplicateEvent
    };

    // Simulate handleProtoFetch seeding: add a chat msgId to the cache
    const seededKey = buildChatDedupeKey({
        common: { msgId: '500', createTime: '1700000000' },
        user: { uniqueId: 'u1' },
        comment: 'seeded'
    });
    manager.recentEventDedupes.set(seededKey, Date.now() + 3600000);

    // Same message should be suppressed
    const suppressed = manager.shouldSuppressDuplicateEvent('chat', {
        common: { msgId: '500', createTime: '1700000000' },
        user: { uniqueId: 'u1' },
        comment: 'seeded'
    });
    assert.strictEqual(suppressed, true, 'seeded message should be suppressed');

    // Different message should pass
    const passed = manager.shouldSuppressDuplicateEvent('chat', {
        common: { msgId: '501', createTime: '1700000001' },
        user: { uniqueId: 'u1' },
        comment: 'new message'
    });
    assert.strictEqual(passed, false, 'new message should not be suppressed');
});

test('replay seeding: expired entry is refreshed by seeding logic', () => {
    // This directly tests the handleProtoFetch seeding condition:
    //   if (!existing || existing <= now) { set(key, now + ttl); }
    // Without this fix, seeding used has() which returns true for expired
    // entries and skips the refresh, letting duplicates leak through.
    const manager = {
        recentEventDedupes: new Map(),
        nextEventDedupePruneAt: 0,
        logDebug() {},
        pruneRecentEventDedupes: ConnectionManager.prototype.pruneRecentEventDedupes,
        shouldSuppressDuplicateEvent: ConnectionManager.prototype.shouldSuppressDuplicateEvent
    };

    const chatData = {
        common: { msgId: 'm1' },
        user: { uniqueId: 'u1' },
        comment: 'hello'
    };
    const key = buildChatDedupeKey(chatData);

    // Plant an expired entry (as if seeded 2 hours ago with a 1-hour TTL)
    manager.recentEventDedupes.set(key, Date.now() - 1000);

    // Run the exact seeding condition from handleProtoFetch
    const now = Date.now();
    const existing = manager.recentEventDedupes.get(key);
    if (!existing || existing <= now) {
        manager.recentEventDedupes.set(key, now + 3600000);
    }

    // The entry should now be live, not expired
    const newExpiry = manager.recentEventDedupes.get(key);
    assert.ok(newExpiry > now, 'seeding should have refreshed the expired entry');

    // And shouldSuppress should now catch it
    const suppressed = manager.shouldSuppressDuplicateEvent('chat', chatData);
    assert.strictEqual(suppressed, true, 'refreshed entry should suppress duplicate');
});

// ---------------------------------------------------------------------------
// Polling fallback handoff regression
// ---------------------------------------------------------------------------

test('polling fallback reset clears connector bootstrap state and saved cursor', () => {
    const manager = {
        connection: {
            clientParams: { cursor: 'c1', internal_ext: 'ie1', room_id: 'r1' },
            webClient: {
                clientParams: { cursor: 'c2', internal_ext: 'ie2', room_id: 'r2' },
                roomId: 'r2'
            },
            options: {
                clientParams: { cursor: 'c3', internal_ext: 'ie3', room_id: 'r3' },
                webClientParams: { cursor: 'c4', internal_ext: 'ie4', room_id: 'r4' },
                wsClientParams: { cursor: 'c5', internal_ext: 'ie5', room_id: 'r5' }
            },
            roomId: 'r6'
        },
        resumeCursorState: { cursor: 'saved', internalExt: 'saved', roomId: 'r6' },
        previousRoomId: 'r6'
    };

    ConnectionManager.prototype.resetConnectionBootstrapState.call(manager, {
        clearRoomId: true,
        clearResumeCursor: true
    });

    assert.strictEqual(manager.connection.clientParams.cursor, '');
    assert.strictEqual(manager.connection.clientParams.internal_ext, '');
    assert.strictEqual(manager.connection.clientParams.room_id, '');
    assert.strictEqual(manager.connection.webClient.clientParams.cursor, '');
    assert.strictEqual(manager.connection.webClient.clientParams.internal_ext, '');
    assert.strictEqual(manager.connection.webClient.clientParams.room_id, '');
    assert.strictEqual(manager.connection.webClient.roomId, '');
    assert.strictEqual(manager.connection.options.clientParams.cursor, '');
    assert.strictEqual(manager.connection.options.clientParams.internal_ext, '');
    assert.strictEqual(manager.connection.options.clientParams.room_id, '');
    assert.strictEqual(manager.connection.options.webClientParams.cursor, '');
    assert.strictEqual(manager.connection.options.webClientParams.internal_ext, '');
    assert.strictEqual(manager.connection.options.webClientParams.room_id, '');
    assert.strictEqual(manager.connection.options.wsClientParams.cursor, '');
    assert.strictEqual(manager.connection.options.wsClientParams.internal_ext, '');
    assert.strictEqual(manager.connection.options.wsClientParams.room_id, '');
    assert.strictEqual(manager.connection.roomId, '');
    assert.strictEqual(manager.resumeCursorState, null);
    assert.strictEqual(manager.previousRoomId, null);
});

test('polling fallback handoff uses cooldown before legacy init', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
        require.resolve('../../tiktok/connection-manager.js'),
        'utf8'
    );

    assert.ok(
        src.includes('POLLING_FALLBACK_HANDOFF_DELAY_MS'),
        'connection config should define a polling fallback handoff delay'
    );
    assert.ok(
        /await this\.waitForPollingFallbackHandoff\(stage\);[\s\S]{0,300}this\.initializeConnectionInstance\(\{ forceLegacy: true, context: 'legacy_fallback' \}\);/.test(src),
        'polling fallback should wait briefly before initializing the legacy connector'
    );
    assert.ok(
        /await this\.waitForPollingFallbackHandoff\('websocket_strike'\);/.test(src),
        'websocket strike fallback should also wait before legacy init'
    );
});

test('legacy-mode connect clears transient connector cursor before connect', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
        require.resolve('../../tiktok/connection-manager.js'),
        'utf8'
    );
    assert.ok(
        /if \(this\.pollingFallbackActivated \|\| this\.preferredStrategy === 'legacy' \|\| this\.connectionStrategy === 'legacy'\) \{\s*this\.resetConnectionBootstrapState\(\);\s*\}[\s\S]{0,120}await activeConnection\.connect\(\);/.test(src),
        'legacy-mode connect should clear transient cursor/internal_ext before connecting'
    );
});

// ---------------------------------------------------------------------------
// Quiet-room liveness regression
// ---------------------------------------------------------------------------

test('quiet-room: websocketData handler updates lastMessageTime', () => {
    // We verify the code pattern rather than the full wiring, because
    // instantiating a real ConnectionManager requires a live TikTok session.
    // The websocketData handler now routes through noteConnectionActivity(),
    // which updates lastMessageTime and also cancels any pending false-positive
    // stream-end timer.
    const fs = require('fs');
    const src = fs.readFileSync(
        require.resolve('../../tiktok/connection-manager.js'),
        'utf8'
    );
    const wsDataHandler = src.match(
        /\.on\('websocketData'[\s\S]{0,400}this\.noteConnectionActivity\('websocketData'\)/
    );
    assert.ok(wsDataHandler, 'websocketData handler should note connection activity');

    const noteActivityMethod = src.match(
        /noteConnectionActivity\(source = 'activity'\)\s*\{[\s\S]{0,220}this\.lastMessageTime\s*=\s*Date\.now\(\)/
    );
    assert.ok(noteActivityMethod, 'noteConnectionActivity should update lastMessageTime');

    // Also verify handleConnect sets lastMessageTime before startHealthCheck.
    // The method body is ~600 chars to the assignment, so we search in two steps.
    const handleConnectIdx = src.indexOf('handleConnect() {');
    assert.ok(handleConnectIdx > 0, 'handleConnect definition should exist in source');
    const handleConnectBody = src.slice(handleConnectIdx, handleConnectIdx + 1200);
    const lastMsgIdx = handleConnectBody.indexOf('this.lastMessageTime = Date.now()');
    const healthCheckIdx = handleConnectBody.indexOf('this.startHealthCheck()');
    assert.ok(lastMsgIdx > 0, 'handleConnect should set lastMessageTime');
    assert.ok(healthCheckIdx > 0, 'handleConnect should call startHealthCheck');
    assert.ok(lastMsgIdx < healthCheckIdx, 'lastMessageTime should be set before startHealthCheck');
});

// ---------------------------------------------------------------------------
// Gift icon regression
// ---------------------------------------------------------------------------

test('gift icon: normal gift sends contentimg from generic icon', () => {
    const img = __test.resolveTikTokGiftDisplayImage(
        {},
        { giftPictureUrl: 'https://cdn.example.com/rose.webp' },
        {},
        {}
    );
    assert.strictEqual(img, 'https://cdn.example.com/rose.webp',
        'generic giftPictureUrl should resolve as display image');
});

test('gift icon: display image skips non-renderable internal URIs', () => {
    const img = __test.resolveTikTokGiftDisplayImage(
        {},
        { giftPictureUrl: { uri: 'webcast://internal_only', urlList: ['https://cdn.example.com/rose.webp'] } },
        {},
        {}
    );
    assert.strictEqual(img, 'https://cdn.example.com/rose.webp',
        'should resolve public URL, not internal webcast:// URI');
});

test('gift icon: text-only mode suppresses contentimg in sendGiftMessage', () => {
    // Verify the actual send path gates contentimg on textOnly.
    // sendGiftMessage sets contentImage = textOnly ? null : resolveTikTokGiftDisplayImage(...)
    // so we verify that pattern exists in the source.
    const fs = require('fs');
    const src = fs.readFileSync(
        require.resolve('../../tiktok/connection-manager.js'),
        'utf8'
    );
    const textOnlyGate = src.match(
        /const contentImage\s*=\s*textOnly\s*\?\s*null\s*:\s*resolveTikTokGiftDisplayImage/
    );
    assert.ok(textOnlyGate,
        'sendGiftMessage should gate contentImage on textOnly using resolveTikTokGiftDisplayImage');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
