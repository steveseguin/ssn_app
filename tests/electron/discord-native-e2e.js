#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const electronPath = require('electron');
const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-discord-native-'));
const remoteToken = `discord-native-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const botToken = 'fixture.discord.bot.token';

const fixture = {
	botUser: { id: '100000000000000001', username: 'SSAppFixtureBot', global_name: 'SSApp Fixture Bot', bot: true, avatar: null },
	application: { id: '200000000000000002', name: 'SSApp Discord Fixture' },
	guild: {
		id: '300000000000000003',
		name: 'SSApp Test Server',
		roles: [{ id: '300000000000000003', name: '@everyone', permissions: '3072', position: 0, color: 0 }],
	},
	channel: {
		id: '400000000000000004',
		guild_id: '300000000000000003',
		name: 'native-chat',
		type: 0,
		position: 1,
		permission_overwrites: [],
	},
	member: {
		roles: [],
		user: { id: '100000000000000001' },
	},
};

let apiServer = null;
let gatewayServer = null;
let gatewaySockets = new Set();
let apiPort = 0;
let gatewayPort = 0;
let remotePort = 0;
let child = null;
let mainWindowId = null;
let output = '';
let outboundMessages = [];
let identifyPayloads = [];
let rejectNextSend = false;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

function sendJson(response, status, value) {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(body),
	});
	response.end(body);
}

async function readJsonBody(request) {
	let body = '';
	for await (const chunk of request) body += chunk;
	return body ? JSON.parse(body) : {};
}

async function startDiscordFixture() {
	apiServer = http.createServer(async (request, response) => {
		try {
			if (request.headers.authorization !== `Bot ${botToken}`) {
				sendJson(response, 401, { message: '401: Unauthorized', code: 0 });
				return;
			}
			const url = new URL(request.url || '/', 'http://127.0.0.1');
			const pathname = url.pathname.replace(/^\/api\/v10/, '');
			if (request.method === 'GET' && pathname === '/users/@me') return sendJson(response, 200, fixture.botUser);
			if (request.method === 'GET' && pathname === '/oauth2/applications/@me') return sendJson(response, 200, fixture.application);
			if (request.method === 'GET' && pathname === '/users/@me/guilds') {
				return sendJson(response, 200, [{ id: fixture.guild.id, name: fixture.guild.name, icon: null, permissions: '3072' }]);
			}
			if (request.method === 'GET' && pathname === `/guilds/${fixture.guild.id}`) return sendJson(response, 200, fixture.guild);
			if (request.method === 'GET' && pathname === `/guilds/${fixture.guild.id}/channels`) return sendJson(response, 200, [fixture.channel]);
			if (request.method === 'GET' && pathname === `/guilds/${fixture.guild.id}/members/${fixture.botUser.id}`) return sendJson(response, 200, fixture.member);
			if (request.method === 'GET' && pathname === `/channels/${fixture.channel.id}`) return sendJson(response, 200, fixture.channel);
			if (request.method === 'GET' && pathname === '/gateway/bot') {
				return sendJson(response, 200, { url: `ws://127.0.0.1:${gatewayPort}`, shards: 1, session_start_limit: {} });
			}
			if (request.method === 'POST' && pathname === `/channels/${fixture.channel.id}/messages`) {
				const body = await readJsonBody(request);
				outboundMessages.push(body);
				if (rejectNextSend) {
					rejectNextSend = false;
					return sendJson(response, 403, { message: 'Fixture send denied', code: 50013 });
				}
				return sendJson(response, 200, {
					id: String(800000000000000000n + BigInt(outboundMessages.length)),
					channel_id: fixture.channel.id,
					content: body.content,
					nonce: body.nonce,
					author: fixture.botUser,
				});
			}
			sendJson(response, 404, { message: `Fixture route not found: ${request.method} ${pathname}`, code: 0 });
		} catch (error) {
			sendJson(response, 500, { message: error.message, code: 0 });
		}
	});
	await new Promise((resolve, reject) => {
		apiServer.once('error', reject);
		apiServer.listen(0, '127.0.0.1', () => {
			apiPort = apiServer.address().port;
			resolve();
		});
	});

	const gatewayHttpServer = http.createServer();
	gatewayServer = new WebSocket.Server({ server: gatewayHttpServer });
	gatewayServer.on('connection', (socket) => {
		gatewaySockets.add(socket);
		socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
		socket.on('message', (raw) => {
			const payload = JSON.parse(String(raw));
			if (payload.op === 1) {
				socket.send(JSON.stringify({ op: 11, d: null }));
				return;
			}
			if (payload.op === 2 || payload.op === 6) {
				identifyPayloads.push(payload);
				socket.send(JSON.stringify({
					op: 0,
					t: payload.op === 6 ? 'RESUMED' : 'READY',
					s: 1,
					d: payload.op === 6 ? {} : {
						v: 10,
						user: fixture.botUser,
						session_id: `fixture-session-${Date.now()}`,
						resume_gateway_url: `ws://127.0.0.1:${gatewayPort}`,
						guilds: [{ id: fixture.guild.id, unavailable: false }],
					},
				}));
			}
		});
		socket.on('close', () => gatewaySockets.delete(socket));
	});
	await new Promise((resolve, reject) => {
		gatewayHttpServer.once('error', reject);
		gatewayHttpServer.listen(0, '127.0.0.1', () => {
			gatewayPort = gatewayHttpServer.address().port;
			gatewayServer.fixtureHttpServer = gatewayHttpServer;
			resolve();
		});
	});
}

