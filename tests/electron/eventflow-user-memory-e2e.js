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
const EXAMPLE_FLOW = path.join(SOURCE_ROOT, "actions", "examples", "user-memory-participation-draw.json");
const ELECTRON_PATH = require("electron");
const PROFILE_PREFIX = path.join(os.tmpdir(), "ssapp-user-memory-e2e-");

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
	throw new Error(`Timed out waiting for SSApp DevTools on port ${port}`);
}

async function connectToEditor(port) {
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const page = browser.contexts().flatMap((context) => context.pages())[0];
	if (!page) throw new Error("SSApp did not expose its main Electron page");

	const editorLink = page.locator('#main-navigation a[data-page="event-flow-editor"]');
	await editorLink.waitFor({ state: "visible" });

	const deadline = Date.now() + 30000;
	let frame = null;
	while (Date.now() < deadline) {
		// SSApp has two startup phases; retrying the real nav click avoids
		// racing the phase that attaches the iframe-switching handler.
		await editorLink.click();
		frame = page.frames().find((candidate) => candidate.name() === "frame2");
		if (frame && (await frame.evaluate(() => !!window.flowEditor).catch(() => false))) break;
		await page.waitForTimeout(250);
	}
	if (!frame) throw new Error("Event Flow editor frame did not initialize");
	return { browser, page, frame };
}

async function showEditorPage(page, frame) {
	const editorLink = page.locator('#main-navigation a[data-page="event-flow-editor"]');
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		await editorLink.click();
		await page.waitForTimeout(250);
		const selected = await page.evaluate(() => {
			const target = document.getElementById("frame2");
			const link = document.querySelector('#main-navigation a[data-page="event-flow-editor"]');
			return !!target && getComputedStyle(target).display !== "none" && link?.classList.contains("active");
		});
		if (selected && (await frame.locator("#open-test-panel").isVisible())) return;
	}
	throw new Error("Event Flow editor did not become visible");
}

async function selectImportedFlow(frame) {
	const importedId = await frame.evaluate(async () => {
		const flows = await window.eventFlowSystem.getAllFlows();
		const flow = flows.find((candidate) => candidate.name?.startsWith("User Memory: Participation"));
		if (!flow?.id) return "";
		await window.flowEditor.loadFlow(flow.id);
		return flow.id;
	});
	assert.ok(importedId, "imported User Memory flow should remain available after restart");
	await frame.waitForFunction(() =>
		window.flowEditor?.currentFlow?.nodes?.some((node) => node.stateType === "USER_MEMORY")
	);
}

async function importExampleFlow(frame) {
	const flowData = JSON.parse(fs.readFileSync(EXAMPLE_FLOW, "utf8"));
	const importedId = await frame.evaluate(async (data) => {
		const savedFlow = await window.flowEditor.importSingleFlow(data, true);
		if (!savedFlow?.id) return "";
		await window.flowEditor.loadFlowList();
		await window.flowEditor.loadFlow(savedFlow.id);
		return savedFlow.id;
	}, flowData);
	assert.ok(importedId, "editor import method should save the example flow");
	await frame.locator(".flow-item", { hasText: "User Memory" }).first().waitFor({ state: "attached" });
}

async function runTestMessage(frame, username, message, source = "twitch", options = {}) {
	await frame.locator("#test-source").selectOption(source);
	await frame.locator("#test-username").fill(username);
	await frame.locator("#test-message").fill(message);
	await frame.locator("#test-mod").setChecked(options.mod === true);
	const previous = await frame.locator("#test-results").innerText();
	await frame.locator("#run-test-btn").click();
	await frame.waitForFunction((oldText) => {
		const current = document.getElementById("test-results")?.innerText || "";
		return current.includes("Test Results") && current !== oldText;
	}, previous);
	return frame.locator("#test-results").innerText();
}

async function getMemoryCount(frame) {
	return frame.evaluate(
		() => window.eventFlowSystem.getUserMemorySummary("state_prize_draw", window.flowEditor.currentFlow)?.count
	);
}

