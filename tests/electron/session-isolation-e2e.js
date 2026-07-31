#!/usr/bin/env node

"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const electronPath = require("electron");
const repoRoot = path.resolve(__dirname, "..", "..");
const socialStreamRoot = path.resolve(repoRoot, "..", "social_stream");
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssapp-session-isolation-"));
const token = `session-isolation-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
			path: `${pathname}${pathname.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`,
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

function launchApp(port) {
	const child = spawn(electronPath, [
		".",
		"--multiinstance",
		"--preferlocalassets",
		`--filesource=${socialStreamRoot}`,
		"--remote-control",
	], {
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
	});
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk.toString(); });
	child.stderr.on("data", (chunk) => { output += chunk.toString(); });
	return { child, getOutput: () => output };
}

async function stopApp(instance) {
	if (!instance || instance.child.exitCode !== null) return;
	instance.child.kill();
	await Promise.race([
		new Promise((resolve) => instance.child.once("exit", resolve)),
		new Promise((resolve) => setTimeout(resolve, 5000)),
	]);
}

async function stopActiveApp(port, instance) {
	let browserPid = null;
	try {
		browserPid = await execInMain(port, "process.ppid");
	} catch (_) { }
	try {
		await requestJson(port, "/api/v1/command", { action: "shutdownApp", value: { confirm: true } });
	} catch (_) { }
	await new Promise((resolve) => setTimeout(resolve, 1000));
	if (Number.isInteger(browserPid) && browserPid > 0) {
		try {
			process.kill(browserPid);
		} catch (_) { }
	}
	await stopApp(instance);
}

async function waitForStatus(port, expectedSession, timeoutMs = 60000) {
	const started = Date.now();
	let lastError = null;
	while (Date.now() - started < timeoutMs) {
		try {
			const status = await requestJson(port, "/api/v1/status");
			if (status?.app?.mainWindowReady && status.app.session === expectedSession) return status;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out waiting for session ${expectedSession}: ${lastError?.message || "no status"}`);
}

async function getMainWindow(port) {
	const started = Date.now();
	while (Date.now() - started < 30000) {
		const response = await requestJson(port, "/windows");
		const mainWindow = (response.windows || []).find((item) => String(item.url || "").includes("index.html"));
		if (mainWindow) return mainWindow;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Main window was not found.");
}

async function execInMain(port, code) {
	const mainWindow = await getMainWindow(port);
	const response = await requestJson(port, "/exec", { windowId: mainWindow.id, code });
	if (!response.ok) throw new Error(response.error || "Main-window execution failed.");
	return response.result;
}

async function setSessionMarker(port, marker) {
	return execInMain(port, `(() => {
		const { ipcRenderer } = require("electron");
		const current = ipcRenderer.sendSync("storageGet", ["settings"]) || {};
		const settings = Object.assign({}, current.settings || {}, { sessionIsolationProbe: ${JSON.stringify(marker)} });
		ipcRenderer.sendSync("storageSave", { settings });
		localStorage.setItem("sessionPartitionProbe", ${JSON.stringify(marker)});
		return true;
	})()`);
}

async function readSessionMarkers(port) {
	return execInMain(port, `(() => {
		const { ipcRenderer } = require("electron");
		const cached = ipcRenderer.sendSync("storageGet", ["settings"]) || {};
		let localSettings = null;
		let sourceState = null;
		try { localSettings = JSON.parse(localStorage.getItem("settings") || "null"); } catch (_) {}
		try { sourceState = JSON.parse(localStorage.getItem("socialStreamState") || "null"); } catch (_) {}
		return {
			cached: cached.settings && cached.settings.sessionIsolationProbe || null,
			localSettings: localSettings && localSettings.sessionIsolationProbe || null,
			partitionOnly: localStorage.getItem("sessionPartitionProbe"),
			sourceBackup: sourceState && sourceState.sessionIsolationProbe || null
		};
	})()`);
}

async function selectSessionForNextLaunch(port, sessionId) {
	const result = await execInMain(
		port,
		`(() => {
			require("electron").ipcRenderer.invoke("switchSession", ${JSON.stringify(sessionId)});
			return true;
		})()`
	);
	assert.strictEqual(result, true);
	await waitForStatus(port, sessionId, 90000);
}

async function removeProfile() {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			fs.rmSync(profileDir, { recursive: true, force: true });
			return;
		} catch (_) {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
}

async function run() {
	const port = await getFreePort();
	let instance = launchApp(port);
	const defaultMarker = `default-${Date.now()}`;
	const secondaryMarker = `secondary-${Date.now()}`;

	try {
		await waitForStatus(port, "default");
		await setSessionMarker(port, defaultMarker);
		const defaultBackup = await execInMain(port, `(() => {
			const { ipcRenderer } = require("electron");
			const cached = ipcRenderer.sendSync("storageGet", ["settings"]) || {};
			return Promise.all([
				ipcRenderer.invoke("store-set", "localStorageBackup", {
					settings: JSON.stringify(cached.settings || {}),
					socialStreamState: JSON.stringify({ sessionIsolationProbe: ${JSON.stringify(defaultMarker)} })
				}),
				ipcRenderer.invoke("store-set", "localStorageBackupTime", Date.now())
			]);
		})()`);
		assert.ok(defaultBackup.every((result) => result?.success), JSON.stringify(defaultBackup));
		const created = await execInMain(port, `require("electron").ipcRenderer.invoke("createSession", {
			id: "probe-secondary",
			name: "Probe Secondary",
			description: "Session isolation diagnostic"
		})`);
		assert.strictEqual(created?.success, true, JSON.stringify(created));
		await new Promise((resolve) => setTimeout(resolve, 500));
		await selectSessionForNextLaunch(port, "probe-secondary");
		const secondaryInitial = await readSessionMarkers(port);
		assert.strictEqual(secondaryInitial.cached, null, JSON.stringify(secondaryInitial));
		assert.strictEqual(secondaryInitial.localSettings, null, JSON.stringify(secondaryInitial));
		assert.strictEqual(secondaryInitial.partitionOnly, null, JSON.stringify(secondaryInitial));
		assert.strictEqual(secondaryInitial.sourceBackup, null, JSON.stringify(secondaryInitial));

		await setSessionMarker(port, secondaryMarker);
		await new Promise((resolve) => setTimeout(resolve, 500));
		await selectSessionForNextLaunch(port, "default");
		const defaultRestored = await readSessionMarkers(port);
		assert.strictEqual(defaultRestored.cached, defaultMarker, JSON.stringify(defaultRestored));
		assert.strictEqual(defaultRestored.localSettings, defaultMarker, JSON.stringify(defaultRestored));

		console.log("SSApp User Session isolation Electron end-to-end checks passed.");
	} catch (error) {
		throw new Error(`${error.stack || error.message}\n${instance.getOutput().slice(-8000)}`);
	} finally {
		await stopActiveApp(port, instance);
		await new Promise((resolve) => setTimeout(resolve, 500));
		await removeProfile();
	}
}

run().catch((error) => {
	console.error(error);
	process.exit(1);
});
