'use strict';

// Uses the real app UI/IPC, installed connector and protobuf transport against
// loopback. Only TikTok's remote bootstrap is replaced in the isolated process.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { _electron } = require('playwright-core');
const WebSocket = require('ws');
const connector = require('tiktok-live-connector');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const root = path.resolve(__dirname, '../..');

async function freePort() {
	const server = net.createServer();
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

async function waitFor(check, label, timeout = 20000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out: ${label}`);
}

function chatFrame(id) {
	const empty = Buffer.alloc(0);
	const chat = Object.assign(connector.WebcastChatMessage.decode(empty), {
		content: `disconnect fixture ${id}`,
		common: Object.assign(connector.CommonMessageData.decode(empty), {
			msgId: String(id), createTime: String(Math.floor(Date.now() / 1000)), roomId: '123456',
		}),
		user: Object.assign(connector.User.decode(empty), { id: '123', nickname: 'Fixture viewer', uniqueId: 'fixture_viewer' }),
	});
	const result = Object.assign(connector.ProtoMessageFetchResult.decode(empty), {
		messages: [Object.assign(connector.BaseProtoMessage.decode(empty), {
			method: 'WebcastChatMessage', msgId: String(id), payload: connector.WebcastChatMessage.encode(chat).finish(),
		})],
	});
	return connector.createBaseWebcastPushFrame({ payload: connector.ProtoMessageFetchResult.encode(result).finish() }).finish();
}

async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-tiktok-disconnect-'));
	const relayPort = await freePort();
	const room = `tiktok_disconnect_${Date.now()}`;
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
		streamID: room, password: 'false', state: true, settings: { server2: { setting: true } }, wsServer: true,
	}));
	const server = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise(resolve => server.once('listening', resolve));
	let connections = 0;
	server.on('connection', () => { connections++; });
	let app;
	let appProcess;
	let relay;
	let output = '';
	const received = [];
	try {
		app = await _electron.launch({
			executablePath: require('electron'), cwd: root,
			args: ['.', '--running-from-source', '--multiinstance',
				`--filesource=${path.resolve(root, '../social_stream').replace(/\\/g, '/')}/`,
				`--ssapp-local-server-port=${relayPort}`, '--ssapp-headless-control', '--no-hwa', ...linuxLaunchArgs()],
			env: { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_DIAGNOSTICS_SAFE_GPU: '1', UV_THREADPOOL_SIZE: '2' },
			timeout: 60000,
		});
		appProcess = app.process();
		appProcess.stdout.on('data', chunk => { output = (output + chunk).slice(-16000); });
		appProcess.stderr.on('data', chunk => { output = (output + chunk).slice(-16000); });
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.stateManager?.initialized && typeof configReady !== 'undefined' && configReady);
		// Allow the Social Stream background receiver to finish loading its settings.
		await page.waitForTimeout(6000);
		await app.evaluate((_electron, { root, port }) => {
			const requireFromApp = process.getBuiltinModule('module').createRequire(root + '/package.json');
			const { ConnectionManager } = requireFromApp('./tiktok/connection-manager').__test;
			const originalInitialize = ConnectionManager.prototype.initializeConnectionInstance;
			global.__tiktokValidation = { oldHandler: true, manager: null, events: [] };
			ConnectionManager.prototype.initializeConnectionInstance = function (...args) {
				originalInitialize.apply(this, args);
				global.__tiktokValidation.manager = this;
				const connection = this.connection;
				for (const event of ['websocketData', 'decodedData', 'chat', 'error']) {
					connection.on(event, (...data) => global.__tiktokValidation.events.push({ event, data: event === 'websocketData' ? [] : data }));
				}
				connection._connect = () => {
					connection.webClient.roomId = '123456';
					return connection.setupWebsocket(`ws://127.0.0.1:${port}/`, {}, '123456');
				};
				if (global.__tiktokValidation.oldHandler) {
					for (const listener of connection.listeners('disconnected')) {
						connection.removeListener('disconnected', listener);
						connection.on('disconnect', listener);
					}
				}
			};
		}, { root, port: server.address().port });
		relay = new WebSocket(`ws://127.0.0.1:${relayPort}`);
		await new Promise((resolve, reject) => { relay.once('open', resolve); relay.once('error', reject); });
		relay.send(JSON.stringify({ join: room, out: 3, in: 4 }));
		relay.on('message', raw => {
			try {
				const message = JSON.parse(raw.toString());
				if (message.type === 'tiktok' && String(message.chatmessage).startsWith('disconnect fixture')) received.push(message.chatmessage);
			} catch (_) { }
		});
		const sourceId = await page.evaluate(() => stateManager.addSource({
			target: 'tiktok', username: 'ssapp_fixture', connectionMode: 'tiktok-websocket',
			tiktokSigningProvider: 'auto', autoActivate: false,
		}));
		async function start() {
			const result = await page.evaluate(async sourceId => {
				const result = await performActivationAttempt({ sourceId, mode: 'tiktok-websocket' });
				return { success: result.success, error: result.error?.message };
			}, sourceId);
			assert.ok(result.success, JSON.stringify(result));
			await waitFor(() => server.clients.size === 1, 'fixture socket');
			await waitFor(() => app.evaluate(() => global.__tiktokValidation.manager.connection.isConnected), 'connector ready');
		}
		async function stop() {
			await page.evaluate(async sourceId => {
				await stopThis(document.querySelector(`[data-source-id="${sourceId}"] [data-stophtml]`));
			}, sourceId);
			await waitFor(() => server.clients.size === 0, 'stopped socket');
		}
		function send(id) {
			for (const socket of server.clients) socket.send(chatFrame(id));
		}
		await start();
		send(1001);
		await waitFor(() => received.includes('disconnect fixture 1001'), 'baseline chat at destination');
		for (const socket of server.clients) socket.close(1012, 'fixture restart');
		await new Promise(resolve => setTimeout(resolve, 12000));
		const stalled = await app.evaluate(() => ({
			connected: global.__tiktokValidation.manager.connection.isConnected,
			retryScheduled: !!global.__tiktokValidation.manager.reconnectTimer,
		}));
		assert.deepStrictEqual(stalled, { connected: false, retryScheduled: false });
		assert.strictEqual(connections, 1);
		console.log('[tiktok-disconnect] REPRODUCED old handler: socket closed, no retry after 12s; UI=' + await page.evaluate(id => stateManager.getSource(id).status, sourceId));
		await stop();
		await app.evaluate(() => { global.__tiktokValidation.oldHandler = false; });
		await start();
		send(1002);
		await waitFor(() => received.includes('disconnect fixture 1002'), 'manual restart chat');
		for (let drop = 0; drop < 2; drop++) {
			const count = connections;
			for (const socket of server.clients) socket.close(1012, 'fixture restart');
			await waitFor(() => connections === count + 1, 'automatic reconnect', 30000);
			await new Promise(resolve => setTimeout(resolve, 500));
			send(1003 + drop);
			await waitFor(() => received.includes(`disconnect fixture ${1003 + drop}`), 'chat after automatic reconnect');
		}
		await stop();
		const stoppedCount = connections;
		await new Promise(resolve => setTimeout(resolve, 6000));
		assert.strictEqual(connections, stoppedCount);
		console.log('[tiktok-disconnect] PASS patched handler: two automatic reconnects, chat delivered after each; Stop stayed stopped.');
	} catch (error) {
		if (app) console.error(await app.evaluate(() => JSON.stringify({ events: global.__tiktokValidation.events, stats: global.__tiktokValidation.manager?.getTikTokDiagnosticStats() })));
		console.error(output.slice(-9000));
		throw error;
	} finally {
		if (relay) relay.terminate();
		if (app) {
			await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 5000))]);
			if (appProcess.exitCode === null) appProcess.kill();
		}
		for (const socket of server.clients) socket.terminate();
		await new Promise(resolve => server.close(resolve));
		const resolved = path.resolve(profile);
		assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('ssapp-tiktok-disconnect-'));
		fs.rmSync(resolved, { recursive: true, force: true });
	}
}

if (require.main === module) {
	run().catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { chatFrame, freePort, waitFor };
