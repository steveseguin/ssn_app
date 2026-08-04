'use strict';

// Long-running, real-network Twitch Standard-source soak. Unlike hidden-capture-soak,
// this creates each source through the SSApp renderer so closeOnNavigate and the UI's
// bounded reconnect behavior are both active.
//
//   node tests/electron/twitch-navigation-recovery-soak.js --minutes=30 \
//     --channel=monkeygeegee --channel=alfie --channel=faux

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
const socialStreamRoot = pathToFileURL(socialStreamFsRoot + path.sep).href;
const stamp = Date.now();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-twitch-navigation-soak-profile-'));
const reportPath = process.env.SOAK_REPORT || path.join(os.tmpdir(), `ssapp-twitch-navigation-soak-${stamp}.jsonl`);
const token = `twitch-navigation-soak-${stamp}-${Math.random().toString(36).slice(2)}`;

function argValues(name) {
	return process.argv
		.filter(value => value.startsWith(`--${name}=`))
		.map(value => value.slice(name.length + 3).trim())
		.filter(Boolean);
}

const channels = [...new Set(argValues('channel').map(value => value.replace(/^@+/, '').toLowerCase()))];
const minutes = Math.max(1, parseInt(argValues('minutes')[0] || '30', 10) || 30);
const sampleSeconds = Math.max(10, parseInt(argValues('sample-seconds')[0] || '30', 10) || 30);
let mainWindowId = null;

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function appendReport(entry) {
	fs.appendFileSync(reportPath, `${JSON.stringify(entry)}\n`, 'utf8');
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

function requestJson(port, pathname, body) {
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
		if (payload) req.write(payload);
		req.end();
	});
}

