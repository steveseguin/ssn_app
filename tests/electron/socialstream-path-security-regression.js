'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');

function extractFunctionSource(source, functionName) {
	const signature = `function ${functionName}(`;
	const startIndex = source.indexOf(signature);
	if (startIndex === -1) {
		throw new Error(`Could not find function: ${functionName}`);
	}

	let braceDepth = 0;
	let inString = false;
	let stringQuote = '';
	let escaped = false;
	let bodyStarted = false;

	for (let i = startIndex; i < source.length; i += 1) {
		const char = source[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === '\\') {
				escaped = true;
				continue;
			}
			if (char === stringQuote) {
				inString = false;
				stringQuote = '';
			}
			continue;
		}

		if (char === '"' || char === '\'' || char === '`') {
			inString = true;
			stringQuote = char;
			continue;
		}

		if (char === '{') {
			braceDepth += 1;
			bodyStarted = true;
			continue;
		}

		if (char === '}') {
			braceDepth -= 1;
			if (bodyStarted && braceDepth === 0) {
				return source.slice(startIndex, i + 1);
			}
		}
	}

	throw new Error(`Could not determine end of function: ${functionName}`);
}

function isInside(rootDir, targetPath) {
	const root = path.resolve(rootDir);
	const target = path.resolve(targetPath);
	const relative = path.relative(root, target);
	return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function createHarness() {
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-socialstream-cache-'));
	const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-socialstream-resources-'));
	const context = vm.createContext({
		path,
		process: {
			resourcesPath
		},
		__dirname: repoRoot,
		app: {
			getPath(name) {
				assert.strictEqual(name, 'userData');
				return userDataDir;
			}
		},
		SOCIAL_STREAM_CACHE_DIR: 'social_stream_cache',
		SOCIAL_STREAM_FALLBACK_DIR: 'social_stream_fallback',
		SOCIAL_STREAM_ALLOWED_BRANCHES: new Set(['main', 'beta'])
	});

	const functions = [
		'normalizeSocialStreamBranch',
		'normalizeSocialStreamRelativePath',
		'isPathInsideDirectory',
		'resolvePathInsideRoot',
		'getSocialStreamCachePath',
		'getCandidateBundledPaths'
	];
	const scriptSource = functions.map((name) => extractFunctionSource(mainSource, name)).join('\n');
	new vm.Script(`${scriptSource}\nthis.__test = { ${functions.join(', ')} };`).runInContext(context);

	return {
		userDataDir,
		resourcesPath,
		api: context.__test
	};
}

function testBranchNormalization(api) {
	assert.strictEqual(api.normalizeSocialStreamBranch('main'), 'main');
	assert.strictEqual(api.normalizeSocialStreamBranch('beta'), 'beta');
	assert.strictEqual(api.normalizeSocialStreamBranch(' BETA '), 'beta');
	assert.strictEqual(api.normalizeSocialStreamBranch('../beta'), 'main');
	assert.strictEqual(api.normalizeSocialStreamBranch('main/../../outside'), 'main');
	assert.strictEqual(api.normalizeSocialStreamBranch(''), 'main');
	assert.strictEqual(api.normalizeSocialStreamBranch(null), 'main');
}

function testCachePathsStayInsideBranchRoot(harness) {
	const { userDataDir, api } = harness;
	const mainRoot = path.join(userDataDir, 'social_stream_cache', 'main');
	const betaRoot = path.join(userDataDir, 'social_stream_cache', 'beta');

	const maliciousBranchPath = api.getSocialStreamCachePath('../../outside', 'settings/config.json');
	assert(isInside(mainRoot, maliciousBranchPath), 'malicious branch must resolve inside main cache root');
	assert(!maliciousBranchPath.includes(`social_stream_cache${path.sep}..`), 'cache path must not retain branch traversal');

	const betaPath = api.getSocialStreamCachePath('beta', 'sources/websocket/youtube.html');
	assert(isInside(betaRoot, betaPath), 'beta branch must resolve inside beta cache root');

	const traversalRelativePath = api.getSocialStreamCachePath('beta', '../../outside.txt');
	assert(isInside(betaRoot, traversalRelativePath), 'relative traversal must remain inside selected cache root');
}

function testBundledPathsStayInsideBranchRoots(harness) {
	const { resourcesPath, api } = harness;
	const candidates = api.getCandidateBundledPaths('..\\..\\outside', '..\\manifest.json');
	assert(candidates.length > 0, 'expected bundled candidates');

	const allowedRoots = [
		path.join(resourcesPath, 'social_stream_fallback', 'main'),
		path.join(resourcesPath, 'app.asar.unpacked', 'social_stream_fallback', 'main'),
		path.join(resourcesPath, 'app.asar.unpacked', 'resources', 'social_stream_fallback', 'main'),
		path.join(repoRoot, 'resources', 'social_stream_fallback', 'main'),
		path.join(repoRoot, 'social_stream_fallback', 'main')
	];

	for (const candidate of candidates) {
		assert(
			allowedRoots.some((root) => isInside(root, candidate)),
			`bundled candidate escaped expected roots: ${candidate}`
		);
	}

	const betaCandidates = api.getCandidateBundledPaths('beta', 'settings/config.json');
	assert(
		betaCandidates.every((candidate) => candidate.includes(`${path.sep}social_stream_fallback${path.sep}beta${path.sep}`)),
		'beta candidates should stay under beta fallback roots'
	);
}

function run() {
	const harness = createHarness();
	testBranchNormalization(harness.api);
	testCachePathsStayInsideBranchRoot(harness);
	testBundledPathsStayInsideBranchRoots(harness);
	console.log('socialstream-path-security-regression: all checks passed');
}

run();
