'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const electronPath = require('electron');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamFsRoot = path.resolve(repoRoot, '..', 'social_stream');
const socialStreamRoot = pathToFileURL(socialStreamFsRoot + path.sep).href;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-source-navigation-profile-'));
const token = `source-navigation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let mainWindowId = null;

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

function requestJson(port, pathname, body, timeoutMs = 10000) {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : null;
		const requestPath = `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
		const req = http.request({
			host: '127.0.0.1',
			port,
			path: requestPath,
			method: payload ? 'POST' : 'GET',
			headers: payload ? {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload)
			} : {}
		}, res => {
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
		req.setTimeout(timeoutMs, () => {
			req.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms`));
		});
		if (payload) req.write(payload);
		req.end();
	});
}

async function waitFor(check, label, timeoutMs = 30000) {
	const started = Date.now();
	let lastError = null;
	while (Date.now() - started < timeoutMs) {
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await sleep(100);
	}
	throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function execInWindow(port, windowId, code, label = 'window execution') {
	let response;
	try {
		response = await requestJson(port, '/exec', { windowId, code });
	} catch (error) {
		throw new Error(`${label}: ${error.message}`);
	}
	if (!response || response.ok !== true) {
		throw new Error(`${label}: ${response && response.error ? response.error : 'execution failed'}`);
	}
	return response.result;
}

async function execInMain(port, code, label) {
	return execInWindow(port, mainWindowId, code, label);
}

async function listWindows(port) {
	const response = await requestJson(port, '/windows');
	return response.windows || [];
}

async function getSourceState(port, sourceId) {
	return await execInMain(port, `
		(() => {
			const source = stateManager.getSource(${JSON.stringify(sourceId)});
			return source ? {
				id: source.id,
				status: source.status,
				vid: source.vid || null,
				activeConnectionMode: source.activeConnectionMode || null
			} : null;
		})()
	`, 'read source state');
}

async function assertSourceActive(port, sourceId, windowId, label) {
	const windows = await listWindows(port);
	const source = await getSourceState(port, sourceId);
	assert(windows.some(windowInfo => windowInfo.id === windowId), `${label}: source window closed unexpectedly`);
	assert(source, `${label}: source state disappeared`);
	assert.strictEqual(source.status, 'active', `${label}: source status should remain active`);
	assert(source.vid, `${label}: source tab ID should remain assigned`);
	assert.strictEqual(source.activeConnectionMode, 'classic', `${label}: source should remain in Standard mode`);
}

async function waitForSourceStopped(port, sourceId, windowId, label) {
	await waitFor(async () => {
		const windows = await listWindows(port);
		const source = await getSourceState(port, sourceId);
		return !windows.some(windowInfo => windowInfo.id === windowId)
			&& source
			&& source.status === 'inactive'
			&& !source.vid
			&& !source.activeConnectionMode;
	}, label);
}

async function startFixtureServer() {
	const port = await getFreePort();
	const server = http.createServer((req, res) => {
		if (req.url === '/redirect-frame') {
			res.writeHead(302, { Location: `http://127.0.0.1:${port}/redirect-target` });
			res.end();
			return;
		}
		res.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store'
		});
		res.end(`<!doctype html>
			<html>
				<head><meta charset="utf-8"><title>SSApp navigation fixture</title></head>
				<body>
					<div id="app">initial render</div>
					<script>
						window.__fixtureLoads = Number(sessionStorage.getItem('fixtureLoads') || '0') + 1;
						sessionStorage.setItem('fixtureLoads', String(window.__fixtureLoads));
					</script>
				</body>
			</html>`);
	});
	await new Promise((resolve, reject) => {
		server.listen(port, '127.0.0.1', resolve);
		server.on('error', reject);
	});
	return {
		server,
		origin: `http://127.0.0.1:${port}`
	};
}

async function launchClassicSource(port, platform, channel, url) {
	const sourceId = await execInMain(port, `
		(async () => {
			const existingIds = new Set(stateManager.getSources().map(source => source.id));
			await newOtherSource(
				${JSON.stringify(platform)},
				${JSON.stringify(url)},
				false,
				{
					username: ${JSON.stringify(channel)},
					connectionMode: 'classic',
					isVisible: false,
					isMuted: true,
					autoActivate: false,
					sourceFile: ${JSON.stringify(`sources/${platform}.js`)}
				}
			);
			const source = stateManager.getSources().find(candidate => !existingIds.has(candidate.id));
			if (!source) throw new Error('New source was not created');
			const entry = document.querySelector('[data-source-id="' + source.id + '"]');
			const activate = entry && entry.querySelector('[data-activatehtml]');
			if (!activate) throw new Error('Source activation control was not found');
			await createWindow(activate);
			return source.id;
		})()
	`, `launch ${platform} source`);

	const windowInfo = await waitFor(async () => {
		const windows = await listWindows(port);
		return windows.find(candidate => candidate.url === url);
	}, `wait for ${platform} source window`);
	await waitFor(async () => {
		const source = await getSourceState(port, sourceId);
		return source && source.status === 'active' && source.vid && source.activeConnectionMode === 'classic';
	}, `wait for ${platform} source activation`);
	return { sourceId, windowId: windowInfo.id };
}

