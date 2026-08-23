#!/usr/bin/env node

"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const { linuxLaunchArgs } = require("./helpers/electron-launch");

const electronPath = require("electron");
const APP_ROOT = path.resolve(__dirname, "..", "..");
const SOCIAL_STREAM_ROOT = path.resolve(APP_ROOT, "..", "social_stream");
const PROFILE_PREFIX = path.join(os.tmpdir(), "ssapp-twitch-signin-compat-");

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getFreePort() {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => resolve(address.port));
		});
		server.on("error", reject);
	});
}

async function waitFor(check, label, timeoutMilliseconds = 60000) {
	const deadline = Date.now() + timeoutMilliseconds;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			const result = await check();
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		await delay(100);
	}
	throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function startFixtureServer() {
	const port = await getFreePort();
	let probeHeaders = null;
	const server = http.createServer((request, response) => {
		const requestUrl = new URL(request.url, `http://127.0.0.1:${port}`);
		if (requestUrl.pathname === "/probe") probeHeaders = { ...request.headers };

		response.writeHead(200, {
			"Accept-CH": "Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version",
			"Cache-Control": "no-store",
			"Content-Type": "text/html; charset=utf-8",
		});
		response.end("<!doctype html><html><body>Twitch sign-in compatibility fixture</body></html>");
	});
	await new Promise((resolve, reject) => {
		server.listen(port, "127.0.0.1", resolve);
		server.on("error", reject);
	});
	return {
		port,
		getProbeHeaders: () => probeHeaders,
		close: async () => await new Promise((resolve) => server.close(resolve)),
	};
}

async function requestRemoteControl(port, token, pathname, body) {
	const separator = pathname.includes("?") ? "&" : "?";
	const response = await fetch(
		`http://127.0.0.1:${port}${pathname}${separator}token=${encodeURIComponent(token)}`,
		body
			? {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}
			: undefined
	);
	const payload = await response.json();
	if (!response.ok || payload.ok !== true) throw new Error(payload.error || `HTTP ${response.status}`);
	return payload;
}

