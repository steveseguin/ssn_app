"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..", "..");
const libsSource = fs.readFileSync(path.join(repoRoot, "libs.js"), "utf8");
const indexSource = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");

function extractFunction(source, name) {
	const start = source.indexOf(`function ${name}`);
	assert(start >= 0, `Missing function ${name}`);
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		if (source[i] === "{") depth += 1;
		else if (source[i] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`Unable to extract function ${name}`);
}

const context = {
	manifest: {
		content_scripts: [
			{ matches: ["discord"], js: ["./sources/discord.js"] },
			{ matches: ["discord"], js: ["./thirdparty/vdoninja-sdk.js", "./sources/capturevideo.js"] },
			{ matches: ["velora"], js: ["./shared/vendor/socket.io.min.js", "./sources/websocket/velora.js"] }
		]
	},
	log() {},
	matchRuleShort(value, rule) {
		return value === rule;
	}
};

vm.createContext(context);
vm.runInContext([
	extractFunction(libsSource, "checkSupported"),
	extractFunction(libsSource, "mergeSavedSourceFilesWithManifest"),
	"this.helpers = { checkSupported, mergeSavedSourceFilesWithManifest };"
].join("\n\n"), context);

const { checkSupported, mergeSavedSourceFilesWithManifest } = context.helpers;

assert.deepStrictEqual(Array.from(checkSupported("discord")), [
	"./sources/discord.js",
	"./thirdparty/vdoninja-sdk.js",
	"./sources/capturevideo.js"
]);

assert.deepStrictEqual(Array.from(mergeSavedSourceFilesWithManifest("discord", [
	"sources/discord.js",
	"sources/capturevideo.js"
])), [
	"sources/discord.js",
	"thirdparty/vdoninja-sdk.js",
	"sources/capturevideo.js"
]);

assert.deepStrictEqual(Array.from(mergeSavedSourceFilesWithManifest("discord", [
	"sources/discord.js",
	"thirdparty/vdoninja-sdk.js"
])), [
	"sources/discord.js",
	"thirdparty/vdoninja-sdk.js",
	"sources/capturevideo.js"
]);

assert.deepStrictEqual(Array.from(checkSupported("velora")), [
	"./shared/vendor/socket.io.min.js",
	"./sources/websocket/velora.js"
]);

assert.deepStrictEqual(Array.from(mergeSavedSourceFilesWithManifest("discord", [])), []);
assert.match(indexSource, /sourceFiles = mergeSavedSourceFilesWithManifest\(urlToLoad, sourceFiles\);/);

console.log("manifest-script-order-regression: PASS");
