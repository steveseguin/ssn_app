#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const mainSource = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(repoRoot, 'preload.js'), 'utf8');
const macosWorkflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-macos.yml'), 'utf8');
const { getTrustedStandaloneCustomJsPageType } = require('../../resources/custom-js-page-trust');

function extractFunctionSource(source, functionName) {
	const signature = `function ${functionName}(`;
	const startIndex = source.indexOf(signature);
	assert(startIndex >= 0, `Could not find function: ${functionName}`);

	let braceDepth = 0;
	let parenthesisDepth = 0;
	let bodyStarted = false;
	let inString = false;
	let quote = '';
	let escaped = false;
	for (let i = startIndex; i < source.length; i += 1) {
		const character = source[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === '\\') {
				escaped = true;
				continue;
			}
			if (character === quote) {
				inString = false;
				quote = '';
			}
			continue;
		}
		if (character === '"' || character === "'" || character === '`') {
			inString = true;
			quote = character;
			continue;
		}
		if (!bodyStarted && character === '(') {
			parenthesisDepth += 1;
			continue;
		}
		if (!bodyStarted && character === ')') {
			parenthesisDepth -= 1;
			continue;
		}
		if (character === '{' && (bodyStarted || parenthesisDepth === 0)) {
			braceDepth += 1;
			bodyStarted = true;
		} else if (bodyStarted && character === '}') {
			braceDepth -= 1;
			if (bodyStarted && braceDepth === 0) return source.slice(startIndex, i + 1);
		}
	}
	throw new Error(`Could not determine end of function: ${functionName}`);
}

function testCustomJsTrustBoundary() {
	const preloadTrustListStart = preloadSource.indexOf('const trustedStandaloneCustomJsHostnames');
	const preloadTrustFunctionStart = preloadSource.indexOf('function getStandaloneCustomJsPageType(');
	assert(preloadTrustListStart >= 0 && preloadTrustFunctionStart > preloadTrustListStart, 'preload custom.js trust checker is missing');
	const preloadContext = vm.createContext({
		URL,
		Set,
		window: { location: { href: '' } }
	});
	new vm.Script([
		preloadSource.slice(preloadTrustListStart, preloadTrustFunctionStart),
		extractFunctionSource(preloadSource, 'getStandaloneCustomJsPageType'),
		'this.getPageType = getStandaloneCustomJsPageType;'
	].join('\n')).runInContext(preloadContext);

	const trustedCases = new Map([
		['file:///C:/social_stream/dock.html', 'dock'],
		['file:///tmp/social_stream/path/featured.html?test=1', 'featured'],
		['http://127.0.0.1:8080/bot.html', 'bot'],
		['http://localhost:3000/path/dock.html#test', 'dock'],
		['https://socialstream.ninja/featured.html', 'featured'],
		['https://cache.socialstream.ninja/path/bot.html', 'bot'],
		['https://beta.socialstream.ninja/dock.html', 'dock']
	]);
	for (const [url, expectedType] of trustedCases) {
		assert.strictEqual(getTrustedStandaloneCustomJsPageType(url), expectedType, `Expected trusted custom.js URL: ${url}`);
		preloadContext.window.location.href = url;
		assert.strictEqual(preloadContext.getPageType(), expectedType, `Expected trusted preload custom.js URL: ${url}`);
	}

	const rejectedCases = [
		'https://example.com/dock.html',
		'https://socialstream.ninja.evil.example/dock.html',
		'https://evil.socialstream.ninja/dock.html',
		'https://cache.socialstream.ninja.evil.example/bot.html',
		'http://127.0.0.2/dock.html',
		'data:text/html,/dock.html',
		'https://socialstream.ninja/not-dock.html',
		'https://socialstream.ninja/dock.html/extra',
		'file:///C:/social_stream/index.html'
	];
	for (const url of rejectedCases) {
		assert.strictEqual(getTrustedStandaloneCustomJsPageType(url), '', `Expected rejected custom.js URL: ${url}`);
		preloadContext.window.location.href = url;
		assert.strictEqual(preloadContext.getPageType(), '', `Expected rejected preload custom.js URL: ${url}`);
	}

	for (const hostname of ['127.0.0.1', 'localhost', 'socialstream.ninja', 'cache.socialstream.ninja', 'beta.socialstream.ninja']) {
		assert(preloadSource.includes(`'${hostname}'`), `preload trust list is missing ${hostname}`);
	}
	assert.match(preloadSource, /trustedStandaloneCustomJsHostnames\.has\(hostname\)/);
	const readHandlerStart = mainSource.indexOf('ipcMain.handle("ssapp:read-custom-js-file"');
	const nextHandlerStart = mainSource.indexOf('ipcMain.handle(', readHandlerStart + 1);
	const readHandlerSource = mainSource.slice(readHandlerStart, nextHandlerStart > readHandlerStart ? nextHandlerStart : undefined);
	assert.match(readHandlerSource, /event\?\.senderFrame\?\.url/);
	assert.match(readHandlerSource, /getTrustedStandaloneCustomJsPageType\(senderUrl\)/);
	assert(
		readHandlerSource.indexOf('getTrustedStandaloneCustomJsPageType(senderUrl)') < readHandlerSource.indexOf('getCustomJsFileState()'),
		'trust check must run before custom.js state or file contents are read'
	);
}

