'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PROFILE_PREFIX = 'ssapp-external-browser-auth-';
const LEGACY_PROFILE_PREFIX = 'ssapp-rumble-chrome-auth-';
const PROFILE_PREFIXES = [PROFILE_PREFIX, LEGACY_PROFILE_PREFIX];
const DEVTOOLS_START_TIMEOUT_MS = 20000;
const CDP_COMMAND_TIMEOUT_MS = 15000;
const STALE_PROFILE_AGE_MS = 24 * 60 * 60 * 1000;
const PROFILE_OWNER_FILENAME = '.ssapp-owner.json';

const PLATFORM_SPECS = Object.freeze({
	rumble: Object.freeze({
		label: 'Rumble',
		loginUrl: 'https://rumble.com/login'
	}),
	tiktok: Object.freeze({
		label: 'TikTok',
		loginUrl: 'https://www.tiktok.com/login',
		authCookieNames: Object.freeze(['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'])
	})
});

const activeRunsByPartition = new Map();

function createSigninError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function getPlatformSpec(platform) {
	const normalizedPlatform = String(platform || '').trim().toLowerCase();
	const spec = PLATFORM_SPECS[normalizedPlatform];
	if (!spec) {
		throw createSigninError('SSAPP_EXTERNAL_SIGNIN_PLATFORM', 'Chrome sign-in is not available for this source.');
	}
	return { platform: normalizedPlatform, ...spec };
}

function normalizeExternalSessionPartition(platform, customSession) {
	const { platform: normalizedPlatform } = getPlatformSpec(platform);
	if (customSession && customSession !== 'AUTO') {
		const normalizedSession = String(customSession).trim();
		if (normalizedSession.startsWith('default-')) {
			const explicitPlatform = normalizedSession.replace('default-', '').trim();
			return `persist:${explicitPlatform || normalizedPlatform}`;
		}
		if (normalizedSession === 'default') {
			return 'persist:custom-default';
		}
		return `persist:custom-${normalizedSession}`;
	}
	return `persist:${normalizedPlatform}`;
}

function normalizeRumbleSessionPartition(customSession) {
	return normalizeExternalSessionPartition('rumble', customSession);
}

function isPlatformHostname(platform, hostname) {
	const { platform: normalizedPlatform } = getPlatformSpec(platform);
	const normalized = String(hostname || '').replace(/^\./, '').toLowerCase();
	const rootDomain = normalizedPlatform === 'tiktok' ? 'tiktok.com' : 'rumble.com';
	return normalized === rootDomain || normalized.endsWith(`.${rootDomain}`);
}

function isRumbleHostname(hostname) {
	return isPlatformHostname('rumble', hostname);
}

function isPlatformCookie(platform, cookie) {
	return !!cookie && isPlatformHostname(platform, cookie.domain);
}

function isRumbleCookie(cookie) {
	return isPlatformCookie('rumble', cookie);
}

function mapSameSite(value) {
	switch (String(value || '').toLowerCase()) {
		case 'none':
		case 'no_restriction':
			return 'no_restriction';
		case 'lax':
			return 'lax';
		case 'strict':
			return 'strict';
		default:
			return 'unspecified';
	}
}

function buildCookieUrl(cookie) {
	const hostname = String(cookie?.domain || '').replace(/^\./, '');
	const cookiePath = String(cookie?.path || '/');
	const normalizedPath = cookiePath.startsWith('/') ? cookiePath : `/${cookiePath}`;
	return `${cookie?.secure === false ? 'http' : 'https'}://${hostname}${normalizedPath}`;
}

function toElectronCookie(cookie) {
	const details = {
		url: buildCookieUrl(cookie),
		name: String(cookie.name || ''),
		value: String(cookie.value || ''),
		path: String(cookie.path || '/'),
		secure: cookie.secure !== false,
		httpOnly: cookie.httpOnly === true,
		sameSite: mapSameSite(cookie.sameSite)
	};

	if (String(cookie.domain || '').startsWith('.')) {
		details.domain = String(cookie.domain);
	}
	if (Number.isFinite(cookie.expires) && cookie.expires > 0) {
		details.expirationDate = cookie.expires;
	} else if (Number.isFinite(cookie.expirationDate) && cookie.expirationDate > 0) {
		details.expirationDate = cookie.expirationDate;
	}
	return details;
}