async function waitFor(check, label, timeoutMs = 60000) {
	const started = Date.now();
	let lastError = null;
	while (Date.now() - started < timeoutMs) {
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await sleep(250);
	}
	throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function execInWindow(port, windowId, code, label = 'window execution') {
	const response = await requestJson(port, '/exec', { windowId, code });
	if (!response || response.ok !== true) {
		throw new Error(`${label}: ${response?.error || 'execution failed'}`);
	}
	return response.result;
}

async function execInMain(port, code, label) {
	return await execInWindow(port, mainWindowId, code, label);
}

async function listWindows(port) {
	const response = await requestJson(port, '/windows');
	return response.windows || [];
}

function twitchChatUrl(channel) {
	return `https://www.twitch.tv/popout/${channel}/chat?popout=`;
}

async function installNavigationProbe(port) {
	await execInMain(port, `
		(() => {
			if (window.__ssappTwitchNavigationSoakListener) return true;
			window.__ssappTwitchNavigationSoakEvents = [];
			const soakIpcRenderer = require('electron').ipcRenderer;
			window.__ssappTwitchNavigationSoakListener = (_event, payload) => {
				window.__ssappTwitchNavigationSoakEvents.push({
					at: new Date().toISOString(),
					payload: payload || {}
				});
			};
			soakIpcRenderer.on('window-auto-closed', window.__ssappTwitchNavigationSoakListener);
			return true;
		})()
	`, 'install Twitch navigation soak probe');
}

async function launchSource(port, channel) {
	const url = twitchChatUrl(channel);
	const sourceId = await execInMain(port, `
		(async () => {
			const existingIds = new Set(stateManager.getSources().map(source => source.id));
			await newOtherSource('twitch', ${JSON.stringify(url)}, false, {
				username: ${JSON.stringify(channel)},
				connectionMode: 'classic',
				isVisible: false,
				isMuted: true,
				autoActivate: false,
				sourceFile: 'sources/twitch.js'
			});
			const source = stateManager.getSources().find(candidate => !existingIds.has(candidate.id));
			if (!source) throw new Error('New Twitch source was not created');
			const entry = document.querySelector('[data-source-id="' + source.id + '"]');
			const activate = entry?.querySelector('[data-activatehtml]');
			if (!activate) throw new Error('Twitch source activation control was not found');
			await createWindow(activate);
			return source.id;
		})()
	`, `launch Twitch source ${channel}`);

	await waitFor(async () => {
		const state = await readSourceState(port, sourceId);
		return state?.status === 'active' && state.vid && state.activeConnectionMode === 'classic';
	}, `Twitch source ${channel} activation`);
	return { channel, sourceId, url };
}

async function readSourceState(port, sourceId) {
	return await execInMain(port, `
		(() => {
			const source = stateManager.getSource(${JSON.stringify(sourceId)});
			const entry = document.querySelector('[data-source-id="' + ${JSON.stringify(sourceId)} + '"]');
			const allEvents = Array.isArray(window.__ssappTwitchNavigationSoakEvents)
				? window.__ssappTwitchNavigationSoakEvents
				: [];
			return source ? {
				status: source.status || null,
				vid: source.vid || null,
				activeConnectionMode: source.activeConnectionMode || null,
				statusText: entry?.querySelector('.ws-status')?.textContent?.trim() || '',
				events: allEvents.filter(event => event.payload?.sourceId === source.id)
			} : null;
		})()
	`, `read Twitch source state ${sourceId}`);
}

async function readChatProbe(port, windowId) {
	return await execInWindow(port, windowId, `
		(() => {
			const selector = '[data-a-target="chat-line-message"], [data-test-selector="chat-line-message"], .chat-line__message, [data-test-selector="user-notice-line"]';
			if (!window.__ssappTwitchDomSoakProbe && document.body) {
				const probe = {
					observedRows: document.querySelectorAll(selector).length,
					mutations: 0,
					startedAt: Date.now()
				};
				probe.observer = new MutationObserver(records => {
					for (const record of records) {
						for (const node of record.addedNodes) {
							if (!node || node.nodeType !== 1) continue;
							if (node.matches?.(selector)) probe.observedRows += 1;
							probe.observedRows += node.querySelectorAll?.(selector)?.length || 0;
						}
						probe.mutations += 1;
					}
				});
				probe.observer.observe(document.body, { childList: true, subtree: true });
				window.__ssappTwitchDomSoakProbe = probe;
			}
			const probe = window.__ssappTwitchDomSoakProbe || {};
			return {
				url: location.href,
				title: document.title,
				readyState: document.readyState,
				visibilityState: document.visibilityState,
				presentRows: document.querySelectorAll(selector).length,
				observedRows: probe.observedRows || 0,
				mutations: probe.mutations || 0,
				bodyText: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 180)
			};
		})()
	`, `read Twitch chat probe from window ${windowId}`);
}

function findChannelWindow(windows, channel) {
	const marker = `/popout/${channel.toLowerCase()}/chat`;
	return windows.find(windowInfo => String(windowInfo.url || '').toLowerCase().includes(marker)) || null;
}

async function run() {
	if (!channels.length) {
		throw new Error('Pass at least one --channel=CHANNEL value.');
	}
	if (!fs.existsSync(path.join(socialStreamFsRoot, 'sources', 'twitch.js'))) {
		throw new Error(`Social Stream source repo was not found at ${socialStreamFsRoot}`);
	}

	const remotePort = await getFreePort();
	const child = spawn(electronPath, [
		'.',
		'--running-from-source',
		'--multiinstance',
		'--filesource',
		socialStreamRoot,
		'--remote-control'
	], {
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
	});
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', chunk => {
		stdout = (stdout + chunk.toString()).slice(-30000);
	});
	child.stderr.on('data', chunk => {
		stderr = (stderr + chunk.toString()).slice(-30000);
	});

	const records = new Map(channels.map(channel => [channel, {
		channel,
		windowIds: new Set(),
		maxObservedRows: 0,
		maxPresentRows: 0,
		activitySamples: 0,
		lastObservedRowsByWindow: new Map(),
		maxSimultaneousWindows: 0,
		errors: [],
		statusTransitions: [],
		lastStatusKey: null,
		finalState: null
	}]));

	try {
		appendReport({ type: 'start', at: new Date().toISOString(), minutes, sampleSeconds, channels, reportPath });
		console.log(`[twitch-soak] ${minutes} minute(s), ${channels.length} Standard source(s)`);
		console.log(`[twitch-soak] report: ${reportPath}`);

		await waitFor(async () => {
			try {
				return (await requestJson(remotePort, '/ping'))?.ok;
			} catch (_) {
				return false;
			}
		}, 'SSApp startup');

		const mainWindow = await waitFor(async () => {
			const windows = await listWindows(remotePort);
			return windows.find(windowInfo => String(windowInfo.url || '').includes('index.html'));
		}, 'SSApp main window');
		mainWindowId = mainWindow.id;

		await waitFor(async () => {
			return await execInMain(remotePort, `Boolean(
				window.stateManager
					&& stateManager.initialized
					&& typeof newOtherSource === 'function'
					&& typeof createWindow === 'function'
					&& typeof configReady !== 'undefined'
					&& configReady
					&& (config.twitch?.closeOnNavigateV2 === true || config.twitch?.closeOnNavigate === true)
					&& config.twitch?.closeOnNavigateMode === 'channel'
			)`, 'wait for renderer initialization');
		}, 'SSApp renderer initialization');

		await execInMain(remotePort, 'stateManager.clearAllSourcesAndGroups(); true;', 'clear source state');
		await installNavigationProbe(remotePort);

		const sources = [];
		for (const channel of channels) {
			const source = await launchSource(remotePort, channel);
			sources.push(source);
			appendReport({ type: 'source-started', at: new Date().toISOString(), ...source });
			console.log(`[twitch-soak] started @${channel}`);
		}

		await sleep(10000);
		const startedAt = Date.now();
		const samples = Math.ceil((minutes * 60) / sampleSeconds);
		for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
			const windows = await listWindows(remotePort);
			const sample = {
				type: 'sample',
				at: new Date().toISOString(),
				sample: sampleIndex,
				elapsedMs: Date.now() - startedAt,
				channels: []
			};

			for (const source of sources) {
				const record = records.get(source.channel);
				let state = null;
				let probe = null;
				try {
					state = await readSourceState(remotePort, source.sourceId);
					const matchingWindows = windows.filter(windowInfo =>
						String(windowInfo.url || '').toLowerCase().includes(`/popout/${source.channel}/chat`)
					);
					record.maxSimultaneousWindows = Math.max(record.maxSimultaneousWindows, matchingWindows.length);
					const sourceWindow = findChannelWindow(windows, source.channel);
					if (sourceWindow) {
						record.windowIds.add(sourceWindow.id);
						probe = await readChatProbe(remotePort, sourceWindow.id);
						const previousRows = record.lastObservedRowsByWindow.get(sourceWindow.id) || 0;
						if (probe.observedRows > previousRows) record.activitySamples += 1;
						record.lastObservedRowsByWindow.set(sourceWindow.id, probe.observedRows);
						record.maxObservedRows = Math.max(record.maxObservedRows, probe.observedRows || 0);
						record.maxPresentRows = Math.max(record.maxPresentRows, probe.presentRows || 0);
					}

					const statusKey = JSON.stringify({
						status: state?.status || null,
						vid: state?.vid || null,
						events: state?.events?.length || 0,
						statusText: state?.statusText || ''
					});
					if (statusKey !== record.lastStatusKey) {
						record.statusTransitions.push({ at: sample.at, ...JSON.parse(statusKey) });
						record.lastStatusKey = statusKey;
					}
					record.finalState = state;
					sample.channels.push({ channel: source.channel, state, probe, matchingWindows: matchingWindows.length });
				} catch (error) {
					const message = error?.message || String(error);
					record.errors.push({ at: sample.at, message });
					sample.channels.push({ channel: source.channel, state, probe, error: message });
				}

				console.log(
					`[twitch-soak] s${String(sampleIndex).padStart(3)} @${source.channel.padEnd(22)} ` +
					`status=${String(state?.status || 'error').padEnd(10)} redirects=${state?.events?.length || 0} ` +
					`window=${probe ? 'yes' : 'no '} rows=${String(probe?.observedRows || 0).padStart(4)}`
				);
			}

			appendReport(sample);
			const nextSampleAt = startedAt + (sampleIndex + 1) * sampleSeconds * 1000;
			await sleep(Math.max(0, nextSampleAt - Date.now()));
		}

		const results = [...records.values()].map(record => {
			const events = record.finalState?.events || [];
			return {
				channel: record.channel,
				finalStatus: record.finalState?.status || null,
				finalStatusText: record.finalState?.statusText || '',
				redirects: events.length,
				redirectEvents: events,
				replacementWindows: Math.max(0, record.windowIds.size - 1),
				maxSimultaneousWindows: record.maxSimultaneousWindows,
				maxObservedRows: record.maxObservedRows,
				maxPresentRows: record.maxPresentRows,
				activitySamples: record.activitySamples,
				errors: record.errors,
				statusTransitions: record.statusTransitions
			};
		});
		const summary = {
			type: 'summary',
			at: new Date().toISOString(),
			minutes,
			sampleSeconds,
			results,
			success: results.every(result =>
				result.errors.length === 0
					&& result.maxSimultaneousWindows <= 1
					&& (result.finalStatus === 'active' || (result.redirects >= 4 && result.finalStatus === 'inactive'))
			)
		};
		appendReport(summary);
		console.log(`[twitch-soak] ${summary.success ? 'PASSED' : 'FAILED'} after ${minutes} minute(s)`);
		for (const result of results) {
			console.log(
				`[twitch-soak] @${result.channel} status=${result.finalStatus} redirects=${result.redirects} ` +
				`replacementWindows=${result.replacementWindows} maxDuplicates=${result.maxSimultaneousWindows} ` +
				`rows=${result.maxObservedRows} errors=${result.errors.length}`
			);
		}
		process.exitCode = summary.success ? 0 : 1;
	} catch (error) {
		console.error(error?.stack || error);
		if (stdout) console.error(`\nSSApp stdout:\n${stdout}`);
		if (stderr) console.error(`\nSSApp stderr:\n${stderr}`);
		appendReport({ type: 'fatal', at: new Date().toISOString(), error: error?.message || String(error) });
		process.exitCode = 1;
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
		const resolvedProfile = path.resolve(userDataDir);
		const expectedPrefix = path.resolve(path.join(os.tmpdir(), 'ssapp-twitch-navigation-soak-profile-'));
		if (resolvedProfile.startsWith(expectedPrefix)) {
			fs.rmSync(resolvedProfile, { recursive: true, force: true });
		}
	}
}

run();
