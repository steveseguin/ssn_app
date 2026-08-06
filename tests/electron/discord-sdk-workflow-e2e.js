"use strict";

const assert = require("assert");
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawn } = require("child_process");

const electronPath = require("electron");
const repoRoot = path.resolve(__dirname, "..", "..");
const socialStreamRoot = pathToFileURL(path.resolve(repoRoot, "..", "social_stream") + path.sep).href;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssapp-discord-sdk-profile-"));
const token = `discord-sdk-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = address && typeof address === "object" ? address.port : 0;
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

function requestJson(port, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : null;
		const request = http.request({
			host: "127.0.0.1",
			port,
			path: `${pathname}${pathname.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`,
			method: payload ? "POST" : "GET",
			headers: payload ? {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(payload)
			} : {}
		}, response => {
			let text = "";
			response.setEncoding("utf8");
			response.on("data", chunk => { text += chunk; });
			response.on("end", () => {
				try {
					const json = text ? JSON.parse(text) : {};
					if (response.statusCode >= 200 && response.statusCode < 300) resolve(json);
					else reject(new Error(`HTTP ${response.statusCode}: ${text}`));
				} catch (error) {
					reject(error);
				}
			});
		});
		request.on("error", reject);
		if (payload) request.write(payload);
		request.end();
	});
}

async function waitForMainWindow(port, timeoutMs = 60000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const ping = await requestJson(port, "/ping");
			if (ping && ping.ok) {
				const windows = await requestJson(port, "/windows");
				const mainWindow = (windows.windows || []).find(win => String(win.url || "").includes("index.html"));
				if (mainWindow && mainWindow.id) return mainWindow;
			}
		} catch (_) {}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error("Timed out waiting for the SSApp main window");
}

const rendererWorkflow = `
(async () => {
	const discordUrl = "https://discord.com/channels/123/456";
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const ready = Array.isArray(manifest?.content_scripts) && manifest.content_scripts.some(entry =>
			Array.isArray(entry.js) && entry.js.includes("./sources/capturevideo.js")
		);
		if (ready) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}

	const normalize = value => String(value || "").replace(/\\\\/g, "/").replace(/^\\.?\\//, "");
	const freshFiles = checkSupported(discordUrl).map(normalize);
	const createWindowCalls = [];
	const originalSendSync = ipcRenderer.sendSync.bind(ipcRenderer);
	ipcRenderer.sendSync = function (channel, args) {
		if (channel === "createWindow") {
			createWindowCalls.push(args);
			return 7000 + createWindowCalls.length;
		}
		return originalSendSync(channel, args);
	};

	const makeSource = (id, sourceFiles) => ({
		id,
		target: "discord",
		url: discordUrl,
		username: "Discord E2E",
		videoId: "",
		connectionMode: "classic",
		isVisible: false,
		isMuted: true,
		sourceFile: "sources/discord.js",
		sourceFiles
	});

	try {
		await createClassicWindowFromSource(makeSource("discord-legacy-capture", [
			"sources/discord.js",
			"sources/capturevideo.js"
		]));
		await createClassicWindowFromSource(makeSource("discord-legacy-sdk", [
			"sources/discord.js",
			"thirdparty/vdoninja-sdk.js"
		]));
	} finally {
		ipcRenderer.sendSync = originalSendSync;
	}

	return {
		freshFiles,
		launchFiles: createWindowCalls.map(call => call.sourceFiles)
	};
})()
`;

async function run() {
	const port = await getFreePort();
	const child = spawn(electronPath, [
		".",
		"--running-from-source",
		"--filesource",
		socialStreamRoot,
		"--remote-control",
		...linuxLaunchArgs(),
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: userDataDir,
			SSAPP_REMOTE_CONTROL: "1",
			SSAPP_REMOTE_CONTROL_PORT: String(port),
			SSAPP_REMOTE_CONTROL_TOKEN: token,
			SSAPP_DIAGNOSTICS_SAFE_GPU: "1",
			SSAPP_DEBUG_LOGS: "0"
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true
	});

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", chunk => { stdout += chunk; });
	child.stderr.on("data", chunk => { stderr += chunk; });
	const timer = setTimeout(() => child.kill(), 90000);

	try {
		const mainWindow = await waitForMainWindow(port);
		const response = await requestJson(port, "/exec", { windowId: mainWindow.id, code: rendererWorkflow });
		assert(response && response.ok === true, response && response.error ? response.error : "Renderer workflow failed");
		const expected = ["sources/discord.js", "thirdparty/vdoninja-sdk.js", "sources/capturevideo.js"];
		assert.deepStrictEqual(response.result.freshFiles, expected);
		assert.deepStrictEqual(response.result.launchFiles, [expected, expected]);
		console.log("discord-sdk-workflow-e2e: PASS");
	} catch (error) {
		if (stdout.trim()) console.error("Electron stdout:\n" + stdout.trim());
		if (stderr.trim()) console.error("Electron stderr:\n" + stderr.trim());
		throw error;
	} finally {
		clearTimeout(timer);
		try { child.kill(); } catch (_) {}
		await new Promise(resolve => setTimeout(resolve, 1000));
		try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
	}
}

run().catch(error => {
	console.error(error && error.stack ? error.stack : error);
	process.exitCode = 1;
});
