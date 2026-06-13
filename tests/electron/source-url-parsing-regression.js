"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..", "..");
const indexPath = path.join(repoRoot, "index.html");
const indexSource = fs.readFileSync(indexPath, "utf8");

function extractFunction(source, name) {
	const start = source.indexOf(`function ${name}`);
	assert(start >= 0, `Missing function ${name}`);
	const open = source.indexOf("{", start);
	assert(open >= 0, `Missing function body for ${name}`);
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		const char = source[i];
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`Unable to extract function ${name}`);
}

const helperStart = indexSource.indexOf("function isGenericVpzoneChannel");
const helperEnd = indexSource.indexOf("// Helper: should sign-in be disabled", helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, "Missing source URL helper block");

const helperBlock = indexSource.slice(helperStart, helperEnd);
const dependencyBlock = [
	"isYouTubeTarget",
	"getWebSocketManifestTarget",
	"hasWebSocketManifestEntry",
	"platformSupportsWebSocket"
].map((name) => extractFunction(indexSource, name)).join("\n\n");

const context = {
	console,
	URL,
	manifest: {
		content_scripts: [
			{ js: ["./sources/websocket/kick.js"] },
			{ js: ["./sources/websocket/rumble.js"] },
			{ js: ["./sources/websocket/twitch.js"] },
			{ js: ["./sources/websocket/vpzone.js"] },
			{ js: ["./sources/websocket/joystick.js"] },
			{ js: ["./sources/websocket/bilibili.js"] }
		]
	}
};
vm.createContext(context);
vm.runInContext(`${helperBlock}\n${dependencyBlock}
this.helpers = {
	cleanSourceUrlIdentifier,
	extractSourceUrlIdentifier,
	isValidTikTokUsername,
	normalizeTikTokUsernameInput,
	getExplicitSourceIdentifier,
	getWebSocketChannelForSource,
	getWebSocketScriptPathForSource,
	buildWebSocketLaunchPlan,
	normalizeVpzoneChannel
};`, context);

const {
	cleanSourceUrlIdentifier,
	extractSourceUrlIdentifier,
	isValidTikTokUsername,
	normalizeTikTokUsernameInput,
	getExplicitSourceIdentifier,
	getWebSocketChannelForSource,
	getWebSocketScriptPathForSource,
	buildWebSocketLaunchPlan,
	normalizeVpzoneChannel
} = context.helpers;

function runCases(label, cases, fn) {
	for (const testCase of cases) {
		const actual = fn(testCase.input);
		assert.strictEqual(actual, testCase.expected, `${label}: ${testCase.name || testCase.input}`);
	}
	console.log(`${label}: ${cases.length} cases passed`);
}

runCases("cleanSourceUrlIdentifier", [
	{ input: "@SomeUser", expected: "SomeUser" },
	{ input: "/SomeUser/", expected: "SomeUser" },
	{ input: "#SomeUser", expected: "SomeUser" },
	{ input: "watch", expected: "" },
	{ input: "popup", expected: "" },
	{ input: "v", expected: "" },
	{ input: "index.html", expected: "" },
	{ input: "player.php", expected: "" }
], cleanSourceUrlIdentifier);

