'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function readText(filePath) {
	return fs.readFileSync(filePath, 'utf8');
}

function extractFunctionSource(source, functionName) {
	const asyncSignature = `async function ${functionName}(`;
	const syncSignature = `function ${functionName}(`;
	const startIndex = source.indexOf(asyncSignature) !== -1
		? source.indexOf(asyncSignature)
		: source.indexOf(syncSignature);
	if (startIndex === -1) {
		throw new Error(`Could not find function: ${functionName}`);
	}

	let braceDepth = 0;
	let inString = false;
	let stringQuote = '';
	let escaped = false;
	let bodyStarted = false;
	let endIndex = -1;

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
				endIndex = i + 1;
				break;
			}
		}
	}

	if (endIndex === -1) {
		throw new Error(`Could not determine end of function: ${functionName}`);
	}

	return source.slice(startIndex, endIndex);
}

function createClassList() {
	return {
		values: [],
		add(value) {
			if (!this.values.includes(value)) {
				this.values.push(value);
			}
		}
	};
}

function createFrame(initialSrc = 'about:blank') {
	return {
		src: initialSrc,
		dataset: {},
		classList: createClassList()
	};
}

function createToastRecorder() {
	const calls = [];
	return {
		calls,
		warning(title, message) {
			calls.push({ level: 'warning', title, message });
		},
		error(title, message) {
			calls.push({ level: 'error', title, message });
		}
	};
}

function createConsoleRecorder() {
	const messages = [];
	return {
		messages,
		log(...args) {
			messages.push({ level: 'log', args });
		},
		warn(...args) {
			messages.push({ level: 'warn', args });
		},
		error(...args) {
			messages.push({ level: 'error', args });
		}
	};
}

async function instantiateFunction(functionSource, contextValues, functionName) {
	const context = vm.createContext({
		...contextValues
	});
	const script = new vm.Script(`${functionSource}\nthis.__fn = ${functionName};`, {
		filename: `${functionName}.diagnostic.js`
	});
	script.runInContext(context);
	return {
		context,
		fn: context.__fn
	};
}

async function testSetupIframeSource(indexSource) {
	const fnSource = extractFunctionSource(indexSource, 'setupIframeSource');
	const setupGlobals = { getLanguageExtraParams: () => [] };

	const successFrame = createFrame();
	const successToast = createToastRecorder();
	const successConsole = createConsoleRecorder();
	const successCalls = [];
	const successHarness = await instantiateFunction(fnSource, {
		...setupGlobals,
		currentLanguage: 'en-US',
		window: { initialEditorView: false },
		sourcemode: false,
		devmode: false,
		document: {
			getElementById(id) {
				return id === 'frame2' ? successFrame : null;
			}
		},
		resolveSocialStreamPage: async (pageName, options) => {
			successCalls.push({ pageName, options });
			return { url: 'https://socialstream.ninja/background.html?v=2', origin: 'remote' };
		},
		Toast: successToast,
		console: successConsole
	}, 'setupIframeSource');

	const successResult = await successHarness.fn();
	assert(successResult === true, 'setupIframeSource should return true when remote background resolves');
	assert(successFrame.src.includes('background.html'), 'setupIframeSource should assign background frame src on success');
	assert(successFrame.dataset.ssappOrigin === 'remote', 'setupIframeSource should record remote origin');
	assert(successToast.calls.length === 0, 'setupIframeSource should not toast on remote success');
	assert(successCalls.length === 1, 'setupIframeSource should resolve background once on remote success');

	const fallbackFrame = createFrame();
	const fallbackToast = createToastRecorder();
	const fallbackConsole = createConsoleRecorder();
	const fallbackCalls = [];
	const fallbackHarness = await instantiateFunction(fnSource, {
		...setupGlobals,
		currentLanguage: 'en-US',
		window: { initialEditorView: true },
		sourcemode: false,
		devmode: false,
		document: {
			getElementById(id) {
				return id === 'frame2' ? fallbackFrame : null;
			}
		},
		resolveSocialStreamPage: async (pageName, options) => {
			fallbackCalls.push({ pageName, options });
			if (options && options.forceLocal) {
				return { url: 'file:///fallback/background.html?v=2', origin: 'local' };
			}
			return null;
		},
		Toast: fallbackToast,
		console: fallbackConsole
	}, 'setupIframeSource');

	const fallbackResult = await fallbackHarness.fn();
	assert(fallbackResult === true, 'setupIframeSource should return true when packaged background fallback resolves');
	assert(fallbackFrame.src.startsWith('file:///fallback/background.html'), 'setupIframeSource should assign packaged background src on fallback');
	assert(fallbackToast.calls.some((call) => call.level === 'warning' && call.title === 'Background Fallback'), 'setupIframeSource should warn when using packaged background fallback');
	assert(fallbackCalls.length === 2, 'setupIframeSource should retry background resolution with forceLocal');
	assert(fallbackCalls[1].options && fallbackCalls[1].options.forceLocal === true, 'setupIframeSource should force packaged fallback on second attempt');

	const failFrame = createFrame();
	const failToast = createToastRecorder();
	const failConsole = createConsoleRecorder();
	const failCalls = [];
	const failHarness = await instantiateFunction(fnSource, {
		...setupGlobals,
		currentLanguage: 'en-US',
		window: { initialEditorView: false },
		sourcemode: false,
		devmode: false,
		document: {
			getElementById(id) {
				return id === 'frame2' ? failFrame : null;
			}
		},
		resolveSocialStreamPage: async (pageName, options) => {
			failCalls.push({ pageName, options });
			if (options && options.forceLocal) {
				return null;
			}
			throw new Error('remote background unavailable');
		},
		Toast: failToast,
		console: failConsole
	}, 'setupIframeSource');

	const failResult = await failHarness.fn();
	assert(failResult === false, 'setupIframeSource should return false when background cannot be resolved');
	assert(failToast.calls.some((call) => call.level === 'error' && call.title === 'Background Error'), 'setupIframeSource should raise a background error toast when all paths fail');
	assert(failCalls.length === 2, 'setupIframeSource should attempt packaged fallback after remote exception');

	return [
		'PASS setupIframeSource remote success returns true and assigns src',
		'PASS setupIframeSource packaged fallback returns true and warns',
		'PASS setupIframeSource total failure returns false and errors'
	];
}