function dispatchGatewayMessage(message) {
	const packet = JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: Date.now(), d: message });
	for (const socket of gatewaySockets) {
		if (socket.readyState === WebSocket.OPEN) socket.send(packet);
	}
}

function requestJson(pathname, body, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : JSON.stringify(body);
		const request = http.request({
			host: '127.0.0.1',
			port: remotePort,
			path: `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(remoteToken)}`,
			method: payload === null ? 'GET' : 'POST',
			headers: payload === null ? {} : {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload),
			},
		}, (response) => {
			let text = '';
			response.setEncoding('utf8');
			response.on('data', (chunk) => { text += chunk; });
			response.on('end', () => {
				let data = {};
				try {
					data = text ? JSON.parse(text) : {};
				} catch (error) {
					reject(error);
					return;
				}
				if (response.statusCode >= 200 && response.statusCode < 300) resolve(data);
				else reject(new Error(`HTTP ${response.statusCode}: ${text}`));
			});
		});
		request.setTimeout(timeoutMs, () => request.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
		request.once('error', reject);
		if (payload !== null) request.write(payload);
		request.end();
	});
}

async function waitFor(check, label, timeoutMs = 60000, intervalMs = 250) {
	const startedAt = Date.now();
	let lastError = null;
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await sleep(intervalMs);
	}
	throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

function launchApp() {
	child = spawn(electronPath, [
		'.',
		'--running-from-source',
		'--multiinstance',
		'--preferlocalassets',
		`--filesource=${socialStreamRoot}`,
		'--remote-control',
		...linuxLaunchArgs(),
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDir,
			SSAPP_REMOTE_CONTROL: '1',
			SSAPP_REMOTE_CONTROL_PORT: String(remotePort),
			SSAPP_REMOTE_CONTROL_TOKEN: remoteToken,
			SSAPP_DISCORD_TEST_MODE: '1',
			SSAPP_DISCORD_TEST_API_BASE: `http://127.0.0.1:${apiPort}/api/v10`,
			SSAPP_DISCORD_TEST_GATEWAY_URL: `ws://127.0.0.1:${gatewayPort}`,
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
			SSAPP_DEBUG_LOGS: '0',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	child.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(-40000); });
	child.stderr.on('data', (chunk) => { output = (output + chunk.toString()).slice(-40000); });
}

async function execInMain(code) {
	const response = await requestJson('/exec', { windowId: mainWindowId, code });
	if (!response.ok) throw new Error(response.error || 'Renderer execution failed.');
	return response.result;
}