async function run() {
	assert.ok(fs.existsSync(EXAMPLE_FLOW), `Example flow is missing: ${EXAMPLE_FLOW}`);
	const profileDirectory = fs.mkdtempSync(PROFILE_PREFIX);
	const port = await getFreePort();
	let child = null;

	try {
		console.log("[E2E] Launching isolated SSApp profile");
		child = launchApp(profileDirectory, port);
		await waitForDebugger(port, child);
		let connected = await connectToEditor(port);
		let { page, frame } = connected;

		console.log("[E2E] Importing the shipped User Memory example");
		await importExampleFlow(frame);
		await showEditorPage(page, frame);
		assert.equal(await frame.locator("#flow-canvas .node").count(), 14, "all example nodes should render");
		assert.equal(
			await frame.locator("#flow-canvas .state-reference").count(),
			4,
			"all shared-state links should render"
		);

		if (!(await frame.locator("#open-test-panel").isVisible())) {
			const outerLayout = await page.evaluate(() => {
				const target = document.getElementById("frame2");
				const parent = document.getElementById("dashboard-page");
				return {
					frame: target && { display: getComputedStyle(target).display, rect: target.getBoundingClientRect().toJSON() },
					parent: parent && {
						display: getComputedStyle(parent).display,
						rect: parent.getBoundingClientRect().toJSON(),
					},
					activePage: document.querySelector("#main-navigation a.active")?.dataset?.page || "",
				};
			});
			const innerLayout = await frame.evaluate(() => {
				const target = document.getElementById("open-test-panel");
				return {
					viewport: { width: innerWidth, height: innerHeight },
					button: target && {
						display: getComputedStyle(target).display,
						rect: target.getBoundingClientRect().toJSON(),
					},
					body: {
						display: getComputedStyle(document.body).display,
						rect: document.body.getBoundingClientRect().toJSON(),
					},
				};
			});
			throw new Error(`Event Flow editor is not visibly selected: ${JSON.stringify({ outerLayout, innerLayout })}`);
		}

		await frame.locator("#open-test-panel").click();
		const enterAlice = await runTestMessage(frame, "Alice", "!enter");
		assert.match(enterAlice, /userMemoryCount:\s*1/);

		const aliceEligible = await runTestMessage(frame, "Alice", "? hello");
		assert.match(aliceEligible, /\[eligible\] \? hello/);

		const bobRejected = await runTestMessage(frame, "Bob", "? hello");
		assert.match(bobRejected, /did not modify or block/i);

		const enterBob = await runTestMessage(frame, "Bob", "!enter");
		assert.match(enterBob, /userMemoryCount:\s*2/);

		const unauthorizedDraw = await runTestMessage(frame, "Viewer", "!draw");
		assert.match(unauthorizedDraw, /did not modify or block/i);
		assert.equal(await getMemoryCount(frame), 2, "a viewer should not be able to run the draw");

		const draw = await runTestMessage(frame, "Host", "!draw", "twitch", { mod: true });
		assert.match(draw, /selectedUser:/);
		assert.match(draw, /selectedUserRemoved:\s*true/);
		assert.equal(await getMemoryCount(frame), 1, "draw should remove one winner");

		const unauthorizedReset = await runTestMessage(frame, "Viewer", "!resetdraw");
		assert.match(unauthorizedReset, /did not modify or block/i);
		assert.equal(await getMemoryCount(frame), 1, "a viewer should not be able to clear the draw");

		const reset = await runTestMessage(frame, "Host", "!resetdraw", "twitch", { mod: true });
		assert.match(reset, /userMemoryCleared:\s*true/);
		assert.equal(await getMemoryCount(frame), 0, "Clear All should empty the selected memory");

		console.log("[E2E] Saving one entrant across a real app restart");
		await frame.locator("#close-test-btn").click();
		await frame.locator('.node[data-id="state_prize_draw"]').click();
		await frame.locator("#prop-persistence").selectOption("persistent");
		await frame.locator("#save-flow-btn").click();
		await frame.waitForFunction(async () => {
			const flow = await window.eventFlowSystem.getFlowById(window.flowEditor.currentFlow.id);
			return flow?.nodes?.find((node) => node.id === "state_prize_draw")?.config?.persistence === "persistent";
		});

		await frame.locator("#open-test-panel").click();
		await runTestMessage(frame, "PersistentAlice", "!enter", "youtube");
		assert.equal(await getMemoryCount(frame), 1);
		await frame.waitForTimeout(350);

		await stopApp(child);
		child = null;

		child = launchApp(profileDirectory, port);
		await waitForDebugger(port, child);
		connected = await connectToEditor(port);
		page = connected.page;
		frame = connected.frame;
		await selectImportedFlow(frame);
		await showEditorPage(page, frame);

		const persistentEligible = await frame.evaluate(async () =>
			window.eventFlowSystem.isUserRemembered(
				"state_prize_draw",
				{ type: "youtube", userid: "persistentalice" },
				window.flowEditor.currentFlow
			)
		);
		assert.equal(persistentEligible, true, "saved entrant should reload after restart");

		console.log("[E2E] Clearing the saved memory from its properties");
		await frame.locator('.node[data-id="state_prize_draw"]').click();
		page.once("dialog", (dialog) => dialog.accept());
		await frame.locator("#clear-user-memory-now").click();
		await frame.waitForFunction(() => document.getElementById("user-memory-current-count")?.textContent === "0");
		assert.equal(await getMemoryCount(frame), 0);
		await frame.waitForTimeout(350);

		console.log("[E2E] Confirming the persistent clear survives another restart");
		await stopApp(child);
		child = null;

		child = launchApp(profileDirectory, port);
		await waitForDebugger(port, child);
		connected = await connectToEditor(port);
		page = connected.page;
		frame = connected.frame;
		await selectImportedFlow(frame);
		await showEditorPage(page, frame);
		const clearedUserReturned = await frame.evaluate(async () =>
			window.eventFlowSystem.isUserRemembered(
				"state_prize_draw",
				{ type: "youtube", userid: "persistentalice" },
				window.flowEditor.currentFlow
			)
		);
		assert.equal(clearedUserReturned, false, "cleared persistent entrants should not return after restart");
		assert.equal(await getMemoryCount(frame), 0);

		console.log("[E2E] PASS User Memory editor, runtime, persistence, draw, and reset");
	} finally {
		await stopApp(child);
		if (profileDirectory.startsWith(PROFILE_PREFIX) && fs.existsSync(profileDirectory)) {
			fs.rmSync(profileDirectory, { recursive: true, force: true });
		}
	}
}

run().catch((error) => {
	console.error("[E2E] FAIL", error);
	process.exitCode = 1;
});
