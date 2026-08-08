'use strict';

const assert = require('assert');
const { __test } = require('../../tiktok/connection-manager.js');

function countStickerTags(text) {
  if (typeof text !== 'string') return 0;
  const matches = text.match(/<img class="sticker"/g);
  return Array.isArray(matches) ? matches.length : 0;
}

function run() {
  {
    const message = __test.composeTikTokChatMessage({ content: 'hello from v3' });
    assert.strictEqual(message.chatmessage, 'hello from v3', 'v3 content should populate chat text');
  }

  {
    const legacyMessage = __test.composeTikTokChatMessage({ comment: 'legacy text', content: 'v3 text' });
    const v3FallbackMessage = __test.composeTikTokChatMessage({ comment: '', content: 'v3 text' });
    assert.strictEqual(legacyMessage.chatmessage, 'legacy text', 'a populated legacy comment should keep precedence');
    assert.strictEqual(v3FallbackMessage.chatmessage, 'v3 text', 'empty legacy text should fall back to v3 content');
  }

  const normalized = __test.normalizeTikTokEmoteEntries({
    emotes: [
      {
        placeInComment: '2',
        emote: {
          emoteId: 'nested_1',
          name: 'smiley face',
          image: { imageUrl: '//cdn.example.com/smile.webp' }
        }
      }
    ]
  });
  assert.strictEqual(normalized.length, 1, 'expected one normalized nested emote');
  assert.strictEqual(normalized[0].emoteId, 'nested_1');
  assert.strictEqual(normalized[0].placeInComment, 2);
  assert.strictEqual(normalized[0].emoteUrl, 'https://cdn.example.com/smile.webp');

  {
    const message = __test.composeTikTokChatMessage({
      comment: '[smiley face] hello',
      emotes: [
        {
          placeInComment: 0,
          emote: {
            emoteId: 'wave_1',
            name: 'smiley face',
            image: { imageUrl: 'https://cdn.example.com/wave.webp' }
          }
        }
      ]
    });
    assert.ok(message.chatmessage.includes('<img class="sticker"'), 'expected sticker tag for nested payload');
    assert.ok(!message.chatmessage.toLowerCase().includes('[smiley face]'), 'placeholder should be replaced');
  }

  {
    const message = __test.composeTikTokChatMessage({
      comment: 'Hello [smiley face]',
      emotes: [
        {
          emoteId: 'fallback_1',
          emoteName: 'smiley face',
          emoteImageUrl: 'https://cdn.example.com/smile2.webp'
        }
      ]
    });
    assert.ok(message.chatmessage.includes('<img class="sticker"'), 'fallback replacement should still render image');
    assert.ok(!message.chatmessage.includes('[smiley face]'), 'fallback should remove bracket placeholder');
  }

  {
    const message = __test.composeTikTokChatMessage({
      comment: '[smiley face] [heart]',
      emotes: [
        {
          placeInComment: 0,
          emote: {
            emoteId: 'multi_1',
            name: 'smiley face',
            image: { imageUrl: 'https://cdn.example.com/smile3.webp' }
          }
        },
        {
          placeInComment: 14,
          emote: {
            emoteId: 'multi_2',
            name: 'heart',
            image: { imageUrl: 'https://cdn.example.com/heart.webp' }
          }
        }
      ]
    });
    assert.strictEqual(countStickerTags(message.chatmessage), 2, 'expected both emotes to render');
    assert.ok(!/\[[^\]]+\]/.test(message.chatmessage), 'no bracket placeholders should survive');
  }

  {
    const message = __test.composeTikTokChatMessage({
      comment: '[smiley face]',
      textonly: true,
      emotes: [
        {
          emoteId: 'text_1',
          emoteName: 'smiley face',
          emoteImageUrl: 'https://cdn.example.com/text.webp'
        }
      ]
    });
    assert.ok(!message.chatmessage.includes('<img class="sticker"'), 'text-only mode should avoid sticker tags');
    assert.ok(message.chatmessage.toLowerCase().includes('smiley face'), 'text-only mode should preserve readable label');
    assert.ok(!message.chatmessage.includes('[smiley face]'), 'text-only mode should not leak bracket placeholder');
  }

  {
    const message = __test.composeTikTokChatMessage({
      comment: 'before [smiley face] after',
      textonly: true,
      emotes: [
        {
          emoteImageUrl: 'https://cdn.example.com/no-label.webp'
        }
      ]
    });
    assert.strictEqual(message.chatmessage, 'before after', 'nameless text-only emotes should not inject fallback marker');
    assert.ok(!message.chatmessage.includes('[sticker]'), 'text-only mode should not emit [sticker] fallback');
  }

  console.log('chat-emote-regression: all checks passed');
}

try {
  run();
  process.exit(0);
} catch (error) {
  console.error('chat-emote-regression: failed');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