async function execInView(key, code) {
	const response = await requestJson('/view-exec', { key: String(key), code });
	if (!response.ok) throw new Error(response.error || 'Source execution failed.');
	return response.result;
}

async function waitForApp() {
	await waitFor(async () => {
		try {
			return (await requestJson('/ping')).ok;
		} catch (_) {
			return false;
		}
	}, 'SSApp startup');
	const mainWindow = await waitFor(async () => {
		const windows = (await requestJson('/windows')).windows || [];
		return windows.find((item) => String(item.url || '').includes('index.html'));
	}, 'SSApp main window');
	mainWindowId = mainWindow.id;
	await waitFor(() => execInMain(`Boolean(
		window.stateManager
		&& stateManager.initialized
		&& typeof window.showDiscordAddSourcePrompt === 'function'
		&& window.ninjafy?.discord
		&& typeof configReady !== 'undefined'
		&& configReady
	)`), 'Discord UI initialization');
}

async function stopApp(graceful = false) {
	if (!child || child.exitCode !== null) return;
	if (graceful && mainWindowId) {
		try { await execInMain('window.close(); true;'); } catch (_) { }
	}
	await Promise.race([
		new Promise((resolve) => child.once('exit', resolve)),
		sleep(8000),
	]);
	if (child.exitCode === null) child.kill();
	await Promise.race([
		new Promise((resolve) => child.once('exit', resolve)),
		sleep(4000),
	]);
	if (child.exitCode === null) {
		try { child.kill('SIGKILL'); } catch (_) { }
	}
}

