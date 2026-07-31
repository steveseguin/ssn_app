'use strict';

// Authenticated, long-running Twitch WebSocket validation in SSApp's real Electron runtime.
// The dedicated profile is intentionally persistent so OAuth only needs to be completed once.
// No access or refresh token is returned to this process or written to the report.
//
// Recommended overnight run:
//   npm run test:twitch-websocket:soak -- --minutes=480
// Add --channel=TWITCH_LOGIN only when intentionally monitoring another channel.
//
// The test performs a controlled invalid-access-token exercise in the isolated profile to prove
// that the hosted refresh-token path recovers, then closes EventSub once to prove it reconnects.
// A run that sees no real chat message is reported as inconclusive rather than passed.

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const electronPath = require('electron');

const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamFsRoot = path.resolve(repoRoot, '..', 'social_stream');
const socialStreamUrl = pathToFileURL(socialStreamFsRoot + path.sep).href;
const stamp = Date.now();

const INVALID_ACCESS_TOKEN = 'ssapp-twitch-soak-invalid-access-token';
const REFRESH_STATE_KEY = '__ssappTwitchSoakRefreshState';
const ACCESS_BACKUP_KEY = '__ssappTwitchSoakAccessBackup';
const REFRESH_BACKUP_KEY = '__ssappTwitchSoakRefreshBackup';
const EXPIRY_BACKUP_KEY = '__ssappTwitchSoakExpiryBackup';
const SCOPE_BACKUP_KEY = '__ssappTwitchSoakScopeBackup';
const CLIENT_ID_BACKUP_KEY = '__ssappTwitchSoakClientIdBackup';

function argValue(name) {
	const prefix = `--${name}=`;
	const value = process.argv.find(argument => argument.startsWith(prefix));
	return value ? value.slice(prefix.length) : '';
}

function hasArg(name) {
	return process.argv.includes(`--${name}`);
}

function numericArg(name, fallback, minimum) {
	const parsed = Number.parseFloat(argValue(name));
	return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function defaultProfilePath() {
	if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
		return path.join(process.env.LOCALAPPDATA, 'SSApp Test Profiles', 'twitch-websocket-soak');
	}
	if (process.platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support', 'SSApp Test Profiles', 'twitch-websocket-soak');
	}
	return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ssapp-test-profiles', 'twitch-websocket-soak');
}

function normalizeChannel(value) {
	let channel = String(value || '').trim();
	try {
		if (/^https?:\/\//i.test(channel)) {
			const url = new URL(channel);
			channel = url.pathname.split('/').filter(Boolean)[0] || '';
		}
	} catch (_) { }
	return channel.replace(/^@/, '').replace(/^#/, '').toLowerCase();
}

function printUsage() {
	console.log('Usage: npm run test:twitch-websocket:soak -- [options]');
	console.log('');
	console.log('Options:');
	console.log('  --channel=TWITCH_LOGIN        Channel to monitor (default: signed-in account)');
	console.log('  --minutes=480                 Soak duration after preflight checks');
	console.log('  --profile=PATH                Reusable isolated OAuth profile');
	console.log('  --report=PATH                 JSONL report destination');
	console.log('  --auth-timeout-minutes=10     Time allowed for interactive OAuth');
	console.log('  --sample-seconds=15           Connection-health sample interval');
	console.log('  --max-outage-seconds=90       Longest tolerated socket outage');
	console.log('  --no-auth                     Do not open the browser if sign-in is needed');
	console.log('  --no-force-refresh            Skip the controlled token-refresh exercise');
	console.log('  --no-eventsub-reconnect       Skip the controlled EventSub reconnect exercise');
}

const channel = normalizeChannel(argValue('channel') || process.env.TWITCH_CHANNEL);
let activeChannel = channel;
const minutes = numericArg('minutes', 480, 0.1);
const authTimeoutMinutes = numericArg('auth-timeout-minutes', 10, 1);
const sampleSeconds = numericArg('sample-seconds', 15, 2);
const maxOutageSeconds = numericArg('max-outage-seconds', 90, 10);
const profilePath = path.resolve(argValue('profile') || process.env.SSAPP_TWITCH_SOAK_PROFILE || defaultProfilePath());
const reportPath = path.resolve(
	argValue('report') || process.env.SOAK_REPORT || path.join(os.tmpdir(), `ssapp-twitch-websocket-soak-${stamp}.jsonl`)
);
const allowInteractiveAuth = !hasArg('no-auth');
const forceRefresh = !hasArg('no-force-refresh');
const exerciseEventSubReconnect = !hasArg('no-eventsub-reconnect');

let child = null;
let remotePort = null;
let remoteToken = null;
let mainWindowId = null;
let sourceId = null;
let sourceViewKey = null;
let interrupted = false;
let stdoutTail = '';
let stderrTail = '';

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function getFreePort() {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = address && typeof address === 'object' ? address.port : 0;
			server.close(() => resolve(port));
		});
		server.on('error', reject);
	});
}

