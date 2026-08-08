const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");

function extractObjectLiteral(text, objectStart) {
	const braceStart = text.indexOf("{", objectStart);
	let depth = 0;
	let quote = "";
	let escaped = false;
	for (let index = braceStart; index < text.length; index += 1) {
		const character = text[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = "";
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			continue;
		}
		if (character === "{") depth += 1;
		if (character === "}" && --depth === 0) return text.slice(braceStart, index + 1);
	}
	throw new Error("Translation object was not closed");
}

function readObject(declaration) {
	const start = html.indexOf(declaration);
	assert.ok(start >= 0, `Missing ${declaration}`);
	return Function(`"use strict"; return (${extractObjectLiteral(html, start)});`)();
}

const translations = readObject("const translations = {");
const patches = readObject("const translationPatches = {");
const coverage = readObject("const translationCoveragePatches = {");
const languageMap = readObject("const appTranslationLanguageMap = {");
const optionValues = Array.from(
	html.matchAll(/<option value="(en-us|en-uk|pt-br|ar|es|fr|de|cs|th|zh-CN|zh-TW|tr|uk|test)"/g),
	(match) => match[1]
);
const expectedOptions = ["en-us", "en-uk", "pt-br", "ar", "es", "fr", "de", "cs", "th", "zh-CN", "zh-TW", "tr", "uk", "test"];
assert.deepStrictEqual(optionValues, expectedOptions, "Language selector options changed unexpectedly");

const english = { ...translations.en, ...patches.en, ...coverage.en };
for (const option of optionValues) {
	const normalized = option === "pt-br" ? "pt-BR" : option;
	const localeName = languageMap[normalized] || languageMap[option] || normalized;
	const locale = { ...translations[localeName], ...patches[localeName], ...coverage[localeName] };
	for (const key of Object.keys(english)) {
		assert.ok(Object.prototype.hasOwnProperty.call(locale, key), `${option} is missing Electron translation: ${key}`);
		assert.ok(typeof locale[key] === "string" && locale[key].length > 0, `${option} has an empty Electron translation: ${key}`);
		assert.ok(!/__SSN(?:HOLD|ITEM)_/.test(locale[key]), `${option} contains a generator marker: ${key}`);
		assert.strictEqual(
			(locale[key].match(/\n/g) || []).length,
			(english[key].match(/\n/g) || []).length,
			`${option} accidentally joined separate Electron translations: ${key}`
		);
	}
}

const inlineScripts = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi));
assert.ok(inlineScripts.length > 0, "Expected inline Electron renderer scripts");
inlineScripts.forEach((match) => new Function(match[1]));

console.log(`PASS Electron translation coverage for ${optionValues.length} language options`);