async function runSetupWorkflow() {
	const opened = await execInMain(`(() => {
		const button = document.querySelector('[data-source-type="discord"]');
		if (!button) return { ok: false, reason: 'button missing' };
		button.click();
		const modal = document.getElementById('discordAddSourceModal');
		return {
			ok: !!modal && !modal.classList.contains('hidden'),
			nativeChoice: !!document.getElementById('discordNativeModeButton'),
			webChoice: !!document.getElementById('discordWebModeButton'),
			streamKitChoice: !!document.getElementById('discordStreamKitModeButton'),
		};
	})()`);
	assert.deepStrictEqual(opened, { ok: true, nativeChoice: true, webChoice: true, streamKitChoice: true });

	await execInMain(`(() => {
		window.prompt = () => 'https://streamkit.discord.com/overlay/chat/300000000000000003/400000000000000004';
		document.getElementById('discordStreamKitModeButton').click();
		return true;
	})()`);
	const streamKitSource = await waitFor(() => execInMain(`stateManager.getSources().find(source => source.discordStreamKit) || null`),
		'Discord StreamKit source creation');
	assert.strictEqual(streamKitSource.target, 'discord');
	assert.strictEqual(streamKitSource.sourceFile, 'sources/discordstreamkit.js');
	assert.deepStrictEqual(streamKitSource.sourceFiles, ['sources/discordstreamkit.js']);

	await waitFor(() => execInMain(`(() => {
		try {
			const background = document.getElementById('frame2')?.contentWindow;
			if (!background || typeof background.processIncomingMessage !== 'function') return false;
			if (!background.__ssappDiscordCaptured) {
				background.__ssappDiscordCaptured = [];
				const original = background.processIncomingMessage;
				background.processIncomingMessage = async function (message, sender) {
					if (message?.type === 'discord') background.__ssappDiscordCaptured.push(JSON.parse(JSON.stringify(message)));
					return original.call(this, message, sender);
				};
			}
			return true;
		} catch (_) {
			return false;
		}
	})()`), 'Social Stream background message interceptor');

	await execInMain(`document.querySelector('[data-source-id="${streamKitSource.id}"] [data-activatehtml]').click(); true;`);
	const activeStreamKit = await waitFor(async () => {
		const current = await execInMain(`stateManager.getSource('${streamKitSource.id}')`);
		return current?.status === 'active' && current.vid ? current : null;
	}, 'Discord StreamKit source activation');
	await execInView(activeStreamKit.vid, `(() => {
		document.body.innerHTML = '<div class="Chat_chatContainer__fixture">'
			+ '<div class="Chat_channelName__fixture">#reactions</div>'
			+ '<ul class="Chat_messages__fixture">'
			+ '<li class="Chat_message__fixture"><span class="Chat_timestamp__fixture">12:40 AM</span>'
			+ '<span class="Chat_username__fixture">Backlog</span>'
			+ '<span class="Chat_messageText__fixture">Already visible</span></li>'
			+ '</ul></div>';
		return true;
	})()`);
	await waitFor(() => execInView(activeStreamKit.vid,
		`document.querySelector('[class^="Chat_message__"]')?.dataset?.ssnStreamKitSeen === 'true'`),
		'Discord StreamKit parser attachment');
	assert.strictEqual(await execInMain(`document.getElementById('frame2').contentWindow.__ssappDiscordCaptured.length`), 0,
		'StreamKit backlog must not be captured');
	await execInView(activeStreamKit.vid, `(() => {
		const row = document.createElement('li');
		row.className = 'Chat_message__fixture';
		row.innerHTML = '<span class="Chat_timestamp__fixture">12:41 AM</span>'
			+ '<span class="Chat_username__fixture" style="color:rgb(88, 101, 242)">StreamKit User</span>'
			+ '<span class="Chat_messageText__fixture">Hello &lt;StreamKit&gt; <strong>friends</strong></span>';
		document.querySelector('[class^="Chat_messages__"]').appendChild(row);
		return true;
	})()`);
	const streamKitCapture = await waitFor(() => execInMain(
		`document.getElementById('frame2')?.contentWindow?.__ssappDiscordCaptured?.[0] || null`
	), 'Discord StreamKit message delivery');
	assert.strictEqual(streamKitCapture.type, 'discord');
	assert.strictEqual(streamKitCapture.chatname, 'StreamKit User');
	assert.ok(streamKitCapture.chatmessage.includes('Hello &lt;StreamKit&gt; <strong>friends</strong>'));
	await execInMain(`document.getElementById('frame2').contentWindow.__ssappDiscordCaptured = []; true;`);

	await execInMain(`showDiscordAddSourcePrompt(); true;`);

	await execInMain(`document.getElementById('discordNativeModeButton').click(); true;`);
	await waitFor(() => execInMain(`!document.getElementById('discordNativeSetup').classList.contains('hidden')`), 'native Discord setup panel');
	await execInMain(`(() => {
		const input = document.getElementById('discordBotTokenInput');
		input.value = ${JSON.stringify(botToken)};
		document.getElementById('discordSaveBotButton').click();
		return true;
	})()`);

	await waitFor(() => execInMain(`Boolean(
		document.getElementById('discordBotSelect').value
		&& document.getElementById('discordGuildSelect').querySelector('option[value="${fixture.guild.id}"]')
	)`), 'verified bot and guild discovery');

	await execInMain(`(() => {
		const guild = document.getElementById('discordGuildSelect');
		guild.value = '${fixture.guild.id}';
		guild.dispatchEvent(new Event('change', { bubbles: true }));
		const channel = document.getElementById('discordChannelSelect');
		channel.value = '${fixture.channel.id}';
		channel.dispatchEvent(new Event('change', { bubbles: true }));
		document.getElementById('discordAddSourceButton').click();
		return true;
	})()`);

	const source = await waitFor(async () => {
		const sources = await execInMain(`stateManager.getSources().filter(source => source.discordNative)`);
		return sources[0] || null;
	}, 'native Discord source creation');
	assert.strictEqual(source.target, 'discord');
	assert.strictEqual(source.guildId, fixture.guild.id);
	assert.strictEqual(source.channelId, fixture.channel.id);
	assert.strictEqual(source.connectionMode, 'websocket');
	assert.strictEqual(Object.prototype.hasOwnProperty.call(source, 'token'), false);

	await execInMain(`document.querySelector('[data-source-id="${source.id}"] [data-activatehtml]').click(); true;`);
	const active = await waitFor(async () => {
		const current = await execInMain(`stateManager.getSource('${source.id}')`);
		return current?.status === 'active' && current.vid >= 1000000 ? current : null;
	}, 'native Discord Gateway connection');
	assert.ok(identifyPayloads.some((payload) => payload.op === 2 && payload.d.token === botToken));
	assert.ok(identifyPayloads.some((payload) => payload.op === 2 && payload.d.intents === 33281));

	const windows = (await requestJson('/windows')).windows || [];
	assert.strictEqual(windows.some((item) => String(item.url || '').includes('/channels/')), false, 'native source must not create a Discord browser window');
	const views = (await requestJson('/views')).views || [];
	assert.ok(views.some((item) => Number(item.key) === active.vid && String(item.url).includes(`/channels/${fixture.guild.id}/${fixture.channel.id}`)));

	dispatchGatewayMessage({
		id: '500000000000000005',
		guild_id: fixture.guild.id,
		channel_id: fixture.channel.id,
		content: 'Hello <@600000000000000006>',
		timestamp: new Date().toISOString(),
		author: { id: '600000000000000006', username: 'native-tester', global_name: 'Native Tester', bot: false, avatar: null, discriminator: '0' },
		member: { nick: null, roles: [] },
		mentions: [{ id: '600000000000000006', username: 'native-tester', global_name: 'Native Tester' }],
		attachments: [],
		embeds: [],
	});
	const captured = await waitFor(async () => {
		return execInMain(`document.getElementById('frame2')?.contentWindow?.__ssappDiscordCaptured?.[0] || null`);
	}, 'Discord message delivery to the Social Stream background');
	assert.strictEqual(captured.type, 'discord');
	assert.strictEqual(captured.chatname, 'Native Tester');
	assert.ok(captured.chatmessage.includes('Hello @Native Tester'));
	assert.strictEqual(captured.meta.guildId, fixture.guild.id);
	assert.strictEqual(captured.meta.channelId, fixture.channel.id);
	assert.strictEqual(captured.tid, active.vid);
	assert.strictEqual(Object.prototype.hasOwnProperty.call(captured, 'event'), false);

	const capturedCount = await execInMain(`document.getElementById('frame2').contentWindow.__ssappDiscordCaptured.length`);
	dispatchGatewayMessage({
		id: '500000000000000099',
		guild_id: fixture.guild.id,
		channel_id: fixture.channel.id,
		content: 'Ignored webhook message',
		timestamp: new Date().toISOString(),
		author: { id: '700000000000000007', username: 'webhook', bot: true, discriminator: '0' },
		member: { roles: [] },
		webhook_id: '900000000000000009',
		attachments: [],
		embeds: [],
	});
	await sleep(800);
	assert.strictEqual(await execInMain(`document.getElementById('frame2').contentWindow.__ssappDiscordCaptured.length`), capturedCount);

	await execInMain(`require('electron').ipcRenderer.sendSync('sendToTab', {
		tab: ${active.vid},
		message: { text: 'Outbound from SSApp' }
	}); true;`);
	await waitFor(() => outboundMessages.length === 1, 'Discord outbound REST message');
	assert.strictEqual(outboundMessages[0].content, 'Outbound from SSApp');
	assert.deepStrictEqual(outboundMessages[0].allowed_mentions, { parse: [] });
	assert.strictEqual(outboundMessages[0].enforce_nonce, true);
	assert.ok(outboundMessages[0].nonce);

	await verifyRelayAndTextOnly(active);

	await execInMain(`stateManager.updateSource('${source.id}', { autoActivate: true }); true;`);
	await sleep(1200);
	return source.id;
}

