#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const mainSource = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');
const handlerSource = fs.readFileSync(path.join(repoRoot, 'resources', 'electron-rumble-handler.js'), 'utf8');
const {
	PROFILE_OWNER_FILENAME,
	PROFILE_PREFIX,
	closeRun,
	cleanupStaleProfiles,
	findBrowserExecutable,
	getBrowserCandidates,
	importPlatformCookies,
	importRumbleCookies,
	isPlatformCookie,
	isRumbleCookie,
	launchIsolatedBrowser,
	normalizeExternalSessionPartition,
	normalizeRumbleSessionPartition,
	runExternalBrowserSignin,
	runRumbleChromeSignin,
	scheduleProfileCleanup,
	setupExternalBrowserSigninHandler,
	setupRumbleChromeSigninHandler,
	toElectronCookie,
	verifyTikTokSignin,
	verifyRumbleSignin
} = require('../../resources/electron-rumble-handler');

function makeCookieStore(initialCookies = [], failures = {}) {
	const cookies = initialCookies.map(cookie => ({ ...cookie }));
	const normalizedFailures = typeof failures === 'string' ? { setName: failures } : failures;
	let remainingSetFailure = normalizedFailures.setName ? 1 : 0;
	let remainingRemoveFailure = normalizedFailures.removeName ? 1 : 0;
	return {
		async get() {
			return cookies.map(cookie => ({ ...cookie }));
		},
		async remove(url, name) {
			if (remainingRemoveFailure && name === normalizedFailures.removeName) {
				remainingRemoveFailure -= 1;
				throw new Error('simulated cookie removal failure');
			}
			const target = new URL(url);
			for (let index = cookies.length - 1; index >= 0; index -= 1) {
				const cookie = cookies[index];
				const hostname = String(cookie.domain || '').replace(/^\./, '');
				const cookiePath = String(cookie.path || '/');
				if (cookie.name === name && hostname === target.hostname && cookiePath === target.pathname) {
					cookies.splice(index, 1);
				}
			}
		},
		async set(details) {
			if (remainingSetFailure && details.name === normalizedFailures.setName) {
				remainingSetFailure -= 1;
				throw new Error('simulated cookie write failure');
			}
			const hostname = new URL(details.url).hostname;
			const domain = details.domain || hostname;
			for (let index = cookies.length - 1; index >= 0; index -= 1) {
				if (cookies[index].name === details.name && cookies[index].domain === domain && cookies[index].path === details.path) {
					cookies.splice(index, 1);
				}
			}
			cookies.push({
				...details,
				domain,
				expires: details.expirationDate
			});
		}
	};
}

