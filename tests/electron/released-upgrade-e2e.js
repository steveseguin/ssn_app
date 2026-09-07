"use strict";
// Published Windows binaries -> current packaged fix, with isolated persistent profiles.
// HTTPS responses use local fixture files; no live channels or user accounts are used.
const fs = require("fs"),
	path = require("path"),
	os = require("os"),
	assert = require("assert");
const { _electron } = require("playwright-core");
const root = path.resolve(__dirname, "../.."),
	site = path.resolve(root, "../social_stream");
const artifacts = process.env.SSAPP_UPGRADE_ARTIFACTS || path.join(root, ".codex-tmp/upgrade-qa");
const fixed = process.env.SSAPP_UPGRADE_FIXED || path.join(artifacts, "fixed/win-unpacked/socialstream.exe");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "ssapp-released-upgrade-"));
const versions = (process.env.SSAPP_UPGRADE_VERSIONS || "0.3.128,0.4.14,0.4.25").split(",");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const report = [];
async function launch(executable, profile) {
	const app = await _electron.launch({
		executablePath: executable,
		cwd: root,
		args: ["--multiinstance", "--no-hwa"],
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profile,
			SSAPP_PREFER_LOCAL_ASSETS: "0",
		},
		timeout: 90000,
	});
	try {
		assert.equal(
			await app.evaluate(({ app }) => app.getPath("userData")),
			profile,
			"Actual release uses isolated profile"
		);
		await app.evaluate(async ({ app, BrowserWindow }, site) => {
			const fs = process.mainModule.require("fs"),
				path = process.mainModule.require("path"),
				seen = new WeakSet();
			const install = (s) => {
				if (seen.has(s)) return;
				seen.add(s);
				s.protocol.handle("https", async (request) => {
					const u = new URL(request.url);
					if (
						![
							"socialstream.ninja",
							"beta.socialstream.ninja",
							"cache.socialstream.ninja",
							"raw.githubusercontent.com",
						].includes(u.hostname)
					)
						return new Response("", { status: 503 });
					let relative = decodeURIComponent(u.pathname)
						.replace(/^\/steveseguin\/social_stream\/(main|beta)\//, "/")
						.replace(/^\/(beta\/)?/, "");
					const file = path.resolve(site, relative || "index.html");
					if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile())
						return new Response("", { status: 404 });
					const mime = {
						".html": "text/html",
						".js": "application/javascript",
						".json": "application/json",
						".css": "text/css",
						".svg": "image/svg+xml",
					};
					return new Response(fs.readFileSync(file), {
						headers: {
							"content-type": mime[path.extname(file)] || "application/octet-stream",
						},
					});
				});
			};
			BrowserWindow.getAllWindows().forEach((w) => install(w.webContents.session));
			app.on("session-created", install);
		}, site);
		const main = await app.firstWindow();
		await main.reload({ waitUntil: "domcontentloaded" });
		return { app, main };
	} catch (error) {
		await app.close();
		throw error;
	}
}
async function background(main, scheme = "https:") {
	for (let n = 0; n < 240; n++) {
		const f = main.frames().find((f) => f.url().startsWith(scheme) && f.url().includes("/background.html"));
		try {
			if (f && (await f.evaluate(() => window.eventFlowSystem && window.eventFlowSystem.db))) return f;
		} catch (_) {}
		await delay(250);
	}
	throw Error("Background not ready: " + scheme);
}
const snapshot = (frame) =>
	frame.evaluate(() => ({
		url: location.href,
		flows: JSON.parse(JSON.stringify(eventFlowSystem.flows)),
		room: streamID,
		textonly: settings.textonlymode?.setting,
	}));