async function verifyRelayAndTextOnly(active) {
	const runBackground = (code) => execInMain(`document.getElementById('frame2').contentWindow.eval(${JSON.stringify(code)})`);
	await runBackground(`isExtensionOn = true; settings.disablehost = false; relaytargets = ['discord']; true;`);
	assert.strictEqual(await runBackground(`getSourceType(${active.vid})`), 'discord');
	const sendRelay = async (text, destination = false) => {
		const count = outboundMessages.length;
		await runBackground(`sendMessageToTabs(${JSON.stringify({ response: text, destination })}, false, null, true)`);
		await waitFor(() => outboundMessages.length > count, `relay: ${text}`);
		await sleep(600);
		assert.strictEqual(outboundMessages.length, count + 1, 'each relay should send exactly once');
		assert.strictEqual(outboundMessages[count].content, text);
	};
	await sendRelay('Targeted native relay', 'discord');
	await sendRelay('Untargeted native relay');
	const beforeMismatch = outboundMessages.length;
	await runBackground(`sendMessageToTabs({ response: 'Wrong destination', destination: 'youtube' }, false, null, true)`);
	await sleep(600);
	assert.strictEqual(outboundMessages.length, beforeMismatch, 'other platform destinations must not reach Discord');

	// Exercise the real dock IPC entry point from the background frame, including broadcast replies.
	for (const tid of [active.vid, false]) {
		const count = outboundMessages.length;
		const text = `Dock reply ${tid}`;
		await runBackground(`ipcRenderer.sendSync('postMessage', { overlayNinja: ${JSON.stringify({ response: text, tid, host: true })} }); true;`);
		await waitFor(() => outboundMessages.length > count, text);
		await sleep(1000);
		assert.strictEqual(outboundMessages.length, count + 1, 'dock replies must not be duplicated by native and background routes');
		assert.strictEqual(outboundMessages[count].content, text);
	}

	await execInMain(`window.__discordSendErrors = []; window.ninjafy.discord.onStatus(status => {
		if (status.status === 'error') window.__discordSendErrors.push(status);
	}); true;`);
	rejectNextSend = true;
	await sendRelay('Rejected native relay', 'discord');
	await waitFor(() => execInMain(`window.__discordSendErrors.some(status => status.message === 'Fixture send denied')`), 'send error reaches UI');
	await sleep(800);
	assert.strictEqual(output.includes('Unhandled Rejection at:'), false, 'handled send failures must not trigger global rejection reporting');
	await sendRelay('Native relay recovers after rejection', 'discord');

	await runBackground(`settings.textonlymode = true; chrome.storage.sync.set({ settings }); true;`);
	const message = {
		id: '500000000000000111', guild_id: fixture.guild.id, channel_id: fixture.channel.id,
		author: { id: '600000000000000006', username: 'A&B', bot: false },
		content: 'Hello <@600000000000000006> <:wave:123>\n<literal> & text',
		mentions: [{ id: '600000000000000006', username: 'A&B' }],
		attachments: [{ url: 'https://example.test/file.txt?a=1&b=2', filename: 'file.txt' }],
	};
	dispatchGatewayMessage(message);
	const plain = await waitFor(() => runBackground(`__ssappDiscordCaptured.find(message => message.meta?.messageId === '${message.id}') || null`), 'text-only capture');
	assert.strictEqual(plain.textonly, true);
	assert.strictEqual(plain.chatname, 'A&B');
	assert.strictEqual(plain.chatmessage, 'Hello @A&B :wave:\n<literal> & text\nhttps://example.test/file.txt?a=1&b=2');
	await runBackground(`settings.textonlymode = false; chrome.storage.sync.set({ settings }); true;`);
	message.id = '500000000000000112';
	dispatchGatewayMessage(message);
	const rich = await waitFor(() => runBackground(`__ssappDiscordCaptured.find(message => message.meta?.messageId === '${message.id}') || null`), 'rich capture after toggling text-only off');
	assert.strictEqual(rich.textonly, false);
	assert.ok(rich.chatmessage.includes('<img '));
	assert.ok(rich.chatmessage.includes('<br>&lt;literal&gt; &amp; text'));
	console.log('Discord relay, dock reply, send-error recovery, and text-only workflows passed.');
}

