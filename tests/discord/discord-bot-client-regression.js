#!/usr/bin/env node

'use strict';

const assert = require('assert');
const {
	DiscordRestClient,
	PERMISSION_SEND_MESSAGES,
	PERMISSION_VIEW_CHANNEL,
	__test,
} = require('../../resources/discord-bot-client');

function hasPermission(value, permission) {
	return (value & permission) === permission;
}

async function testChannelPermissions() {
	const guild = {
		id: '1',
		roles: [
			{ id: '1', permissions: '3072' },
			{ id: '2', permissions: '0' },
		],
	};
	const channel = {
		permission_overwrites: [
			{ id: '1', type: 0, allow: '0', deny: '2048' },
			{ id: '2', type: 0, allow: '2048', deny: '0' },
			{ id: '9', type: 1, allow: '0', deny: '1024' },
		],
	};
	const permissions = __test.computeChannelPermissions(guild, channel, { roles: ['2'], user: { id: '9' } });
	assert.strictEqual(hasPermission(permissions, PERMISSION_SEND_MESSAGES), true, 'role overwrite should restore Send Messages');
	assert.strictEqual(hasPermission(permissions, PERMISSION_VIEW_CHANNEL), false, 'member overwrite should deny View Channel last');
}

async function testMessageNormalization() {
	const payload = __test.normalizeDiscordMessage({
		id: '10',
		guild_id: '1',
		channel_id: '4',
		content: 'Hello <@9> <:wave:123>',
		author: { id: '9', username: 'tester', global_name: 'Native Tester', discriminator: '0', avatar: null, bot: false },
		member: { roles: ['2'] },
		mentions: [{ id: '9', username: 'tester', global_name: 'Native Tester' }],
		attachments: [{ url: 'https://cdn.example/image.png', filename: 'image.png', content_type: 'image/png' }],
		embeds: [],
	}, {
		guild: { id: '1', roles: [{ id: '2', color: 0x336699, position: 1 }] },
		channelLookup: new Map(),
	});

	assert.strictEqual(payload.type, 'discord');
	assert.strictEqual(payload.chatname, 'Native Tester');
	assert.ok(payload.chatmessage.includes('Hello @Native Tester'));
	assert.ok(payload.chatmessage.includes('cdn.discordapp.com/emojis/123.webp'));
	assert.strictEqual(payload.contentimg, 'https://cdn.example/image.png');
	assert.strictEqual(payload.nameColor, '#336699');
	assert.strictEqual(payload.meta.guildId, '1');
	assert.strictEqual(payload.meta.channelId, '4');
	assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, 'event'), false);
}

async function testMessageSplitting() {
	const parts = __test.splitDiscordMessage(`${'x'.repeat(1998)}😀${'y'.repeat(30)}`);
	assert.strictEqual(parts.length, 2);
	for (const part of parts) assert.ok(Array.from(part).length <= 2000);
	assert.strictEqual(parts.join(''), `${'x'.repeat(1998)}😀${'y'.repeat(30)}`);
}

async function testRestQueueOrdering() {
	const client = new DiscordRestClient('token', {
		fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
	});
	const order = [];
	const first = client.queueChannelRequest('4', async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
		order.push('first');
	});
	const second = client.queueChannelRequest('4', async () => {
		order.push('second');
	});
	await Promise.all([first, second]);
	assert.deepStrictEqual(order, ['first', 'second']);
	await new Promise((resolve) => setImmediate(resolve));
	assert.strictEqual(client.channelQueues.size, 0, 'completed per-channel queues should be released');
}

async function main() {
	await testChannelPermissions();
	await testMessageNormalization();
	await testMessageSplitting();
	await testRestQueueOrdering();
	assert.strictEqual(__test.gatewayCloseError(4014).code, 'SSAPP_DISCORD_MESSAGE_CONTENT_INTENT');
	console.log('Discord bot client regression tests passed.');
}

main().catch((error) => {
	console.error(error.stack || error);
	process.exitCode = 1;
});