async function removeSource(port, sourceId) {
	await execInMain(port, `
		stateManager.removeSource(${JSON.stringify(sourceId)});
		true;
	`, 'remove test source').catch(() => null);
}

async function runSoftNavigationCase(port, fixtureOrigin, platform) {
	const channel = `${platform}-soft-alpha`;
	const initialPath = platform === 'twitch'
		? `/popout/${channel}/chat?popout=`
		: `/watch/${channel}`;
	const aliasPath = platform === 'twitch'
		? `/${channel}?react=2&popout=#soft`
		: `/stream/${channel}?react=2#soft`;
	const changedPath = platform === 'twitch'
		? `/popout/${platform}-soft-beta/chat?popout=`
		: `/watch/${platform}-soft-beta`;
	const initialUrl = fixtureOrigin + initialPath;
	const source = await launchClassicSource(port, platform, channel, initialUrl);

	await execInWindow(port, source.windowId, `
		document.getElementById('app').textContent = 'react render without navigation';
		true;
	`, `${platform} DOM rerender`);
	await sleep(250);
	await assertSourceActive(port, source.sourceId, source.windowId, `${platform} DOM rerender`);

	await execInWindow(port, source.windowId, `
		(() => {
			const frame = document.createElement('iframe');
			frame.src = ${JSON.stringify(fixtureOrigin + '/redirect-frame')};
			document.body.appendChild(frame);
			return true;
		})()
	`, `${platform} subframe redirect`);
	await sleep(500);
	await assertSourceActive(port, source.sourceId, source.windowId, `${platform} subframe redirect`);

	const queryRewrite = platform === 'twitch'
		? `/popout/${channel}/chat?react=1&popout=#state`
		: `/watch/${channel}?react=1#state`;
	await execInWindow(port, source.windowId, `
		history.replaceState({ render: 1 }, '', ${JSON.stringify(queryRewrite)});
		true;
	`, `${platform} React query rewrite`);
	await sleep(250);
	await assertSourceActive(port, source.sourceId, source.windowId, `${platform} React query rewrite`);

	await execInWindow(port, source.windowId, `
		history.pushState({ render: 2 }, '', ${JSON.stringify(aliasPath)});
		true;
	`, `${platform} same-channel route rewrite`);
	await sleep(250);
	await assertSourceActive(port, source.sourceId, source.windowId, `${platform} same-channel route rewrite`);

	await execInWindow(port, source.windowId, 'location.reload(); true;', `${platform} same-channel reload`).catch(() => null);
	await waitFor(async () => {
		const windows = await listWindows(port);
		return windows.some(windowInfo => windowInfo.id === source.windowId && windowInfo.url === fixtureOrigin + aliasPath);
	}, `${platform} same-channel reload`);
	await sleep(500);
	await assertSourceActive(port, source.sourceId, source.windowId, `${platform} same-channel reload`);

	await execInWindow(port, source.windowId, `
		history.pushState({ raid: true }, '', ${JSON.stringify(changedPath)});
		true;
	`, `${platform} SPA channel change`).catch(() => null);
	await waitForSourceStopped(port, source.sourceId, source.windowId, `${platform} SPA channel change`);
	await removeSource(port, source.sourceId);

	return {
		platform,
		domRerender: 'active',
		subframeRedirect: 'active',
		queryRewrite: 'active',
		sameChannelRouteRewrite: 'active',
		sameChannelReload: 'active',
		spaChannelChange: 'stopped'
	};
}

async function runFullNavigationCase(port, fixtureOrigin, platform) {
	const channel = `${platform}-full-alpha`;
	const nextChannel = `${platform}-full-beta`;
	const initialPath = platform === 'twitch'
		? `/popout/${channel}/chat?popout=`
		: `/watch/${channel}`;
	const nextPath = platform === 'twitch'
		? `/popout/${nextChannel}/chat?popout=`
		: `/watch/${nextChannel}`;
	const source = await launchClassicSource(port, platform, channel, fixtureOrigin + initialPath);

	await execInWindow(port, source.windowId, `
		location.assign(${JSON.stringify(fixtureOrigin + nextPath)});
		true;
	`, `${platform} full channel navigation`).catch(() => null);
	await waitForSourceStopped(port, source.sourceId, source.windowId, `${platform} full channel navigation`);
	await removeSource(port, source.sourceId);
	return { platform, fullChannelNavigation: 'stopped' };
}