async function testCookieImportAndRollback() {
	const originalRumble = {
		name: 'rumble_auth',
		value: 'old',
		domain: '.rumble.com',
		path: '/',
		secure: true,
		httpOnly: true,
		sameSite: 'lax'
	};
	const unrelatedCookie = {
		name: 'twitch_auth',
		value: 'untouched',
		domain: '.twitch.tv',
		path: '/',
		secure: true
	};
	const newRumble = {
		name: 'rumble_auth',
		value: 'new',
		domain: '.rumble.com',
		path: '/',
		secure: true,
		httpOnly: true,
		sameSite: 'Lax'
	};

	const cookieStore = makeCookieStore([originalRumble, unrelatedCookie]);
	let flushCount = 0;
	const destinationSession = {
		cookies: cookieStore,
		async flushStorageData() { flushCount += 1; }
	};
	assert.strictEqual(await importRumbleCookies(destinationSession, [newRumble]), 1);
	const imported = await cookieStore.get({});
	assert(imported.some(cookie => cookie.name === 'rumble_auth' && cookie.value === 'new'));
	assert(imported.some(cookie => cookie.name === 'twitch_auth' && cookie.value === 'untouched'));
	assert.strictEqual(flushCount, 1);
	await assert.rejects(
		importRumbleCookies(destinationSession, [{ ...unrelatedCookie }]),
		error => error && error.code === 'SSAPP_EXTERNAL_NO_COOKIES'
	);
	assert((await cookieStore.get({})).some(cookie => cookie.name === 'rumble_auth' && cookie.value === 'new'));

	const failingStore = makeCookieStore([originalRumble, unrelatedCookie], 'new_auth');
	const failingSession = {
		cookies: failingStore,
		async flushStorageData() { }
	};
	await assert.rejects(
		importRumbleCookies(failingSession, [{ ...newRumble, name: 'new_auth' }]),
		/simulated cookie write failure/
	);
	const restored = await failingStore.get({});
	assert(restored.some(cookie => cookie.name === 'rumble_auth' && cookie.value === 'old'));
	assert(restored.some(cookie => cookie.name === 'twitch_auth' && cookie.value === 'untouched'));

	const secondOriginal = { ...originalRumble, name: 'rumble_secondary', path: '/account' };
	const removalFailureStore = makeCookieStore(
		[originalRumble, secondOriginal, unrelatedCookie],
		{ removeName: 'rumble_secondary' }
	);
	const removalFailureSession = {
		cookies: removalFailureStore,
		async flushStorageData() { }
	};
	await assert.rejects(
		importRumbleCookies(removalFailureSession, [newRumble]),
		/simulated cookie removal failure/
	);
	const removalRestored = await removalFailureStore.get({});
	assert(removalRestored.some(cookie => cookie.name === 'rumble_auth' && cookie.value === 'old'));
	assert(removalRestored.some(cookie => cookie.name === 'rumble_secondary' && cookie.value === 'old'));
	assert(removalRestored.some(cookie => cookie.name === 'twitch_auth' && cookie.value === 'untouched'));

	const oldTikTok = {
		name: 'sessionid', value: 'old-tiktok', domain: '.tiktok.com', path: '/', secure: true, httpOnly: true
	};
	const newTikTok = {
		name: 'sessionid', value: 'new-tiktok', domain: '.tiktok.com', path: '/', secure: true, httpOnly: true
	};
	const googleCookie = {
		name: 'SID', value: 'must-not-import', domain: '.google.com', path: '/', secure: true, httpOnly: true
	};
	const tiktokStore = makeCookieStore([oldTikTok, originalRumble]);
	const tiktokSession = {
		cookies: tiktokStore,
		async flushStorageData() { }
	};
	assert.strictEqual(await importPlatformCookies(tiktokSession, 'tiktok', [newTikTok, googleCookie]), 1);
	const importedTikTok = await tiktokStore.get({});
	assert(importedTikTok.some(cookie => cookie.name === 'sessionid' && cookie.value === 'new-tiktok'));
	assert(importedTikTok.some(cookie => cookie.name === 'rumble_auth' && cookie.value === 'old'));
	assert.strictEqual(importedTikTok.some(cookie => cookie.domain === '.google.com'), false, 'Google cookies must never enter the SSApp profile');
	await assert.rejects(
		importPlatformCookies(tiktokSession, 'tiktok', [googleCookie]),
		error => error && error.code === 'SSAPP_EXTERNAL_NO_COOKIES'
	);
}

async function testDuplicateProfileGuard() {
	let releaseLaunch;
	const launchGate = new Promise(resolve => { releaseLaunch = resolve; });
	const dependencies = {
		electron: {},
		browser: { name: 'Chrome', path: 'chrome' },
		session: { fromPartition: () => ({ cookies: makeCookieStore(), flushStorageData: async () => { } }) },
		dialog: { showMessageBox: async () => ({ response: 1 }) },
		launchBrowser: async () => {
			await launchGate;
			return { client: null, childProcess: null, profileDir: null };
		}
	};

	const firstRun = runRumbleChromeSignin({ customSession: 'profile-a' }, dependencies);
	await assert.rejects(
		runRumbleChromeSignin({ customSession: 'profile-a' }, dependencies),
		error => error && error.code === 'SSAPP_EXTERNAL_SIGNIN_ACTIVE'
	);
	await assert.rejects(
		runRumbleChromeSignin({ customSession: 'profile-b' }, dependencies),
		error => error && error.code === 'SSAPP_EXTERNAL_SIGNIN_ACTIVE' && /other Chrome sign-in/.test(error.message)
	);
	releaseLaunch();
	const result = await firstRun;
	assert.strictEqual(result.cancelled, true);
}

