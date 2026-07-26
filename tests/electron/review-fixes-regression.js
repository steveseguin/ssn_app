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
const headlessLauncherSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'start-headless.sh'), 'utf8');
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
	let inLineComment = false;
	let inBlockComment = false;
	for (let i = startIndex; i < source.length; i += 1) {
		const character = source[i];
		// Comments have to be skipped rather than scanned: an apostrophe in prose
		// ("the pump's timer") would otherwise look like the start of a string and swallow
		// the rest of the file.
		if (inLineComment) {
			if (character === '\n') inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (character === '*' && source[i + 1] === '/') {
				inBlockComment = false;
				i += 1;
			}
			continue;
		}
		if (!inString && character === '/' && source[i + 1] === '/') {
			inLineComment = true;
			i += 1;
			continue;
		}
		if (!inString && character === '/' && source[i + 1] === '*') {
			inBlockComment = true;
			i += 1;
			continue;
		}
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
	let wayland = false;
	let pumpInstalls = 0;
	const context = vm.createContext({
		process: { platform: 'linux' },
		isBrowserViewDestroyed: () => false,
		parkSourceWindowOffscreen: () => {
			parkCalls += 1;
			return parkResult;
		},
		sourceWindowIntersectsVirtualScreen: bounds => !!bounds && bounds.x > -5000 && bounds.x < 5000,
		isWaylandSession: () => wayland,
		installFramePump: () => { pumpInstalls += 1; }
	});
	new vm.Script([
		extractFunctionSource(mainSource, 'stealthHideView'),
		extractFunctionSource(mainSource, 'stealthShowView'),
		'this.visibility = { stealthHideView, stealthShowView };'
	].join('\n')).runInContext(context);

	// Linux hides for real. Minimizing left the window in the taskbar and pager, and on
	// Wayland it cannot be reversed reliably because there is no minimized state there.
	const normal = createMockSourceWindow();
	assert.strictEqual(context.visibility.stealthHideView(normal.view), true);
	assert.strictEqual(normal.state.visible, false, 'Linux hide should actually hide the source window');
	assert.strictEqual(normal.state.minimized, false, 'Linux hide should not minimize when hide() works');
	assert.strictEqual(normal.view.__ss_visible, false);
	assert.strictEqual(normal.state.skipTaskbar, true);
	assert.strictEqual(parkCalls, 0, 'Linux hide must not rely on off-screen parking');
	assert.strictEqual(pumpInstalls, 1, 'hiding should make sure the frame pump is installed');
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

	const hideRejected = createMockSourceWindow({ hideWorks: false });
	assert.strictEqual(context.visibility.stealthHideView(hideRejected.view), true);
	assert.strictEqual(hideRejected.state.minimized, true, 'minimize is the fallback when hide() is refused');
	assert.strictEqual(hideRejected.view.__ss_visible, false);

	const bothRejected = createMockSourceWindow({ minimizeWorks: false, hideWorks: false });
	assert.strictEqual(context.visibility.stealthHideView(bothRejected.view), false);
	assert.strictEqual(bothRejected.view.__ss_visible, true, 'failed hide must not claim the window is hidden');
	assert.strictEqual(bothRejected.state.skipTaskbar, false);

	// Wayland forbids programmatic positioning and reports every window at 0,0, so reveal
	// there must neither replay stored bounds nor judge success by an on-screen check.
	wayland = true;
	const waylandView = createMockSourceWindow({
		bounds: { x: 0, y: 0, width: 900, height: 600 },
		previousBounds: { x: 200, y: 150, width: 800, height: 500 },
		logicalVisible: false,
		visible: false
	});
	assert.strictEqual(context.visibility.stealthShowView(waylandView.view), true);
	assert.strictEqual(waylandView.state.visible, true);
	assert.strictEqual(waylandView.view.__ss_visible, true, 'Wayland reveal must not depend on window coordinates');
	assert.deepStrictEqual(
		waylandView.state.bounds,
		{ x: 0, y: 0, width: 900, height: 600 },
		'Wayland reveal should leave placement to the compositor'
	);
	wayland = false;

	context.process.platform = 'win32';
	const windowsView = createMockSourceWindow();
	parkResult = true;
	assert.strictEqual(context.visibility.stealthHideView(windowsView.view), true);
	assert.strictEqual(windowsView.view.__ss_visible, false);
	assert.strictEqual(parkCalls, 1, 'non-Linux hide should continue using verified off-screen parking');
}