runCases("extractSourceUrlIdentifier", [
	{ input: "https://vpzone.tv/watch/evarate", expected: "evarate" },
	{ input: "https://vpzone.tv/watch/Ashaelon", expected: "Ashaelon" },
	{ input: "vpzone.tv/watch/evarate", expected: "evarate" },
	{ input: "https://vpzone.tv/chat-dock/evarate", expected: "evarate" },
	{ input: "https://vpzone.tv/?channel=evarate", expected: "evarate" },
	{ input: "https://vpzone.tv/?username=Ashaelon", expected: "Ashaelon" },
	{ input: "https://kick.com/popout/xqc/chat", expected: "xqc" },
	{ input: "https://kick.com/xqc/chatroom", expected: "xqc" },
	{ input: "https://kick.com/some-name", expected: "some-name" },
	{ input: "https://kick.com/popout/Some-Name/chat?foo=1", expected: "Some-Name" },
	{ input: "https://kick.com/channel/someone", expected: "someone" },
	{ input: "https://www.twitch.tv/popout/someone/chat", expected: "someone" },
	{ input: "https://www.twitch.tv/someone", expected: "someone" },
	{ input: "https://player.twitch.tv/?channel=SomeUser&parent=localhost", expected: "SomeUser" },
	{ input: "https://rumble.com/c/MyChannel/live", expected: "MyChannel" },
	{ input: "https://rumble.com/user/MyUser/live", expected: "MyUser" },
	{ input: "https://rumble.com/chat/popup/123456789", expected: "123456789" },
	{ input: "https://joystick.tv/u/Streamer/chat", expected: "Streamer" },
	{ input: "https://example.com/watch/alice", expected: "alice" },
	{ input: "https://example.com/view/bob", expected: "bob" },
	{ input: "https://example.com/play/carla", expected: "carla" },
	{ input: "https://example.com/stream/dan/chat", expected: "dan" },
	{ input: "https://example.com/events/erin/chat", expected: "erin" },
	{ input: "https://example.com/app/live/frank", expected: "frank" },
	{ input: "https://example.com/studio/channel/gina", expected: "gina" },
	{ input: "https://example.com/profiles/hank/videos", expected: "hank" },
	{ input: "https://example.com/live/room/ivy", expected: "ivy" },
	{ input: "https://example.com/@jess/live", expected: "jess" },
	{ input: "https://www.tiktok.com/@souzaxx.nx/live", expected: "souzaxx.nx" },
	{ input: "www.tiktok.com/@Some.User/live", expected: "Some.User" },
	{ input: "https://example.com/?streamUsername=kyle", expected: "kyle" },
	{ input: "https://example.com/?room=room-42", expected: "room-42" },
	{ input: "https://example.com/?handle=@lena", expected: "lena" },
	{ input: "https://example.com/?slug=slug-name", expected: "slug-name" },
	{ input: "https://example.com/?channel_name=SnakeChannel", expected: "SnakeChannel" },
	{ input: "https://example.com/?user_name=SnakeUser", expected: "SnakeUser" },
	{ input: "https://example.com/?streamerName=CamelStreamer", expected: "CamelStreamer" },
	{ input: "https://example.com/?room_id=SnakeRoom", expected: "SnakeRoom" },
	{ input: "https://example.com/watch", expected: "" },
	{ input: "https://example.com/chat", expected: "" },
	{ input: "https://example.com/index.html", expected: "" },
	{ input: "https://example.com/watch/example", expected: "" },
	{ input: "https://foo.example.com/watch/foo", expected: "foo" },
	{ input: "https://example.com/source/websocket/watch/mona", expected: "mona" },
	{ input: "https://example.com/only-chat/nora", expected: "nora" },
	{ input: "https://example.com/broadcast/oscar/live", expected: "oscar" },
	{ input: "https://example.com/player/channel/pat", expected: "pat" }
], extractSourceUrlIdentifier);

runCases("normalizeTikTokUsernameInput", [
	{ input: "souzaxx", expected: "souzaxx" },
	{ input: "@souzaxx", expected: "souzaxx" },
	{ input: "@souzaxx.nx", expected: "souzaxx.nx" },
	{ input: "souzaxx.nx/live", expected: "souzaxx.nx" },
	{ input: "@souzaxx.nx/live", expected: "souzaxx.nx" },
	{ input: "https://www.tiktok.com/@Some.User", expected: "Some.User" },
	{ input: "https://www.tiktok.com/@souzaxx.nx/live", expected: "souzaxx.nx" },
	{ input: "https://m.tiktok.com/@mobile_user/live", expected: "mobile_user" },
	{ input: "www.tiktok.com/@Some.User/live?lang=en", expected: "Some.User" },
	{ input: "https://www.tiktok.com/@alice/live?room_id=123", expected: "alice" },
	{ input: "https://www.tiktok.com/@alice/live?user=bob", expected: "alice" },
	{ input: "www.tiktok.com/@Some.User/live?room_id=123&user=wrong", expected: "Some.User" },
	{ input: "https://www.tiktok.com/live?room_id=123", expected: "" },
	{ input: "https://www.tiktok.com/live?user=queryUser", expected: "queryUser" },
	{ input: "https://www.tiktok.com/live", expected: "" },
	{ input: "https://www.tiktok.com/t/ZPRandom/", expected: "" },
	{ input: "https://kick.com/someone", expected: "" },
	{ input: "kick.com/someone", expected: "" },
	{ input: "https://www.tiktok.com/@https://www.tiktok.com/@nested/live", expected: "" },
	{ input: "bad-user", expected: "" }
], normalizeTikTokUsernameInput);