async function testUnverifiedImportAndClosedBrowserPaths() {
	const oldCookie = {
		name: 'rumble_auth', value: 'old', domain: '.rumble.com', path: '/', secure: true
	};
	const newCookie = {
		name: 'rumble_auth', value: 'new', domain: '.rumble.com', path: '/', secure: true
	};
	const cookieStore = makeCookieStore([oldCookie]);
	const dialogResponses = [0, 1];
	const result = await runRumbleChromeSignin({ customSession: 'unverified-profile' }, {
		electron: {},
		browser: { name: 'Chrome', path: 'chrome' },
		session: { fromPartition: () => ({ cookies: cookieStore, flushStorageData: async () => { } }) },
		dialog: { showMessageBox: async () => ({ response: dialogResponses.shift() }) },
		launchBrowser: async () => ({
			profileDir: null,
			childProcess: null,
			client: {
				call: async method => method === 'Target.getTargets'
					? { targetInfos: [] }
					: method === 'Storage.getCookies' ? { cookies: [newCookie] } : {},
				sendWithoutReply() { },
				close() { }
			}
		})
	});
	assert.strictEqual(result.success, true);
	assert.strictEqual(result.verified, false);
	assert((await cookieStore.get({})).some(cookie => cookie.name === 'rumble_auth' && cookie.value === 'new'));

	const preservedStore = makeCookieStore([oldCookie]);
	await assert.rejects(
		runRumbleChromeSignin({ customSession: 'closed-browser-profile' }, {
			electron: {},
			browser: { name: 'Chrome', path: 'chrome' },
			session: { fromPartition: () => ({ cookies: preservedStore, flushStorageData: async () => { } }) },
			dialog: { showMessageBox: async () => ({ response: 0 }) },
			launchBrowser: async () => ({
				profileDir: null,
				childProcess: null,
				client: {
					call: async () => { throw new Error('Chrome connection closed'); },
					sendWithoutReply() { },
					close() { }
				}
			})
		}),
		/Chrome connection closed/
	);
	assert((await preservedStore.get({})).some(cookie => cookie.name === 'rumble_auth' && cookie.value === 'old'));
}

async function testTikTokVerificationAndFlow() {
	const targetInfos = [{ targetId: 'tiktok-page', type: 'page', url: 'https://www.tiktok.com/foryou' }];
	const unsignedClient = {
		call: async method => {
			if (method === 'Target.getTargets') return { targetInfos };
			if (method === 'Storage.getCookies') {
				return { cookies: [{ name: 'passport_csrf_token', value: 'csrf', domain: '.tiktok.com' }] };
			}
			return {};
		}
	};
	const unsigned = await verifyTikTokSignin(unsignedClient);
	assert.strictEqual(unsigned.signedIn, false, 'a non-authentication TikTok cookie must not count as signed in');

	const signedClient = {
		call: async method => {
			if (method === 'Target.getTargets') return { targetInfos };
			if (method === 'Storage.getCookies') {
				return {
					cookies: [
						{ name: 'sessionid', value: 'signed-in', domain: '.tiktok.com' },
						{ name: 'SID', value: 'google-secret', domain: '.google.com' }
					]
				};
			}
			return {};
		}
	};
	const signed = await verifyTikTokSignin(signedClient);
	assert.strictEqual(signed.signedIn, true, 'TikTok sessionid should verify the imported destination session');

	const destinationStore = makeCookieStore();
	const dialogResponses = [0];
	const result = await runExternalBrowserSignin({ platform: 'tiktok', customSession: 'tiktok-profile' }, {
		electron: {},
		browser: { name: 'Chrome', path: 'chrome' },
		session: {
			fromPartition: partition => {
				assert.strictEqual(partition, 'persist:custom-tiktok-profile');
				return { cookies: destinationStore, flushStorageData: async () => { } };
			}
		},
		dialog: { showMessageBox: async () => ({ response: dialogResponses.shift() }) },
		launchBrowser: async () => ({
			profileDir: null,
			childProcess: null,
			client: {
				...signedClient,
				sendWithoutReply() { },
				close() { }
			}
		})
	});
	assert.strictEqual(result.success, true);
	assert.strictEqual(result.platform, 'tiktok');
	assert.strictEqual(result.verified, true);
	const imported = await destinationStore.get({});
	assert(imported.some(cookie => cookie.name === 'sessionid' && cookie.value === 'signed-in'));
	assert.strictEqual(imported.some(cookie => cookie.domain === '.google.com'), false);
}