async function testEnsurePopupPanelLoaded(indexSource) {
	const fnSource = extractFunctionSource(indexSource, 'ensurePopupPanelLoaded');
	const popupGlobals = {
		sourcemode: false,
		devmode: false,
		forceHostedGeneratedLinks: false,
		isBetaMode: false,
		getSsappHostedBase: (branch) => branch === 'beta' ? 'https://beta.socialstream.ninja' : 'https://socialstream.ninja',
		getLanguageExtraParams: () => [],
		postLanguageToPopupFrameAfterLoad: () => {},
	};

	const successFrame = createFrame();
	const successToast = createToastRecorder();
	const successConsole = createConsoleRecorder();
	const successCalls = [];
	const successHarness = await instantiateFunction(fnSource, {
		...popupGlobals,
		document: {
			getElementById(id) {
				return id === 'frame1' ? successFrame : null;
			}
		},
		resolveSocialStreamPage: async (pageName, options) => {
			successCalls.push({ pageName, options });
			return { url: 'https://socialstream.ninja/popup.html?v=2', origin: 'remote' };
		},
		Toast: successToast,
		console: successConsole
	}, 'ensurePopupPanelLoaded');

	const successResult = await successHarness.fn();
	assert(successResult === true, 'ensurePopupPanelLoaded should return true when remote popup resolves');
	assert(successFrame.src.includes('popup.html'), 'ensurePopupPanelLoaded should assign popup frame src on success');
	assert(successToast.calls.length === 0, 'ensurePopupPanelLoaded should not toast on remote success');
	assert(successCalls.length === 1, 'ensurePopupPanelLoaded should not retry when popup resolves remotely');
	assert(successCalls[0].options.generatedLinkBase === 'https://socialstream.ninja/', 'popup should request canonical generated links');

	const fallbackFrame = createFrame();
	const fallbackToast = createToastRecorder();
	const fallbackConsole = createConsoleRecorder();
	const fallbackCalls = [];
	const fallbackHarness = await instantiateFunction(fnSource, {
		...popupGlobals,
		document: {
			getElementById(id) {
				return id === 'frame1' ? fallbackFrame : null;
			}
		},
		resolveSocialStreamPage: async (pageName, options) => {
			fallbackCalls.push({ pageName, options });
			if (options && options.forceLocal) {
				return { url: 'file:///fallback/popup.html?v=2', origin: 'local' };
			}
			throw new Error('remote popup unavailable');
		},
		Toast: fallbackToast,
		console: fallbackConsole
	}, 'ensurePopupPanelLoaded');

	const fallbackResult = await fallbackHarness.fn();
	assert(fallbackResult === true, 'ensurePopupPanelLoaded should return true when packaged popup fallback resolves');
	assert(fallbackFrame.src.startsWith('file:///fallback/popup.html'), 'ensurePopupPanelLoaded should assign packaged popup src on fallback');
	assert(fallbackToast.calls.some((call) => call.level === 'warning' && call.title === 'Popup Fallback'), 'ensurePopupPanelLoaded should warn when using packaged popup fallback');
	assert(fallbackCalls.length === 2, 'ensurePopupPanelLoaded should retry popup resolution with forceLocal');
	assert(fallbackCalls[1].options.generatedLinkBase === 'https://socialstream.ninja/', 'packaged popup fallback should preserve canonical generated links');

	const failFrame = createFrame();
	const failToast = createToastRecorder();
	const failConsole = createConsoleRecorder();
	const failCalls = [];
	const failHarness = await instantiateFunction(fnSource, {
		...popupGlobals,
		document: {
			getElementById(id) {
				return id === 'frame1' ? failFrame : null;
			}
		},
		resolveSocialStreamPage: async (pageName, options) => {
			failCalls.push({ pageName, options });
			return null;
		},
		Toast: failToast,
		console: failConsole
	}, 'ensurePopupPanelLoaded');

	const failResult = await failHarness.fn();
	assert(failResult === false, 'ensurePopupPanelLoaded should return false when popup cannot be resolved');
	assert(failToast.calls.some((call) => call.level === 'error' && call.title === 'Popup Error'), 'ensurePopupPanelLoaded should raise a popup error toast when all paths fail');
	assert(failCalls.length === 2, 'ensurePopupPanelLoaded should attempt packaged popup fallback when remote resolution returns null');

	return [
		'PASS ensurePopupPanelLoaded remote success returns true and assigns src',
		'PASS ensurePopupPanelLoaded packaged fallback returns true and warns',
		'PASS ensurePopupPanelLoaded total failure returns false and errors'
	];
}

