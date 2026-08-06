'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const electronPath = require('electron');

const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = pathToFileURL(path.resolve(repoRoot, '..', 'social_stream') + path.sep).href;
const socialStreamYoutubeHtml = pathToFileURL(path.resolve(repoRoot, '..', 'social_stream', 'sources', 'websocket', 'youtube.html')).href;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-youtube-workflow-profile-'));
const token = `youtube-workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let mainExecWindowId = null;

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

function requestJson(port, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : null;
		const req = http.request({
			host: '127.0.0.1',
			port,
			path: `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
			method: payload ? 'POST' : 'GET',
			headers: payload ? {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload)
			} : {}
		}, (res) => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', chunk => {
				text += chunk;
			});
			res.on('end', () => {
				try {
					const json = text ? JSON.parse(text) : {};
					if (res.statusCode >= 200 && res.statusCode < 300) {
						resolve(json);
						return;
					}
					reject(new Error(`HTTP ${res.statusCode}: ${text}`));
				} catch (error) {
					reject(error);
				}
			});
		});
		req.on('error', reject);
		if (payload) {
			req.write(payload);
		}
		req.end();
	});
}

async function waitForRemoteControl(port, timeoutMs = 60000) {
	const started = Date.now();
	let lastError = null;
	while (Date.now() - started < timeoutMs) {
		try {
			const ping = await requestJson(port, '/ping');
			if (ping && ping.ok) {
				return ping;
			}
		} catch (error) {
			lastError = error;
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	throw new Error(`Timed out waiting for remote control server: ${lastError ? lastError.message : 'no response'}`);
}

async function waitForMainWindow(port, timeoutMs = 30000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const windows = await requestJson(port, '/windows');
		const mainWindow = (windows.windows || []).find(win => typeof win.url === 'string' && win.url.includes('index.html'))
			|| (windows.windows || [])[0];
		if (mainWindow && mainWindow.id) {
			mainExecWindowId = mainWindow.id;
			return mainWindow;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('Timed out waiting for main window');
}

async function waitForWindow(port, predicate, timeoutMs = 30000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const windows = await requestJson(port, '/windows');
		const match = (windows.windows || []).find(predicate);
		if (match) {
			return match;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('Timed out waiting for matching window');
}

async function execInWindow(port, windowId, code, label = 'renderer exec') {
	let response;
	try {
		response = await requestJson(port, '/exec', { windowId, code });
	} catch (error) {
		throw new Error(`${label}: ${error && error.message ? error.message : error}`);
	}
	if (!response || response.ok !== true) {
		const message = response && response.error ? response.error : 'renderer exec failed';
		throw new Error(`${label}: ${message}`);
	}
	return response.result;
}

async function execInRenderer(port, code, label = 'renderer exec') {
	return execInWindow(port, mainExecWindowId, code, label);
}

async function waitForExecResult(port, windowId, code, label = 'exec result', timeoutMs = 20000) {
	const started = Date.now();
	let lastError = null;
	while (Date.now() - started < timeoutMs) {
		try {
			const result = await execInWindow(port, windowId, code, label);
			if (result) {
				return result;
			}
		} catch (error) {
			lastError = error;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`${label}: timed out${lastError ? ` (${lastError.message})` : ''}`);
}

async function openAndInspectYouTubeWebSocketPage(port, urlToOpen, expectedShorts) {
	await execInRenderer(port, `window.open(${JSON.stringify(urlToOpen)}, '_blank');`, 'open youtube websocket page');
	const pageWindow = await waitForWindow(port, win => typeof win.url === 'string' && win.url.includes('sources/websocket/youtube.html') && win.url.includes(expectedShorts ? 'shorts=1' : 'standard-e2e'));
	const state = await waitForExecResult(port, pageWindow.id, `
		(() => {
			if (typeof getYouTubeSourceType !== 'function' || typeof youtubeShorts === 'undefined') return null;
			return {
				href: location.href,
				youtubeShorts,
				sourceType: getYouTubeSourceType(),
				controlValue: document.getElementById('youtube-source-type-value')?.textContent || null,
				shortsButtonActive: document.getElementById('youtube-type-shorts')?.classList.contains('active') || false,
				standardButtonActive: document.getElementById('youtube-type-standard')?.classList.contains('active') || false
			};
		})()
	`, 'inspect youtube websocket page');
	assert.strictEqual(state.youtubeShorts, expectedShorts, `youtube.html shorts mode mismatch for ${urlToOpen}`);
	assert.strictEqual(state.sourceType, expectedShorts ? 'youtubeshorts' : 'youtube', `youtube.html source type mismatch for ${urlToOpen}`);
	assert.strictEqual(state.shortsButtonActive, expectedShorts, `youtube.html shorts button state mismatch for ${urlToOpen}`);
	assert.strictEqual(state.standardButtonActive, !expectedShorts, `youtube.html standard button state mismatch for ${urlToOpen}`);
	await execInWindow(port, pageWindow.id, 'window.close(); true;', 'close youtube websocket page').catch(() => null);
	return state;
}

const rendererWorkflow = String.raw`
(async function () {
	function assertRenderer(condition, message) {
		if (!condition) throw new Error(message);
	}
	async function waitFor(predicate, message, timeoutMs = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			try {
				if (predicate()) return;
			} catch (_) { }
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		throw new Error(message);
	}
	function sourceSummary() {
		return stateManager.getSources().map(source => ({
			id: source.id,
			target: source.target,
			username: source.username,
			videoId: source.videoId,
			url: source.url,
			replyOnly: !!source.replyOnly,
			accountRole: source.accountRole || 'normal',
			connectionMode: source.connectionMode || null
		}));
	}
	function parseQueryFromUrl(rawUrl) {
		const parsed = new URL(rawUrl);
		return Object.fromEntries(parsed.searchParams.entries());
	}

	await waitFor(() => window.stateManager && stateManager.initialized, 'stateManager was not initialized');
	await waitFor(() => typeof newSourceVideoID === 'function'
		&& typeof newSource === 'function'
		&& typeof parseYoutubeUrl === 'function'
		&& typeof extractYoutubeID === 'function'
		&& typeof normalizeYouTubePublicSourceInput === 'function'
		&& typeof normalizeTwitchUsernameInput === 'function'
		&& typeof newSourcePrompt === 'function'
		&& typeof showYouTubeAddModeModal === 'function'
		&& typeof showYouTubeOwnerChannelConfirm === 'function'
		&& typeof showYouTubeOwnerManageModal === 'function'
		&& typeof fetchYouTubeOwnerStreamsForGroup === 'function'
		&& typeof buildYouTubeWebSocketQueryParams === 'function'
		&& typeof createYoutubeWebSocketWindowFromSource === 'function', 'YouTube workflow functions were not available');

	stateManager.clearAllSourcesAndGroups();
	await Promise.resolve();

	const originalConfirm = window.confirm;
	const originalPrompt = window.prompt;
	const confirmMessages = [];
	window.confirm = (message) => {
		confirmMessages.push(String(message || ''));
		return false;
	};

	try {
		window.prompt = () => 'https://www.twitch.tv/popout/evarate/chat?popout=';
		await newSourcePrompt('twitch');
		const twitchSource = stateManager.getSources().find(source => source.target === 'twitch');
		assertRenderer(twitchSource?.username === 'evarate', 'Twitch popout URL should be reduced to the channel username');
		assertRenderer(twitchSource?.url === 'https://www.twitch.tv/popout/evarate/chat?popout=',
			'Twitch popout URL should produce the canonical chat URL');
		window.prompt = originalPrompt;

		const normalizedWatchUrl = normalizeYouTubePublicSourceInput('https://www.youtube.com/watch?v=urlroute001');
		const normalizedShortUrl = normalizeYouTubePublicSourceInput('youtu.be/urlroute002');
		assertRenderer(normalizedWatchUrl.value === 'https://www.youtube.com/watch?v=urlroute001' && normalizedWatchUrl.isChannelName === false,
			'watch URL should remain a video URL');
		assertRenderer(normalizedShortUrl.value === 'https://youtu.be/urlroute002' && normalizedShortUrl.isChannelName === false,
			'youtu.be URL should remain a video URL');

		await newSource('youtube', normalizedWatchUrl.value, false, {}, normalizedWatchUrl.isChannelName);
		await newSource('youtube', normalizedShortUrl.value, false, {}, normalizedShortUrl.isChannelName);
		const watchUrlSource = stateManager.getSources().find(source => source.videoId === 'urlroute001');
		const shortUrlSource = stateManager.getSources().find(source => source.videoId === 'urlroute002');
		assertRenderer(watchUrlSource?.target === 'youtube' && /[?&]v=urlroute001(?:&|$)/.test(watchUrlSource.url || ''),
			'watch URL should route through the direct video-source path');
		assertRenderer(shortUrlSource?.target === 'youtube' && /[?&]v=urlroute002(?:&|$)/.test(shortUrlSource.url || ''),
			'youtu.be URL should route through the direct video-source path');

		const firstModePromise = showYouTubeAddModeModal();
		const secondModePromise = showYouTubeAddModeModal();
		document.querySelector('[data-youtube-add-mode="public"]').click();
		const modeResults = await Promise.all([firstModePromise, secondModePromise]);
		assertRenderer(modeResults[0] === null && modeResults[1] === 'public', 'reopened add-mode modal should settle both callers');

		const testChannels = [
			{ channelId: 'UCmodal000000000000000001', channelTitle: 'First Channel', thumbnails: {} },
			{ channelId: 'UCmodal000000000000000002', channelTitle: 'Second Channel', thumbnails: {} }
		];
		const firstConfirmPromise = showYouTubeOwnerChannelConfirm({ channels: testChannels });
		const secondConfirmPromise = showYouTubeOwnerChannelConfirm({ channels: testChannels });
		document.getElementById('youtubeOwnerUseChannelButton').click();
		const confirmResults = await Promise.all([firstConfirmPromise, secondConfirmPromise]);
		assertRenderer(confirmResults[0] === null && confirmResults[1]?.channelId === testChannels[0].channelId,
			'reopened owner-channel modal should cancel the old caller and resolve the new caller');

		const manageGroup = { channelTitle: 'Manage Test', username: 'manage-test', channelId: testChannels[0].channelId };
		const firstManagePromise = showYouTubeOwnerManageModal(manageGroup);
		const secondManagePromise = showYouTubeOwnerManageModal(manageGroup);
		document.getElementById('youtubeOwnerManageCloseButton').click();
		const manageResults = await Promise.all([firstManagePromise, secondManagePromise]);
		assertRenderer(manageResults[0] === 'close' && manageResults[1] === 'close', 'reopened owner-manage modal should settle both callers');

		const ownerGroupId = stateManager.addGroup({
			id: 'youtube-owner-e2e-auth',
			target: 'youtube',
			username: 'Owner E2E',
			channelId: 'UCowner000000000000000001',
			youtubeDiscoveryMode: 'owner',
			youtubeAuthRef: 'youtube-owner:missing-e2e-auth',
			autoActivate: false,
			streams: []
		});
		const ownerGroup = stateManager.getGroup(ownerGroupId);
		let ownerAuthError = null;
		try {
			await fetchYouTubeOwnerStreamsForGroup(ownerGroup);
		} catch (error) {
			ownerAuthError = { code: error.code, message: error.message };
		}
		assertRenderer(ownerAuthError?.code === 'SSAPP_YOUTUBE_OWNER_AUTH_REQUIRED',
			'owner discovery should preserve its re-sign-in error code across Electron IPC');
		const ownerActivationResult = await handleYouTubeActivation(
			ownerGroup.username,
			false,
			false,
			true,
			false,
			{ manualTrigger: true, groupId: ownerGroupId }
		);
		assertRenderer(ownerActivationResult?.type === 'auth_error', 'expired owner auth should return a visible auth error');

		const schedulerGroupId = stateManager.addGroup({
			id: 'youtube-owner-e2e-scheduler',
			target: 'youtube',
			username: 'Scheduler E2E',
			channelId: 'UCowner000000000000000002',
			youtubeDiscoveryMode: 'owner',
			youtubeAuthRef: 'youtube-owner:scheduler-e2e',
			autoActivate: true,
			streams: []
		});
		stateManager.addSource({
			id: 'youtube-owner-e2e-active',
			target: 'youtube',
			username: 'Scheduler E2E',
			groupId: schedulerGroupId,
			videoId: 'activee2e01',
			url: 'https://www.youtube.com/live_chat?is_popout=1&v=activee2e01',
			vid: 7654321,
			status: 'active',
			youtubeChatStatus: 'ready',
			liveChatId: 'active-chat'
		});
		stateManager.addSource({
			id: 'youtube-owner-e2e-waiting',
			target: 'youtube',
			username: 'Scheduler E2E',
			groupId: schedulerGroupId,
			videoId: 'waitinge2e1',
			url: 'https://www.youtube.com/live_chat?is_popout=1&v=waitinge2e1',
			status: 'inactive',
			youtubeChatStatus: 'waiting'
		});
		const schedulerGroup = stateManager.getGroup(schedulerGroupId);
		assertRenderer(groupHasActiveConnection(schedulerGroup), 'scheduler fixture should contain an active source');
		assertRenderer(groupNeedsYouTubeOwnerChatPolling(schedulerGroup), 'waiting owner chat should keep polling beside an active source');

		const originalDiscoveryCheck = checkYouTubeGroupForNewStreams;
		const originalSetTimeout = window.setTimeout;
		const originalClearTimeout = window.clearTimeout;
		const capturedSchedulerTimers = [];
		window.setTimeout = function (callback, delay, ...args) {
			const isYouTubeSchedulerCallback = typeof callback === 'function'
				&& String(callback).includes('checkYouTubeGroupForNewStreamsWithBackoff');
			if (isYouTubeSchedulerCallback && delay >= 30000) {
				const timer = { youtubeSchedulerE2E: true, callback, delay, cleared: false };
				capturedSchedulerTimers.push(timer);
				return timer;
			}
			return originalSetTimeout(callback, delay, ...args);
		};
		window.clearTimeout = function (timer) {
			if (timer?.youtubeSchedulerE2E) {
				timer.cleared = true;
				return;
			}
			return originalClearTimeout(timer);
		};
		checkYouTubeGroupForNewStreams = async function () {
			await new Promise(resolve => originalSetTimeout(resolve, 50));
			return { type: 'no_eligible_streams' };
		};
		try {
			startYouTubeGroupAutoCheck(schedulerGroupId);
			stateManager.updateGroup(schedulerGroupId, { autoActivate: false });
			stopYouTubeGroupAutoCheck(schedulerGroupId);
			await new Promise(resolve => originalSetTimeout(resolve, 100));
			assertRenderer(capturedSchedulerTimers.length === 0, 'stopped in-flight YouTube check must not reschedule itself');
			assertRenderer(!youtubeGroupBackoffState.has(schedulerGroupId), 'stopped in-flight check should clear backoff state');

			stateManager.updateGroup(schedulerGroupId, { autoActivate: true });
			startYouTubeGroupAutoCheck(schedulerGroupId);
			await new Promise(resolve => originalSetTimeout(resolve, 10));
			startYouTubeGroupAutoCheck(schedulerGroupId);
			await new Promise(resolve => originalSetTimeout(resolve, 150));
			const activeTimers = capturedSchedulerTimers.filter(timer => !timer.cleared);
			assertRenderer(activeTimers.length === 1, 'restarted YouTube auto-check should leave exactly one polling chain');
		} finally {
			stopYouTubeGroupAutoCheck(schedulerGroupId);
			checkYouTubeGroupForNewStreams = originalDiscoveryCheck;
			window.setTimeout = originalSetTimeout;
			window.clearTimeout = originalClearTimeout;
		}

		const mixedGroupId = stateManager.addGroup({
			id: 'youtube-owner-e2e-mixed',
			target: 'youtube',
			username: 'Mixed E2E',
			channelId: 'UCowner000000000000000003',
			youtubeDiscoveryMode: 'owner',
			youtubeAuthRef: 'youtube-owner:mixed-e2e',
			autoActivate: true,
			streams: []
		});
		const originalOwnerFetch = fetchYouTubeOwnerStreamsForGroup;
		const originalMixedSetTimeout = window.setTimeout;
		fetchYouTubeOwnerStreamsForGroup = async function () {
			return [
				{
					videoId: 'mixlivee2e1',
					isShort: false,
					status: 'live',
					liveChatId: 'mixed-live-chat',
					youtubeChatStatus: 'ready',
					channelId: 'UCowner000000000000000003',
					channelTitle: 'Mixed E2E'
				},
				{
					videoId: 'mixwaite2e1',
					isShort: false,
					status: 'upcoming',
					scheduledStartTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
					liveChatId: '',
					youtubeChatStatus: 'waiting',
					channelId: 'UCowner000000000000000003',
					channelTitle: 'Mixed E2E'
				}
			];
		};
		window.setTimeout = function (callback, delay, ...args) {
			if (delay === 500) return { mixedYouTubeE2E: true };
			return originalMixedSetTimeout(callback, delay, ...args);
		};
		try {
			const mixedResult = await checkYouTubeGroupForNewStreams(mixedGroupId);
			assertRenderer(mixedResult?.type === 'waiting_for_chat' && mixedResult.waitingCount === 1,
				'mixed live/waiting owner result should keep polling for the waiting chat');
		} finally {
			fetchYouTubeOwnerStreamsForGroup = originalOwnerFetch;
			window.setTimeout = originalMixedSetTimeout;
		}

		await newSourceVideoID('youtube', 'IaZtam78ec0', false, { isAutoDiscovered: false, connectionMode: 'websocket' });
		await Promise.resolve();
		assertRenderer(confirmMessages.length === 0, 'first YouTube source should not prompt as duplicate');

		await newSourceVideoID('youtube', 'ddddddddddd', false, { isAutoDiscovered: false, connectionMode: 'websocket' });
		await Promise.resolve();
		assertRenderer(confirmMessages.length === 0, 'different YouTube video ID should not prompt as duplicate');

		await newSourceVideoID('youtube', 'ddddddddddd', false, { isAutoDiscovered: false, connectionMode: 'websocket' });
		await Promise.resolve();
		assertRenderer(confirmMessages.length === 1, 'same YouTube video ID should still prompt as duplicate');
		assertRenderer(/already exists/i.test(confirmMessages[0]), 'duplicate prompt should explain the source already exists');

		await newSourceVideoID('youtubeshorts', 'fffffffffff', false, { isAutoDiscovered: false, connectionMode: 'websocket' });
		await Promise.resolve();
		assertRenderer(confirmMessages.length === 1, 'YouTube Shorts source should not collide with standard YouTube source');

		const parsedShortsUrl = parseYoutubeUrl('https://www.youtube.com/shorts/abcdefghijk?feature=share');
		const parsedWatchUrl = parseYoutubeUrl('https://www.youtube.com/watch?v=abcdefghijk');
		const parsedLiveChatShortsUrl = parseYoutubeUrl('https://www.youtube.com/live_chat?is_popout=1&v=abcdefghijk&shorts');
		const extractedShorts = extractYoutubeID('https://www.youtube.com/shorts/abcdefghijk?feature=share');
		const extractedLiveChatShorts = extractYoutubeID('https://www.youtube.com/live_chat?is_popout=1&v=abcdefghijk&shorts');
		const extractedRawId = extractYoutubeID('abcdefghijk');
		assertRenderer(parsedShortsUrl && parsedShortsUrl.type === 'video' && parsedShortsUrl.isShort === true, 'Shorts URL should parse as a Shorts video');
		assertRenderer(parsedWatchUrl && parsedWatchUrl.type === 'video' && parsedWatchUrl.isShort === false, 'Watch URL should parse as a standard video');
		assertRenderer(parsedLiveChatShortsUrl && parsedLiveChatShortsUrl.type === 'video' && parsedLiveChatShortsUrl.isShort === true, 'live_chat URL with shorts marker should parse as a Shorts video');
		assertRenderer(extractedShorts && extractedShorts.id === 'abcdefghijk' && extractedShorts.isShorts === true, 'extractYoutubeID should preserve Shorts URL signal');
		assertRenderer(extractedLiveChatShorts && extractedLiveChatShorts.id === 'abcdefghijk' && extractedLiveChatShorts.isShorts === true, 'extractYoutubeID should preserve live_chat shorts marker');
		assertRenderer(extractedRawId && extractedRawId.id === 'abcdefghijk' && extractedRawId.isShorts === false, 'raw video ID should remain standard unless user marks Shorts');

		const sources = sourceSummary();
		const standardSource = stateManager.getSource('youtube-vid-ddddddddddd');
		const shortsSource = stateManager.getSource('youtubeshorts-vid-fffffffffff');
		assertRenderer(standardSource && standardSource.url === 'https://www.youtube.com/live_chat?is_popout=1&v=ddddddddddd', 'standard YouTube source URL should not contain shorts marker');
		assertRenderer(shortsSource && shortsSource.url === 'https://www.youtube.com/live_chat?is_popout=1&v=fffffffffff&shorts', 'Shorts source URL should contain shorts marker');

		const standardQuery = buildYouTubeWebSocketQueryParams(standardSource, {});
		const shortsQuery = buildYouTubeWebSocketQueryParams(shortsSource, {});
		const markerQuery = buildYouTubeWebSocketQueryParams({
			target: 'youtube',
			videoId: 'hhhhhhhhhhh',
			url: 'https://www.youtube.com/live_chat?is_popout=1&v=hhhhhhhhhhh&shorts'
		}, { devmode: true });
		assertRenderer(standardQuery.videoId === 'ddddddddddd' && !('shorts' in standardQuery) && standardQuery.ssapp === '1', 'standard WebSocket query should not include shorts');
		assertRenderer(shortsQuery.videoId === 'fffffffffff' && shortsQuery.shorts === '1' && shortsQuery.ssapp === '1', 'Shorts WebSocket query should include shorts=1');
		assertRenderer(markerQuery.videoId === 'hhhhhhhhhhh' && markerQuery.shorts === '1' && markerQuery.devmode === '' && markerQuery.ssapp === '1', 'URL shorts marker should carry into WebSocket query');

		const launchPlan = buildWebSocketLaunchPlan({ target: 'youtubeshorts', username: 'SomeChannel', url: '' }, {});
		assertRenderer(launchPlan.websocketTarget === 'youtube', 'Shorts launch plan should use shared YouTube websocket target');
		assertRenderer(launchPlan.queryParams.channel === 'SomeChannel' && launchPlan.queryParams.shorts === '1' && launchPlan.queryParams.ssapp === '1', 'Shorts launch plan should carry shorts=1');

		const originalSendSync = ipcRenderer.sendSync.bind(ipcRenderer);
		const createWindowCalls = [];
		ipcRenderer.sendSync = function (channel, args) {
			if (channel === 'createWindow') {
				createWindowCalls.push(args);
				return 424242 + createWindowCalls.length;
			}
			return originalSendSync(channel, args);
		};
		try {
			await createYoutubeWebSocketWindowFromSource(standardSource, false);
			await createYoutubeWebSocketWindowFromSource(shortsSource, false);
		} finally {
			ipcRenderer.sendSync = originalSendSync;
		}
		assertRenderer(createWindowCalls.length === 2, 'expected two intercepted YouTube WebSocket createWindow calls');

		const standardLaunchQuery = parseQueryFromUrl(createWindowCalls[0].url);
		const shortsLaunchQuery = parseQueryFromUrl(createWindowCalls[1].url);
		assertRenderer(standardLaunchQuery.videoId === 'ddddddddddd' && !('shorts' in standardLaunchQuery) && standardLaunchQuery.ssapp === '1', 'standard WebSocket launch URL should not include shorts');
		assertRenderer(shortsLaunchQuery.videoId === 'fffffffffff' && shortsLaunchQuery.shorts === '1' && shortsLaunchQuery.ssapp === '1', 'Shorts WebSocket launch URL should include shorts=1');
		assertRenderer(createWindowCalls[0].source && createWindowCalls[0].source.endsWith('sources/websocket/youtube.js'), 'standard launch should inject youtube websocket script');
		assertRenderer(createWindowCalls[1].source && createWindowCalls[1].source.endsWith('sources/websocket/youtube.js'), 'Shorts launch should inject youtube websocket script');

		return {
			ok: true,
			confirmMessages,
			sources,
			standardQuery,
			shortsQuery,
			markerQuery,
			launchPlan,
			ownerAuthError,
			launchUrls: createWindowCalls.map(call => call.url)
		};
	} finally {
		window.confirm = originalConfirm;
		window.prompt = originalPrompt;
	}
})()
`;

async function run() {
	const port = await getFreePort();
	const electronArgs = [
		'.',
		'--running-from-source',
		'--filesource',
		socialStreamRoot,
		'--remote-control'
	];
	if (process.platform === 'linux') {
		// The npm Electron binary is not installed with a root-owned setuid
		// sandbox helper. These flags apply only to this isolated E2E process.
		electronArgs.push('--no-sandbox', '--ozone-platform=x11');
	}
	const child = spawn(
		electronPath,
		electronArgs,
		{
			cwd: repoRoot,
			env: {
				...process.env,
				SSAPP_USER_DATA_DIR: userDataDir,
				SSAPP_REMOTE_CONTROL: '1',
				SSAPP_REMOTE_CONTROL_PORT: String(port),
				SSAPP_REMOTE_CONTROL_TOKEN: token,
				SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
				SSAPP_DEBUG_LOGS: '0'
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		}
	);

	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', chunk => {
		stdout += chunk;
	});
	child.stderr.on('data', chunk => {
		stderr += chunk;
	});

	const timer = setTimeout(() => {
		try {
			child.kill();
		} catch (_) { }
	}, 120000);

	try {
		await waitForRemoteControl(port);
		await waitForMainWindow(port);
		const result = await execInRenderer(port, rendererWorkflow, 'youtube workflow');
		assert(result && result.ok === true, `workflow failed: ${JSON.stringify(result)}`);
		const standardPageState = await openAndInspectYouTubeWebSocketPage(
			port,
			`${socialStreamYoutubeHtml}?videoId=standard-e2e&ssapp=1&standard-e2e=1`,
			false
		);
		const shortsPageState = await openAndInspectYouTubeWebSocketPage(
			port,
			`${socialStreamYoutubeHtml}?videoId=shorts-e2e&shorts=1&ssapp=1`,
			true
		);
		console.log('[youtube-workflow-e2e] Sources:', JSON.stringify(result.sources, null, 2));
		console.log('[youtube-workflow-e2e] Duplicate prompts:', result.confirmMessages.length);
		console.log('[youtube-workflow-e2e] Launch URLs:', JSON.stringify(result.launchUrls, null, 2));
		console.log('[youtube-workflow-e2e] youtube.html standard state:', JSON.stringify(standardPageState, null, 2));
		console.log('[youtube-workflow-e2e] youtube.html shorts state:', JSON.stringify(shortsPageState, null, 2));
	} catch (error) {
		console.error('[youtube-workflow-e2e] FAILED:', error && error.stack ? error.stack : error);
		if (stdout.trim()) console.error('[youtube-workflow-e2e] Electron stdout:\n' + stdout.trim());
		if (stderr.trim()) console.error('[youtube-workflow-e2e] Electron stderr:\n' + stderr.trim());
		throw error;
	} finally {
		clearTimeout(timer);
		try {
			child.kill();
		} catch (_) { }
	}
}

run().catch(() => {
	process.exitCode = 1;
});