async function exercise(frame) {
	return await frame.evaluate(async () => {
		window.qaUpgradeHits = 0;
		window.eventFlowSystem.allowEvalCustomJs = true;
		await window.eventFlowSystem.processMessage({
			type: "youtube",
			chatname: "Upgrade Fixture",
			chatmessage: "UPGRADE-QA",
			textonly: true,
		});
		return window.qaUpgradeHits;
	});
}
(async () => {
	console.log("Evidence: " + output);
	for (const version of versions) {
		const profile = path.join(output, version);
		fs.mkdirSync(profile, { recursive: true });
		const room = "upgradeqa" + version.replace(/\./g, "") + Date.now();
		fs.writeFileSync(
			path.join(profile, "savedSync.json"),
			JSON.stringify({
				streamID: room,
				password: "false",
				state: false,
				settings: { textonlymode: { setting: true } },
				wsServer: false,
			})
		);
		const row = { from: version, profile };
		report.push(row);
		let running;
		try {
			running = await launch(path.join(artifacts, "v" + version, "unpacked/socialstream.exe"), profile);
			row.actualVersion = await running.app.evaluate(({ app }) => app.getVersion());
			assert.equal(row.actualVersion, version);
			let bg = await background(running.main);
			await bg.evaluate(async () => {
				for (const active of [true, false])
					await eventFlowSystem.saveFlow({
						id: active ? "active-flow" : "inactive-flow",
						name: active ? "Working saved flow" : "Disabled saved flow",
						active,
						nodes: [
							{
								id: "trigger",
								type: "trigger",
								triggerType: "messageContains",
								x: 30,
								y: 50,
								config: { text: "UPGRADE-QA" },
							},
							{
								id: "action",
								type: "action",
								actionType: "customJs",
								x: 350,
								y: 50,
								config: { code: "window.qaUpgradeHits++;return result;" },
							},
						],
						connections: [{ from: "trigger", to: "action" }],
					});
			});
			row.readiness = await bg.evaluate(() => ({
				background: typeof window.processIncomingMessage,
				sanitizer: typeof window.filterXSS,
			}));
			assert.equal(row.readiness.background, "function");
			assert.equal(row.readiness.sanitizer, "function");
			row.before = await snapshot(bg);
			assert.equal(await exercise(bg), 1, "Only active saved flow runs");
			await running.main.evaluate(() => localStorage.setItem("upgrade-qa-pref", "keep-this"));
			await running.app.evaluate(async ({ BrowserWindow }, url) => {
				const main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("/index.html"));
				await main.webContents.session.cookies.set({
					url,
					name: "upgrade_qa",
					value: "keep-this",
					expirationDate: Date.now() / 1000 + 86400,
				});
			}, new URL(row.before.url).origin);
			await delay(18000);
			row.settled = await running.main.evaluate(() => document.getElementById("frame2").src);
			if (version === "0.4.25") {
				assert(row.settled.startsWith("file:"), "Published 0.4.25 reproduces false fallback");
				row.fallback = await snapshot(await background(running.main, "file:"));
				assert.equal(row.fallback.flows.length, 0, "Fallback shows separate empty flow store");
				console.log("[upgrade] Published 0.4.25 false fallback reproduced");
			} else assert(row.settled.startsWith("https:"), "Older release stays online");
			await running.app.close();
			running = null;
			for (const phase of ["upgrade", "restart"]) {
				running = await launch(fixed, profile);
				row.fixedVersion = await running.app.evaluate(({ app }) => app.getVersion());
				bg = await background(running.main);
				await delay(18000);
				assert(bg.url().startsWith("https:"), "Fixed package remains online beyond fallback deadline");
				row[phase] = await snapshot(bg);
				assert.deepStrictEqual(row[phase].flows, row.before.flows, "Complete active/inactive flow graphs preserved");
				assert.equal(row[phase].room, room, "Session preserved");
				assert.equal(row[phase].textonly, true, "Setting preserved");
				assert.equal(
					await running.main.evaluate(() => localStorage.getItem("upgrade-qa-pref")),
					"keep-this",
					"App preference preserved"
				);
				assert.equal(await exercise(bg), 1, "Saved flow works after " + phase + " and disabled flow stays disabled");
				const cookies = await running.app.evaluate(async ({ BrowserWindow }, url) => {
					const main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("/index.html"));
					return await main.webContents.session.cookies.get({
						url,
						name: "upgrade_qa",
					});
				}, new URL(row.before.url).origin);
				assert.equal(cookies[0]?.value, "keep-this", "Session cookie preserved");
				await running.main.locator('[data-page="event-flow-editor"]').click();
				await bg.locator(".flow-item-name").filter({ hasText: "Working saved flow" }).waitFor({ state: "visible" });
				assert.equal(await bg.locator(".flow-item-status.active").count(), 1, "Editor displays active flow");
				assert.equal(await bg.locator(".flow-item-status.inactive").count(), 1, "Editor displays disabled flow");
				await bg.locator('.flow-item[data-id="active-flow"]').click({ position: { x: 75, y: 25 } });
				assert.equal(await bg.locator("#flow-name").inputValue(), "Working saved flow");
				await running.main.screenshot({
					path: path.join(profile, phase + ".png"),
				});
				await running.app.close();
				running = null;
				console.log("[upgrade] " + version + " " + phase + ": passed");
			}
		} finally {
			fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
			if (running) await running.app.close();
		}
	}
	console.log("PASS published-release upgrade matrix; report: " + path.join(output, "report.json"));
})().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