async function testInitializeApplication(indexSource) {
	const fnSource = extractFunctionSource(indexSource, 'initializeApplication');

	const failingToast = createToastRecorder();
	const failingConsole = createConsoleRecorder();
	let failingLoadManifestCalled = false;
	const failingHarness = await instantiateFunction(fnSource, {
		config: {},
		manifest: null,
		localStorage: {
			getItem() {
				return null;
			}
		},
		initializeConfig: async () => ({ global: {} }),
		setupIframeSource: async () => false,
		loadManifest: async () => {
			failingLoadManifestCalled = true;
			return null;
		},
		console: failingConsole,
		Toast: failingToast
	}, 'initializeApplication');

	const failingResult = await failingHarness.fn();
	assert(failingResult === false, 'initializeApplication should abort when background setup fails');
	assert(failingLoadManifestCalled === false, 'initializeApplication should not continue to manifest loading after background failure');

	const passingToast = createToastRecorder();
	const passingConsole = createConsoleRecorder();
	let passingLoadManifestCalled = false;
	const passingHarness = await instantiateFunction(fnSource, {
		config: {},
		manifest: null,
		localStorage: {
			getItem() {
				return null;
			}
		},
		initializeConfig: async () => ({ global: {} }),
		setupIframeSource: async () => true,
		loadManifest: async () => {
			passingLoadManifestCalled = true;
			return { content_scripts: [] };
		},
		console: passingConsole,
		Toast: passingToast
	}, 'initializeApplication');

	const passingResult = await passingHarness.fn();
	assert(passingResult === true, 'initializeApplication should continue when background setup succeeds');
	assert(passingLoadManifestCalled === true, 'initializeApplication should continue to manifest loading after background success');

	return [
		'PASS initializeApplication aborts when background setup fails',
		'PASS initializeApplication continues when background setup succeeds'
	];
}