async function testUnavailableBrowserAndIpcBoundary() {
	await assert.rejects(
		runRumbleChromeSignin({}, {
			electron: {},
			candidates: [],
			existsSync: () => false
		}),
		error => error && error.code === 'SSAPP_EXTERNAL_BROWSER_NOT_FOUND'
	);

	const registeredHandlers = new Map();
	const mainWebContents = {};
	const mainWindow = { isDestroyed: () => false, webContents: mainWebContents };
	setupExternalBrowserSigninHandler({
		electron: {
			app: { on() { } },
			ipcMain: {
				removeHandler() { },
				handle(channel, handler) {
					registeredHandlers.set(channel, handler);
				}
			}
		},
		getMainWindow: () => mainWindow
	});
	assert.strictEqual(typeof registeredHandlers.get('external-browser-signin'), 'function');
	assert.strictEqual(typeof registeredHandlers.get('rumble-chrome-signin'), 'function');
	await assert.rejects(
		registeredHandlers.get('external-browser-signin')({ sender: {} }, { platform: 'rumble' }),
		error => error && error.code === 'SSAPP_EXTERNAL_SIGNIN_FORBIDDEN'
	);
	await assert.rejects(
		registeredHandlers.get('external-browser-signin')({ sender: mainWebContents }, { platform: 'instagram' }),
		error => error && error.code === 'SSAPP_EXTERNAL_SIGNIN_PLATFORM'
	);
}

async function testLaunchFailureIsPromptAndClean() {
	const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(PROFILE_PREFIX)));
	const child = new EventEmitter();
	child.exitCode = null;
	child.kill = () => { child.exitCode = 1; };
	const started = Date.now();
	await assert.rejects(
		launchIsolatedBrowser({ name: 'Chrome', path: 'missing-chrome' }, {
			reserveLocalPort: async () => 65534,
			spawnFn: () => {
				process.nextTick(() => child.emit('error', new Error('ENOENT')));
				return child;
			},
			startTimeoutMs: 5000
		}),
		error => error && error.code === 'SSAPP_EXTERNAL_BROWSER_LAUNCH_FAILED' && /ENOENT/.test(error.message)
	);
	assert(Date.now() - started < 2000, 'a browser launch error waited for the full startup timeout');
	const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(PROFILE_PREFIX) && !before.has(name));
	assert.deepStrictEqual(after, [], `temporary Chrome profiles were left behind: ${after.join(', ')}`);
}

async function testCrashCleanupRespectsOtherInstances() {
	const deadOwnerProfile = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
	const activeOwnerProfile = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
	fs.writeFileSync(path.join(deadOwnerProfile, PROFILE_OWNER_FILENAME), JSON.stringify({ pid: 2147483647 }));
	fs.writeFileSync(path.join(activeOwnerProfile, PROFILE_OWNER_FILENAME), JSON.stringify({ pid: process.pid }));
	const oldTime = new Date(Date.now() - (48 * 60 * 60 * 1000));
	fs.utimesSync(activeOwnerProfile, oldTime, oldTime);
	try {
		await cleanupStaleProfiles();
		assert.strictEqual(fs.existsSync(deadOwnerProfile), false, 'a crashed SSApp temporary Chrome profile was not cleaned on restart');
		assert.strictEqual(fs.existsSync(activeOwnerProfile), true, 'cleanup removed another running SSApp instance\'s Chrome profile');
	} finally {
		fs.rmSync(deadOwnerProfile, { recursive: true, force: true });
		fs.rmSync(activeOwnerProfile, { recursive: true, force: true });
	}
}

