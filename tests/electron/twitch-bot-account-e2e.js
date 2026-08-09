#!/usr/bin/env node

"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { linuxLaunchArgs } = require("./helpers/electron-launch");

const electronPath = require("electron");
const repoRoot = path.resolve(__dirname, "..", "..");
const socialStreamRoot = path.resolve(repoRoot, "..", "social_stream");
const profilePrefix = path.join(os.tmpdir(), "ssapp-twitch-bot-account-");
const profileDir = fs.mkdtempSync(profilePrefix);
const remoteToken = `twitch-bot-account-${Date.now()}-${Math.random().toString(36).slice(2)}`;

let child = null;
let remotePort = null;
let mainWindowId = null;
let sourceId = null;
let sourceViewKey = null;
let output = "";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

function requestJson(pathname, body, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : JSON.stringify(body);
		const request = http.request({
			host: "127.0.0.1",
			port: remotePort,
			path: `${pathname}${pathname.includes("?") ? "&" : "?"}token=${encodeURIComponent(remoteToken)}`,
			method: payload === null ? "GET" : "POST",
			headers: payload === null ? {} : {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(payload),
			},
		}, (response) => {
			let text = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => { text += chunk; });
			response.on("end", () => {
				let data = {};
				try {
					data = text ? JSON.parse(text) : {};
				} catch (error) {
					reject(error);
					return;
				}
				if (response.statusCode >= 200 && response.statusCode < 300) {
					resolve(data);
					return;
				}
				reject(new Error(`HTTP ${response.statusCode}: ${text}`));
			});
		});
		request.setTimeout(timeoutMs, () => request.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
		request.on("error", reject);
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
	throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

function launchApp() {
	child = spawn(electronPath, [
		".",
		"--running-from-source",
		"--multiinstance",
		"--preferlocalassets",
		`--filesource=${socialStreamRoot}`,
		"--remote-control",
		...linuxLaunchArgs(),
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDir,
			SSAPP_REMOTE_CONTROL: "1",
			SSAPP_REMOTE_CONTROL_PORT: String(remotePort),
			SSAPP_REMOTE_CONTROL_TOKEN: remoteToken,
			SSAPP_DIAGNOSTICS_SAFE_GPU: "1",
			SSAPP_DEBUG_LOGS: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	child.stdout.on("data", (chunk) => { output = (output + chunk.toString()).slice(-30000); });
	child.stderr.on("data", (chunk) => { output = (output + chunk.toString()).slice(-30000); });
}

async function listWindows() {
	return (await requestJson("/windows")).windows || [];
}

async function listViews() {
	return (await requestJson("/views")).views || [];
}

async function execInWindow(windowId, code) {
	const response = await requestJson("/exec", { windowId, code });
	if (!response.ok) throw new Error(response.error || "Window execution failed.");
	return response.result;
}

async function execInMain(code) {
	return execInWindow(mainWindowId, code);
}

async function execInSource(code) {
	const response = await requestJson("/view-exec", { key: sourceViewKey, code });
	if (!response.ok) throw new Error(response.error || "Source execution failed.");
	return response.result;
}

async function waitForApp() {
	await waitFor(async () => {
		try {
			return (await requestJson("/ping")).ok;
		} catch (_) {
			return false;
		}
	}, "SSApp startup");

	const mainWindow = await waitFor(async () => {
		return (await listWindows()).find((windowInfo) => String(windowInfo.url || "").includes("index.html"));
	}, "SSApp main window");
	mainWindowId = mainWindow.id;

	await waitFor(async () => execInMain(`Boolean(
		window.stateManager
		&& stateManager.initialized
		&& typeof updateTwitchBotAccountMenu === "function"
		&& typeof configReady !== "undefined"
		&& configReady
	)`), "SSApp renderer initialization");
}

async function createAndCheckSourceUi() {
	sourceId = await execInMain(`(() => {
		stateManager.clearAllSourcesAndGroups();
		return stateManager.addSource({
			id: "twitch-bot-account-e2e",
			target: "twitch",
			url: "https://www.twitch.tv/ssn_test_fixture",
			username: "ssn_test_fixture",
			connectionMode: "classic",
			isVisible: false,
			isMuted: true,
			autoActivate: false,
			supportsWSS: true,
			sourceFile: "sources/websocket/twitch.js"
		});
	})()`);

	await waitFor(async () => execInMain(`Boolean(document.querySelector('[data-source-id="${sourceId}"]'))`), "Twitch source UI");

	const result = await execInMain(`(async () => {
		const entry = document.querySelector('[data-source-id="${sourceId}"]');
		const section = entry.querySelector('[data-twitch-websocket-sending]');
		const replyOnly = entry.querySelector('[data-reply-only]');
		const accountRole = entry.querySelector('[data-account-role]');
		const standardHidden = section.classList.contains('hidden');
		stateManager.updateSource(${JSON.stringify(sourceId)}, { connectionMode: 'websocket', activeConnectionMode: null });
		updateSourceUIAfterModeChange(entry, 'websocket', false);
		const websocketVisible = !section.classList.contains('hidden');
		const accountItem = section.querySelector('[data-twitch-bot-account]');
		applyTwitchBotAccountStatus(${JSON.stringify(sourceId)}, {
			connected: false,
			event: 'status',
			mainHasChannelBotScope: false,
			mainBotAuthorizationReady: false,
			mainAccountIsBroadcaster: true,
			mainAccountLogin: 'ssn_test_fixture'
		});
		await openTwitchBotAccountSettings(accountItem);
		const modalText = document.getElementById('tiktok-auth-modal')?.textContent || '';
		const oldLoginWarningVisible = !!document.getElementById('twitch-bot-main-permission-warning');
		closeModal();
		applyTwitchBotAccountStatus(${JSON.stringify(sourceId)}, {
			connected: false,
			event: 'status',
			mainHasChannelBotScope: true,
			mainBotAuthorizationReady: true,
			mainAccountIsBroadcaster: true,
			mainAccountLogin: 'ssn_test_fixture'
		});
		await openTwitchBotAccountSettings(accountItem);
		const currentLoginWarningHidden = !document.getElementById('twitch-bot-main-permission-warning');
		closeModal();
		return {
			standardHidden,
			websocketVisible,
			accountText: accountItem.textContent.trim(),
			legacyControlsPresent: !!replyOnly && !!accountRole,
			modalText,
			oldLoginWarningVisible,
			currentLoginWarningHidden,
			sourceCount: stateManager.getSources().length
		};
	})()`);

	assert.equal(result.standardHidden, true, "Standard Twitch mode exposed the WebSocket-only bot control.");
	assert.equal(result.websocketVisible, true, "WebSocket Twitch mode did not expose the bot control.");
	assert.equal(result.accountText, "Automatic reply account: Main account");
	assert.equal(result.legacyControlsPresent, true, "Existing reply-only/account-role controls were removed.");
	assert.match(result.modalText, /does not create another source/i);
	assert.match(result.modalText, /existing Bot reply-only and Account role setup remains separate/i);
	assert.match(result.modalText, /one-time permission may be needed/i);
	assert.equal(result.oldLoginWarningVisible, true, "An older main-account login did not show the targeted warning.");
	assert.equal(result.currentLoginWarningHidden, true, "A current main-account login showed an unnecessary warning.");
	assert.equal(result.sourceCount, 1, "Opening bot account settings created another source.");
}

async function launchSourceAndCheckCommandBridge() {
	const tabId = await execInMain(`(async () => {
		const entry = document.querySelector('[data-source-id="${sourceId}"]');
		const activate = entry && entry.querySelector('[data-activatehtml]');
		if (!activate) throw new Error('Twitch source activate button missing');
		return await createWindow(activate);
	})()`);
	assert.ok(tabId, "Twitch WebSocket source did not open.");
	sourceViewKey = String(tabId);

	await waitFor(async () => {
		return (await listViews()).some((view) => String(view.key) === sourceViewKey && /sources\/websocket\/twitch\.html/i.test(view.url || ""));
	}, "Twitch WebSocket source view");
	await waitFor(async () => execInSource(`Boolean(
		document.getElementById('auth-link')
		&& window.chrome
		&& window.chrome.runtime
	)`), "Twitch source injection");

	await execInSource(`(() => {
		localStorage.setItem('twitchOAuthToken', 'e2e-main-fixture-token');
		localStorage.setItem('twitchOAuthScope', 'chat:read user:write:chat');
		localStorage.setItem('twitchOAuthClientId', 'ysbszgkt7uh5kn7qjed822dd89722n');
		localStorage.setItem('twitchBotOAuthToken', 'e2e-fixture-token');
		localStorage.setItem('twitchBotUserId', '222');
		localStorage.setItem('twitchBotLogin', 'ssnfixturebot');
		return true;
	})()`);

	const connected = await execInMain(`(async () => {
		const { ipcRenderer } = require('electron');
		const source = stateManager.getSource(${JSON.stringify(sourceId)});
		const status = await ipcRenderer.invoke('sendToTab-async', {
			tab: source.vid || source.wssId,
			message: { type: 'TWITCH_BOT_ACCOUNT_STATUS' }
		});
		applyTwitchBotAccountStatus(${JSON.stringify(sourceId)}, status || {});
		const entry = document.querySelector('[data-source-id="${sourceId}"]');
		return {
			status,
			label: entry.querySelector('[data-twitch-bot-account]').textContent.trim(),
			disconnectHidden: entry.querySelector('[data-twitch-bot-disconnect]').classList.contains('hidden'),
			sourceCount: stateManager.getSources().length
		};
	})()`);
	assert.equal(connected.status.connected, true);
	assert.equal(connected.status.mainHasChannelBotScope, false);
	assert.equal(connected.status.mainBotAuthorizationReady, false);
	assert.equal(connected.label, "Automatic reply account: @ssnfixturebot");
	assert.equal(connected.disconnectHidden, false);
	assert.equal(connected.sourceCount, 1, "Connected status created another source.");

	const twitchSourceText = fs.readFileSync(path.join(socialStreamRoot, "sources", "websocket", "twitch.js"), "utf8");
	assert.match(twitchSourceText, /reconnect this WebSocket source's main Twitch account/i);
	assert.match(twitchSourceText, /make \$\{botLabel\} a moderator/i);
	const authorizationFailure = "Twitch blocked automatic replies from @ssnfixturebot. Reconnect this WebSocket source's main Twitch account using the channel owner, or make @ssnfixturebot a moderator in this channel.";
	await execInSource(`(() => {
		window.ssWssNotifyTwitch('bot_account', ${JSON.stringify(authorizationFailure)}, {
			botAccount: {
				connected: true,
				login: 'ssnfixturebot',
				userId: '222',
				event: 'error',
				error: ${JSON.stringify(authorizationFailure)},
				requiresMainReauthorization: true,
				mainHasChannelBotScope: false,
				mainBotAuthorizationReady: false,
				mainAccountIsBroadcaster: true,
				mainAccountLogin: 'ssn_test_fixture'
			}
		});
		return true;
	})()`);

	const visibleFailure = await waitFor(async () => execInMain(`(() => {
		const source = stateManager.getSource(${JSON.stringify(sourceId)});
		const entry = document.querySelector('[data-source-id="${sourceId}"]');
		updateTwitchBotAccountMenu(entry, source);
		const note = entry.querySelector('[data-twitch-bot-status]');
		return source.twitchBotRequiresMainReauthorization && note && !note.classList.contains('hidden')
			? note.textContent.trim()
			: '';
	})()`), "Twitch bot authorization failure in SSApp");
	assert.match(visibleFailure, /channel owner/i);
	assert.match(visibleFailure, /moderator/i);

	await execInSource(`(() => {
		window.ssWssNotifyTwitch('bot_account', '', {
			botAccount: {
				connected: true,
				login: 'ssnfixturebot',
				userId: '222',
				event: 'status',
				error: null,
				requiresMainReauthorization: false,
				mainHasChannelBotScope: true,
				mainBotAuthorizationReady: true,
				mainAccountIsBroadcaster: true,
				mainAccountLogin: 'ssn_test_fixture'
			}
		});
		return true;
	})()`);
	await waitFor(async () => execInMain(`(() => {
		const source = stateManager.getSource(${JSON.stringify(sourceId)});
		const entry = document.querySelector('[data-source-id="${sourceId}"]');
		updateTwitchBotAccountMenu(entry, source);
		return !source.twitchBotAccountError
			&& entry.querySelector('[data-twitch-bot-status]').classList.contains('hidden');
	})()`), "Twitch bot authorization warning to clear after a successful send");

	const disconnected = await execInMain(`(async () => {
		const { ipcRenderer } = require('electron');
		const source = stateManager.getSource(${JSON.stringify(sourceId)});
		const status = await ipcRenderer.invoke('sendToTab-async', {
			tab: source.vid || source.wssId,
			message: { type: 'TWITCH_BOT_ACCOUNT_DISCONNECT' }
		});
		applyTwitchBotAccountStatus(${JSON.stringify(sourceId)}, status || {});
		const entry = document.querySelector('[data-source-id="${sourceId}"]');
		return {
			status,
			label: entry.querySelector('[data-twitch-bot-account]').textContent.trim()
		};
	})()`);
	assert.equal(disconnected.status.connected, false);
	assert.equal(disconnected.label, "Automatic reply account: Main account");
	assert.equal(await execInSource(`localStorage.getItem('twitchBotOAuthToken')`), null);

	const standardResult = await execInMain(`(() => {
		const { ipcRenderer } = require('electron');
		const source = stateManager.getSource(${JSON.stringify(sourceId)});
		if (source.vid) ipcRenderer.sendSync('closeWindow', { vid: source.vid });
		stateManager.updateSource(${JSON.stringify(sourceId)}, {
			connectionMode: 'classic',
			activeConnectionMode: null,
			vid: null,
			wssId: null,
			status: 'inactive'
		});
		const entry = document.querySelector('[data-source-id="${sourceId}"]');
		updateSourceUIAfterModeChange(entry, 'classic', false);
		return entry.querySelector('[data-twitch-websocket-sending]').classList.contains('hidden');
	})()`);
	assert.equal(standardResult, true, "Switching back to Standard mode left the WebSocket-only control visible.");
}

async function cleanup() {
	try {
		await requestJson("/api/v1/command", { action: "shutdownApp", value: { confirm: true } }, 5000);
	} catch (_) { }
	if (child && child.exitCode === null) {
		child.kill();
		await Promise.race([
			new Promise((resolve) => child.once("exit", resolve)),
			sleep(5000),
		]);
	}
	const resolvedProfile = path.resolve(profileDir);
	if (resolvedProfile.startsWith(path.resolve(profilePrefix))) {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			try {
				fs.rmSync(resolvedProfile, { recursive: true, force: true });
				break;
			} catch (_) {
				await sleep(250);
			}
		}
	}
}

async function run() {
	remotePort = await getFreePort();
	launchApp();
	try {
		await waitForApp();
		await createAndCheckSourceUi();
		await launchSourceAndCheckCommandBridge();
		console.log("PASS: Twitch WebSocket bot-account UI and source command bridge work in an isolated SSApp profile.");
	} catch (error) {
		console.error(error.stack || error.message || error);
		if (output) console.error(output.slice(-10000));
		process.exitCode = 1;
	} finally {
		await cleanup();
	}
}

run();
