#!/usr/bin/env node

"use strict";

// Covers the Kasada-on-Kick, restricted-mock-on-Google preload.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { linuxLaunchArgs } = require("./helpers/electron-launch");

const APP_ROOT = path.resolve(__dirname, "..", "..");
const PROFILE_PREFIX = path.join(os.tmpdir(), "ssapp-adaptive-signin-preload-");
const PROFILE_ARGUMENT = "--adaptive-signin-preload-profile=";
const KICK_URL = "https://kick.com/sign-in-test";
const GOOGLE_URL = "https://accounts.google.com/sign-in-test";
const DIRECT_MOCK_URL = "https://mock-preload.test/sign-in-test";

async function waitForWindowLocation(win, expectedHostname, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const currentUrl = new URL(win.webContents.getURL());
			if (currentUrl.hostname === expectedHostname && !win.webContents.isLoading()) return;
		} catch (_) {}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for ${expectedHostname} sign-in fixture to load`);
}

async function runElectronChecks() {
	const { app, BrowserWindow, ipcMain, session } = require("electron");
	const profileArgument = process.argv.find((argument) => argument.startsWith(PROFILE_ARGUMENT));
	const profileDirectory = profileArgument ? profileArgument.slice(PROFILE_ARGUMENT.length) : "";
	assert.ok(profileDirectory, "isolated profile path is required");
	app.setPath("userData", profileDirectory);
	await app.whenReady();

	const partition = `persist:adaptive-signin-preload-${process.pid}`;
	const testSession = session.fromPartition(partition);
	const fixtureHtml = '<!doctype html><html><head><meta charset="utf-8"></head><body>Sign-in fixture</body></html>';
	await testSession.protocol.handle("https", (request) => {
		const hostname = new URL(request.url).hostname;
		if (
			hostname !== "kick.com" &&
			hostname !== "accounts.google.com" &&
			hostname !== "mock-preload.test"
		) {
			return new Response("Not found", { status: 404 });
		}
		return new Response(fixtureHtml, {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	});

	let genericPostMessageCount = 0;
	let googleRelayCount = 0;
	let googleRelayInstalled = false;
	const onGenericPostMessage = (_event, payload) => {
		if (payload && payload.__kickAdaptiveProbe === true) genericPostMessageCount += 1;
	};
	const onGoogleRelay = (_event, rawPayload) => {
		try {
			const payload = JSON.parse(rawPayload);
			if (payload?.data?.__kickAdaptiveRelayProbe === true) googleRelayCount += 1;
		} catch (_) {}
	};
	const onGoogleRelayState = (_event, rawPayload) => {
		try {
			const payload = JSON.parse(rawPayload);
			if (payload?.event === "installed") googleRelayInstalled = true;
		} catch (_) {}
	};
	ipcMain.on("postMessage", onGenericPostMessage);
	ipcMain.on("google-oauth-relay", onGoogleRelay);
	ipcMain.on("google-oauth-relay-state", onGoogleRelayState);

	const webPreferences = {
		nodeIntegration: false,
		contextIsolation: false,
		sandbox: false,
		webSecurity: true,
		session: testSession,
		preload: path.join(APP_ROOT, "preload-kick.js"),
	};
	const parentWindow = new BrowserWindow({ show: false, webPreferences });
	let popupWindow = null;
	let directMockWindow = null;

	try {
		await parentWindow.loadURL(KICK_URL);
		const kickState = await parentWindow.webContents.executeJavaScript(`({
			hostname: location.hostname,
			hasKasadaBridge: typeof window.navigateTo === 'function',
			hasGenericIpc: typeof window.__ipc !== 'undefined',
			hasOAuthBridge: typeof window.__ssapp !== 'undefined'
		})`);
		assert.deepStrictEqual(kickState, {
			hostname: "kick.com",
			hasKasadaBridge: true,
			hasGenericIpc: false,
			hasOAuthBridge: false,
		});

		parentWindow.webContents.setWindowOpenHandler(() => ({
			action: "allow",
			overrideBrowserWindowOptions: { show: false, webPreferences },
		}));
		const popupPromise = new Promise((resolve) => {
			parentWindow.webContents.once("did-create-window", resolve);
		});
		await parentWindow.webContents.executeJavaScript(`window.open(${JSON.stringify(GOOGLE_URL)}, '_blank'); true`);
		popupWindow = await popupPromise;
		await waitForWindowLocation(popupWindow, "accounts.google.com");

		const googlePopupState = await popupWindow.webContents.executeJavaScript(`({
			hostname: location.hostname,
			hasChromeMock: !!window.chrome,
			webdriverHidden: navigator.webdriver !== true,
			hasGenericIpc: typeof window.__ipc !== 'undefined',
			hasOAuthBridge: typeof window.__ssapp !== 'undefined',
			hasNodeProcess: typeof window.process !== 'undefined',
			hasNodeRequire: typeof window.require !== 'undefined'
		})`);
		assert.deepStrictEqual(googlePopupState, {
			hostname: "accounts.google.com",
			hasChromeMock: true,
			webdriverHidden: true,
			hasGenericIpc: false,
			hasOAuthBridge: false,
			hasNodeProcess: false,
			hasNodeRequire: false,
		});
		assert.strictEqual(googleRelayInstalled, true, "the dedicated Google relay should remain installed");

		await popupWindow.webContents.executeJavaScript(`
			window.postMessage({ cmd: 'restricted-probe', __kickAdaptiveProbe: true }, '*');
			window.opener.postMessage({ __kickAdaptiveRelayProbe: true }, '*');
			true;
		`);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.strictEqual(genericPostMessageCount, 0, "the Google page must not reach the generic postMessage IPC bridge");
		assert.strictEqual(googleRelayCount, 1, "the dedicated Google OAuth relay should continue to work");

		directMockWindow = new BrowserWindow({
			show: false,
			webPreferences: {
				...webPreferences,
				preload: path.join(APP_ROOT, "preload-mock.js"),
			},
		});
		await directMockWindow.loadURL(DIRECT_MOCK_URL);
		const directMockState = await directMockWindow.webContents.executeJavaScript(`({
			hasGenericIpc: typeof window.__ipc !== 'undefined',
			hasOAuthBridge: typeof window.__ssapp !== 'undefined'
		})`);
		assert.deepStrictEqual(directMockState, {
			hasGenericIpc: true,
			hasOAuthBridge: true,
		});
		await directMockWindow.webContents.executeJavaScript(`
			window.postMessage({ cmd: 'normal-probe', __kickAdaptiveProbe: true }, '*');
			true;
		`);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.strictEqual(
			genericPostMessageCount,
			1,
			"ordinary mock preload windows should retain their existing IPC bridge"
		);

		await parentWindow.loadURL(GOOGLE_URL);
		const redirectedGoogleState = await parentWindow.webContents.executeJavaScript(`({
			hostname: location.hostname,
			hasChromeMock: !!window.chrome,
			hasGenericIpc: typeof window.__ipc !== 'undefined',
			hasOAuthBridge: typeof window.__ssapp !== 'undefined'
		})`);
		assert.deepStrictEqual(redirectedGoogleState, {
			hostname: "accounts.google.com",
			hasChromeMock: true,
			hasGenericIpc: false,
			hasOAuthBridge: false,
		});

		console.log("Kick adaptive preload end-to-end checks passed.");
	} finally {
		ipcMain.removeListener("postMessage", onGenericPostMessage);
		ipcMain.removeListener("google-oauth-relay", onGoogleRelay);
		ipcMain.removeListener("google-oauth-relay-state", onGoogleRelayState);
		if (popupWindow && !popupWindow.isDestroyed()) popupWindow.destroy();
		if (directMockWindow && !directMockWindow.isDestroyed()) directMockWindow.destroy();
		if (!parentWindow.isDestroyed()) parentWindow.destroy();
		try {
			await testSession.protocol.unhandle("https");
		} catch (_) {}
	}
}

if (process.versions.electron) {
	const { app } = require("electron");
	runElectronChecks()
		.then(() => {
			app.exit(0);
		})
		.catch((error) => {
			console.error(error && error.stack ? error.stack : error);
			app.exit(1);
		});
} else {
	const electronPath = require("electron");
	const environment = { ...process.env };
	const profileDirectory = fs.mkdtempSync(PROFILE_PREFIX);
	delete environment.ELECTRON_RUN_AS_NODE;
	const child = spawn(electronPath, [__filename, `${PROFILE_ARGUMENT}${profileDirectory}`, ...linuxLaunchArgs()], {
		cwd: APP_ROOT,
		env: environment,
		stdio: "inherit",
		windowsHide: true,
	});
	const timeout = setTimeout(() => child.kill(), 30000);
	child.once("exit", (code) => {
		clearTimeout(timeout);
		try {
			fs.rmSync(profileDirectory, { recursive: true, force: true });
		} catch (_) {}
		process.exitCode = code || 0;
	});
}