async function testHiddenRendererYield() {
	let animationFrameCalls = 0;
	const context = vm.createContext({
		document: { hidden: true },
		requestAnimationFrame() {
			animationFrameCalls += 1;
		},
		setTimeout,
		clearTimeout
	});
	new vm.Script(`${extractFunctionSource(indexSource, 'waitForNextRender')}\nthis.waitForNextRender = waitForNextRender;`).runInContext(context);

	const hiddenStarted = Date.now();
	await context.waitForNextRender();
	assert(Date.now() - hiddenStarted < 500, 'hidden renderer yield should use a timer without waiting for a frame');
	assert.strictEqual(animationFrameCalls, 0, 'hidden renderer should not schedule a suspended animation frame');

	context.document.hidden = false;
	context.requestAnimationFrame = () => {
		animationFrameCalls += 1;
	};
	const fallbackStarted = Date.now();
	await context.waitForNextRender();
	const fallbackElapsed = Date.now() - fallbackStarted;
	assert(fallbackElapsed >= 75 && fallbackElapsed < 1000, `visible renderer fallback took ${fallbackElapsed}ms`);

	let frameCallbackRan = false;
	context.requestAnimationFrame = callback => setTimeout(() => {
		frameCallbackRan = true;
		callback();
	}, 0);
	const frameStarted = Date.now();
	await context.waitForNextRender();
	assert.strictEqual(frameCallbackRan, true, 'normal renderer yield should use requestAnimationFrame');
	assert(Date.now() - frameStarted < 500, 'normal animation-frame yield should not stall');
}

function createMockSourceWindow(options = {}) {
	const state = {
		bounds: { ...(options.bounds || { x: 120, y: 80, width: 900, height: 600 }) },
		visible: options.visible !== false,
		minimized: options.minimized === true,
		skipTaskbar: false,
		minimizeWorks: options.minimizeWorks !== false,
		hideWorks: options.hideWorks !== false
	};
	const view = {
		__ss_visible: options.logicalVisible !== false,
		__prevBounds: options.previousBounds ? { ...options.previousBounds } : null,
		getBounds: () => ({ ...state.bounds }),
		setBounds: bounds => { state.bounds = { ...bounds }; },
		setSkipTaskbar: value => { state.skipTaskbar = !!value; },
		isVisible: () => state.visible,
		showInactive: () => { state.visible = true; },
		show: () => { state.visible = true; },
		minimize: () => {
			if (state.minimizeWorks) state.minimized = true;
		},
		isMinimized: () => state.minimized,
		restore: () => {
			state.minimized = false;
			state.visible = true;
		},
		hide: () => {
			if (state.hideWorks) state.visible = false;
		}
	};
	return { view, state };
}