// The frame pump replaces requestAnimationFrame on third-party chat pages, so its
// semantics have to match the real thing. None of this is observable from the end-to-end
// diagnostics, which can only see that callbacks keep arriving.
function testFramePumpSemantics() {
	const { FRAME_PUMP_SCRIPT } = require('../../hidden-window-keepalive');

	let clock = 1000;
	const intervals = [];
	const asyncThrows = [];
	let nativeQueue = [];
	let nativeHandleSeq = 1000;
	const nativeCancelled = [];

	const win = {
		requestAnimationFrame(callback) {
			nativeHandleSeq += 1;
			nativeQueue.push({ handle: nativeHandleSeq, callback });
			return nativeHandleSeq;
		},
		cancelAnimationFrame(handle) {
			nativeCancelled.push(handle);
		}
	};

	const context = vm.createContext({
		window: win,
		performance: { now: () => clock },
		setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
		clearInterval: () => { },
		setTimeout: (fn) => { asyncThrows.push(fn); return asyncThrows.length; },
		Map,
		Object,
		TypeError,
		Date
	});

	assert.strictEqual(vm.runInContext(FRAME_PUMP_SCRIPT, context), 'installed');
	assert.strictEqual(vm.runInContext(FRAME_PUMP_SCRIPT, context), 'already-installed', 'install must be idempotent');
	assert.strictEqual(intervals.length, 1, 'the pump should own exactly one interval');
	assert.notStrictEqual(win.requestAnimationFrame, undefined);

	const fireNativeFrame = () => {
		const pending = nativeQueue;
		nativeQueue = [];
		for (const entry of pending) entry.callback(clock);
	};
	const runPumpTick = () => intervals[0].fn();

	// A real frame delivers queued callbacks exactly once.
	let ranA = 0;
	win.requestAnimationFrame(() => { ranA += 1; });
	assert.strictEqual(nativeQueue.length, 1, 'a real frame should have been requested');
	fireNativeFrame();
	assert.strictEqual(ranA, 1);

	// With frames withheld, the timer delivers instead - but only once frames look stalled.
	let ranB = 0;
	win.requestAnimationFrame(() => { ranB += 1; });
	runPumpTick();
	assert.strictEqual(ranB, 0, 'the pump must not pre-empt frames that are still arriving');
	clock += 500;
	runPumpTick();
	assert.strictEqual(ranB, 1, 'the pump should deliver once frames are stalled');

	// The frame that eventually shows up must not re-run work the pump already did.
	fireNativeFrame();
	assert.strictEqual(ranB, 1, 'a late frame must not double-run pumped callbacks');

	// Re-registering from inside a callback lands in the next batch, not this one.
	let loops = 0;
	const loop = () => { loops += 1; win.requestAnimationFrame(loop); };
	win.requestAnimationFrame(loop);
	clock += 500;
	runPumpTick();
	assert.strictEqual(loops, 1, 're-registration must not run again in the same batch');
	clock += 500;
	runPumpTick();
	assert.strictEqual(loops, 2);

	// Cancelling before the batch runs.
	let cancelledRan = 0;
	const cancelMe = win.requestAnimationFrame(() => { cancelledRan += 1; });
	win.cancelAnimationFrame(cancelMe);
	clock += 500;
	runPumpTick();
	assert.strictEqual(cancelledRan, 0, 'a cancelled callback must not run');

	// Cancelling a sibling from inside the same batch, which native rAF honours.
	let siblingRan = 0;
	let siblingHandle = 0;
	win.requestAnimationFrame(() => { win.cancelAnimationFrame(siblingHandle); });
	siblingHandle = win.requestAnimationFrame(() => { siblingRan += 1; });
	clock += 500;
	runPumpTick();
	assert.strictEqual(siblingRan, 0, 'cancelling later work mid-batch must be honoured');

	// Handles the real API issued before we took over still reach the real API.
	win.cancelAnimationFrame(999);
	assert.deepStrictEqual(nativeCancelled, [999], 'unknown handles should fall through to the native API');

	// A throwing callback is reported, and does not stop the rest of the batch.
	let afterThrow = 0;
	win.requestAnimationFrame(() => { throw new Error('boom'); });
	win.requestAnimationFrame(() => { afterThrow += 1; });
	clock += 500;
	runPumpTick();
	assert.strictEqual(afterThrow, 1, 'one failing callback must not cancel the batch');
	assert.strictEqual(asyncThrows.length, 1, 'the error should still be reported asynchronously');
	assert.throws(() => asyncThrows[0](), /boom/);

	// A non-function argument fails the way the real API does.
	assert.throws(() => win.requestAnimationFrame('not a function'), TypeError);

	const stats = vm.runInContext('window.__ssnFramePump.stats()', context);
	assert(stats.nativeBatches >= 2, `expected native batches, got ${JSON.stringify(stats)}`);
	assert(stats.pumpedBatches >= 5, `expected pumped batches, got ${JSON.stringify(stats)}`);

	// Disposal puts the real functions back.
	vm.runInContext('window.__ssnFramePump.dispose()', context);
	assert.strictEqual(vm.runInContext('!!window.__ssnFramePump', context), false);
	let afterDispose = 0;
	win.requestAnimationFrame(() => { afterDispose += 1; });
	fireNativeFrame();
	assert.strictEqual(afterDispose, 1, 'dispose should restore the native implementation');
}

