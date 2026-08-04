#!/usr/bin/env node

"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { chromium } = require("playwright-core");

const APP_ROOT = path.resolve(__dirname, "..", "..");
const SOCIAL_STREAM_ROOT = path.resolve(process.env.SOCIAL_STREAM_SOURCE_DIR || path.join(APP_ROOT, "..", "social_stream"));
const EXECUTABLE_OVERRIDE = String(process.env.SSAPP_E2E_EXECUTABLE || "").trim();
const ELECTRON_PATH = EXECUTABLE_OVERRIDE ? path.resolve(EXECUTABLE_OVERRIDE) : require("electron");
const ELECTRON_APP_ARGS = EXECUTABLE_OVERRIDE ? [] : ["."];
const EXPECTED_VERSION = String(process.env.SSAPP_EXPECT_VERSION || "").trim();
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ssapp-chathistory-origin-e2e-"));
const MESSAGE_PREFIX = `history-origin-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			server.close(error => (error ? reject(error) : resolve(port)));
		});
	});
}

function getMimeType(filePath) {
	switch (path.extname(filePath).toLowerCase()) {
		case ".html": return "text/html; charset=utf-8";
		case ".js": return "application/javascript; charset=utf-8";
		case ".json": return "application/json; charset=utf-8";
		case ".css": return "text/css; charset=utf-8";
		case ".svg": return "image/svg+xml";
		case ".png": return "image/png";
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".woff2": return "font/woff2";
		default: return "application/octet-stream";
	}
}

function createSourceServer() {
	const sourceRoot = path.resolve(SOCIAL_STREAM_ROOT);
	const sourcePrefix = `${sourceRoot}${path.sep}`;
	const server = http.createServer((request, response) => {
		let pathname;
		try {
			pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
		} catch (_) {
			response.writeHead(400).end("Bad request");
			return;
		}

		const relativePath = pathname.replace(/^\/+/, "").replace(/\//g, path.sep);
		const filePath = path.resolve(sourceRoot, relativePath || "index.html");
		if (filePath !== sourceRoot && !filePath.startsWith(sourcePrefix)) {
			response.writeHead(403).end("Forbidden");
			return;
		}

		fs.stat(filePath, (error, stats) => {
			if (error || !stats.isFile()) {
				response.writeHead(404, { "Cache-Control": "no-store" }).end("Not found");
				return;
			}
			response.writeHead(200, {
				"Cache-Control": "no-store",
				"Content-Length": stats.size,
				"Content-Type": getMimeType(filePath),
			});
			if (request.method === "HEAD") {
				response.end();
				return;
			}
			fs.createReadStream(filePath).pipe(response);
		});
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: server.address().port });
		});
	});
}

function canReachDebugger(port) {
	return new Promise(resolve => {
		const request = http.get(`http://127.0.0.1:${port}/json/version`, response => {
			response.resume();
			resolve(response.statusCode === 200);
		});
		request.setTimeout(750, () => request.destroy());
		request.on("error", () => resolve(false));
	});
}