function getBrowserCandidates(platform = process.platform, env = process.env) {
	const candidates = [];
	const configuredPath = String(env.SSAPP_EXTERNAL_BROWSER_PATH || env.SSAPP_RUMBLE_CHROME_PATH || '').trim();
	if (configuredPath) {
		candidates.push({ name: 'Chrome', path: configuredPath });
	}

	if (platform === 'win32') {
		const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
		for (const root of roots) {
			candidates.push({ name: 'Chrome', path: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') });
		}
		for (const root of roots) {
			candidates.push({ name: 'Edge', path: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
		}
	} else if (platform === 'darwin') {
		candidates.push(
			{ name: 'Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
			{ name: 'Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' }
		);
		if (env.HOME) {
			candidates.push(
				{ name: 'Chrome', path: path.join(env.HOME, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome') },
				{ name: 'Edge', path: path.join(env.HOME, 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge') }
			);
		}
	} else {
		candidates.push(
			{ name: 'Chrome', path: '/usr/bin/google-chrome' },
			{ name: 'Chrome', path: '/usr/bin/google-chrome-stable' },
			{ name: 'Chrome', path: '/opt/google/chrome/google-chrome' },
			{ name: 'Chromium', path: '/usr/bin/chromium' },
			{ name: 'Chromium', path: '/usr/bin/chromium-browser' },
			{ name: 'Chromium', path: '/snap/bin/chromium' },
			{ name: 'Edge', path: '/usr/bin/microsoft-edge' },
			{ name: 'Edge', path: '/usr/bin/microsoft-edge-stable' },
			{ name: 'Edge', path: '/opt/microsoft/msedge/msedge' }
		);
	}

	const seen = new Set();
	return candidates.filter(candidate => {
		const normalizedPath = path.resolve(candidate.path).toLowerCase();
		if (seen.has(normalizedPath)) return false;
		seen.add(normalizedPath);
		return true;
	});
}

function findBrowserExecutable(options = {}) {
	const existsSync = options.existsSync || fs.existsSync;
	const candidates = options.candidates || getBrowserCandidates(options.platform, options.env);
	return candidates.find(candidate => {
		try {
			return existsSync(candidate.path);
		} catch (_) {
			return false;
		}
	}) || null;
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function reserveLocalPort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = address && typeof address === 'object' ? address.port : 0;
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}
				resolve(port);
			});
		});
	});
}

function getDevToolsVersion(port) {
	return new Promise((resolve, reject) => {
		const request = http.get({
			host: '127.0.0.1',
			port,
			path: '/json/version',
			timeout: 1000
		}, response => {
			let body = '';
			response.setEncoding('utf8');
			response.on('data', chunk => { body += chunk; });
			response.on('end', () => {
				if (response.statusCode !== 200) {
					reject(new Error(`Chrome DevTools returned HTTP ${response.statusCode}`));
					return;
				}
				try {
					resolve(JSON.parse(body));
				} catch (error) {
					reject(error);
				}
			});
		});
		request.once('timeout', () => request.destroy(new Error('Chrome DevTools request timed out.')));
		request.once('error', reject);
	});
}

async function waitForDevToolsEndpoint(port, childProcess, timeoutMs = DEVTOOLS_START_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	let launchError = null;
	const onLaunchError = error => { launchError = error; };
	childProcess?.once?.('error', onLaunchError);
	try {
		while (Date.now() < deadline) {
			if (launchError) {
				throw createSigninError(
					'SSAPP_EXTERNAL_BROWSER_LAUNCH_FAILED',
					`Could not start Chrome: ${launchError.message || launchError}`
				);
			}
			try {
				const version = await getDevToolsVersion(port);
				if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
			} catch (_) { }
			if (childProcess && childProcess.exitCode !== null) {
				throw createSigninError('SSAPP_EXTERNAL_BROWSER_CLOSED', 'Chrome closed before sign-in started.');
			}
			await delay(100);
		}
		throw createSigninError('SSAPP_EXTERNAL_BROWSER_TIMEOUT', 'Chrome did not start its isolated sign-in session in time.');
	} finally {
		childProcess?.removeListener?.('error', onLaunchError);
	}
}

class CdpConnection {
	constructor(websocketUrl, options = {}) {
		this.websocketUrl = websocketUrl;
		this.WebSocketImpl = options.WebSocketImpl || WebSocket;
		this.socket = null;
		this.nextId = 1;
		this.pending = new Map();
	}

	connect(timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const socket = new this.WebSocketImpl(this.websocketUrl);
			this.socket = socket;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				try { socket.close(); } catch (_) { }
				reject(createSigninError('SSAPP_EXTERNAL_CDP_TIMEOUT', 'Timed out connecting to Chrome.'));
			}, timeoutMs);

			socket.once('open', () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve();
			});
			socket.once('error', error => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(createSigninError('SSAPP_EXTERNAL_CDP_CONNECT_FAILED', `Could not connect to Chrome: ${error.message}`));
			});
			socket.on('message', raw => this.handleMessage(raw));
			socket.on('close', () => this.rejectPending(createSigninError('SSAPP_EXTERNAL_CDP_CLOSED', 'Chrome closed before sign-in was imported.')));
		});
	}

	handleMessage(raw) {
		let message;
		try {
			message = JSON.parse(raw.toString());
		} catch (_) {
			return;
		}
		if (!message || !message.id || !this.pending.has(message.id)) return;
		const pending = this.pending.get(message.id);
		this.pending.delete(message.id);
		clearTimeout(pending.timeout);
		if (message.error) {
			pending.reject(createSigninError('SSAPP_EXTERNAL_CDP_COMMAND_FAILED', message.error.message || 'Chrome command failed.'));
			return;
		}
		pending.resolve(message.result || {});
	}

	call(method, params = {}, sessionId = null, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
		if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) {
			return Promise.reject(createSigninError('SSAPP_EXTERNAL_CDP_NOT_CONNECTED', 'Chrome is not connected.'));
		}
		const id = this.nextId++;
		const message = { id, method, params };
		if (sessionId) message.sessionId = sessionId;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(createSigninError('SSAPP_EXTERNAL_CDP_COMMAND_TIMEOUT', `Chrome did not answer ${method} in time.`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
			try {
				this.socket.send(JSON.stringify(message));
			} catch (error) {
				clearTimeout(timeout);
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	sendWithoutReply(method, params = {}) {
		if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) return;
		try {
			this.socket.send(JSON.stringify({ id: this.nextId++, method, params }));
		} catch (_) { }
	}

	rejectPending(error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pending.clear();
	}

	close() {
		this.rejectPending(createSigninError('SSAPP_EXTERNAL_CDP_CLOSED', 'Chrome connection closed.'));
		try { this.socket?.close(); } catch (_) { }
		this.socket = null;
	}
}

function parseHostname(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch (_) {
		return '';
	}
}

async function findPlatformPageTarget(client, platform) {
	const { targetInfos = [] } = await client.call('Target.getTargets');
	const platformTargets = targetInfos.filter(target => {
		if (target.type !== 'page') return false;
		return isPlatformHostname(platform, parseHostname(target.url));
	});
	return platformTargets.find(target => {
		const hostname = parseHostname(target.url);
		const rootDomain = platform === 'tiktok' ? 'tiktok.com' : 'rumble.com';
		return hostname === rootDomain || hostname === `www.${rootDomain}`;
	}) || platformTargets[0] || null;
}

async function verifyRumbleSignin(client) {
	const target = await findPlatformPageTarget(client, 'rumble');
	if (!target) {
		return { signedIn: false, reason: 'Rumble is not open in the Chrome sign-in window.' };
	}

	const { sessionId } = await client.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
	try {
		const expression = `(async () => {
			try {
				const currentUrl = new URL(location.href);
				if (currentUrl.hostname !== 'rumble.com' && currentUrl.hostname !== 'www.rumble.com') {
					return { signedIn: false, reason: 'Rumble is still showing its sign-in page.' };
				}
				const accountUrl = new URL('/account', currentUrl.origin);
				const response = await fetch(accountUrl.href, {
					credentials: 'include',
					cache: 'no-store',
					redirect: 'follow'
				});
				const finalUrl = new URL(response.url);
				const finalHostname = finalUrl.hostname.toLowerCase();
				const rumbleHostname = finalHostname === 'rumble.com' || finalHostname.endsWith('.rumble.com');
				const accountPage = rumbleHostname && finalUrl.pathname.startsWith('/account');
				return {
					signedIn: response.ok && accountPage,
					url: finalUrl.origin + finalUrl.pathname
				};
			} catch (error) {
				return { signedIn: false, reason: error && error.message ? error.message : String(error) };
			}
		})()`;
		const result = await client.call('Runtime.evaluate', {
			expression,
			awaitPromise: true,
			returnByValue: true
		}, sessionId);
		return result?.result?.value || { signedIn: false, reason: 'Rumble sign-in could not be verified.' };
	} finally {
		try { await client.call('Target.detachFromTarget', { sessionId }); } catch (_) { }
	}
}

async function verifyTikTokSignin(client) {
	const target = await findPlatformPageTarget(client, 'tiktok');
	if (!target) {
		return { signedIn: false, reason: 'TikTok is not open in the Chrome sign-in window.' };
	}

	const cookies = await readPlatformCookies(client, 'tiktok');
	const authCookieNames = new Set(PLATFORM_SPECS.tiktok.authCookieNames);
	const authCookie = cookies.find(cookie => authCookieNames.has(String(cookie?.name || '').toLowerCase()) && cookie.value);
	if (!authCookie) {
		return {
			signedIn: false,
			reason: 'TikTok has not created a signed-in session cookie yet.'
		};
	}
	return { signedIn: true, url: target.url };
}

async function verifyPlatformSignin(client, platform) {
	if (platform === 'rumble') return verifyRumbleSignin(client);
	if (platform === 'tiktok') return verifyTikTokSignin(client);
	getPlatformSpec(platform);
	return { signedIn: false, reason: 'This source cannot be verified.' };
}

async function readPlatformCookies(client, platform) {
	const result = await client.call('Storage.getCookies');
	return Array.isArray(result.cookies) ? result.cookies.filter(cookie => isPlatformCookie(platform, cookie)) : [];
}

async function removePlatformCookies(cookieStore, platform, knownCookies = null) {
	const existing = Array.isArray(knownCookies)
		? knownCookies
		: (await cookieStore.get({})).filter(cookie => isPlatformCookie(platform, cookie));
	for (const cookie of existing) {
		await cookieStore.remove(buildCookieUrl(cookie), cookie.name);
	}
	return existing;
}

async function setPlatformCookies(cookieStore, cookies) {
	for (const cookie of cookies) {
		await cookieStore.set(toElectronCookie(cookie));
	}
}

async function importPlatformCookies(destinationSession, platform, chromeCookies) {
	const spec = getPlatformSpec(platform);
	const platformCookies = chromeCookies.filter(cookie => isPlatformCookie(spec.platform, cookie));
	if (!platformCookies.length) {
		throw createSigninError(
			'SSAPP_EXTERNAL_NO_COOKIES',
			`Chrome did not contain a ${spec.label} session to import.`
		);
	}

	const backup = (await destinationSession.cookies.get({})).filter(cookie => isPlatformCookie(spec.platform, cookie));
	try {
		await removePlatformCookies(destinationSession.cookies, spec.platform, backup);
		await setPlatformCookies(destinationSession.cookies, platformCookies);
		await destinationSession.flushStorageData();
	} catch (error) {
		try {
			await removePlatformCookies(destinationSession.cookies, spec.platform);
			await setPlatformCookies(destinationSession.cookies, backup);
			await destinationSession.flushStorageData();
		} catch (restoreError) {
			console.error(`[External Browser Sign-In] Failed to restore the previous ${spec.label} session:`, restoreError.message);
		}
		throw error;
	}
	return platformCookies.length;
}

async function importRumbleCookies(destinationSession, chromeCookies) {
	return importPlatformCookies(destinationSession, 'rumble', chromeCookies);
}

function resolveTemporaryProfileDirectory(profileDir) {
	if (!profileDir) return;
	const tempRoot = path.resolve(os.tmpdir());
	const resolvedProfile = path.resolve(profileDir);
	const hasAllowedPrefix = PROFILE_PREFIXES.some(prefix => path.basename(resolvedProfile).startsWith(prefix));
	if (path.dirname(resolvedProfile).toLowerCase() !== tempRoot.toLowerCase() || !hasAllowedPrefix) {
		throw createSigninError('SSAPP_EXTERNAL_PROFILE_SCOPE', 'Refused to remove an unexpected Chrome profile directory.');
	}
	return resolvedProfile;
}

function scheduleProfileCleanup(profileDir) {
	let resolvedProfile;
	try {
		resolvedProfile = resolveTemporaryProfileDirectory(profileDir);
	} catch (_) {
		return;
	}
	if (!resolvedProfile) return;
	const helperSource = `
		const fs = require('fs');
		const os = require('os');
		const path = require('path');
		const target = path.resolve(process.argv[1] || '');
		const tempRoot = path.resolve(os.tmpdir());
		const prefixes = ${JSON.stringify(PROFILE_PREFIXES)};
		if (path.dirname(target).toLowerCase() !== tempRoot.toLowerCase() || !prefixes.some(prefix => path.basename(target).startsWith(prefix))) process.exit(2);
		let attempts = 0;
		(function remove() {
			try {
				fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
				process.exit(0);
			} catch (_) {
				if (++attempts >= 80) process.exit(1);
				setTimeout(remove, 250);
			}
		})();
	`;
	try {
		const helper = spawn(process.execPath, ['-e', helperSource, resolvedProfile], {
			detached: true,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			stdio: 'ignore',
			windowsHide: true
		});
		helper.once('error', () => { });
		helper.unref();
	} catch (_) { }
}

async function removeProfileDirectory(profileDir, attempts = 6) {
	const resolvedProfile = resolveTemporaryProfileDirectory(profileDir);
	if (!resolvedProfile) return;

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			await fs.promises.rm(resolvedProfile, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt === attempts - 1) {
				console.warn('[External Browser Sign-In] Temporary profile cleanup will be retried later:', error.message);
				return;
			}
			await delay(250 * (attempt + 1));
		}
	}
}