async function testDetachedProfileCleanupHelper() {
	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
	fs.writeFileSync(path.join(profileDir, 'cleanup-fixture.txt'), 'temporary Rumble profile fixture');
	scheduleProfileCleanup(profileDir);
	const deadline = Date.now() + 5000;
	while (fs.existsSync(profileDir) && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.strictEqual(fs.existsSync(profileDir), false, 'the detached shutdown cleanup helper left its temporary profile behind');
}

async function testLiveBrowserLaunch() {
	const browser = findBrowserExecutable();
	assert(browser, 'Chrome or Edge must be installed for the live browser check');
	for (const platform of ['rumble', 'tiktok']) {
		const domainPattern = platform === 'tiktok' ? /tiktok\.com/i : /rumble\.com/i;
		const urlPattern = platform === 'tiktok'
			? /^https:\/\/(?:[^./]+\.)?tiktok\.com\//i
			: /^https:\/\/(?:[^./]+\.)?rumble\.com\//i;
		const run = await launchIsolatedBrowser(browser, { platform });
		try {
			const { targetInfos = [] } = await run.client.call('Target.getTargets');
			const target = targetInfos.find(candidate => candidate.type === 'page' && domainPattern.test(candidate.url));
			assert(target, `the isolated browser should open ${platform}`);
			const { sessionId } = await run.client.call('Target.attachToTarget', {
				targetId: target.targetId,
				flatten: true
			});
			try {
				const deadline = Date.now() + 20000;
				let pageState = null;
				while (Date.now() < deadline) {
					const result = await run.client.call('Runtime.evaluate', {
						expression: '({ webdriver: navigator.webdriver, url: location.href })',
						returnByValue: true
					}, sessionId);
					pageState = result?.result?.value || null;
					if (urlPattern.test(pageState?.url || '')) break;
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				assert.strictEqual(pageState?.webdriver, false, 'Chrome must not expose WebDriver automation');
				assert.match(pageState?.url || '', urlPattern);
				const verification = platform === 'tiktok'
					? await verifyTikTokSignin(run.client)
					: await verifyRumbleSignin(run.client);
				assert.strictEqual(verification.signedIn, false, `a fresh Chrome profile must not appear signed into ${platform}`);
			} finally {
				try { await run.client.call('Target.detachFromTarget', { sessionId }); } catch (_) { }
			}
		} finally {
			await closeRun(run);
		}
	}
}

async function run() {
	assert.strictEqual(normalizeRumbleSessionPartition('AUTO'), 'persist:rumble');
	assert.strictEqual(normalizeRumbleSessionPartition(''), 'persist:rumble');
	assert.strictEqual(normalizeRumbleSessionPartition('   '), 'persist:custom-');
	assert.strictEqual(normalizeRumbleSessionPartition(' AUTO '), 'persist:custom-AUTO');
	assert.strictEqual(normalizeRumbleSessionPartition('default-rumble'), 'persist:rumble');
	assert.strictEqual(normalizeRumbleSessionPartition('default'), 'persist:custom-default');
	assert.strictEqual(normalizeRumbleSessionPartition('creator-account'), 'persist:custom-creator-account');
	assert.strictEqual(normalizeExternalSessionPartition('tiktok', 'AUTO'), 'persist:tiktok');
	assert.strictEqual(normalizeExternalSessionPartition('tiktok', 'default-tiktok'), 'persist:tiktok');
	assert.strictEqual(normalizeExternalSessionPartition('tiktok', 'creator-account'), 'persist:custom-creator-account');
	assert.throws(
		() => normalizeExternalSessionPartition('instagram', 'AUTO'),
		error => error && error.code === 'SSAPP_EXTERNAL_SIGNIN_PLATFORM'
	);
	assert(getBrowserCandidates('linux', {}).some(candidate => candidate.path === '/usr/bin/chromium'));
	assert.strictEqual(findBrowserExecutable({
		candidates: [{ name: 'Chrome', path: 'missing' }, { name: 'Edge', path: 'found' }],
		existsSync: candidatePath => candidatePath === 'found'
	})?.name, 'Edge');

	assert.strictEqual(isRumbleCookie({ domain: '.rumble.com' }), true);
	assert.strictEqual(isRumbleCookie({ domain: 'auth.rumble.com' }), true);
	assert.strictEqual(isRumbleCookie({ domain: 'evilrumble.com' }), false);
	assert.strictEqual(isRumbleCookie({ domain: 'accounts.google.com' }), false);
	assert.strictEqual(isPlatformCookie('tiktok', { domain: '.tiktok.com' }), true);
	assert.strictEqual(isPlatformCookie('tiktok', { domain: 'm.tiktok.com' }), true);
	assert.strictEqual(isPlatformCookie('tiktok', { domain: 'eviltiktok.com' }), false);
	assert.strictEqual(isPlatformCookie('tiktok', { domain: 'accounts.google.com' }), false);
	assert.deepStrictEqual(toElectronCookie({
		name: 'session',
		value: 'value',
		domain: '.rumble.com',
		path: '/',
		secure: true,
		httpOnly: true,
		sameSite: 'None',
		expires: 12345
	}), {
		url: 'https://rumble.com/',
		name: 'session',
		value: 'value',
		path: '/',
		secure: true,
		httpOnly: true,
		sameSite: 'no_restriction',
		domain: '.rumble.com',
		expirationDate: 12345
	});

	assert.match(indexSource, /data-signin-chrome/);
	assert.match(indexSource, /rumble: 'Rumble'/);
	assert.match(indexSource, /tiktok: 'TikTok'/);
	assert.match(indexSource, /Sign into \$\{platformLabel\} via Chrome for \$\{sessionLabel\}/);
	assert.match(indexSource, /ipcRenderer\.invoke\('external-browser-signin'/);
	assert.match(indexSource, /After signing in through the SSApp window, close that sign-in window/);
	assert.match(indexSource, /leave Chrome open until SSApp finishes importing/);
	assert.match(indexSource, /customSession: requestedCustomSession/);
	assert.match(mainSource, /setupExternalBrowserSigninHandler\(\{[\s\S]*?getMainWindow: \(\) => mainWindow,[\s\S]*?trackPartition: partition => createdPartitions\.add\(partition\)[\s\S]*?\}\)/);
	assert.match(handlerSource, /--remote-debugging-address=127\.0\.0\.1/);
	assert.doesNotMatch(handlerSource, /--remote-debugging-port=0/);
	assert.doesNotMatch(handlerSource, /--enable-automation/);
	assert.doesNotMatch(handlerSource, /name=\["'\]password|response\.text\(\)/);
	assert.match(handlerSource, /finalHostname === 'rumble\.com' \|\| finalHostname\.endsWith\('\.rumble\.com'\)/);
	assert.match(handlerSource, /Only \$\{spec\.label\} cookies will be copied/);
	assert.match(handlerSource, /leave Chrome open, return here, and click Import Sign-In/);
	assert.match(handlerSource, /'sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'/);

	await testCookieImportAndRollback();
	await testDuplicateProfileGuard();
	await testUnverifiedImportAndClosedBrowserPaths();
	await testTikTokVerificationAndFlow();
	await testUnavailableBrowserAndIpcBoundary();
	await testLaunchFailureIsPromptAndClean();
	await testCrashCleanupRespectsOtherInstances();
	await testDetachedProfileCleanupHelper();
	if (process.argv.includes('--live-browser')) await testLiveBrowserLaunch();
	console.log('Rumble Chrome sign-in regression checks passed.');
}

run().catch(error => {
	console.error(error && error.stack ? error.stack : error);
	process.exitCode = 1;
});