function testLinuxWindowVisibility() {
	let parkCalls = 0;
	let parkResult = true;
	const context = vm.createContext({
		process: { platform: 'linux' },
		isBrowserViewDestroyed: () => false,
		parkSourceWindowOffscreen: () => {
			parkCalls += 1;
			return parkResult;
		},
		sourceWindowIntersectsVirtualScreen: bounds => !!bounds && bounds.x > -5000 && bounds.x < 5000
	});
	new vm.Script([
		extractFunctionSource(mainSource, 'stealthHideView'),
		extractFunctionSource(mainSource, 'stealthShowView'),
		'this.visibility = { stealthHideView, stealthShowView };'
	].join('\n')).runInContext(context);

	const normal = createMockSourceWindow();
	assert.strictEqual(context.visibility.stealthHideView(normal.view), true);
	assert.strictEqual(normal.state.minimized, true, 'Linux hide should minimize the source window');
	assert.strictEqual(normal.view.__ss_visible, false);
	assert.strictEqual(normal.state.skipTaskbar, true);
	assert.strictEqual(parkCalls, 0, 'Linux hide must not rely on off-screen parking');
	assert.strictEqual(context.visibility.stealthShowView(normal.view), true);
	assert.strictEqual(normal.state.minimized, false);
	assert.strictEqual(normal.state.visible, true);
	assert.strictEqual(normal.view.__ss_visible, true);
	assert.deepStrictEqual(normal.state.bounds, { x: 120, y: 80, width: 900, height: 600 });

	const parked = createMockSourceWindow({
		bounds: { x: -20000, y: -20000, width: 900, height: 600 },
		previousBounds: { x: 200, y: 150, width: 800, height: 500 },
		minimized: true,
		logicalVisible: false
	});
	assert.strictEqual(context.visibility.stealthShowView(parked.view), true);
	assert.deepStrictEqual(parked.state.bounds, { x: 200, y: 150, width: 800, height: 500 });
	assert.strictEqual(parked.view.__ss_visible, true, 'reveal should report visible only after restoring on-screen bounds');

	const minimizeRejected = createMockSourceWindow({ minimizeWorks: false });
	assert.strictEqual(context.visibility.stealthHideView(minimizeRejected.view), true);
	assert.strictEqual(minimizeRejected.state.visible, false, 'Linux hide should fall back to native hide when minimize fails');
	assert.strictEqual(minimizeRejected.view.__ss_visible, false);

	const hideRejected = createMockSourceWindow({ minimizeWorks: false, hideWorks: false });
	assert.strictEqual(context.visibility.stealthHideView(hideRejected.view), false);
	assert.strictEqual(hideRejected.view.__ss_visible, true, 'failed hide must not claim the window is hidden');
	assert.strictEqual(hideRejected.state.skipTaskbar, false);

	context.process.platform = 'win32';
	const windowsView = createMockSourceWindow();
	parkResult = true;
	assert.strictEqual(context.visibility.stealthHideView(windowsView.view), true);
	assert.strictEqual(windowsView.view.__ss_visible, false);
	assert.strictEqual(parkCalls, 1, 'non-Linux hide should continue using verified off-screen parking');
}

function testMacosCheckoutFallback() {
	assert.match(macosWorkflow, /id:\s*checkout_with_submodules/);
	assert.match(macosWorkflow, /if:\s*steps\.checkout_with_submodules\.outcome\s*==\s*'failure'/);
	const fallbackStart = macosWorkflow.indexOf('- name: Checkout code (fallback without submodules)');
	const fallbackEnd = macosWorkflow.indexOf('\n      - name:', fallbackStart + 1);
	const fallbackStep = macosWorkflow.slice(fallbackStart, fallbackEnd > fallbackStart ? fallbackEnd : undefined);
	assert.doesNotMatch(fallbackStep, /if:\s*failure\(\)/);
}

async function run() {
	testCustomJsTrustBoundary();
	await testHiddenRendererYield();
	testLinuxWindowVisibility();
	testMacosCheckoutFallback();
	console.log('review-fixes-regression: all checks passed');
}

run().catch(error => {
	console.error(error);
	process.exit(1);
});