runCases("isValidTikTokUsername", [
	{ input: "souzaxx", expected: true },
	{ input: "@souzaxx", expected: true },
	{ input: "souzaxx.nx", expected: true },
	{ input: "some_user.123", expected: true },
	{ input: "bad-user", expected: false },
	{ input: "https://www.tiktok.com/@souzaxx", expected: false },
	{ input: "www.tiktok.com", expected: false }
], isValidTikTokUsername);

runCases("normalizeVpzoneChannel", [
	{ input: "https://vpzone.tv/watch/Ashaelon", expected: "ashaelon" },
	{ input: "vpzone.tv/watch/evarate", expected: "evarate" },
	{ input: "https://vpzone.tv/?channel=Evarate", expected: "evarate" },
	{ input: "vpzone", expected: "" },
	{ input: "vpzone.tv", expected: "" },
	{ input: "@Ashaelon", expected: "ashaelon" }
], normalizeVpzoneChannel);

const explicitCases = [
	{
		name: "channel beats hostname label",
		source: { username: "example.com", channel: "real-user" },
		url: "https://example.com/watch/other-user",
		expected: "real-user"
	},
	{
		name: "username works when not hostname-derived",
		source: { username: "manualName" },
		url: "https://example.com/watch/urlName",
		expected: "manualName"
	},
	{
		name: "hostname-derived username ignored",
		source: { username: "example.com" },
		url: "https://example.com/watch/urlName",
		expected: ""
	},
	{
		name: "room id works",
		source: { username: "example.com", roomId: "room-7" },
		url: "https://example.com/watch/urlName",
		expected: "room-7"
	},
	{
		name: "snake case channel works",
		source: { username: "example.com", channel_name: "snake-channel" },
		url: "https://example.com/watch/urlName",
		expected: "snake-channel"
	},
	{
		name: "camel case streamer works",
		source: { username: "example.com", streamerName: "camel-streamer" },
		url: "https://example.com/watch/urlName",
		expected: "camel-streamer"
	}
];
for (const testCase of explicitCases) {
	assert.strictEqual(
		getExplicitSourceIdentifier(testCase.source, testCase.url),
		testCase.expected,
		`getExplicitSourceIdentifier: ${testCase.name}`
	);
}
console.log(`getExplicitSourceIdentifier: ${explicitCases.length} cases passed`);

const channelCases = [
	{
		name: "old VPZONE hostname label recovers URL channel",
		source: { target: "vpzone", username: "vpzone.tv", url: "https://vpzone.tv/watch/evarate" },
		expected: "evarate"
	},
	{
		name: "VPZONE uppercase stored name lowercases",
		source: { target: "vpzone", username: "Ashaelon", url: "https://vpzone.tv/watch/Ashaelon" },
		expected: "ashaelon"
	},
	{
		name: "hostname label replaced by URL identifier",
		source: { target: "kick", username: "kick.com", url: "https://kick.com/popout/xqc/chat" },
		expected: "xqc"
	},
	{
		name: "manual username beats URL identifier",
		source: { target: "kick", username: "manualName", url: "https://kick.com/popout/urlName/chat" },
		expected: "manualName"
	},
	{
		name: "explicit channel beats username",
		source: { target: "future", username: "future.tv", channel: "real-channel", url: "https://future.tv/watch/url-channel" },
		expected: "real-channel"
	},
	{
		name: "generic future websocket source gets URL identifier",
		source: { target: "future", username: "future.tv", url: "https://future.tv/events/real-channel/chat" },
		expected: "real-channel"
	},
	{
		name: "plain username fallback when URL is empty",
		source: { target: "future", username: "plainUser", url: "" },
		expected: "plainUser"
	},
	{
		name: "query channel beats path",
		source: { target: "future", username: "future.tv", url: "https://future.tv/watch/pathUser?channel=queryUser" },
		expected: "queryUser"
	}
];
for (const testCase of channelCases) {
	assert.strictEqual(getWebSocketChannelForSource(testCase.source), testCase.expected, `getWebSocketChannelForSource: ${testCase.name}`);
}
console.log(`getWebSocketChannelForSource: ${channelCases.length} cases passed`);

