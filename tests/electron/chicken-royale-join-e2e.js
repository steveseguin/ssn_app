#!/usr/bin/env node

"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawn } = require("child_process");

const electronPath = require("electron");
const repoRoot = path.resolve(__dirname, "..", "..");
const socialStreamRoot = path.resolve(repoRoot, "..", "social_stream");
const profilePrefix = path.join(os.tmpdir(), "ssapp-chicken-royale-e2e-");
const profileDir = fs.mkdtempSync(profilePrefix);
const controlToken = `chicken-royale-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
		const request = http.request({
			host: "127.0.0.1",
			port,
			path: `${pathname}${pathname.includes("?") ? "&" : "?"}token=${encodeURIComponent(controlToken)}`,
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
				try {
					const parsed = text ? JSON.parse(text) : {};
					if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
					else reject(new Error(`HTTP ${response.statusCode}: ${text}`));
				} catch (error) {
					reject(error);
				}
			});
		});
		request.on("error", reject);
		if (payload !== null) request.write(payload);
		request.end();
	});
}

async function waitForControl(port, child, timeoutMs = 60000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`SSApp exited early (${child.exitCode}).`);
		try {
			const response = await requestJson(port, "/ping");
			if (response && response.ok) return;
		} catch (_) {}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("Timed out waiting for SSApp remote control.");
}

async function findMainWindow(port, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	let windows;
	while (Date.now() < deadline) {
		windows = await requestJson(port, "/windows");
		const mainWindow = (windows.windows || []).find((item) => String(item.url || "").includes("index.html"));
		if (mainWindow) return mainWindow;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Main SSApp window was not found: ${JSON.stringify(windows)}`);
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
	const controlPort = await getFreePort();
	const relayPort = await getFreePort();
	const unavailablePort = await getFreePort();
	fs.writeFileSync(path.join(profileDir, "savedSync.json"), JSON.stringify({
		streamID: "chicken_royale_e2e",
		password: "false",
		state: true,
		settings: { server2: { setting: true } },
		wsServer: true,
	}));

	const child = spawn(electronPath, [
		".",
		"--multiinstance",
		"--running-from-source",
		"--preferlocalassets",
		`--filesource=${socialStreamRoot.replace(/\\/g, "/")}/`,
		"--remote-control",
		`--ssapp-local-server-port=${relayPort}`,
		"--no-hwa",
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDir,
			SSAPP_REMOTE_CONTROL: "1",
			SSAPP_REMOTE_CONTROL_PORT: String(controlPort),
			SSAPP_REMOTE_CONTROL_TOKEN: controlToken,
			SSAPP_DIAGNOSTICS_SAFE_GPU: "1",
			SSAPP_DEBUG_LOGS: process.env.SSAPP_E2E_DEBUG || "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk.toString(); });
	child.stderr.on("data", (chunk) => { output += chunk.toString(); });

	try {
		await waitForControl(controlPort, child);
		const mainWindow = await findMainWindow(controlPort);
		const gamePageUrl = pathToFileURL(path.join(socialStreamRoot, "games", "chickenroyale.html")).href;
		const connectingUrl = `${gamePageUrl}?session=chicken_royale_e2e&autojoin&server2=${encodeURIComponent(`ws://127.0.0.1:${unavailablePort}`)}&v=3.52.0`;
		const connectedUrl = `${gamePageUrl}?session=chicken_royale_e2e&autojoin&server2=${encodeURIComponent(`ws://127.0.0.1:${relayPort}`)}&v=3.52.0`;

		const response = await requestJson(controlPort, "/exec", {
			windowId: mainWindow.id,
			code: `(async () => {
				const deadline = Date.now() + 30000;
				let background = null;
				while (Date.now() < deadline) {
					const frame = document.getElementById("frame2");
					try {
						background = frame && frame.contentWindow;
						if (background && typeof background.processIncomingMessage === "function" && typeof background.setupSocketDock === "function") break;
					} catch (_) {}
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				if (!background) return { ready: false, stage: "background" };

				const game = document.createElement("iframe");
				game.id = "chicken-royale-e2e";
				game.style.cssText = "position:fixed;left:-10000px;width:1280px;height:720px";
				document.body.appendChild(game);

				async function waitForGame(expectedPort) {
					while (Date.now() < deadline) {
						try {
							if (game.contentWindow
								&& game.contentWindow.location.href.includes(String(expectedPort))
								&& typeof game.contentWindow.getChickenRoyaleTransportState === "function") return true;
						} catch (_) {}
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
					return false;
				}

				game.src = ${JSON.stringify(connectingUrl)};
				if (!await waitForGame(${unavailablePort})) return { ready: false, stage: "connecting-page" };
				await new Promise((resolve) => setTimeout(resolve, 300));
				const connectingState = game.contentWindow.getChickenRoyaleTransportState();
				const connectingText = game.contentDocument.getElementById("connection-line").textContent;
				const connectingInstructions = getComputedStyle(game.contentDocument.getElementById("instructions")).display;

				game.src = ${JSON.stringify(connectedUrl)};
				if (!await waitForGame(${relayPort})) return { ready: false, stage: "connected-page" };
				while (Date.now() < deadline && !game.contentWindow.getChickenRoyaleTransportState().ready) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}

				background.isExtensionOn = true;
				background.settings.server2 = { setting: true };
				background.setupSocketDock();
				while (Date.now() < deadline && (!background.socketserverDock || background.socketserverDock.readyState !== 1)) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				if (!background.socketserverDock || background.socketserverDock.readyState !== 1) return { ready: false, stage: "background-relay" };

				await new Promise((resolve) => setTimeout(resolve, 500));
				await background.processIncomingMessage({ id: 95001, type: "discord", chatname: "AutoJoinUser", chatmessage: "hello everyone" }, null);
				await new Promise((resolve) => setTimeout(resolve, 250));
				await background.processIncomingMessage({ id: 95002, type: "discord", chatname: "CommandJoinUser", chatmessage: "!join" }, null);
				await new Promise((resolve) => setTimeout(resolve, 750));

				const connectedState = game.contentWindow.getChickenRoyaleTransportState();
				const connectionLine = game.contentDocument.getElementById("connection-line");
				const roster = game.contentDocument.getElementById("roster-list");
				return {
					ready: true,
					connectingState,
					connectingText,
					connectingInstructions,
					connectedState,
					connectedText: connectionLine.textContent,
					connectedClass: connectionLine.className,
					connectedInstructions: getComputedStyle(game.contentDocument.getElementById("instructions")).display,
					rosterText: roster.textContent,
				};
			})()`,
		});

		assert.strictEqual(response.ok, true, response.error || JSON.stringify(response));
		const result = response.result;
		assert.strictEqual(result.ready, true, JSON.stringify(result));
		assert.strictEqual(result.connectingState.ready, false);
		assert.match(result.connectingText, /Connecting to chat/);
		assert.strictEqual(result.connectingInstructions, "none");
		assert.strictEqual(result.connectedState.ready, true);
		assert.strictEqual(result.connectedClass, "connected");
		assert.match(result.connectedText, /Chat connected/);
		assert.match(result.connectedText, /Auto-join ON/);
		assert.notStrictEqual(result.connectedInstructions, "none");
		assert.match(result.rosterText, /AutoJoinUser/);
		assert.match(result.rosterText, /CommandJoinUs/);
		console.log("Chicken Royale connection and join Electron E2E passed.");
	} catch (error) {
		throw new Error(`${error.message}\n${output.slice(-8000)}`);
	} finally {
		await stopApp(child);
		if (profileDir.startsWith(profilePrefix) && fs.existsSync(profileDir)) {
			fs.rmSync(profileDir, { recursive: true, force: true });
		}
	}
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
