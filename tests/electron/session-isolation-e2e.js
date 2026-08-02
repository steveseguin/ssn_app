#!/usr/bin/env node

"use strict";

const assert = require("assert");
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const crypto = require("crypto");
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
		...linuxLaunchArgs(),
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

async function waitForSessionMarkers(port, expected, timeoutMs = 30000) {
	const started = Date.now();
	let markers = null;
	while (Date.now() - started < timeoutMs) {
		markers = await readSessionMarkers(port);
		if (Object.entries(expected).every(([key, value]) => markers[key] === value)) return markers;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for session markers: ${JSON.stringify({ expected, markers })}`);
}

async function readImportedSessionState(port, sourceId) {
	return execInMain(port, `(() => {
		let storedState = null;
		try { storedState = JSON.parse(localStorage.getItem("socialStreamState") || "null"); } catch (_) {}
		const source = typeof stateManager !== "undefined" ? stateManager.getSource(${JSON.stringify(sourceId)}) : null;
		return {
			localMarker: localStorage.getItem("sessionImportProbe"),
			storedMarker: storedState && storedState.global && storedState.global.sessionImportProbe || null,
			stateMarker: typeof stateManager !== "undefined" && stateManager.state.global.sessionImportProbe || null,
			sourceUsername: source && source.username || null
		};
	})()`);
}

async function createIndexedDbMarker(port, databaseName) {
	return execInMain(port, `new Promise((resolve, reject) => {
		const request = indexedDB.open(${JSON.stringify(databaseName)}, 1);
		request.onupgradeneeded = () => request.result.createObjectStore("marker");
		request.onsuccess = () => {
			request.result.close();
			resolve(true);
		};
		request.onerror = () => reject(request.error || new Error("IndexedDB marker failed"));
	})`);
}

async function hasIndexedDbMarker(port, databaseName) {
	return execInMain(port, `indexedDB.databases().then((databases) => {
		return databases.some((database) => database.name === ${JSON.stringify(databaseName)});
	})`);
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
	const importedMarker = `imported-${Date.now()}`;
	const importedSourceId = "imported-session-source";
	const secondarySessionId = "probe-secondary";
	const overlappingInactiveSessionId = `${secondarySessionId}-inactive`;
	const indexedDbMarker = `deleted-session-${Date.now()}`;
	const secondaryScope = `session-${crypto.createHash("sha256").update(secondarySessionId).digest("hex").slice(0, 24)}`;
	const secondarySavedSyncPath = path.join(profileDir, `savedSync.${secondaryScope}.json`);

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
			id: ${JSON.stringify(secondarySessionId)},
			name: "Probe Secondary",
			description: "Session isolation diagnostic"
		})`);
		assert.strictEqual(created?.success, true, JSON.stringify(created));
		await new Promise((resolve) => setTimeout(resolve, 500));
		await selectSessionForNextLaunch(port, secondarySessionId);
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

		const importedState = {
			sources: [[importedSourceId, {
				id: importedSourceId,
				target: "twitch",
				username: "imported-channel",
				status: "inactive",
				connectionMode: "classic",
				isAutoDiscovered: false,
				isVisible: true,
				isMuted: false,
				autoActivate: false
			}]],
			groups: [],
			global: { sessionImportProbe: importedMarker }
		};
		const stagedImport = await execInMain(port, `require("electron").ipcRenderer.invoke(
			"stageUserSessionImport",
			${JSON.stringify(secondarySessionId)},
			{
				sessionImportProbe: ${JSON.stringify(importedMarker)},
				settings: ${JSON.stringify(JSON.stringify({ sessionIsolationProbe: importedMarker }))},
				socialStreamState: ${JSON.stringify(JSON.stringify(importedState))}
			}
		)`);
		assert.strictEqual(stagedImport?.success, true, JSON.stringify(stagedImport));

		const defaultBeforeImport = await readImportedSessionState(port, importedSourceId);
		assert.strictEqual(defaultBeforeImport.localMarker, null, JSON.stringify(defaultBeforeImport));
		assert.strictEqual(defaultBeforeImport.sourceUsername, null, JSON.stringify(defaultBeforeImport));

		await selectSessionForNextLaunch(port, secondarySessionId);
		const secondaryRestored = await readSessionMarkers(port);
		assert.strictEqual(secondaryRestored.cached, importedMarker, JSON.stringify(secondaryRestored));
		assert.strictEqual(secondaryRestored.localSettings, importedMarker, JSON.stringify(secondaryRestored));
		assert.strictEqual(secondaryRestored.partitionOnly, secondaryMarker, JSON.stringify(secondaryRestored));

		const importedSession = await readImportedSessionState(port, importedSourceId);
		assert.strictEqual(importedSession.localMarker, importedMarker, JSON.stringify(importedSession));
		assert.strictEqual(importedSession.storedMarker, importedMarker, JSON.stringify(importedSession));
		assert.strictEqual(importedSession.stateMarker, importedMarker, JSON.stringify(importedSession));
		assert.strictEqual(importedSession.sourceUsername, "imported-channel", JSON.stringify(importedSession));
		const consumedImport = await execInMain(port, `require("electron").ipcRenderer.invoke("getPendingUserSessionImport")`);
		assert.strictEqual(consumedImport?.pendingImport, null, JSON.stringify(consumedImport));
		assert.strictEqual(await createIndexedDbMarker(port, indexedDbMarker), true);
		assert.strictEqual(await hasIndexedDbMarker(port, indexedDbMarker), true);

		assert.strictEqual(fs.existsSync(secondarySavedSyncPath), true, secondarySavedSyncPath);
		await execInMain(port, `(() => {
			require("electron").ipcRenderer.invoke("deleteSession", ${JSON.stringify(secondarySessionId)});
			return true;
		})()`);
		await waitForStatus(port, "default", 90000);

		const sessionsAfterDelete = await execInMain(port, `require("electron").ipcRenderer.invoke("getSessions")`);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(sessionsAfterDelete.sessions || {}, secondarySessionId), false);
		const defaultAfterDelete = await waitForSessionMarkers(port, {
			cached: defaultMarker,
			localSettings: defaultMarker
		});
		assert.strictEqual(defaultAfterDelete.cached, defaultMarker, JSON.stringify(defaultAfterDelete));
		assert.strictEqual(defaultAfterDelete.localSettings, defaultMarker, JSON.stringify(defaultAfterDelete));
		assert.strictEqual(fs.existsSync(secondarySavedSyncPath), false, secondarySavedSyncPath);
		assert.strictEqual(fs.existsSync(`${secondarySavedSyncPath}.tmp`), false, `${secondarySavedSyncPath}.tmp`);
		assert.strictEqual(fs.existsSync(`${secondarySavedSyncPath}.bak`), false, `${secondarySavedSyncPath}.bak`);
		const storeData = JSON.parse(fs.readFileSync(path.join(profileDir, "config.json"), "utf8"));
		const deletedScope = storeData.userSessionData?.[secondaryScope] || {};
		assert.deepStrictEqual(Object.keys(deletedScope), [], JSON.stringify(deletedScope));
		assert.strictEqual(storeData.pendingUserSessionPartitionCleanup, undefined, JSON.stringify(storeData.pendingUserSessionPartitionCleanup));

		const recreated = await execInMain(port, `require("electron").ipcRenderer.invoke("createSession", {
			id: ${JSON.stringify(secondarySessionId)},
			name: "Recreated Probe Secondary",
			description: "Deleted partition cleanup diagnostic"
		})`);
		assert.strictEqual(recreated?.success, true, JSON.stringify(recreated));
		await selectSessionForNextLaunch(port, secondarySessionId);

		const recreatedMarkers = await readSessionMarkers(port);
		assert.strictEqual(recreatedMarkers.cached, null, JSON.stringify(recreatedMarkers));
		assert.strictEqual(recreatedMarkers.localSettings, null, JSON.stringify(recreatedMarkers));
		assert.strictEqual(recreatedMarkers.partitionOnly, null, JSON.stringify(recreatedMarkers));
		assert.strictEqual(recreatedMarkers.sourceBackup, null, JSON.stringify(recreatedMarkers));
		const recreatedImportState = await readImportedSessionState(port, importedSourceId);
		assert.strictEqual(recreatedImportState.localMarker, null, JSON.stringify(recreatedImportState));
		assert.strictEqual(recreatedImportState.sourceUsername, null, JSON.stringify(recreatedImportState));
		assert.strictEqual(await hasIndexedDbMarker(port, indexedDbMarker), false);

		const recreatedMarker = `recreated-${Date.now()}`;
		await setSessionMarker(port, recreatedMarker);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const overlappingInactive = await execInMain(port, `require("electron").ipcRenderer.invoke("createSession", {
			id: ${JSON.stringify(overlappingInactiveSessionId)},
			name: "Overlapping Inactive Probe",
			description: "Exact partition cleanup diagnostic"
		})`);
		assert.strictEqual(overlappingInactive?.success, true, JSON.stringify(overlappingInactive));
		const inactiveDelete = await execInMain(
			port,
			`require("electron").ipcRenderer.invoke("deleteSession", ${JSON.stringify(overlappingInactiveSessionId)})`
		);
		assert.strictEqual(inactiveDelete?.success, true, JSON.stringify(inactiveDelete));
		assert.strictEqual(inactiveDelete?.partitionCleanupPending, false, JSON.stringify(inactiveDelete));
		const activeAfterOverlappingDelete = await readSessionMarkers(port);
		assert.strictEqual(activeAfterOverlappingDelete.cached, recreatedMarker, JSON.stringify(activeAfterOverlappingDelete));
		assert.strictEqual(activeAfterOverlappingDelete.localSettings, recreatedMarker, JSON.stringify(activeAfterOverlappingDelete));
		assert.strictEqual(activeAfterOverlappingDelete.partitionOnly, recreatedMarker, JSON.stringify(activeAfterOverlappingDelete));

		console.log("SSApp User Session isolation, import, deletion, and partition cleanup Electron end-to-end checks passed.");
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