function closeRunForQuit(run) {
	if (!run) return;
	run.closing = true;
	try { run.client?.sendWithoutReply('Browser.close'); } catch (_) { }
	try { run.client?.close(); } catch (_) { }
	if (run.childProcess && run.childProcess.exitCode === null) {
		try { run.childProcess.kill(); } catch (_) { }
	}
	try {
		const resolvedProfile = resolveTemporaryProfileDirectory(run.profileDir);
		if (resolvedProfile) {
			fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	} catch (error) {
		console.warn('[External Browser Sign-In] Could not finish temporary profile cleanup during shutdown:', error.message);
		scheduleProfileCleanup(run.profileDir);
	}
}

async function cleanupStaleProfiles(now = Date.now()) {
	const tempRoot = path.resolve(os.tmpdir());
	let entries = [];
	try {
		entries = await fs.promises.readdir(tempRoot, { withFileTypes: true });
	} catch (_) {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !PROFILE_PREFIXES.some(prefix => entry.name.startsWith(prefix))) continue;
		const profileDir = path.join(tempRoot, entry.name);
		try {
			const stat = await fs.promises.stat(profileDir);
			let ownerIsRunning = null;
			try {
				const owner = JSON.parse(await fs.promises.readFile(path.join(profileDir, PROFILE_OWNER_FILENAME), 'utf8'));
				if (Number.isInteger(owner.pid) && owner.pid > 0) {
					try {
						process.kill(owner.pid, 0);
						ownerIsRunning = true;
					} catch (error) {
						ownerIsRunning = error?.code === 'EPERM';
					}
				}
			} catch (_) { }
			if (ownerIsRunning === false || (ownerIsRunning === null && now - stat.mtimeMs >= STALE_PROFILE_AGE_MS)) {
				await removeProfileDirectory(profileDir);
			}
		} catch (_) { }
	}
}