async function verifyRestart(sourceId) {
	mainWindowId = null;
	identifyPayloads = [];
	launchApp();
	await waitForApp();
	const source = await waitFor(async () => {
		const current = await execInMain(`stateManager.getSource('${sourceId}')`);
		return current?.status === 'active' && current.vid >= 1000000 ? current : null;
	}, 'Discord auto-activation after restart', 90000);
	assert.strictEqual(source.autoActivate, true);
	assert.ok(identifyPayloads.some((payload) => payload.op === 2 && payload.d.token === botToken), 'saved encrypted token should reconnect after restart');

	await execInMain(`document.querySelector('[data-source-id="${sourceId}"] [data-stophtml]').click(); true;`);
	await waitFor(async () => {
		const current = await execInMain(`stateManager.getSource('${sourceId}')`);
		return current?.status === 'inactive' && !current.vid && !current.wssId;
	}, 'native Discord source stop');
	const views = (await requestJson('/views')).views || [];
	assert.strictEqual(views.some((item) => Number(item.key) >= 1000000), false);

	// Group deletion must close both native connections and classic browser sources.
	await execInMain(`(async () => {
		stateManager.addGroup({ id: 'delete-group-e2e', target: 'custom', username: 'Delete group test' });
		const streamKit = stateManager.getSources().find(source => source.discordStreamKit);
		for (const id of ['${sourceId}', streamKit.id]) {
			stateManager.moveSourceToGroup(id, 'delete-group-e2e');
			await activateSource(document.querySelector('[data-source-id="' + id + '"] [data-activatehtml]'));
		}
		return true;
	})()`);
	const groupedSources = await waitFor(async () => {
		const sources = await execInMain(`stateManager.getSources().filter(source => source.groupId === 'delete-group-e2e')`);
		return sources.length === 2 && sources.every(source => source.vid && source.status === 'active') ? sources : null;
	}, 'grouped native and browser connections');
	await execInMain(`deleteThis(document.querySelector('[data-group-id="delete-group-e2e"]')); true;`);
	await sleep(1200);
	assert.strictEqual(await execInMain(`stateManager.getSources().some(source => source.groupId === 'delete-group-e2e')`), false);
	const afterDelete = (await requestJson('/views')).views || [];
	assert.strictEqual(afterDelete.some(view => groupedSources.some(source => source.vid === Number(view.key))), false,
		'deleted groups must not leave native or browser views running');
	await waitFor(() => gatewaySockets.size === 0, 'deleted group disconnects Discord Gateway');
	console.log('Group deletion closed native and browser sources.');
}