function execFileAsync(file, args) {
	return new Promise((resolve, reject) => {
		execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
			if (error) {
				error.stdout = stdout;
				error.stderr = stderr;
				reject(error);
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

async function getDebuggerProcessId(port) {
	if (process.platform !== "win32") return null;
	const result = await execFileAsync("netstat.exe", ["-ano", "-p", "TCP"]);
	const suffix = `:${port}`;
	for (const line of result.stdout.split(/\r?\n/)) {
		const columns = line.trim().split(/\s+/);
		if (columns.length < 5 || columns[0] !== "TCP") continue;
		if (!columns[1].endsWith(suffix) || columns[3] !== "LISTENING") continue;
		const pid = Number(columns[4]);
		if (Number.isInteger(pid) && pid > 0) return pid;
	}
	return null;
}

async function waitForDebugger(port, child, timeoutMs = 60000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`SSApp exited before DevTools was ready (exit ${child.exitCode}).`);
		}
		if (await canReachDebugger(port)) return;
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error(`Timed out waiting for SSApp DevTools on port ${port}.`);
}

function launchApp(debugPort, sourcePort) {
	const args = [
		...ELECTRON_APP_ARGS,
		"--multiinstance",
		`--filesource=http://127.0.0.1:${sourcePort}/`,
		`--remote-debugging-port=${debugPort}`,
		"--disable-logs",
	];
	if (!EXECUTABLE_OVERRIDE) args.splice(ELECTRON_APP_ARGS.length, 0, "--running-from-source");

	const child = spawn(ELECTRON_PATH, args, {
		cwd: APP_ROOT,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: PROFILE_DIR,
			SSAPP_DIAGNOSTICS_SAFE_GPU: "1",
			SSAPP_DEBUG_LOGS: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let output = "";
	child.stdout.on("data", chunk => { output += chunk.toString(); });
	child.stderr.on("data", chunk => { output += chunk.toString(); });
	return { child, getOutput: () => output };
}

async function stopApp(browser, child, mainProcessId) {
	if (browser) {
		try { await browser.close(); } catch (_) { }
	}
	if (EXECUTABLE_OVERRIDE && process.platform === "win32" && mainProcessId) {
		try { await execFileAsync("taskkill.exe", ["/PID", String(mainProcessId), "/T", "/F"]); } catch (_) { }
	}
	if (!child || child.exitCode !== null) return;
	await Promise.race([
		new Promise(resolve => child.once("exit", resolve)),
		new Promise(resolve => setTimeout(resolve, 5000)),
	]);
	if (child.exitCode === null) {
		child.kill();
		await Promise.race([
			new Promise(resolve => child.once("exit", resolve)),
			new Promise(resolve => setTimeout(resolve, 5000)),
		]);
	}
}

async function removeProfileDirectory() {
	const resolvedProfile = path.resolve(PROFILE_DIR);
	if (path.dirname(resolvedProfile) !== path.resolve(os.tmpdir()) || !path.basename(resolvedProfile).startsWith("ssapp-chathistory-origin-e2e-")) {
		throw new Error(`Refusing to remove unexpected test profile path: ${resolvedProfile}`);
	}

	let lastError = null;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			fs.rmSync(resolvedProfile, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			if (error.code !== "EBUSY" && error.code !== "EPERM" && error.code !== "ENOTEMPTY") throw error;
			await new Promise(resolve => setTimeout(resolve, 250));
		}
	}
	throw lastError;
}

async function connectToMainPage(debugPort, child) {
	await waitForDebugger(debugPort, child);
	const mainProcessId = await getDebuggerProcessId(debugPort);
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes("index.html"));
		if (page) return { browser, page, mainProcessId };
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	await browser.close();
	throw new Error("SSApp did not expose its main Electron page.");
}

async function waitForAppFrames(page, sourcePort) {
	const sourceOrigin = `http://127.0.0.1:${sourcePort}`;
	await page.waitForFunction(expectedOrigin => {
		const popup = document.getElementById("frame1");
		const background = document.getElementById("frame2");
		return popup && background && popup.src.startsWith(expectedOrigin) && background.src.startsWith(expectedOrigin);
	}, sourceOrigin, { timeout: 60000 });

	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		const popup = page.frames().find(frame => frame.url().startsWith(`${sourceOrigin}/popup.html`));
		const background = page.frames().find(frame => frame.url().startsWith(`${sourceOrigin}/background.html`));
		if (popup && background) {
			const popupReady = await popup.evaluate(() => {
				const historyLink = document.getElementById("chathistory");
				if (document.readyState !== "complete" || !historyLink || historyLink.target !== "_self") return false;
				return historyLink.getAttribute("href") === "#";
			}).catch(() => false);
			const backgroundReady = await background.evaluate(async () => {
				if (typeof messageStoreDB === "undefined" || !messageStoreDB) return false;
				try {
					await messageStoreDB.ensureDB();
					return !!messageStoreDB.db && messageStoreDB.db.objectStoreNames.contains("messages");
				} catch (_) {
					return false;
				}
			}).catch(() => false);
			if (popupReady && backgroundReady) return { popup, background };
		}
		await page.waitForTimeout(100);
	}
	const diagnostics = await Promise.all(page.frames().map(async frame => ({
		name: frame.name(),
		url: frame.url(),
		state: await frame.evaluate(() => ({
			readyState: document.readyState,
			hasHistoryLink: !!document.getElementById("chathistory"),
			historyLinkHref: document.getElementById("chathistory")?.href || "",
			historyLinkTarget: document.getElementById("chathistory")?.target || "",
			hasMessageStore: typeof messageStoreDB !== "undefined" && !!messageStoreDB,
			databaseReady: typeof messageStoreDB !== "undefined" && !!messageStoreDB && !!messageStoreDB.db,
		})).catch(error => ({ evaluationError: error.message })),
	})));
	throw new Error(`Timed out waiting for the remote popup and background frames: ${JSON.stringify(diagnostics)}`);
}

async function addStoredMessage(background, marker) {
	return background.evaluate(async messageMarker => {
		await messageStoreDB.ensureDB();
		if (typeof settings === "object" && settings) settings.disableDB = false;
		const message = {
			chatname: "History E2E",
			chatmessage: messageMarker,
			type: "youtube",
			textonly: true,
		};
		const id = await addMessageDB(message);
		return {
			id,
			version: messageStoreDB.db.version,
			stores: Array.from(messageStoreDB.db.objectStoreNames),
		};
	}, marker);
}

async function openHistoryAndWait(page, popup, marker) {
	const context = page.context();
	const pageCount = context.pages().length;
	await popup.evaluate(() => {
		if (document.body.classList.contains("beginner-mode")) disablePopupBeginnerMode();
		const mechanics = document.getElementById("wrapper-global-mechanics-options");
		mechanics.checked = true;
		mechanics.dispatchEvent(new Event("change", { bubbles: true }));
	});
	const historyLink = popup.locator("#chathistory");
	if (!await historyLink.isVisible()) {
		const visibility = await historyLink.evaluate(element => {
			const ancestors = [];
			let current = element;
			while (current && ancestors.length < 8) {
				const style = getComputedStyle(current);
				ancestors.push({
					tag: current.tagName,
					id: current.id,
					className: current.className,
					display: style.display,
					visibility: style.visibility,
					height: current.getBoundingClientRect().height,
				});
				current = current.parentElement;
			}
			return ancestors;
		});
		throw new Error(`Chat history link is not visible after opening Mechanics: ${JSON.stringify(visibility)}`);
	}
	await popup.waitForFunction(() => {
		const link = document.getElementById("chathistory");
		return link && link.target === "_self" && link.getAttribute("href") === "#";
	});
	await historyLink.scrollIntoViewIfNeeded();
	const newPagePromise = context.waitForEvent("page", { timeout: 30000 });
	await historyLink.click();
	const historyPage = await newPagePromise;
	await historyPage.waitForLoadState("domcontentloaded");
	assert.ok(historyPage.url().startsWith("blob:"), `Message Browser did not use the local snapshot document: ${historyPage.url()}`);
	assert.strictEqual(await historyPage.title(), "Message Browser", "Message Browser window title is incorrect.");
	assert.strictEqual(context.pages().length, pageCount + 1, "Opening history did not create exactly one Message Browser window.");
	const layout = await historyPage.evaluate(() => {
		const frame = document.getElementById("history-frame").getBoundingClientRect();
		return { frame, viewport: { width: innerWidth, height: innerHeight } };
	});
	assert.ok(layout.viewport.width >= 700 && layout.viewport.height >= 450, `Message Browser window is too small: ${JSON.stringify(layout)}`);
	assert.ok(layout.frame.width >= layout.viewport.width - 1 && layout.frame.height >= layout.viewport.height - 1, `Message Browser does not fill its window: ${JSON.stringify(layout)}`);

	const deadline = Date.now() + 30000;
	let history = null;
	let rendered = false;
	while (Date.now() < deadline) {
		history = historyPage.frames().find(frame => frame !== historyPage.mainFrame() && frame.url().includes("/chathistory.html"));
		rendered = history ? await history.evaluate(expectedMarker => {
			return Array.from(document.querySelectorAll(".message-text")).some(node => node.textContent.includes(expectedMarker));
		}, marker).catch(() => false) : false;
		if (rendered) break;
		await page.waitForTimeout(100);
	}
	assert.ok(history, "Message Browser iframe did not load.");
	assert.strictEqual(new URL(history.url()).origin, new URL(popup.url()).origin, "History did not stay on the popup/background origin.");
	if (!rendered) {
		const diagnostics = await history.evaluate(() => {
			return {
				url: location.href,
				origin: location.origin,
				snapshot: window.__ssappHistorySnapshotState || null,
				bodyText: document.body.innerText.slice(0, 1000),
			};
		});
		assert.fail(`Message Browser did not render ${marker}: ${JSON.stringify(diagnostics)}`);
	}

	const state = await history.evaluate(expectedMarker => ({
		messageVisible: Array.from(document.querySelectorAll(".message-text")).some(node => node.textContent.includes(expectedMarker)),
		snapshot: window.__ssappHistorySnapshotState || null,
		controlsVisible: !!document.getElementById("search-input") && !!document.getElementById("messages-container"),
	}), marker);
	assert.strictEqual(state.messageVisible, true, `History did not show ${marker}.`);
	assert.strictEqual(state.snapshot?.active, true, `Message Browser did not enter snapshot mode: ${JSON.stringify(state)}`);
	assert.ok(state.snapshot.stores.includes("messages"), `History snapshot came from a database without the messages store: ${JSON.stringify(state)}`);
	assert.strictEqual(state.controlsVisible, true, `Message Browser controls are missing: ${JSON.stringify(state)}`);
	return { historyPage, history, state };
}

async function closeHistory(historyPage) {
	if (historyPage.isClosed()) return;
	await historyPage.close();
	assert.strictEqual(historyPage.isClosed(), true, "Message Browser window did not close.");
}

async function verifySnapshotFeatures(historyPage, history, background) {
	const firstMarker = `${MESSAGE_PREFIX}-first`;
	const secondMarker = `${MESSAGE_PREFIX}-second`;
	const keyword = history.locator("#keyword-filter");
	await keyword.fill(firstMarker);
	await history.waitForFunction(({ included, excluded }) => {
		const visibleMessages = Array.from(document.querySelectorAll(".message-text"), node => node.textContent || "");
		return visibleMessages.length === 1 && visibleMessages[0].includes(included) && !visibleMessages[0].includes(excluded);
	}, { included: firstMarker, excluded: secondMarker }, { timeout: 10000 });

	await history.locator("#clear-filters").click();
	await history.waitForFunction(({ first, second }) => {
		const visibleMessages = Array.from(document.querySelectorAll(".message-text"), node => node.textContent || "");
		return visibleMessages.some(text => text.includes(first)) && visibleMessages.some(text => text.includes(second));
	}, { first: firstMarker, second: secondMarker }, { timeout: 10000 });

	await history.locator("#export-format").selectOption("json");
	await history.locator("#export-timeframe").selectOption("all");
	await history.evaluate(() => {
		const originalCreateObjectURL = URL.createObjectURL;
		const originalAnchorClick = HTMLAnchorElement.prototype.click;
		let exportBlob = null;
		window.__historyExportCapture = null;
		URL.createObjectURL = function (value) {
			exportBlob = value;
			return originalCreateObjectURL.call(this, value);
		};
		HTMLAnchorElement.prototype.click = function (...args) {
			const filename = this.download;
			if (exportBlob && typeof exportBlob.text === "function") {
				exportBlob.text().then(content => {
					window.__historyExportCapture = { filename, content };
					URL.createObjectURL = originalCreateObjectURL;
					HTMLAnchorElement.prototype.click = originalAnchorClick;
				});
			}
			return originalAnchorClick.apply(this, args);
		};
	});
	const downloadPromise = historyPage.waitForEvent("download", { timeout: 15000 });
	await history.locator("#export-button").click();
	const download = await downloadPromise;
	assert.match(download.suggestedFilename(), /^chat_export_.*\.json$/, "History export filename is incorrect.");
	await history.waitForFunction(() => !!window.__historyExportCapture, null, { timeout: 10000 });
	const exportCapture = await history.evaluate(() => window.__historyExportCapture);
	assert.strictEqual(exportCapture.filename.replace(/:/g, "_"), download.suggestedFilename(), "History export link used the wrong filename.");
	const exportedMessages = JSON.parse(exportCapture.content);
	assert.ok(exportedMessages.some(message => message.chatmessage === firstMarker), "History export omitted the first saved message.");
	assert.ok(exportedMessages.some(message => message.chatmessage === secondMarker), "History export omitted the second saved message.");

	historyPage.once("dialog", dialog => dialog.accept());
	await history.locator("#clear-history").click();
	await history.waitForFunction(() => {
		return document.getElementById("clear-history")?.textContent === "History Deleted" &&
			window.__ssappHistorySnapshotState?.count === 0 &&
			!document.querySelector(".message-wrapper");
	}, null, { timeout: 10000 });

	const clearDeadline = Date.now() + 10000;
	let storedCount = null;
	while (Date.now() < clearDeadline) {
		storedCount = await background.evaluate(async () => {
			await messageStoreDB.ensureDB();
			return new Promise((resolve, reject) => {
				const request = messageStoreDB.db.transaction("messages", "readonly").objectStore("messages").count();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		});
		if (storedCount === 0) break;
		await historyPage.waitForTimeout(100);
	}
	assert.strictEqual(storedCount, 0, "Delete All History did not clear the background database.");
	return {
		filtering: true,
		exportDownload: true,
		clearHistoryRelay: true,
	};
}

async function readAppVersion(page) {
	return page.evaluate(() => {
		try {
			return ipcRenderer.sendSync("getVersion");
		} catch (_) {
			return "";
		}
	});
}

async function runAppPass(sourcePort, options = {}) {
	const debugPort = await getFreePort();
	const launched = launchApp(debugPort, sourcePort);
	let browser = null;
	let mainProcessId = null;
	const targetErrors = [];
	try {
		const connected = await connectToMainPage(debugPort, launched.child);
		browser = connected.browser;
		mainProcessId = connected.mainProcessId;
		const page = connected.page;
		const captureTargetErrors = targetPage => {
			targetPage.on("console", message => {
			if (message.type() === "error" && /NotFoundError|object store|Error loading messages|Error initializing app/i.test(message.text())) {
				targetErrors.push(message.text());
			}
			});
			targetPage.on("pageerror", error => {
				if (/NotFoundError|object store|Error loading messages|Error initializing app/i.test(error.message)) {
					targetErrors.push(error.message);
				}
			});
		};
		for (const existingPage of page.context().pages()) captureTargetErrors(existingPage);
		page.context().on("page", captureTargetErrors);

		const { popup, background } = await waitForAppFrames(page, sourcePort);
		const version = await readAppVersion(page);
		if (EXPECTED_VERSION) assert.strictEqual(version, EXPECTED_VERSION, `Expected SSApp ${EXPECTED_VERSION}, got ${version}.`);
		await popup.evaluate(() => { window.__historyPopupStayedAlive = "popup-alive"; });
		await background.evaluate(() => { window.__historyBackgroundStayedAlive = "background-alive"; });

		if (options.seed) {
			const first = await addStoredMessage(background, `${MESSAGE_PREFIX}-first`);
			assert.ok(first.id, `First message was not stored: ${JSON.stringify(first)}`);
			assert.ok(first.stores.includes("messages"), `Background database has no messages store: ${JSON.stringify(first)}`);
			const firstHistory = await openHistoryAndWait(page, popup, `${MESSAGE_PREFIX}-first`);
			await closeHistory(firstHistory.historyPage);

			assert.strictEqual(await popup.evaluate(() => window.__historyPopupStayedAlive), "popup-alive", "Popup reloaded while history was open.");
			assert.strictEqual(await background.evaluate(() => window.__historyBackgroundStayedAlive), "background-alive", "Background reloaded while history was open.");

			const second = await addStoredMessage(background, `${MESSAGE_PREFIX}-second`);
			assert.ok(second.id, `Second message was not stored: ${JSON.stringify(second)}`);
			const secondHistory = await openHistoryAndWait(page, popup, `${MESSAGE_PREFIX}-second`);
			await closeHistory(secondHistory.historyPage);
		} else {
			const persistedHistory = await openHistoryAndWait(page, popup, `${MESSAGE_PREFIX}-first`);
			const secondVisible = await persistedHistory.history.evaluate(marker => {
				return Array.from(document.querySelectorAll(".message-text")).some(node => node.textContent.includes(marker));
			}, `${MESSAGE_PREFIX}-second`);
			assert.strictEqual(secondVisible, true, "Second stored message did not persist across an app restart.");
			await verifySnapshotFeatures(persistedHistory.historyPage, persistedHistory.history, background);
			await closeHistory(persistedHistory.historyPage);
		}

		await page.waitForTimeout(500);
		assert.deepStrictEqual(targetErrors, [], `History emitted database errors: ${JSON.stringify(targetErrors)}`);
		return version;
	} catch (error) {
		throw new Error(`${error.message}\n${launched.getOutput().slice(-6000)}`);
	} finally {
		await stopApp(browser, launched.child, mainProcessId);
	}
}

async function run() {
	assert.ok(fs.existsSync(path.join(SOCIAL_STREAM_ROOT, "popup.js")), `Social Stream source not found: ${SOCIAL_STREAM_ROOT}`);
	const source = await createSourceServer();
	try {
		const firstVersion = await runAppPass(source.port, { seed: true });
		await new Promise(resolve => setTimeout(resolve, 750));
		const secondVersion = await runAppPass(source.port, { seed: false });
		assert.strictEqual(secondVersion, firstVersion, "SSApp version changed between persistence passes.");
		console.log("Chat history origin compatibility Electron E2E passed", JSON.stringify({
			version: firstVersion,
			executable: EXECUTABLE_OVERRIDE || "repository Electron",
			persistence: true,
			repeatedOpenClose: true,
			fullSizeMessageBrowser: true,
			filtering: true,
			exportDownload: true,
			clearHistoryRelay: true,
			popupStayedAlive: true,
			backgroundStayedAlive: true,
		}));
	} finally {
		await new Promise(resolve => source.server.close(resolve));
		await removeProfileDirectory();
	}
}

run().catch(error => {
	console.error(error);
	process.exit(1);
});