async function testResponseValidation(indexSource, mainSource) {
	assert(/function isLikelyHtmlDocument\s*\(/.test(indexSource), 'index.html should define isLikelyHtmlDocument');
	assert(/function validateRemoteHtmlPage\s*\(/.test(indexSource), 'index.html should define validateRemoteHtmlPage');
	assert(/received HTML instead of JSON/.test(indexSource), 'fetchJsonResource should reject HTML masquerading as JSON');
	assert(/validateRemoteHtmlPage\(pageName,\s*text\)/.test(indexSource), 'resolveSocialStreamPage should validate fetched HTML pages');
	assert(/validateRemoteHtmlPage\(relativePath,\s*text\)/.test(indexSource), 'resolveWebSocketHtml should validate fetched websocket HTML pages');

	assert(/function isLikelyHtmlText\s*\(/.test(mainSource), 'main.js should define isLikelyHtmlText');
	assert(/function validateSocialStreamSourceText\s*\(/.test(mainSource), 'main.js should define validateSocialStreamSourceText');
	assert(/received HTML instead of JavaScript/.test(mainSource), 'main.js should reject HTML masquerading as JavaScript');
	assert(/validateSocialStreamSourceText\(text,\s*relativePath,\s*remoteUrl\)/.test(mainSource), 'loadSocialStreamSource should validate remote script responses before caching');

	return [
		'PASS fetchJsonResource rejects HTML masquerading as JSON',
		'PASS remote HTML page loaders validate expected page content',
		'PASS remote Social Stream JS loaders reject HTML masquerading as JavaScript'
	];
}

function runStaticChecks(indexSource, mainSource) {
	const checks = [];

	assert(/pageId === 'dashboard' \|\| pageId === 'event-flow-editor'[\s\S]*?await setupIframeSource\(\);/.test(indexSource), 'switchToPage should bootstrap frame2 via setupIframeSource when dashboard is opened');
	checks.push('PASS switchToPage bootstraps dashboard via setupIframeSource when frame2 is blank');

	assert(/pageId === 'link-overlay'[\s\S]*?await ensurePopupPanelLoaded\(\);/.test(indexSource), 'switchToPage should bootstrap the popup panel via ensurePopupPanelLoaded');
	checks.push('PASS switchToPage bootstraps popup via ensurePopupPanelLoaded when frame1 is blank');

	assert(/const remoteResult = await resolveRemote\(\);[\s\S]*?const cachedResult = await resolveCache\(\);[\s\S]*?const localFallback = await resolvePackaged\(\);/.test(indexSource), 'resolveSocialStreamPage should try remote, then cache, then packaged assets');
	checks.push('PASS resolveSocialStreamPage still falls back remote -> cache -> packaged');

	assert(/getSsappRemoteBases\(remoteBranch\)/.test(indexSource), 'remote page resolution should try cache and canonical hosted origins');
	checks.push('PASS remote page resolution tries cache host then canonical hosted origin');

	assert(/generatedlinkbase=\$\{encodeURIComponent\(options\.generatedLinkBase\)\}/.test(indexSource), 'local popup fallback should carry the canonical generated-link base');
	checks.push('PASS local popup fallback carries a separate canonical generated-link base');

	assert(/mainApp && preferLocalAssetsFlag[\s\S]*?hostedlinks=1/.test(mainSource), 'prefer-local startup should keep user-facing links hosted');
	checks.push('PASS prefer-local startup marks generated links as hosted');

	return checks;
}

async function main() {
	const repoRoot = path.resolve(__dirname, '..', '..');
	const indexPath = path.join(repoRoot, 'index.html');
	const mainPath = path.join(repoRoot, 'main.js');
	const indexSource = readText(indexPath);
	const mainSource = readText(mainPath);

	const results = [];
	results.push(...runStaticChecks(indexSource, mainSource));
	results.push(...await testSetupIframeSource(indexSource));
	results.push(...await testEnsurePopupPanelLoaded(indexSource));
	results.push(...await testInitializeApplication(indexSource));
	results.push(...await testResponseValidation(indexSource, mainSource));

	console.log('frame-fallback-diagnostics');
	console.log('');
	results.forEach((line) => console.log(`- ${line}`));
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error('frame-fallback-diagnostics: failed');
		console.error(error && error.stack ? error.stack : error);
		process.exit(1);
	});