const scriptCases = [
	{
		name: "classic saved source file falls back to websocket script",
		source: { target: "vpzone", sourceFile: "sources/vpzone.js" },
		target: "vpzone",
		expected: "sources/websocket/vpzone.js"
	},
	{
		name: "matching websocket script is preserved",
		source: { target: "kick", sourceFile: "sources/websocket/kick.js" },
		target: "kick",
		expected: "sources/websocket/kick.js"
	},
	{
		name: "mismatched websocket script is rejected",
		source: { target: "kick", sourceFile: "sources/websocket/twitch.js" },
		target: "kick",
		expected: "sources/websocket/kick.js"
	},
	{
		name: "bilibilicom maps to bilibili websocket script",
		source: { target: "bilibilicom", sourceFile: "sources/bilibilicom.js" },
		target: "bilibili",
		expected: "sources/websocket/bilibili.js"
	}
];
for (const testCase of scriptCases) {
	assert.strictEqual(
		getWebSocketScriptPathForSource(testCase.source, testCase.target),
		testCase.expected,
		`getWebSocketScriptPathForSource: ${testCase.name}`
	);
}
console.log(`getWebSocketScriptPathForSource: ${scriptCases.length} cases passed`);

const launchCases = [
	{
		name: "VPZONE launch plan",
		source: { target: "vpzone", username: "vpzone.tv", url: "https://vpzone.tv/watch/evarate", sourceFile: "sources/vpzone.js" },
		options: {},
		expected: {
			websocketTarget: "vpzone",
			scriptPath: "sources/websocket/vpzone.js",
			queryParams: { channel: "evarate", ssapp: "1" }
		}
	},
	{
		name: "Rumble tracker launch plan",
		source: { target: "rumble", username: "rumble.com", url: "https://rumble.com/c/MyChannel/live", rumbleApiTracker: true },
		options: { devmode: true },
		expected: {
			websocketTarget: "rumble",
			scriptPath: "sources/websocket/rumble.js",
			queryParams: { channel: "MyChannel", followerMode: "total", tracker: "1", devmode: "", ssapp: "1" }
		}
	},
	{
		name: "YouTube shorts maps to YouTube websocket target",
		source: { target: "youtubeshorts", username: "SomeChannel", url: "" },
		options: {},
		expected: {
			websocketTarget: "youtube",
			scriptPath: "sources/websocket/youtube.js",
			queryParams: { channel: "SomeChannel", ssapp: "1" }
		}
	},
	{
		name: "mismatched saved websocket script does not leak",
		source: { target: "kick", username: "kick.com", url: "https://kick.com/popout/xqc/chat", sourceFile: "sources/websocket/twitch.js" },
		options: {},
		expected: {
			websocketTarget: "kick",
			scriptPath: "sources/websocket/kick.js",
			queryParams: { channel: "xqc", ssapp: "1" }
		}
	}
];
for (const testCase of launchCases) {
	assert.deepStrictEqual(
		JSON.parse(JSON.stringify(buildWebSocketLaunchPlan(testCase.source, testCase.options))),
		testCase.expected,
		`buildWebSocketLaunchPlan: ${testCase.name}`
	);
}
console.log(`buildWebSocketLaunchPlan: ${launchCases.length} cases passed`);

console.log("source URL parsing regression checks passed");