async function run() {
	const fixture = await startFixtureServer();
	const remoteControlPort = await getFreePort();
	const profileDirectory = fs.mkdtempSync(PROFILE_PREFIX);
	const remoteControlToken = `twitch-signin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const sourceUrl = pathToFileURL(`${SOCIAL_STREAM_ROOT}${path.sep}`).href;
	const fixtureBaseUrl = `http://127.0.0.1:${fixture.port}`;
	const twitchFixtureUrl = `${fixtureBaseUrl}/sources/websocket/twitch.html`;
	const child = spawn(
		electronPath,
		[
			".",
			"--running-from-source",
			"--multiinstance",
			"--filesource",
			sourceUrl,
			"--remote-control",
			...linuxLaunchArgs(),
		],
		{
			cwd: APP_ROOT,
			env: {
				...process.env,
				SSAPP_USER_DATA_DIR: profileDirectory,
				SSAPP_REMOTE_CONTROL: "1",
				SSAPP_REMOTE_CONTROL_PORT: String(remoteControlPort),
				SSAPP_REMOTE_CONTROL_TOKEN: remoteControlToken,
				SSAPP_DIAGNOSTICS_SAFE_GPU: "1",
				SSAPP_DEBUG_LOGS: "0",
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		}
	);

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout = `${stdout}${chunk}`.slice(-30000);
	});
	child.stderr.on("data", (chunk) => {
		stderr = `${stderr}${chunk}`.slice(-30000);
	});
	const request = (pathname, body) =>
		requestRemoteControl(remoteControlPort, remoteControlToken, pathname, body);
	const executeInWindow = async (windowId, code) => (await request("/exec", { windowId, code })).result;
	const executeInView = async (key, code) => (await request("/view-exec", { key, code })).result;

	try {
		await waitFor(async () => {
			try {
				return (await request("/ping")).ok;
			} catch (_) {
				return false;
			}
		}, "SSApp startup");

		const mainWindow = await waitFor(async () => {
			const windows = (await request("/windows")).windows || [];
			return windows.find((windowInfo) => String(windowInfo.url || "").includes("index.html")) || false;
		}, "SSApp main window");

		await waitFor(
			async () =>
				await executeInWindow(
					mainWindow.id,
					"Boolean(window.config && config.twitch?.signin?.preload === 'mock')"
				),
			"Twitch sign-in configuration"
		);

		const signInViewKey = await executeInWindow(
			mainWindow.id,
			`(async () => {
				let conf = config.global ? { ...config.global } : {};
				if (config.global?.signin) conf = { ...conf, ...config.global.signin };
				if (config.twitch) conf = { ...conf, ...config.twitch };
				if (config.twitch?.signin) conf = { ...conf, ...config.twitch.signin };
				return await require('electron').ipcRenderer.invoke('signIn', {
					url: ${JSON.stringify(twitchFixtureUrl)},
					platform: 'twitch',
					wss: true,
					muted: true,
					visible: true,
					source: false,
					userInitiated: true,
					customSession: 'twitch-signin-compat-e2e',
					config: conf,
					configs: config
				});
			})()`
		);
		assert.ok(signInViewKey, "SSApp should return the Twitch sign-in view key");

		await waitFor(async () => {
			const views = (await request("/views")).views || [];
			const signInView = views.find(
				(candidate) => String(candidate.key) === String(signInViewKey)
			);
			return signInView && signInView.url === twitchFixtureUrl ? signInView : false;
		}, "Twitch sign-in fixture");

		const parentState = await executeInView(
			signInViewKey,
			`(() => {
				let dynamicCodeResult = null;
				try { dynamicCodeResult = Function('return 42')(); }
				catch (error) { dynamicCodeResult = error.name + ': ' + error.message; }
				return {
					hasMockBridge: typeof window.__ipc !== 'undefined',
					hasNodeProcess: typeof window.process !== 'undefined',
					dynamicCodeResult
				};
			})()`
		);
		assert.strictEqual(parentState.hasMockBridge, true, "Twitch should retain its original mock preload");
		assert.strictEqual(parentState.hasNodeProcess, false);
		assert.strictEqual(parentState.dynamicCodeResult, 42, "Twitch dynamic integrity code must be allowed");

		await executeInView(
			signInViewKey,
			`window.open(${JSON.stringify(`${fixtureBaseUrl}/popup`)}, '_blank'); true`
		);
		const popupWindow = await waitFor(async () => {
			const windows = (await request("/windows")).windows || [];
			return windows.find((windowInfo) => windowInfo.url === `${fixtureBaseUrl}/popup`) || false;
		}, "Twitch OAuth child window");

		const popupState = await executeInWindow(
			popupWindow.id,
			`(async () => {
				const response = await fetch(${JSON.stringify(`${fixtureBaseUrl}/probe?nonce=${Date.now()}`)}, {
					cache: 'no-store'
				});
				return {
					acceptCH: response.headers.get('accept-ch'),
					hasNodeProcess: typeof window.process !== 'undefined',
					hasNodeRequire: typeof window.require !== 'undefined'
				};
			})()`
		);
		assert.strictEqual(
			popupState.acceptCH,
			"Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version",
			"OAuth popups must retain their own Accept-CH negotiation"
		);
		assert.strictEqual(popupState.hasNodeProcess, false);
		assert.strictEqual(popupState.hasNodeRequire, false);

		const probeHeaders = fixture.getProbeHeaders();
		assert.ok(probeHeaders, "the popup should request the client-hint probe");

		console.log("Twitch sign-in compatibility end-to-end checks passed.");
	} catch (error) {
		console.error(error && error.stack ? error.stack : error);
		console.error("Recent SSApp stdout:\n", stdout);
		console.error("Recent SSApp stderr:\n", stderr);
		process.exitCode = 1;
	} finally {
		child.kill();
		await new Promise((resolve) => {
			if (child.exitCode !== null) return resolve();
			child.once("exit", resolve);
			setTimeout(resolve, 5000);
		});
		await fixture.close();
		try {
			fs.rmSync(profileDirectory, { recursive: true, force: true });
		} catch (_) {}
	}
}

run();
