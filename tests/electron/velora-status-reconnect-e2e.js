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
const socialStreamRoot = pathToFileURL(path.resolve(repoRoot, "..", "social_stream") + path.sep).href;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssapp-velora-status-profile-"));
const remoteToken = `velora-status-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
		const payload = body ? JSON.stringify(body) : null;
		const request = http.request({
			host: "127.0.0.1",
			port,
			path: `${pathname}${pathname.includes("?") ? "&" : "?"}token=${encodeURIComponent(remoteToken)}`,
			method: payload ? "POST" : "GET",
			headers: payload ? {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(payload),
			} : {},
		}, (response) => {
			let text = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => {
				text += chunk;
			});
			response.on("end", () => {
				try {
					const parsed = text ? JSON.parse(text) : {};
					if (response.statusCode >= 200 && response.statusCode < 300) {
						resolve(parsed);
						return;
					}
					reject(new Error(`HTTP ${response.statusCode}: ${text}`));
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

async function waitForRemoteControl(port, timeoutMs = 60000) {
	const started = Date.now();
	let lastError = null;
	while (Date.now() - started < timeoutMs) {
		try {
			const response = await requestJson(port, "/ping");
			if (response && response.ok) return;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out waiting for SSApp remote control${lastError ? `: ${lastError.message}` : "."}`);
}

async function waitForMainWindow(port, timeoutMs = 30000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const response = await requestJson(port, "/windows");
		const mainWindow = (response.windows || []).find((item) => String(item.url || "").includes("index.html"));
		if (mainWindow && mainWindow.id) return mainWindow;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("Timed out waiting for the SSApp main window.");
}

async function execInWindow(port, windowId, code) {
	const response = await requestJson(port, "/exec", { windowId, code });
	if (!response || response.ok !== true) {
		throw new Error(response && response.error ? response.error : "Renderer execution failed.");
	}
	return response.result;
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
	const remotePort = await getFreePort();
	const child = spawn(electronPath, [
		".",
		"--running-from-source",
		"--multiinstance",
		"--filesource",
		socialStreamRoot,
		"--remote-control",
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: userDataDir,
			SSAPP_REMOTE_CONTROL: "1",
			SSAPP_REMOTE_CONTROL_PORT: String(remotePort),
			SSAPP_REMOTE_CONTROL_TOKEN: remoteToken,
			SSAPP_DIAGNOSTICS_SAFE_GPU: "1",
			SSAPP_DEBUG_LOGS: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		output += chunk.toString();
	});

	try {
		await waitForRemoteControl(remotePort);
		const mainWindow = await waitForMainWindow(remotePort);
		const result = await execInWindow(remotePort, mainWindow.id, `
			(async () => {
				const started = Date.now();
				while (!window.stateManager || !window.ninjafy?.sendMessage || typeof updateConnectionStatus !== 'function') {
					if (Date.now() - started > 30000) return { ready: false };
					await new Promise((resolve) => setTimeout(resolve, 100));
				}

				const sourceId = 'velora-status-reconnect-e2e';
				const existing = window.stateManager.getSource(sourceId);
				if (!existing) {
					window.stateManager.addSource({
						id: sourceId,
						target: 'velora',
						username: 'status-reconnect-e2e',
						connectionMode: 'websocket',
						supportsWSS: true,
					});
				}
				window.stateManager.updateSource(sourceId, {
					vid: 424242,
					wssId: 424242,
					status: 'activating',
					activeConnectionMode: 'websocket',
				});
				await new Promise((resolve) => setTimeout(resolve, 100));

				const readStatus = () => {
					const entry = document.querySelector('[data-source-id="' + sourceId + '"]');
					const status = entry?.querySelector('.ws-status');
					const source = window.stateManager.getSource(sourceId);
					return {
						found: Boolean(entry && status),
						display: status?.style.display || '',
						className: status?.className || '',
						text: status?.textContent || '',
						sourceStatus: source?.status || null,
					};
				};
				const sendStatus = (status, message) => window.ninjafy.sendMessage(null, {
					wssStatus: { sourceId, platform: 'velora', status, message }
				}, null, 424242);

				sendStatus('disconnected', 'Velora Events disconnected.');
				await new Promise((resolve) => setTimeout(resolve, 100));
				const disconnected = readStatus();
				sendStatus('connected', 'Velora WebSocket connected.');
				await new Promise((resolve) => setTimeout(resolve, 100));
				const connected = readStatus();
				await new Promise((resolve) => setTimeout(resolve, 2300));
				const afterOldTimer = readStatus();
				return { ready: true, disconnected, connected, afterOldTimer };
			})()
		`);

		assert.strictEqual(result.ready, true, JSON.stringify(result));
		assert.strictEqual(result.disconnected.found, true, JSON.stringify(result));
		assert.match(result.disconnected.className, /\bstopped\b/, JSON.stringify(result));
		assert.match(result.connected.className, /\bconnected\b/, JSON.stringify(result));
		assert.strictEqual(result.connected.display, "inline-flex", JSON.stringify(result));
		assert.match(result.afterOldTimer.className, /\bconnected\b/, JSON.stringify(result));
		assert.strictEqual(result.afterOldTimer.display, "inline-flex", JSON.stringify(result));
		assert.strictEqual(result.afterOldTimer.sourceStatus, "active", JSON.stringify(result));
		const holdMs = Number.parseInt(process.env.SSAPP_E2E_HOLD_MS || "0", 10);
		if (Number.isFinite(holdMs) && holdMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, holdMs));
		}
		console.log("velora-status-reconnect-e2e: connected status survives the stale disconnect timeout");
	} catch (error) {
		throw new Error(`${error.message}\n${output.slice(-5000)}`);
	} finally {
		await stopApp(child);
	}
}

run().catch((error) => {
	console.error(error && error.stack ? error.stack : error);
	process.exitCode = 1;
});
