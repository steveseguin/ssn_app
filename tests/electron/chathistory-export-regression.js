#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..', '..');
const files = [
	path.join(repoRoot, 'chathistory.js'),
	path.resolve(repoRoot, '..', 'social_stream', 'chathistory.js'),
];

function extractFunction(source, name) {
	const start = source.indexOf(`function ${name}`);
	assert(start >= 0, `Missing function ${name}`);
	const open = source.indexOf('{', start);
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		if (source[index] === '{') depth += 1;
		if (source[index] === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(start, index + 1);
		}
	}
	throw new Error(`Unable to extract function ${name}`);
}

for (const filePath of files) {
	const source = fs.readFileSync(filePath, 'utf8');
	const context = {};
	vm.createContext(context);
	vm.runInContext(`${extractFunction(source, 'formatTsvField')}\nthis.formatTsvField = formatTsvField;`, context);
	const format = context.formatTsvField;
	assert.strictEqual(format('plain text'), 'plain text');
	assert.strictEqual(format('hello\tthere\nnext'), 'hello there next');
	assert.strictEqual(format('=2+2'), "'=2+2");
	assert.strictEqual(format('  +SUM(A1:A2)'), "'  +SUM(A1:A2)");
	assert.strictEqual(format('-10+20'), "'-10+20");
	assert.strictEqual(format('@IMPORTXML("https://example.test")'), "'@IMPORTXML(\"https://example.test\")");
}

console.log('Chat history TSV export regression checks passed for SSApp and Social Stream sources.');