async function runInvalidRouteCase(port, fixtureOrigin, platform) {
	const channel = `${platform}-invalid-alpha`;
	const initialPath = platform === 'twitch'
		? `/popout/${channel}/chat?popout=`
		: `/watch/${channel}`;
	const invalidPath = platform === 'twitch' ? '/directory' : '/';
	const source = await launchClassicSource(port, platform, channel, fixtureOrigin + initialPath);

	await execInWindow(port, source.windowId, `
		history.pushState({ invalid: true }, '', ${JSON.stringify(invalidPath)});
		true;
	`, `${platform} invalid capture route`).catch(() => null);
	await waitForSourceStopped(port, source.sourceId, source.windowId, `${platform} invalid capture route`);
	await removeSource(port, source.sourceId);
	return { platform, invalidCaptureRoute: 'stopped' };
}

function assertPlatformConfigs() {
	for (const fileName of ['config_0.json', 'config_linux_0.json', 'config_mac_0.json']) {
		const filePath = path.join(socialStreamFsRoot, 'settings', fileName);
		const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		for (const platform of ['twitch', 'vpzone']) {
			assert.strictEqual(config[platform]?.closeOnNavigate, true, `${fileName}: ${platform} closeOnNavigate should be enabled`);
			assert.strictEqual(config[platform]?.closeOnNavigateMode, 'channel', `${fileName}: ${platform} should use channel navigation mode`);
		}
	}
}

async function run() {
	assertPlatformConfigs();
	const remotePort = await getFreePort();
	const fixture = await startFixtureServer();
	const electronArgs = [
		'.',
		'--running-from-source',
		'--multiinstance',
		'--filesource',
		socialStreamRoot,
		'--remote-control',
		...linuxLaunchArgs(),
	];
	const child = spawn(
		electronPath,
		electronArgs,
		{
			cwd: repoRoot,
			env: {
				...process.env,
				SSAPP_USER_DATA_DIR: userDataDir,
				SSAPP_REMOTE_CONTROL: '1',
				SSAPP_REMOTE_CONTROL_PORT: String(remotePort),
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
	child.stdout.on('data', chunk => {
		stdout = (stdout + chunk.toString()).slice(-20000);
	});
	child.stderr.on('data', chunk => {
		stderr = (stderr + chunk.toString()).slice(-20000);
	});

	try {
		await waitFor(async () => {
			try {
				const response = await requestJson(remotePort, '/ping');
				return response && response.ok;
			} catch (_) {
				return false;
			}
		}, 'SSApp startup', 60000);

		const mainWindow = await waitFor(async () => {
			const windows = await listWindows(remotePort);
			return windows.find(windowInfo => String(windowInfo.url || '').includes('index.html'));
		}, 'SSApp main window');
		mainWindowId = mainWindow.id;

		await waitFor(async () => {
			return await execInMain(remotePort, `
				Boolean(
					window.stateManager
					&& stateManager.initialized
					&& typeof newOtherSource === 'function'
					&& typeof createWindow === 'function'
					&& typeof configReady !== 'undefined'
					&& configReady
					&& config.twitch?.closeOnNavigateMode === 'channel'
					&& config.vpzone?.closeOnNavigateMode === 'channel'
				)
			`, 'wait for renderer initialization');
		}, 'SSApp renderer initialization', 60000);

		await execInMain(remotePort, 'stateManager.clearAllSourcesAndGroups(); true;', 'clear source state');

		const results = [];
		for (const platform of ['twitch', 'vpzone']) {
			results.push(await runSoftNavigationCase(remotePort, fixture.origin, platform));
			results.push(await runFullNavigationCase(remotePort, fixture.origin, platform));
			results.push(await runInvalidRouteCase(remotePort, fixture.origin, platform));
		}

		console.log('Source navigation safety E2E passed.');
		console.log(JSON.stringify(results, null, 2));
	} catch (error) {
		console.error(error && error.stack ? error.stack : error);
		if (stdout) console.error(`\nSSApp stdout:\n${stdout}`);
		if (stderr) console.error(`\nSSApp stderr:\n${stderr}`);
		throw error;
	} finally {
		try {
			await requestJson(remotePort, '/api/v1/command', {
				action: 'shutdownApp',
				value: { confirm: true }
			});
		} catch (_) { }
		await Promise.race([
			new Promise(resolve => child.once('exit', resolve)),
			sleep(5000)
		]);
		if (child.exitCode === null) {
			try { child.kill(); } catch (_) { }
		}
		await new Promise(resolve => fixture.server.close(resolve));
		const resolvedProfile = path.resolve(userDataDir);
		const expectedPrefix = path.resolve(path.join(os.tmpdir(), 'ssapp-source-navigation-profile-'));
		if (resolvedProfile.startsWith(expectedPrefix)) {
			fs.rmSync(resolvedProfile, { recursive: true, force: true });
		}
	}
}

run().catch(() => {
	process.exitCode = 1;
});
