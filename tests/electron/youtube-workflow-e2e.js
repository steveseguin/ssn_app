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
		&& typeof parseYoutubeUrl === 'function'
		&& typeof extractYoutubeID === 'function'
		&& typeof buildYouTubeWebSocketQueryParams === 'function'
		&& typeof createYoutubeWebSocketWindowFromSource === 'function', 'YouTube workflow functions were not available');

	stateManager.clearAllSourcesAndGroups();
	await Promise.resolve();

	const originalConfirm = window.confirm;
	const confirmMessages = [];
	window.confirm = (message) => {
		confirmMessages.push(String(message || ''));
		return false;
	};

	try {
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
			launchUrls: createWindowCalls.map(call => call.url)
		};
	} finally {
		window.confirm = originalConfirm;
	}
})()
`;

async function run() {
	const port = await getFreePort();
	const child = spawn(
		electronPath,
		[
			'.',
			'--running-from-source',
			'--filesource',
			socialStreamRoot,
			'--remote-control'
		],
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
