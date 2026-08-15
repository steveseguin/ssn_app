#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright-core");
const { linuxLaunchArgs } = require("./helpers/electron-launch");

const APP_ROOT = path.resolve(__dirname, "..", "..");
const SOURCE_ROOT = path.resolve(process.env.SOCIAL_STREAM_SOURCE_DIR || path.join(APP_ROOT, "..", "social_stream"));
const ELECTRON_PATH = require("electron");
const PROFILE_PREFIX = path.join(os.tmpdir(), "ssapp-eventflow-webhook-e2e-");

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

function startWebhookReceiver() {
	const requests = [];
	const server = http.createServer((request, response) => {
		response.setHeader("Access-Control-Allow-Origin", "*");
		response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
		response.setHeader("Access-Control-Allow-Headers", "Content-Type");
		response.setHeader("Access-Control-Allow-Private-Network", "true");

		if (request.method === "OPTIONS") {
			response.statusCode = 204;
			response.end();
			return;
		}

		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			requests.push({
				method: request.method,
				url: request.url,
				headers: request.headers,
				body,
			});
			response.statusCode = 204;
			response.end();
		});
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve({
				server,
				port: typeof address === "object" && address ? address.port : 0,
				requests,
			});
		});
	});
}

function waitForExit(child, timeoutMs = 10000) {
	if (!child || child.exitCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function stopApp(child) {
	if (!child || child.exitCode !== null) return;
	child.kill();
	await waitForExit(child);
}

function launchApp(profileDirectory, port) {
	const sourceArg = SOURCE_ROOT.replace(/\\/g, "/").replace(/\/?$/, "/");
	return spawn(
		ELECTRON_PATH,
		[
			".",
			"--running-from-source",
			`--filesource=${sourceArg}`,
			"--multiinstance",
			"--disable-logs",
			`--remote-debugging-port=${port}`,
			...linuxLaunchArgs(),
		],
		{
			cwd: APP_ROOT,
			env: {
				...process.env,
				SSAPP_USER_DATA_DIR: profileDirectory,
				SSAPP_DEBUG_LOGS: "0",
			},
			stdio: "ignore",
			windowsHide: true,
		}
	);
}

function canReachDebugger(port) {
	return new Promise((resolve) => {
		const request = http.get(`http://127.0.0.1:${port}/json/version`, (response) => {
			response.resume();
			resolve(response.statusCode === 200);
		});
		request.setTimeout(750, () => request.destroy());
		request.on("error", () => resolve(false));
	});
}

async function waitForDebugger(port, child, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`SSApp exited before DevTools was ready (exit ${child.exitCode})`);
		}
		if (await canReachDebugger(port)) return;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("Timed out waiting for SSApp DevTools");
}

async function connectToEditor(port) {
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const pages = browser.contexts().flatMap((context) => context.pages());
	const page = pages.find((candidate) => candidate.url().includes("index.html")) || pages[0];
	if (!page) throw new Error("SSApp did not expose its main Electron page");

	const editorLink = page.locator('#main-navigation a[data-page="event-flow-editor"]');
	await editorLink.waitFor({ state: "visible" });

	const deadline = Date.now() + 30000;
	let frame = null;
	while (Date.now() < deadline) {
		await editorLink.click();
		frame = page.frames().find((candidate) => candidate.name() === "frame2");
		if (frame && (await frame.evaluate(() => !!window.flowEditor).catch(() => false))) break;
		await page.waitForTimeout(250);
	}
	if (!frame) throw new Error("Event Flow editor frame did not initialize");
	return { browser, frame };
}

async function waitForWebhookRequest(receiver, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (receiver.requests.length > 0) return receiver.requests[0];
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Timed out waiting for the local webhook request");
}

async function run() {
	assert.ok(fs.existsSync(path.join(SOURCE_ROOT, "actions", "EventFlowSystem.js")), `Social Stream source is missing: ${SOURCE_ROOT}`);
	const profileDirectory = fs.mkdtempSync(PROFILE_PREFIX);
	const debuggerPort = await getFreePort();
	const receiver = await startWebhookReceiver();
	let child = null;
	let browser = null;

	try {
		console.log("[E2E] Launching SSApp with an isolated profile and local Social Stream source");
		child = launchApp(profileDirectory, debuggerPort);
		await waitForDebugger(debuggerPort, child);
		const connected = await connectToEditor(debuggerPort);
		browser = connected.browser;
		const frame = connected.frame;

		console.log("[E2E] Creating the built-in Chat Relay to Discord flow");
		await frame.locator("#template-select").selectOption("chat-relay");
		await frame.waitForFunction(() => {
			const flow = window.flowEditor?.currentFlow;
			const webhook = flow?.nodes?.find((node) => node.actionType === "webhook");
			return flow?.name?.startsWith("Chat Relay to Discord") && webhook?.config?.body?.includes('"avatar_url": "{chatimg}"');
		});

		const actionId = await frame.evaluate(() =>
			window.flowEditor.currentFlow.nodes.find((node) => node.actionType === "webhook")?.id || ""
		);
		assert.ok(actionId, "Discord template should contain a Call Webhook action");
		await frame.locator(`.node[data-id="${actionId}"]`).click();
		await frame.locator("#prop-url").fill(`http://127.0.0.1:${receiver.port}/discord`);
		assert.equal(
			await frame.locator("#prop-body").inputValue(),
			'{"content": "{message}", "username": "{username}", "avatar_url": "{chatimg}"}',
			"the shipped template should expose the expected Discord JSON"
		);
		await frame.locator("#save-flow-btn").click();
		await frame.waitForFunction(() => window.flowEditor?.unsavedChanges === false);

		const sourceMessage = {
			type: "tiktok",
			chatname: 'Erallie "Live"',
			chatmessage: 'Hello "Discord"\nEmoji 😀 and \\path',
			chatimg: "https://example.com/avatar.png",
			textonly: true,
		};

		console.log("[E2E] Running the saved flow through the real Event Flow runtime");
		await frame.evaluate(async (message) => {
			const flow = JSON.parse(JSON.stringify(window.flowEditor.currentFlow));
			flow.active = true;
			await window.eventFlowSystem.evaluateFlow(flow, message);
		}, sourceMessage);

		const request = await waitForWebhookRequest(receiver);
		assert.equal(request.method, "POST");
		assert.equal(request.url, "/discord");
		assert.match(request.headers["content-type"] || "", /^application\/json/i);
		assert.deepEqual(JSON.parse(request.body), {
			content: sourceMessage.chatmessage,
			username: sourceMessage.chatname,
			avatar_url: sourceMessage.chatimg,
		});
		assert.equal(receiver.requests.length, 1, "one source message should produce exactly one webhook request");

		console.log("[E2E] PASS Discord webhook variables rendered through the actual SSApp Event Flow runtime");
	} finally {
		if (browser) await browser.close().catch(() => {});
		await stopApp(child);
		await new Promise((resolve) => receiver.server.close(resolve));
		const resolvedProfile = path.resolve(profileDirectory);
		const resolvedPrefix = path.resolve(PROFILE_PREFIX);
		if (resolvedProfile.startsWith(resolvedPrefix) && fs.existsSync(resolvedProfile)) {
			fs.rmSync(resolvedProfile, { recursive: true, force: true });
		}
	}
}

run().catch((error) => {
	console.error("[E2E] FAIL", error);
	process.exitCode = 1;
});
