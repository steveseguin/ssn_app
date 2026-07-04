"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..", "..");
const indexSource = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");

function extractFunction(source, name) {
	const start = source.indexOf(`function ${name}`);
	assert(start >= 0, `Missing function ${name}`);
	const open = source.indexOf("{", start);
	assert(open >= 0, `Missing function body for ${name}`);
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		const char = source[i];
		if (char === "{") depth += 1;
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`Unable to extract function ${name}`);
}

const functions = [
	"isYouTubeTarget",
	"isYouTubeOwnerGroup",
	"shouldPollYouTubeGroup",
	"renderYouTubeGroupCountdown"
].map((name) => extractFunction(indexSource, name)).join("\n\n");

const calls = [];
const groups = new Map();
const elements = new Map();

const context = {
	console,
	Date,
	stateManager: {
		getGroup: (id) => groups.get(id) || null
	},
	getYouTubeGroupElement: (id) => elements.get(id) || null,
	clearYouTubeGroupCountdown: (id, clearStatus) => calls.push({ type: "clear", id, clearStatus }),
	groupHasActiveConnection: () => false,
	formatYouTubeAutoCheckDelay: () => "1m",
	getYouTubeDiscoveryStatusText: () => "No eligible streams.",
	translateTemplateSafe: (_key, values) => `Next check in ${values.time}.`,
	updateConnectionStatus: (_element, status, message, options) => calls.push({ type: "status", status, message, options })
};

vm.createContext(context);
vm.runInContext(`${functions}
this.helpers = { shouldPollYouTubeGroup, renderYouTubeGroupCountdown };`, context);

groups.set("owner-off", {
	id: "owner-off",
	target: "youtube",
	autoActivate: false,
	youtubeDiscoveryMode: "owner"
});
elements.set("owner-off", {});
assert.equal(
	context.helpers.shouldPollYouTubeGroup(groups.get("owner-off")),
	false,
	"owner discovery should not poll when auto-activate is off"
);
context.helpers.renderYouTubeGroupCountdown("owner-off", { type: "no_eligible_streams" }, Date.now() + 60000);
assert(
	calls.some((call) => call.type === "clear" && call.id === "owner-off" && call.clearStatus === true),
	"owner discovery with auto-activate off should clear recurring polling status"
);

calls.length = 0;
groups.set("owner-on", {
	id: "owner-on",
	target: "youtube",
	autoActivate: true,
	youtubeDiscoveryMode: "owner"
});
elements.set("owner-on", {});
assert.equal(
	context.helpers.shouldPollYouTubeGroup(groups.get("owner-on")),
	true,
	"owner discovery should poll when auto-activate is on"
);
context.helpers.renderYouTubeGroupCountdown("owner-on", { type: "no_eligible_streams" }, Date.now() + 60000);
assert(
	calls.some((call) => call.type === "status" && call.message.includes("Next check in 1m")),
	"owner discovery should show the next check when auto-activate is on"
);

calls.length = 0;
groups.set("public-off", {
	id: "public-off",
	target: "youtube",
	autoActivate: false
});
elements.set("public-off", {});
context.helpers.renderYouTubeGroupCountdown("public-off", { type: "no_eligible_streams" }, Date.now() + 60000);
assert(
	calls.some((call) => call.type === "clear" && call.id === "public-off" && call.clearStatus === true),
	"public groups with auto-activate off should still clear polling status"
);

console.log("youtube owner discovery regression checks passed");