function testMacosCheckoutFallback() {
	assert.match(macosWorkflow, /id:\s*checkout_with_submodules/);
	assert.match(macosWorkflow, /if:\s*steps\.checkout_with_submodules\.outcome\s*==\s*'failure'/);
	const fallbackStart = macosWorkflow.indexOf('- name: Checkout code (fallback without submodules)');
	const fallbackEnd = macosWorkflow.indexOf('\n      - name:', fallbackStart + 1);
	const fallbackStep = macosWorkflow.slice(fallbackStart, fallbackEnd > fallbackStart ? fallbackEnd : undefined);
	assert.doesNotMatch(fallbackStep, /if:\s*failure\(\)/);
}

function testHeadlessLauncherLifecycle() {
	assert.match(
		headlessLauncherSource,
		/command -v xdpyinfo/,
		'the launcher should fail clearly when its X display probe is unavailable'
	);
	assert.doesNotMatch(
		headlessLauncherSource,
		/\bexec\s+"\$APP_BINARY"/,
		'exec would bypass the EXIT trap and leave the launcher-owned Xvfb running'
	);
	assert.match(headlessLauncherSource, /APP_PID=\$!/);
	assert.match(headlessLauncherSource, /if wait "\$APP_PID"/);
	assert.match(headlessLauncherSource, /trap cleanup EXIT/);
}

function testElectron43ApiCompatibility() {
	assert.doesNotMatch(
		mainSource,
		/const parsed = url\.parse\(req\.url, true\)/,
		'the local control server should use the WHATWG URL API on Electron 43'
	);
	assert.match(
		mainSource,
		/const requestUrl = new URL\(req\.url \|\| '\/', 'http:\/\/127\.0\.0\.1'\);/
	);
	assert.match(
		mainSource,
		/mainWindow\.webContents\.on\('console-message', \(event\) => \{[\s\S]*?event\?\.message/,
		'the main window should use Electron 43 console-message event details'
	);
}

async function run() {
	testCustomJsTrustBoundary();
	await testHiddenRendererYield();
	testLinuxWindowVisibility();
	testFramePumpSemantics();
	testMacosCheckoutFallback();
	testHeadlessLauncherLifecycle();
	testElectron43ApiCompatibility();
	console.log('review-fixes-regression: all checks passed');
}

run().catch(error => {
	console.error(error);
	process.exit(1);
});