function requestJson(pathname, body, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : null;
		const requestPath = `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(remoteToken)}`;
		const request = http.request({
			host: '127.0.0.1',
			port: remotePort,
			path: requestPath,
			method: payload ? 'POST' : 'GET',
			headers: payload ? {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload)
			} : {}
		}, response => {
			let text = '';
			response.setEncoding('utf8');
			response.on('data', chunk => {
				text += chunk;
			});
			response.on('end', () => {
				try {
					const data = text ? JSON.parse(text) : {};
					if (response.statusCode >= 200 && response.statusCode < 300) {
						resolve(data);
						return;
					}
					reject(new Error(`HTTP ${response.statusCode}: ${data.error || text}`));
				} catch (error) {
					reject(error);
				}
			});
		});
		request.setTimeout(timeoutMs, () => request.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms`)));
		request.on('error', reject);
		if (payload) request.write(payload);
		request.end();
	});
}

async function waitFor(check, label, timeoutMs, intervalMs = 500) {
	const startedAt = Date.now();
	let lastError = null;
	while (Date.now() - startedAt < timeoutMs) {
		if (interrupted) throw createRunError('Soak interrupted', 'INTERRUPTED');
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await sleep(intervalMs);
	}
	throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

function createRunError(message, code = 'FAILED') {
	const error = new Error(message);
	error.code = code;
	return error;
}

async function execInWindow(windowId, code, label = 'window execution') {
	const response = await requestJson('/exec', { windowId, code });
	if (!response || response.ok !== true) {
		throw new Error(`${label}: ${response && response.error ? response.error : 'execution failed'}`);
	}
	return response.result;
}

async function execInMain(code, label = 'main window execution') {
	return execInWindow(mainWindowId, code, label);
}

async function execInSource(code, label = 'Twitch source execution') {
	const response = await requestJson('/view-exec', { key: sourceViewKey, code });
	if (!response || response.ok !== true) {
		throw new Error(`${label}: ${response && response.error ? response.error : 'execution failed'}`);
	}
	return response.result;
}

async function listWindows() {
	const response = await requestJson('/windows');
	return response.windows || [];
}

async function listViews() {
	const response = await requestJson('/views');
	return response.views || [];
}

function writeReport(type, data = {}) {
	fs.appendFileSync(reportPath, `${JSON.stringify({ type, at: new Date().toISOString(), ...data })}\n`, 'utf8');
}

function formatDuration(ms) {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutesPart = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return `${hours}h ${minutesPart}m ${seconds}s`;
}

function safeTail(value) {
	return String(value || '')
		.replace(/(access_token|refresh_token|authorization)(["'=: ]+)[^\s"']+/gi, '$1$2[redacted]')
		.replace(/([?#](?:[^\s#]*token)[^\s]*)/gi, '[redacted-url-parameters]')
		.slice(-8000);
}

function launchApp() {
	fs.mkdirSync(profilePath, { recursive: true });
	fs.mkdirSync(path.dirname(reportPath), { recursive: true });
	fs.writeFileSync(reportPath, '', 'utf8');

	const args = [
		'.',
		'--running-from-source',
		'--multiinstance',
		'--filesource',
		socialStreamUrl,
		'--remote-control'
	];
	child = spawn(electronPath, args, {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profilePath,
			SSAPP_REMOTE_CONTROL: '1',
			SSAPP_REMOTE_CONTROL_PORT: String(remotePort),
			SSAPP_REMOTE_CONTROL_TOKEN: remoteToken,
			SSAPP_DEBUG_LOGS: '1'
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: false
	});
	child.stdout.on('data', chunk => {
		stdoutTail = (stdoutTail + chunk.toString()).slice(-40000);
	});
	child.stderr.on('data', chunk => {
		stderrTail = (stderrTail + chunk.toString()).slice(-40000);
	});
	child.once('exit', code => {
		if (!interrupted && code !== null && code !== 0) {
			console.error(`[twitch-soak] SSApp exited unexpectedly with code ${code}`);
		}
	});
}

async function waitForApp() {
	await waitFor(async () => {
		try {
			const response = await requestJson('/ping');
			return response && response.ok;
		} catch (_) {
			return false;
		}
	}, 'SSApp startup', 60000);

	const mainWindow = await waitFor(async () => {
		const windows = await listWindows();
		return windows.find(windowInfo => String(windowInfo.url || '').includes('index.html'));
	}, 'SSApp main window', 30000);
	mainWindowId = mainWindow.id;

	await waitFor(async () => {
		return await execInMain(`
			Boolean(
				window.stateManager
					&& stateManager.initialized
					&& typeof newOtherSource === 'function'
					&& typeof createWindow === 'function'
					&& typeof platformSupportsWebSocket === 'function'
					&& platformSupportsWebSocket('twitch')
					&& typeof configReady !== 'undefined'
					&& configReady
			)
		`, 'wait for SSApp renderer initialization');
	}, 'SSApp renderer initialization', 60000);
}

async function launchTwitchSource() {
	const result = await execInMain(`
		(async () => {
			stateManager.clearAllSourcesAndGroups();
			let id = null;
			if (${JSON.stringify(Boolean(channel))}) {
				const element = await newOtherSource(
					'twitch',
					${JSON.stringify(channel ? `https://www.twitch.tv/${channel}` : '')},
					false,
					{
						username: ${JSON.stringify(channel)},
						connectionMode: 'websocket',
						isVisible: true,
						isMuted: true,
						autoActivate: false,
						sourceFile: 'sources/websocket/twitch.js'
					}
				);
				id = element && element.dataset ? element.dataset.sourceId : null;
			} else {
				id = stateManager.addSource({
					id: 'twitch-soak-own-channel',
					target: 'twitch',
					url: '',
					username: '',
					connectionMode: 'websocket',
					isVisible: true,
					isMuted: true,
					autoActivate: false,
					supportsWSS: true,
					sourceFile: 'sources/websocket/twitch.js'
				});
				await Promise.resolve();
			}
			if (!id) throw new Error('Twitch source was not created');
			const entry = document.querySelector('[data-source-id="' + id + '"]');
			const activate = entry && entry.querySelector('[data-activatehtml]');
			if (!activate) throw new Error('Twitch source activation control was not found');
			const tabId = await createWindow(activate);
			if (!tabId) throw new Error('Twitch WebSocket source did not open');
			return { sourceId: id, tabId };
		})()
	`, 'launch Twitch WebSocket source');

	sourceId = result.sourceId;
	sourceViewKey = String(result.tabId);
	await waitFor(async () => {
		const views = await listViews();
		return views.some(view => String(view.key) === sourceViewKey && /sources\/websocket\/twitch\.html/i.test(view.url || ''));
	}, 'Twitch WebSocket source window', 60000);

	await waitFor(async () => {
		return await execInSource(`
			Boolean(
				document.getElementById('auth-link')
					&& window.websocket
					&& typeof window.__SSAPP_START_TWITCH_AUTH__ === 'function'
			)
		`, 'wait for Twitch source injection');
	}, 'Twitch source script injection', 60000);

	if (!channel) {
		const reloading = await execInSource(`
			(() => {
				if (!localStorage.getItem('twitchChannel')) return false;
				localStorage.removeItem('twitchChannel');
				setTimeout(() => location.reload(), 25);
				return true;
			})()
		`, 'clear remembered Twitch channel');
		if (reloading) {
			await sleep(250);
			await waitFor(async () => {
				return await execInSource(`
					Boolean(
						document.getElementById('auth-link')
							&& window.websocket
							&& typeof window.__SSAPP_START_TWITCH_AUTH__ === 'function'
					)
				`, 'wait for Twitch source reload');
			}, 'Twitch source reload', 60000);
		}
	}
}

async function installTracker() {
	return await execInSource(`
		(() => {
			if (window.__ssappTwitchSoakTracker) return true;
			const tracker = {
				id: Date.now() + '-' + Math.random().toString(36).slice(2),
				startedAt: Date.now(),
				forwardedMessages: 0,
				chatMessages: 0,
				forwardedEvents: 0,
				domRowsAdded: 0,
				lastForwardedAt: 0,
				eventMessages: 0,
				eventTypes: {},
				lastEventMessageAt: 0,
				eventSocketsSeen: 0,
				eventSocketChanges: 0,
				eventSocketOpens: 0,
				eventSocketCloses: 0,
				eventSocketErrors: 0,
				refreshRequests: 0,
				refreshSuccesses: 0,
				refreshFailures: 0,
				validateRequests: 0,
				validateFailures: 0,
				eventSocket: null,
				eventExerciseOriginal: null,
				eventExerciseStartedAt: 0
			};
			window.__ssappTwitchSoakTracker = tracker;

			const runtime = window.chrome && window.chrome.runtime;
			if (runtime && typeof runtime.sendMessage === 'function' && !runtime.__ssappTwitchSoakWrapped) {
				const originalSendMessage = runtime.sendMessage;
				runtime.sendMessage = function(...args) {
					try {
						const active = window.__ssappTwitchSoakTracker;
						const request = args[1] && typeof args[1] === 'object' ? args[1] : args[0];
						const message = request && request.message;
						if (active && message && typeof message === 'object') {
							active.forwardedMessages += 1;
							active.lastForwardedAt = Date.now();
							if (typeof message.chatmessage === 'string' && message.chatmessage.length) active.chatMessages += 1;
							if (message.event) active.forwardedEvents += 1;
						}
					} catch (_) { }
					return originalSendMessage.apply(this, args);
				};
				runtime.__ssappTwitchSoakWrapped = true;
			}

			if (typeof window.fetch === 'function' && !window.fetch.__ssappTwitchSoakWrapped) {
				const originalFetch = window.fetch;
				const trackedFetch = async function(...args) {
					const active = window.__ssappTwitchSoakTracker;
					let url = '';
					try {
						url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
					} catch (_) { }
					const isRefresh = url.includes('sso.socialstream.ninja/auth/twitch/refresh');
					const isValidate = url.includes('id.twitch.tv/oauth2/validate');
					if (active && isRefresh) active.refreshRequests += 1;
					if (active && isValidate) active.validateRequests += 1;
					try {
						const response = await originalFetch.apply(this, args);
						if (active && isRefresh) {
							if (response && response.ok) active.refreshSuccesses += 1;
							else active.refreshFailures += 1;
						}
						if (active && isValidate && (!response || !response.ok)) active.validateFailures += 1;
						return response;
					} catch (error) {
						if (active && isRefresh) active.refreshFailures += 1;
						if (active && isValidate) active.validateFailures += 1;
						throw error;
					}
				};
				trackedFetch.__ssappTwitchSoakWrapped = true;
				window.fetch = trackedFetch;
			}

			const textarea = document.getElementById('textarea');
			if (textarea && typeof MutationObserver === 'function') {
				tracker.domObserver = new MutationObserver(records => {
					for (const record of records) tracker.domRowsAdded += record.addedNodes ? record.addedNodes.length : 0;
				});
				tracker.domObserver.observe(textarea, { childList: true });
			}

			const hookEventSocket = () => {
				const active = window.__ssappTwitchSoakTracker;
				if (!active) return;
				const socket = window.eventSocket || null;
				if (socket === active.eventSocket) return;
				if (active.eventSocket) active.eventSocketChanges += 1;
				active.eventSocket = socket;
				if (!socket) return;
				active.eventSocketsSeen += 1;
				socket.addEventListener('open', () => { active.eventSocketOpens += 1; });
				socket.addEventListener('close', () => { active.eventSocketCloses += 1; });
				socket.addEventListener('error', () => { active.eventSocketErrors += 1; });
				socket.addEventListener('message', event => {
					active.eventMessages += 1;
					active.lastEventMessageAt = Date.now();
					try {
						const parsed = JSON.parse(event.data);
						const type = parsed && parsed.metadata && parsed.metadata.message_type;
						if (type) active.eventTypes[type] = (active.eventTypes[type] || 0) + 1;
					} catch (_) { }
				});
			};
			tracker.eventHookTimer = setInterval(hookEventSocket, 250);
			hookEventSocket();
			return true;
		})()
	`, 'install Twitch soak tracker');
}

async function readSourceState() {
	return await execInMain(`
		(() => {
			const source = stateManager.getSource(${JSON.stringify(sourceId)});
			return source ? {
				present: true,
				status: source.status || null,
				error: source.error || null,
				vid: source.vid || null,
				wssId: source.wssId || null,
				activeConnectionMode: source.activeConnectionMode || null
			} : { present: false };
		})()
	`, 'read Twitch source state');
}

async function readViewState() {
	return await execInSource(`
		(() => {
			const tracker = window.__ssappTwitchSoakTracker || null;
			const accessToken = localStorage.getItem('twitchOAuthToken') || '';
			const refreshToken = localStorage.getItem('twitchOAuthRefreshToken') || '';
			const refreshState = sessionStorage.getItem(${JSON.stringify(REFRESH_STATE_KEY)}) || '';
			const eventSocket = window.eventSocket || null;
			const authElement = document.querySelector('.auth');
			const socketElements = Array.from(document.querySelectorAll('.socket'));
			return {
				urlReady: /sources\\/websocket\\/twitch\\.html/i.test(location.href),
				tokenPresent: !!accessToken,
				refreshTokenPresent: !!refreshToken,
				invalidAccessToken: accessToken === ${JSON.stringify(INVALID_ACCESS_TOKEN)},
				refreshExerciseState: refreshState,
				refreshExerciseRecovered: refreshState === 'armed'
					&& !!accessToken
					&& accessToken !== ${JSON.stringify(INVALID_ACCESS_TOKEN)}
					&& !!refreshToken,
				expiresInMs: Math.max(0, Number(localStorage.getItem('twitchOAuthExpiry') || 0) - Date.now()),
				authVisible: !!authElement && !authElement.classList.contains('hidden'),
				socketUiVisible: socketElements.some(element => !element.classList.contains('hidden')),
				currentUser: (document.getElementById('current-user')?.textContent || '').trim(),
				currentChannel: (document.getElementById('current-channel')?.textContent || '').trim(),
				chatReadyState: window.websocket && Number.isFinite(window.websocket.readyState)
					? window.websocket.readyState
					: null,
				eventReadyState: eventSocket && Number.isFinite(eventSocket.readyState)
					? eventSocket.readyState
					: null,
				eventExerciseStarted: !!(tracker && tracker.eventExerciseOriginal),
				eventExerciseRecovered: !!(
					tracker
						&& tracker.eventExerciseOriginal
						&& eventSocket
						&& eventSocket !== tracker.eventExerciseOriginal
						&& eventSocket.readyState === WebSocket.OPEN
				),
				tracker: tracker ? {
					id: tracker.id,
					startedAt: tracker.startedAt,
					forwardedMessages: tracker.forwardedMessages,
					chatMessages: tracker.chatMessages,
					forwardedEvents: tracker.forwardedEvents,
					domRowsAdded: tracker.domRowsAdded,
					lastForwardedAt: tracker.lastForwardedAt,
					eventMessages: tracker.eventMessages,
					eventTypes: { ...tracker.eventTypes },
					lastEventMessageAt: tracker.lastEventMessageAt,
					eventSocketsSeen: tracker.eventSocketsSeen,
					eventSocketChanges: tracker.eventSocketChanges,
					eventSocketOpens: tracker.eventSocketOpens,
					eventSocketCloses: tracker.eventSocketCloses,
					eventSocketErrors: tracker.eventSocketErrors,
					refreshRequests: tracker.refreshRequests,
					refreshSuccesses: tracker.refreshSuccesses,
					refreshFailures: tracker.refreshFailures,
					validateRequests: tracker.validateRequests,
					validateFailures: tracker.validateFailures
				} : null
			};
		})()
	`, 'read Twitch WebSocket health');
}

async function triggerInteractiveAuth() {
	const started = await execInSource(`
		(() => {
			if (typeof window.__SSAPP_START_TWITCH_AUTH__ !== 'function') return false;
			if (window.__ssappTwitchSoakAuthPending) return true;
			window.__ssappTwitchSoakAuthPending = true;
			Promise.resolve(window.__SSAPP_START_TWITCH_AUTH__())
				.catch(() => null)
				.finally(() => { window.__ssappTwitchSoakAuthPending = false; });
			return true;
		})()
	`, 'start Twitch OAuth');
	if (!started) throw new Error('SSApp could not start Twitch OAuth');
}

async function ensureAuthenticated() {
	let state = await readViewState();
	if (!state.refreshTokenPresent) {
		if (!allowInteractiveAuth) {
			throw createRunError('The isolated profile needs Twitch sign-in and --no-auth was specified.', 'INCONCLUSIVE');
		}
		console.log('[twitch-soak] Twitch sign-in is required in the isolated test profile.');
		console.log('[twitch-soak] Complete the browser authorization that is opening; the test will continue automatically.');
		writeReport('auth_required', { timeoutMinutes: authTimeoutMinutes });
		await triggerInteractiveAuth();
	}

	state = await waitFor(async () => {
		const candidate = await readViewState();
		return candidate.tokenPresent && candidate.refreshTokenPresent && candidate.chatReadyState === 1 ? candidate : null;
	}, 'authenticated Twitch chat connection', authTimeoutMinutes * 60000, 1000);

	const normalizedUser = normalizeChannel(state.currentUser);
	const normalizedConnectedChannel = normalizeChannel(state.currentChannel);
	if (channel && normalizedConnectedChannel && normalizedConnectedChannel !== channel) {
		throw new Error(`Twitch connected to ${state.currentChannel}, not requested channel ${channel}`);
	}
	activeChannel = normalizedConnectedChannel || normalizedUser || channel;
	console.log(`[twitch-soak] Chat connected as ${state.currentUser || 'authenticated user'} to ${state.currentChannel || activeChannel}.`);
	writeReport('authenticated', {
		currentUser: state.currentUser || null,
		currentChannel: state.currentChannel || activeChannel,
		ownChannel: normalizedUser === activeChannel,
		expiresInMs: state.expiresInMs
	});
	return state;
}

async function armForcedRefresh() {
	return await execInSource(`
		(() => {
			const accessToken = localStorage.getItem('twitchOAuthToken');
			const refreshToken = localStorage.getItem('twitchOAuthRefreshToken');
			if (!accessToken || !refreshToken) return false;
			sessionStorage.setItem(${JSON.stringify(ACCESS_BACKUP_KEY)}, accessToken);
			sessionStorage.setItem(${JSON.stringify(REFRESH_BACKUP_KEY)}, refreshToken);
			sessionStorage.setItem(${JSON.stringify(EXPIRY_BACKUP_KEY)}, localStorage.getItem('twitchOAuthExpiry') || '');
			sessionStorage.setItem(${JSON.stringify(SCOPE_BACKUP_KEY)}, localStorage.getItem('twitchOAuthScope') || '');
			sessionStorage.setItem(${JSON.stringify(CLIENT_ID_BACKUP_KEY)}, localStorage.getItem('twitchOAuthClientId') || '');
			sessionStorage.setItem(${JSON.stringify(REFRESH_STATE_KEY)}, 'armed');
			localStorage.setItem('twitchOAuthToken', ${JSON.stringify(INVALID_ACCESS_TOKEN)});
			sessionStorage.setItem('twitchOAuthToken', ${JSON.stringify(INVALID_ACCESS_TOKEN)});
			setTimeout(() => location.reload(), 25);
			return true;
		})()
	`, 'arm controlled Twitch token refresh');
}

async function finalizeForcedRefresh() {
	await execInSource(`
		(() => {
			sessionStorage.setItem(${JSON.stringify(REFRESH_STATE_KEY)}, 'passed');
			sessionStorage.removeItem(${JSON.stringify(ACCESS_BACKUP_KEY)});
			sessionStorage.removeItem(${JSON.stringify(REFRESH_BACKUP_KEY)});
			sessionStorage.removeItem(${JSON.stringify(EXPIRY_BACKUP_KEY)});
			sessionStorage.removeItem(${JSON.stringify(SCOPE_BACKUP_KEY)});
			sessionStorage.removeItem(${JSON.stringify(CLIENT_ID_BACKUP_KEY)});
			return true;
		})()
	`, 'finalize controlled Twitch token refresh');
}

async function restoreForcedRefreshIfNeeded() {
	if (!sourceViewKey || !remotePort) return false;
	try {
		return await execInSource(`
			(() => {
				if (sessionStorage.getItem(${JSON.stringify(REFRESH_STATE_KEY)}) !== 'armed') return false;
				const accessToken = sessionStorage.getItem(${JSON.stringify(ACCESS_BACKUP_KEY)});
				const refreshToken = sessionStorage.getItem(${JSON.stringify(REFRESH_BACKUP_KEY)});
				if (!accessToken || !refreshToken) return false;
				localStorage.setItem('twitchOAuthToken', accessToken);
				localStorage.setItem('twitchOAuthRefreshToken', refreshToken);
				const restore = (storageKey, backupKey) => {
					const value = sessionStorage.getItem(backupKey) || '';
					if (value) localStorage.setItem(storageKey, value);
					else localStorage.removeItem(storageKey);
				};
				restore('twitchOAuthExpiry', ${JSON.stringify(EXPIRY_BACKUP_KEY)});
				restore('twitchOAuthScope', ${JSON.stringify(SCOPE_BACKUP_KEY)});
				restore('twitchOAuthClientId', ${JSON.stringify(CLIENT_ID_BACKUP_KEY)});
				sessionStorage.setItem('twitchOAuthToken', accessToken);
				sessionStorage.setItem(${JSON.stringify(REFRESH_STATE_KEY)}, 'restored_after_failure');
				return true;
			})()
		`, 'restore Twitch test credentials');
	} catch (_) {
		return false;
	}
}

async function exerciseTokenRefresh() {
	if (!forceRefresh) {
		console.log('[twitch-soak] Controlled token refresh skipped by request.');
		writeReport('refresh_exercise', { result: 'skipped' });
		return 'skipped';
	}

	console.log('[twitch-soak] Exercising hosted token refresh in the isolated profile...');
	writeReport('refresh_exercise', { result: 'started' });
	const armed = await armForcedRefresh();
	if (!armed) throw new Error('Could not arm the Twitch token-refresh exercise');

	try {
		const recovered = await waitFor(async () => {
			const state = await readViewState();
			return state.refreshExerciseRecovered && state.chatReadyState === 1 ? state : null;
		}, 'Twitch token refresh recovery', 180000, 1000);
		await finalizeForcedRefresh();
		await installTracker();
		console.log('[twitch-soak] Hosted token refresh recovered to an open chat connection.');
		writeReport('refresh_exercise', {
			result: 'passed',
			expiresInMs: recovered.expiresInMs
		});
		return 'passed';
	} catch (error) {
		const restored = await restoreForcedRefreshIfNeeded();
		writeReport('refresh_exercise', { result: 'failed', restored, error: error.message });
		throw new Error(`Controlled Twitch token refresh failed${restored ? '; the isolated profile credentials were restored' : ''}: ${error.message}`);
	}
}

async function exerciseEventSub() {
	if (!exerciseEventSubReconnect) {
		console.log('[twitch-soak] Controlled EventSub reconnect skipped by request.');
		writeReport('eventsub_reconnect_exercise', { result: 'skipped' });
		return 'skipped';
	}

	let state = null;
	try {
		state = await waitFor(async () => {
			const candidate = await readViewState();
			return candidate.eventReadyState === 1 ? candidate : null;
		}, 'EventSub connection', 60000, 1000);
	} catch (error) {
		const candidate = await readViewState().catch(() => null);
		const ownChannel = candidate && normalizeChannel(candidate.currentUser) === activeChannel;
		if (ownChannel) throw error;
		console.log('[twitch-soak] EventSub is unavailable for this account/channel pair; reconnect exercise is inconclusive.');
		writeReport('eventsub_reconnect_exercise', { result: 'inconclusive', reason: 'eventsub_unavailable' });
		return 'inconclusive';
	}

	await installTracker();
	const started = await execInSource(`
		(() => {
			const tracker = window.__ssappTwitchSoakTracker;
			const socket = window.eventSocket;
			if (!tracker || !socket || socket.readyState !== WebSocket.OPEN) return false;
			tracker.eventExerciseOriginal = socket;
			tracker.eventExerciseStartedAt = Date.now();
			socket.close(4000, 'SSApp Twitch soak reconnect exercise');
			return true;
		})()
	`, 'start EventSub reconnect exercise');
	if (!started) throw new Error('Could not start the EventSub reconnect exercise');

	state = await waitFor(async () => {
		const candidate = await readViewState();
		return candidate.eventExerciseRecovered && candidate.chatReadyState === 1 ? candidate : null;
	}, 'EventSub reconnect recovery', 120000, 1000);
	console.log('[twitch-soak] EventSub recovered on a replacement socket while chat stayed open.');
	writeReport('eventsub_reconnect_exercise', { result: 'passed' });
	return state ? 'passed' : 'failed';
}

const trackerTotals = {
	forwardedMessages: 0,
	chatMessages: 0,
	forwardedEvents: 0,
	domRowsAdded: 0,
	eventMessages: 0,
	eventSocketsSeen: 0,
	eventSocketChanges: 0,
	eventSocketOpens: 0,
	eventSocketCloses: 0,
	eventSocketErrors: 0,
	refreshRequests: 0,
	refreshSuccesses: 0,
	refreshFailures: 0,
	validateRequests: 0,
	validateFailures: 0,
	eventTypes: {}
};
let previousTracker = null;

function ingestTracker(tracker) {
	if (!tracker || !tracker.id) return;
	const fields = [
		'forwardedMessages',
		'chatMessages',
		'forwardedEvents',
		'domRowsAdded',
		'eventMessages',
		'eventSocketsSeen',
		'eventSocketChanges',
		'eventSocketOpens',
		'eventSocketCloses',
		'eventSocketErrors',
		'refreshRequests',
		'refreshSuccesses',
		'refreshFailures',
		'validateRequests',
		'validateFailures'
	];
	const sameGeneration = previousTracker && previousTracker.id === tracker.id;
	for (const field of fields) {
		const current = Number(tracker[field]) || 0;
		const previous = sameGeneration ? Number(previousTracker[field]) || 0 : 0;
		trackerTotals[field] += Math.max(0, current - previous);
	}
	const eventTypes = tracker.eventTypes || {};
	const previousEventTypes = sameGeneration ? previousTracker.eventTypes || {} : {};
	for (const [type, count] of Object.entries(eventTypes)) {
		const delta = Math.max(0, (Number(count) || 0) - (Number(previousEventTypes[type]) || 0));
		trackerTotals.eventTypes[type] = (trackerTotals.eventTypes[type] || 0) + delta;
	}
	previousTracker = JSON.parse(JSON.stringify(tracker));
}

function updateOutage(health, name, open, now) {
	const field = name === 'chat' ? 'chatOutageStartedAt' : 'eventOutageStartedAt';
	const longestField = name === 'chat' ? 'longestChatOutageMs' : 'longestEventOutageMs';
	const countField = name === 'chat' ? 'chatOutages' : 'eventOutages';
	if (open) {
		if (health[field]) {
			health[longestField] = Math.max(health[longestField], now - health[field]);
			health[field] = 0;
		}
		return;
	}
	if (!health[field]) {
		health[field] = now;
		health[countField] += 1;
	}
	health[longestField] = Math.max(health[longestField], now - health[field]);
}

async function runSoak(eventSubResult) {
	const startedAt = Date.now();
	const endsAt = startedAt + minutes * 60000;
	const eventSubRequired = eventSubResult === 'passed';
	const health = {
		samples: 0,
		chatOutages: 0,
		eventOutages: 0,
		chatOutageStartedAt: 0,
		eventOutageStartedAt: 0,
		longestChatOutageMs: 0,
		longestEventOutageMs: 0,
		authLossStartedAt: 0
	};
	let nextConsoleAt = 0;
	let failure = null;

	console.log(`[twitch-soak] Starting ${minutes}-minute endurance sample. Keep the channel active and send at least one real chat message.`);
	writeReport('soak_started', {
		minutes,
		sampleSeconds,
		maxOutageSeconds,
		eventSubRequired
	});

	while (Date.now() < endsAt) {
		if (interrupted) throw createRunError('Soak interrupted', 'INTERRUPTED');
		const now = Date.now();
		const views = await listViews();
		if (!views.some(view => String(view.key) === sourceViewKey)) {
			failure = 'Twitch source window closed during the soak';
			break;
		}

		await installTracker();
		const [viewState, sourceState] = await Promise.all([readViewState(), readSourceState()]);
		ingestTracker(viewState.tracker);
		health.samples += 1;
		updateOutage(health, 'chat', viewState.chatReadyState === 1, now);
		if (eventSubRequired) updateOutage(health, 'event', viewState.eventReadyState === 1, now);

		if (!viewState.tokenPresent || !viewState.refreshTokenPresent || viewState.authVisible) {
			if (!health.authLossStartedAt) health.authLossStartedAt = now;
		} else {
			health.authLossStartedAt = 0;
		}

		const maxOutageMs = maxOutageSeconds * 1000;
		if (health.longestChatOutageMs > maxOutageMs) {
			failure = `Twitch chat stayed disconnected for more than ${maxOutageSeconds} seconds`;
		}
		if (!failure && eventSubRequired && health.longestEventOutageMs > maxOutageMs) {
			failure = `Twitch EventSub stayed disconnected for more than ${maxOutageSeconds} seconds`;
		}
		if (!failure && health.authLossStartedAt && now - health.authLossStartedAt > 30000) {
			failure = 'Twitch credentials disappeared or the source returned to the sign-in screen';
		}
		if (!failure && !sourceState.present) {
			failure = 'Twitch source state disappeared during the soak';
		}

		writeReport('sample', {
			elapsedMs: now - startedAt,
			chatReadyState: viewState.chatReadyState,
			eventReadyState: viewState.eventReadyState,
			tokenPresent: viewState.tokenPresent,
			refreshTokenPresent: viewState.refreshTokenPresent,
			expiresInMs: viewState.expiresInMs,
			authVisible: viewState.authVisible,
			sourceStatus: sourceState.status || null,
			sourceError: sourceState.error || null,
			longestChatOutageMs: health.longestChatOutageMs,
			longestEventOutageMs: health.longestEventOutageMs,
			trackerTotals: { ...trackerTotals, eventTypes: { ...trackerTotals.eventTypes } }
		});

		if (now >= nextConsoleAt) {
			console.log(
				`[twitch-soak] ${formatDuration(now - startedAt)} ` +
				`chat=${viewState.chatReadyState === 1 ? 'open' : 'down'} ` +
				`eventsub=${viewState.eventReadyState === 1 ? 'open' : (eventSubRequired ? 'down' : 'n/a')} ` +
				`messages=${trackerTotals.chatMessages} refreshes=${trackerTotals.refreshSuccesses}`
			);
			nextConsoleAt = now + 60000;
		}

		if (failure) break;
		await sleep(Math.min(sampleSeconds * 1000, Math.max(0, endsAt - Date.now())));
	}

	const finishedAt = Date.now();
	updateOutage(health, 'chat', true, finishedAt);
	if (eventSubRequired) updateOutage(health, 'event', true, finishedAt);

	let result = failure ? 'failed' : 'passed';
	const inconclusiveReasons = [];
	if (!failure && trackerTotals.chatMessages === 0) {
		result = 'inconclusive';
		inconclusiveReasons.push('No real Twitch chat message was observed; message delivery cannot be proven.');
	}
	if (!failure && eventSubResult === 'inconclusive') {
		result = 'inconclusive';
		inconclusiveReasons.push('EventSub was unavailable for this account/channel pair.');
	}

	return {
		result,
		failure,
		inconclusiveReasons,
		durationMs: finishedAt - startedAt,
		eventSubRequired,
		health,
		trackerTotals: { ...trackerTotals, eventTypes: { ...trackerTotals.eventTypes } }
	};
}

async function shutdownApp() {
	if (!child) return;
	if (remotePort) {
		try {
			await requestJson('/api/v1/command', {
				action: 'shutdownApp',
				value: { confirm: true }
			});
		} catch (_) { }
	}
	await Promise.race([
		new Promise(resolve => child.once('exit', resolve)),
		sleep(5000)
	]);
	if (child.exitCode === null) {
		try { child.kill(); } catch (_) { }
	}
}

async function run() {
	if (hasArg('help') || hasArg('h')) {
		printUsage();
		return 0;
	}
	if (channel && !/^[a-z0-9_]{1,25}$/i.test(channel)) {
		printUsage();
		throw createRunError('--channel must be a valid Twitch login.', 'USAGE');
	}
	if (!fs.existsSync(path.join(socialStreamFsRoot, 'sources', 'websocket', 'twitch.js'))) {
		throw new Error(`Social Stream source repo was not found at ${socialStreamFsRoot}`);
	}

	remotePort = await getFreePort();
	remoteToken = `twitch-soak-${stamp}-${Math.random().toString(36).slice(2)}`;
	console.log(`[twitch-soak] Source: ${path.join(socialStreamFsRoot, 'sources', 'websocket', 'twitch.js')}`);
	console.log(`[twitch-soak] Isolated reusable profile: ${profilePath}`);
	console.log(`[twitch-soak] JSONL report: ${reportPath}`);
	console.log('[twitch-soak] OAuth tokens remain inside the Electron profile and are never included in the report.');
	launchApp();
	writeReport('run_started', {
		requestedChannel: channel || null,
		minutes,
		profilePath,
		forceRefresh,
		exerciseEventSubReconnect
	});

	let finalSummary = null;
	try {
		await waitForApp();
		await launchTwitchSource();
		await installTracker();
		await ensureAuthenticated();
		const refreshResult = await exerciseTokenRefresh();
		const eventSubResult = await exerciseEventSub();
		const soak = await runSoak(eventSubResult);
		finalSummary = {
			result: soak.result,
			channel: activeChannel || null,
			requestedChannel: channel || null,
			minutesRequested: minutes,
			durationMs: soak.durationMs,
			refreshExercise: refreshResult,
			eventSubReconnectExercise: eventSubResult,
			failure: soak.failure,
			inconclusiveReasons: soak.inconclusiveReasons,
			health: soak.health,
			trackerTotals: soak.trackerTotals,
			reportPath,
			profilePath
		};
		writeReport('summary', finalSummary);
		console.log(`[twitch-soak] ${soak.result.toUpperCase()} after ${formatDuration(soak.durationMs)}.`);
		if (soak.failure) console.error(`[twitch-soak] ${soak.failure}`);
		for (const reason of soak.inconclusiveReasons) console.warn(`[twitch-soak] ${reason}`);
		console.log(`[twitch-soak] Longest outages: chat=${formatDuration(soak.health.longestChatOutageMs)}, EventSub=${formatDuration(soak.health.longestEventOutageMs)}.`);
		console.log(`[twitch-soak] Chat messages observed: ${soak.trackerTotals.chatMessages}. Report: ${reportPath}`);
		return soak.result === 'passed' ? 0 : (soak.result === 'inconclusive' ? 2 : 1);
	} catch (error) {
		const result = error.code === 'INCONCLUSIVE' ? 'inconclusive' : (error.code === 'INTERRUPTED' ? 'interrupted' : 'failed');
		const restored = await restoreForcedRefreshIfNeeded();
		finalSummary = {
			result,
			channel: activeChannel || null,
			requestedChannel: channel || null,
			minutesRequested: minutes,
			error: error.message,
			restoredTestCredentials: restored,
			reportPath,
			profilePath
		};
		writeReport('summary', finalSummary);
		console.error(`[twitch-soak] ${result.toUpperCase()}: ${error.message}`);
		if (stdoutTail) console.error(`\n[twitch-soak] SSApp stdout tail:\n${safeTail(stdoutTail)}`);
		if (stderrTail) console.error(`\n[twitch-soak] SSApp stderr tail:\n${safeTail(stderrTail)}`);
		return result === 'inconclusive' ? 2 : (result === 'interrupted' ? 130 : 1);
	} finally {
		await restoreForcedRefreshIfNeeded();
		await shutdownApp();
	}
}

process.on('SIGINT', () => {
	interrupted = true;
});
process.on('SIGTERM', () => {
	interrupted = true;
});

run().then(code => {
	process.exitCode = code;
}).catch(error => {
	console.error(error && error.stack ? error.stack : error);
	process.exitCode = 1;
});