async function closeRun(run) {
	if (!run) return;
	if (run.closePromise) return run.closePromise;
	run.closing = true;
	run.closePromise = (async () => {
		try { run.client?.sendWithoutReply('Browser.close'); } catch (_) { }
		await delay(300);
		try { run.client?.close(); } catch (_) { }
		if (run.childProcess && run.childProcess.exitCode === null) {
			try { run.childProcess.kill(); } catch (_) { }
		}
		await removeProfileDirectory(run.profileDir);
	})();
	return run.closePromise;
}

async function launchIsolatedBrowser(browser, options = {}) {
	const spec = getPlatformSpec(options.platform || 'rumble');
	const profileDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), PROFILE_PREFIX));
	let run = { browser, platform: spec.platform, childProcess: null, client: null, profileDir, closing: false };
	try {
		await fs.promises.writeFile(path.join(profileDir, PROFILE_OWNER_FILENAME), JSON.stringify({
			pid: process.pid,
			createdAt: Date.now()
		}));
		if (typeof options.onRunCreated === 'function') options.onRunCreated(run);
		const port = await (options.reserveLocalPort || reserveLocalPort)();
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw createSigninError('SSAPP_EXTERNAL_DEVTOOLS_PORT', 'Could not reserve a local Chrome connection port.');
		}
		if (run.closing) {
			throw createSigninError('SSAPP_EXTERNAL_BROWSER_CLOSED', 'SSApp closed the Chrome sign-in before it started.');
		}
		const spawnFn = options.spawnFn || spawn;
		run.childProcess = spawnFn(browser.path, [
			`--user-data-dir=${profileDir}`,
			'--remote-debugging-address=127.0.0.1',
			// Port zero makes Chromium expose navigator.webdriver. A normal local port
			// keeps this genuine Chrome sign-in window out of automation mode.
			`--remote-debugging-port=${port}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--new-window',
			spec.loginUrl
		], {
			stdio: 'ignore',
			windowsHide: false
		});
		run.childProcess?.on?.('error', error => {
			run.childError = error;
		});
		const websocketUrl = await waitForDevToolsEndpoint(port, run.childProcess, options.startTimeoutMs);
		run.client = new CdpConnection(websocketUrl, options);
		await run.client.connect();
		return run;
	} catch (error) {
		await closeRun(run);
		throw error;
	}
}

async function runExternalBrowserSignin(payload = {}, dependencies = {}) {
	const spec = getPlatformSpec(payload.platform);
	const electron = dependencies.electron || require('electron');
	const dialog = dependencies.dialog || electron.dialog;
	const session = dependencies.session || electron.session;
	const browser = dependencies.browser || findBrowserExecutable(dependencies);
	if (!browser) {
		throw createSigninError('SSAPP_EXTERNAL_BROWSER_NOT_FOUND', 'Google Chrome or Microsoft Edge was not found.');
	}

	const partition = normalizeExternalSessionPartition(spec.platform, payload.customSession || 'AUTO');
	if (activeRunsByPartition.size > 0) {
		const samePartition = activeRunsByPartition.has(partition);
		throw createSigninError(
			'SSAPP_EXTERNAL_SIGNIN_ACTIVE',
			samePartition
				? 'A Chrome sign-in is already active for this browser session.'
				: 'Finish or cancel the other Chrome sign-in before starting another profile.'
		);
	}

	const destinationSession = session.fromPartition(partition);
	const parentWindow = typeof dependencies.getMainWindow === 'function' ? dependencies.getMainWindow() : null;
	let run = null;
	activeRunsByPartition.set(partition, null);
	try {
		const registerRun = createdRun => {
			run = createdRun;
			activeRunsByPartition.set(partition, createdRun);
		};
		if (dependencies.launchBrowser) {
			registerRun(await dependencies.launchBrowser(browser, registerRun, { platform: spec.platform }));
		} else {
			run = await launchIsolatedBrowser(browser, {
				...dependencies,
				platform: spec.platform,
				onRunCreated: registerRun
			});
			registerRun(run);
		}

		const promptResult = await dialog.showMessageBox(parentWindow || undefined, {
			type: 'info',
			title: `${spec.label} Sign-In via Chrome`,
			message: `Finish signing into ${spec.label} in ${browser.name}.`,
			detail: `You may use Google in the browser that just opened. When ${spec.label} shows you as signed in, leave Chrome open, return here, and click Import Sign-In. SSApp closes the temporary Chrome window after importing. Only ${spec.label} cookies will be copied into this SSApp browser session.`,
			buttons: ['Import Sign-In', 'Cancel'],
			defaultId: 0,
			cancelId: 1,
			noLink: true
		});
		if (promptResult.response !== 0) {
			return { success: false, cancelled: true, partition, browser: browser.name };
		}

		let verification = await verifyPlatformSignin(run.client, spec.platform);
		while (!verification.signedIn) {
			const retryResult = await dialog.showMessageBox(parentWindow || undefined, {
				type: 'warning',
				title: `${spec.label} Sign-In Not Detected`,
				message: `SSApp could not confirm that ${spec.label} is signed in yet.`,
				detail: verification.reason || `Finish signing in inside Chrome, then try again. "Import Anyway" can replace the existing ${spec.label} sign-in for this SSApp browser session, so use it only when ${spec.label} is visibly signed in.`,
				buttons: ['Try Again', 'Import Anyway', 'Cancel'],
				defaultId: 0,
				cancelId: 2,
				noLink: true
			});
			if (retryResult.response === 2) {
				return { success: false, cancelled: true, partition, browser: browser.name };
			}
			if (retryResult.response === 1) break;
			verification = await verifyPlatformSignin(run.client, spec.platform);
		}

		const chromeCookies = await readPlatformCookies(run.client, spec.platform);
		const importedCookies = await importPlatformCookies(destinationSession, spec.platform, chromeCookies);
		if (typeof dependencies.trackPartition === 'function') dependencies.trackPartition(partition);
		console.log(`[External Browser Sign-In] Imported ${importedCookies} ${spec.label} cookies into ${partition}`);
		return {
			success: true,
			platform: spec.platform,
			partition,
			browser: browser.name,
			importedCookies,
			verified: verification.signedIn === true
		};
	} finally {
		activeRunsByPartition.delete(partition);
		await closeRun(run);
	}
}

async function runRumbleChromeSignin(payload = {}, dependencies = {}) {
	return runExternalBrowserSignin({ ...payload, platform: 'rumble' }, dependencies);
}

function setupExternalBrowserSigninHandler(options = {}) {
	const electron = options.electron || require('electron');
	const { app, ipcMain } = electron;
	const handleSignin = async (event, payload = {}) => {
		const mainWindow = typeof options.getMainWindow === 'function' ? options.getMainWindow() : null;
		if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
			throw createSigninError('SSAPP_EXTERNAL_SIGNIN_FORBIDDEN', 'Chrome sign-in is only available from the SSApp window.');
		}
		return runExternalBrowserSignin(payload, {
			...options,
			electron,
			app,
			getMainWindow: options.getMainWindow
		});
	};

	try { ipcMain.removeHandler('external-browser-signin'); } catch (_) { }
	try { ipcMain.removeHandler('rumble-chrome-signin'); } catch (_) { }
	ipcMain.handle('external-browser-signin', handleSignin);
	ipcMain.handle('rumble-chrome-signin', (event, payload = {}) => {
		return handleSignin(event, { ...payload, platform: 'rumble' });
	});

	cleanupStaleProfiles().catch(() => { });
	app.on('before-quit', () => {
		if (activeRunsByPartition.size > 0) {
			console.log(`[External Browser Sign-In] Closing ${activeRunsByPartition.size} active Chrome sign-in during shutdown.`);
		}
		for (const run of activeRunsByPartition.values()) {
			closeRunForQuit(run);
		}
	});
}

function setupRumbleChromeSigninHandler(options = {}) {
	return setupExternalBrowserSigninHandler(options);
}

module.exports = {
	PLATFORM_SPECS,
	PROFILE_PREFIX,
	PROFILE_OWNER_FILENAME,
	buildCookieUrl,
	closeRun,
	cleanupStaleProfiles,
	findBrowserExecutable,
	getBrowserCandidates,
	importPlatformCookies,
	importRumbleCookies,
	isPlatformCookie,
	isRumbleCookie,
	launchIsolatedBrowser,
	mapSameSite,
	normalizeExternalSessionPartition,
	normalizeRumbleSessionPartition,
	runExternalBrowserSignin,
	runRumbleChromeSignin,
	scheduleProfileCleanup,
	setupExternalBrowserSigninHandler,
	setupRumbleChromeSigninHandler,
	toElectronCookie,
	verifyPlatformSignin,
	verifyTikTokSignin,
	verifyRumbleSignin
};