async function closeFixtures() {
	for (const socket of gatewaySockets) {
		try { socket.terminate(); } catch (_) { }
	}
	gatewaySockets.clear();
	if (gatewayServer) await new Promise((resolve) => gatewayServer.close(resolve));
	if (gatewayServer?.fixtureHttpServer) await new Promise((resolve) => gatewayServer.fixtureHttpServer.close(resolve));
	if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
}

async function main() {
	try {
		remotePort = await getFreePort();
		await startDiscordFixture();
		launchApp();
		await waitForApp();
		const sourceId = await runSetupWorkflow();
		await stopApp(true);

		const savedState = fs.readFileSync(path.join(profileDir, 'savedSync.json'), 'utf8');
		const authStore = fs.readFileSync(path.join(profileDir, 'discord-bot-auth.json'), 'utf8');
		assert.strictEqual(savedState.includes(botToken), false, 'source state must not contain the bot token');
		assert.strictEqual(authStore.includes(botToken), false, 'credential store must not contain the plaintext bot token');
		assert.ok(authStore.includes('protectedToken'));

		await verifyRestart(sourceId);
		console.log('Discord native functional Electron test passed.');
	} catch (error) {
		console.error(error.stack || error);
		if (output) console.error(`\nRecent SSApp output:\n${output}`);
		process.exitCode = 1;
	} finally {
		await stopApp(true);
		await closeFixtures();
		try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) { }
	}
}

main();
