#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const electronPath = require("electron");
const repoRoot = path.resolve(__dirname, "..", "..");
const socialStreamRoot = path.resolve(repoRoot, "..", "social_stream");
const profilePrefix = path.join(os.tmpdir(), "ssapp-individual-likes-e2e-");
const profileDir = fs.mkdtempSync(profilePrefix);
const token = `individual-likes-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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

function requestJson(port, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : JSON.stringify(body);
		const request = http.request(
			{
				host: "127.0.0.1",
				port,
				path: `${pathname}${pathname.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`,
				method: payload === null ? "GET" : "POST",
				headers:
					payload === null
						? {}
						: {
								"Content-Type": "application/json",
								"Content-Length": Buffer.byteLength(payload),
							},
			},
			(response) => {
				let text = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					text += chunk;
				});
				response.on("end", () => {
					try {
						const parsed = text ? JSON.parse(text) : {};
						if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
						else reject(new Error(`HTTP ${response.statusCode}: ${text}`));
					} catch (error) {
						reject(error);
					}
				});
			}
		);
		request.on("error", reject);
		if (payload !== null) request.write(payload);
		request.end();
	});
}

async function waitForControl(port, child, timeoutMs = 60000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (child.exitCode !== null) throw new Error(`SSApp exited early with code ${child.exitCode}.`);
		try {
			const ping = await requestJson(port, "/ping");
			if (ping && ping.ok) return;
		} catch (_) {}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("Timed out waiting for SSApp remote control.");
}

async function stopApp(child) {
	if (!child || child.exitCode !== null) return;
	child.kill();
	await Promise.race([
		new Promise((resolve) => child.once("exit", resolve)),
		new Promise((resolve) => setTimeout(resolve, 5000)),
	]);
}

async function run() {
	const port = await getFreePort();
	const sourceArg = socialStreamRoot.replace(/\\/g, "/").replace(/\/?$/, "/");
	const child = spawn(
		electronPath,
		[
			".",
			"--multiinstance",
			"--running-from-source",
			"--preferlocalassets",
			`--filesource=${sourceArg}`,
			"--remote-control",
			...linuxLaunchArgs(),
		],
		{
			cwd: repoRoot,
			env: {
				...process.env,
				SSAPP_USER_DATA_DIR: profileDir,
				SSAPP_REMOTE_CONTROL: "1",
				SSAPP_REMOTE_CONTROL_PORT: String(port),
				SSAPP_REMOTE_CONTROL_TOKEN: token,
				SSAPP_DIAGNOSTICS_SAFE_GPU: "1",
				SSAPP_DEBUG_LOGS: "0",
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		}
	);
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		output += chunk.toString();
	});

	try {
		await waitForControl(port, child);
		let windows = null;
		let mainWindow = null;
		const windowStarted = Date.now();
		while (Date.now() - windowStarted < 30000) {
			windows = await requestJson(port, "/windows");
			mainWindow = (windows.windows || []).find((item) => String(item.url || "").includes("index.html"));
			if (mainWindow) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(mainWindow, `Main SSApp window was not found: ${JSON.stringify(windows)}`);

		const result = await requestJson(port, "/exec", {
			windowId: mainWindow.id,
			code: `(async () => {
				const started = Date.now();
				let frame = null;
				let background = null;
				while (Date.now() - started < 30000) {
					frame = document.getElementById("frame2");
					try {
						background = frame && frame.contentWindow;
						if (background && typeof background.processIncomingMessage === "function" && background.window.eventFlowSystem) break;
					} catch (_) {}
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				if (!background || typeof background.processIncomingMessage !== "function") {
					return { ready: false, frameUrl: frame && frame.src };
				}

				background.isExtensionOn = true;
				const counts = { reactions: 0, dock: 0, eventFlow: 0, disk: 0 };
				background.sendTargetP2P = function (_payload, target) {
					if (target === "reactions") counts.reactions += 1;
					return true;
				};
				background.sendDataP2P = function () { counts.dock += 1; };
				background.sendToDisk = function () { counts.disk += 1; };
				background.sendToH2R = function () {};
				background.sendToPost = function () {};
				background.sendToDiscord = function () {};
				background.sendToStreamerBot = function () {};
				background.addMessageDB = async function () { return 1; };
				const originalProcessMessage = background.window.eventFlowSystem.processMessage.bind(background.window.eventFlowSystem);
				background.window.eventFlowSystem.processMessage = async function (message) {
					counts.eventFlow += 1;
					return originalProcessMessage(message);
				};

				function resetSettings() {
					delete background.settings.capturelikeevent;
					delete background.settings.hideevents;
					delete background.settings.filtereventstoggle;
					delete background.settings.filterevents;
				}
				function resetCounts() {
					counts.reactions = 0;
					counts.dock = 0;
					counts.eventFlow = 0;
					counts.disk = 0;
				}
				function snapshot() {
					return Object.assign({}, counts);
				}
				async function emit(message) {
					await background.processIncomingMessage(message, null);
					await new Promise((resolve) => setTimeout(resolve, 25));
					return snapshot();
				}

				const scenarios = {};
				resetSettings();
				resetCounts();
				const ipcRenderer = background.require("electron").ipcRenderer;
				ipcRenderer.emit("fromMain", { returnValue: null }, {
					message: { id: 81001, type: "tiktok", event: "liked", chatname: "Ava", chatmessage: "liked the stream" }
				});
				await new Promise((resolve) => setTimeout(resolve, 250));
				scenarios.disabledViaBridge = snapshot();

				resetSettings();
				background.settings.capturelikeevent = { setting: true };
				resetCounts();
				scenarios.enabled = await emit({ id: 81002, type: "tiktok", event: "liked", chatname: "Bea", chatmessage: "liked the stream twice" });

				resetSettings();
				background.settings.capturelikeevent = { setting: true };
				background.settings.hideevents = { setting: true };
				resetCounts();
				scenarios.hidden = await emit({ id: 81003, type: "instagram", event: "liked", chatname: "Cia", chatmessage: "liked a post" });

				resetSettings();
				background.settings.capturelikeevent = { setting: true };
				background.settings.filtereventstoggle = { setting: true };
				background.settings.filterevents = { textsetting: "liked" };
				resetCounts();
				scenarios.filtered = await emit({ id: 81004, type: "meetme", event: "liked", chatname: "Dee", chatmessage: "sent a heart" });

				resetSettings();
				resetCounts();
				scenarios.reaction = await emit({ id: 81005, type: "zoom", event: "reaction", chatname: "Eli", chatmessage: "thumbs up" });

				resetSettings();
				resetCounts();
				scenarios.total = await emit({ id: 81006, type: "tiktok", event: "likes_update", meta: 42 });

				resetSettings();
				resetCounts();
				scenarios.legacyLike = await emit({ id: 81007, type: "legacy", event: "like", chatname: "Fay", chatmessage: "liked" });

				return { ready: true, frameUrl: frame.src, scenarios };
			})()`,
		});

		assert.strictEqual(result.ok, true, JSON.stringify(result));
		assert.strictEqual(result.result.ready, true, JSON.stringify(result.result));
		assert.deepStrictEqual(result.result.scenarios.disabledViaBridge, { reactions: 1, dock: 0, eventFlow: 0, disk: 0 });
		assert.deepStrictEqual(result.result.scenarios.enabled, { reactions: 1, dock: 1, eventFlow: 1, disk: 1 });
		assert.deepStrictEqual(result.result.scenarios.hidden, { reactions: 0, dock: 0, eventFlow: 0, disk: 0 });
		assert.deepStrictEqual(result.result.scenarios.filtered, { reactions: 0, dock: 0, eventFlow: 0, disk: 0 });
		assert.deepStrictEqual(result.result.scenarios.reaction, { reactions: 1, dock: 1, eventFlow: 1, disk: 1 });
		assert.deepStrictEqual(result.result.scenarios.total, { reactions: 0, dock: 1, eventFlow: 1, disk: 1 });
		assert.deepStrictEqual(result.result.scenarios.legacyLike, { reactions: 1, dock: 0, eventFlow: 0, disk: 0 });
		console.log("Individual-like routing Electron end-to-end checks passed.");
	} catch (error) {
		throw new Error(`${error.message}\n${output.slice(-5000)}`);
	} finally {
		await stopApp(child);
		if (profileDir.startsWith(profilePrefix) && fs.existsSync(profileDir)) {
			fs.rmSync(profileDir, { recursive: true, force: true });
		}
	}
}

run().catch((error) => {
	console.error(error);
	process.exit(1);
});
