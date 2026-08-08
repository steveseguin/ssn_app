#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { execFile } = require('child_process');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const electronPath = require('electron');
const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const socialStreamUrl = pathToFileURL(socialStreamRoot + path.sep).href;

function parseArguments(argv) {
	const options = {
		users: [],
		discover: false,
		discoverLimit: 10,
		discoverUrl: 'https://www.tiktok.com/live',
		minimum: 600,
		minutes: 90,
		sampleSeconds: 10,
		stallSeconds: 180,
		reloadGraceSeconds: 60,
		floodWindowSeconds: 10,
		floodLimit: 295,
		warmupSeconds: 180,
		minimumLatencySamples: 20,
		maxRendererMb: 2048,
		maxRendererGrowthMb: 384,
		maxMainMb: 2048,
		maxMainGrowthMb: 512,
		report: '',
	};
	for (const argument of argv) {
		if (argument === '--discover') options.discover = true;
		else if (argument.startsWith('--discover=')) {
			options.discover = true;
			options.discoverLimit = Number(argument.slice('--discover='.length));
		}
		else if (argument.startsWith('--discover-url=')) options.discoverUrl = argument.slice('--discover-url='.length);
		else if (argument.startsWith('--user=')) options.users.push(argument.slice('--user='.length));
		else if (argument.startsWith('--users=')) options.users.push(...argument.slice('--users='.length).split(','));
		else if (argument.startsWith('--minimum=')) options.minimum = Number(argument.slice('--minimum='.length));
		else if (argument.startsWith('--minutes=')) options.minutes = Number(argument.slice('--minutes='.length));
		else if (argument.startsWith('--sample-seconds=')) options.sampleSeconds = Number(argument.slice('--sample-seconds='.length));
		else if (argument.startsWith('--stall-seconds=')) options.stallSeconds = Number(argument.slice('--stall-seconds='.length));
		else if (argument.startsWith('--reload-grace-seconds=')) options.reloadGraceSeconds = Number(argument.slice('--reload-grace-seconds='.length));
		else if (argument.startsWith('--flood-limit=')) options.floodLimit = Number(argument.slice('--flood-limit='.length));
		else if (argument.startsWith('--warmup-seconds=')) options.warmupSeconds = Number(argument.slice('--warmup-seconds='.length));
		else if (argument.startsWith('--minimum-latency-samples=')) options.minimumLatencySamples = Number(argument.slice('--minimum-latency-samples='.length));
		else if (argument.startsWith('--max-renderer-mb=')) options.maxRendererMb = Number(argument.slice('--max-renderer-mb='.length));
		else if (argument.startsWith('--max-renderer-growth-mb=')) options.maxRendererGrowthMb = Number(argument.slice('--max-renderer-growth-mb='.length));
		else if (argument.startsWith('--max-main-mb=')) options.maxMainMb = Number(argument.slice('--max-main-mb='.length));
		else if (argument.startsWith('--max-main-growth-mb=')) options.maxMainGrowthMb = Number(argument.slice('--max-main-growth-mb='.length));
		else if (argument.startsWith('--report=')) options.report = argument.slice('--report='.length);
	}
	options.users = [...new Set(options.users.map(user => String(user || '').trim().replace(/^@/, '')).filter(Boolean))];
	for (const key of [
		'minimum', 'minutes', 'sampleSeconds', 'stallSeconds', 'reloadGraceSeconds', 'floodLimit',
		'warmupSeconds', 'minimumLatencySamples', 'maxRendererMb', 'maxRendererGrowthMb', 'maxMainMb', 'maxMainGrowthMb',
	]) {
		if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`--${key} must be a positive number.`);
	}
	if (options.discover && (!Number.isInteger(options.discoverLimit) || options.discoverLimit < 1 || options.discoverLimit > 50)) {
		throw new Error('--discover limit must be an integer from 1 through 50.');
	}
	if (options.discover) {
		let discoverUrl;
		try { discoverUrl = new URL(options.discoverUrl); } catch (_) { throw new Error('--discover-url must be a valid TikTok LIVE URL.'); }
		const allowedPath = /^\/live(?:\/(?:gaming|lifestyle))?\/?$/i.test(discoverUrl.pathname);
		if (
			discoverUrl.protocol !== 'https:' || discoverUrl.hostname !== 'www.tiktok.com' || !allowedPath ||
			discoverUrl.username || discoverUrl.password || discoverUrl.search || discoverUrl.hash
		) throw new Error('--discover-url must be exactly TikTok /live, /live/gaming, or /live/lifestyle over HTTPS.');
		options.discoverUrl = `${discoverUrl.origin}${discoverUrl.pathname.replace(/\/$/, '')}`;
	}
	if (!options.discover && options.users.length < 3) {
		throw new Error('Provide at least three live TikTok usernames with --users=name1,name2,name3 or repeated --user=name.');
	}
	return options;
}

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

function createMcpSession(port) {
	const child = spawn(process.execPath, [path.join(repoRoot, 'resources', 'ssapp-mcp.js')], {
		cwd: repoRoot,
		env: { ...process.env, SSAPP_CONTROL_URL: `http://127.0.0.1:${port}` },
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let nextId = 1;
	let stderr = '';
	let buffer = '';
	const responses = new Map();
	child.stderr.on('data', chunk => { stderr += chunk.toString(); });
	child.stdout.on('data', chunk => {
		buffer += chunk.toString();
		let newline;
		while ((newline = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const response = JSON.parse(line);
			responses.set(response.id, response);
		}
	});
	const request = async (method, params = {}, timeoutMs = 40000) => {
		const id = nextId++;
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		const startedAt = Date.now();
		while (Date.now() - startedAt < timeoutMs) {
			if (responses.has(id)) {
				const response = responses.get(id);
				responses.delete(id);
				return { response, latencyMs: Date.now() - startedAt };
			}
			if (child.exitCode !== null) throw new Error(`MCP exited (${child.exitCode}): ${stderr}`);
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		throw new Error(`Timed out waiting for MCP ${method}: ${stderr}`);
	};
	const call = async (name, args = {}, timeoutMs = 40000) => {
		const { response, latencyMs } = await request('tools/call', { name, arguments: args }, timeoutMs);
		if (response.error) throw new Error(`${name}: ${JSON.stringify(response.error)}`);
		if (response.result?.isError) throw new Error(`${name}: ${response.result.content?.[0]?.text || 'tool failed'}`);
		return { result: response.result, latencyMs };
	};
	const close = async () => {
		if (!child.stdin.writableEnded) child.stdin.end();
		await Promise.race([
			new Promise(resolve => child.once('exit', resolve)),
			new Promise(resolve => setTimeout(resolve, 2000)),
		]);
		if (child.exitCode === null) child.kill();
	};
	return { child, request, call, close };
}

function apiResult(toolResult) {
	return toolResult?.structuredContent?.result || {};
}

function payload(toolResult) {
	return apiResult(toolResult).payload || {};
}

function startApp(port, profileDir) {
	const child = spawn(electronPath, [
		'.', '--running-from-source', '--multiinstance', '--filesource', socialStreamUrl,
		'--ssapp-control-api', `--ssapp-control-port=${port}`, '--no-hwa', ...linuxLaunchArgs(),
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDir,
			SSAPP_CONTROL_API: '0',
			SSAPP_HEADLESS_CONTROL: '0',
			SSAPP_CONTROL_PORT: String(port),
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
			SSAPP_DEBUG_LOGS: process.env.SSAPP_E2E_DEBUG || '0',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let output = '';
	child.stdout.on('data', chunk => { output += chunk.toString(); });
	child.stderr.on('data', chunk => { output += chunk.toString(); });
	return { child, output: () => output };
}

async function stopApp(appInstance) {
	const child = appInstance?.child;
	if (!child || child.exitCode !== null) return;
	child.kill();
	await Promise.race([
		new Promise(resolve => child.once('exit', resolve)),
		new Promise(resolve => setTimeout(resolve, 5000)),
	]);
}

async function waitForReady(mcp, appInstance, timeoutMs = 60000) {
	const startedAt = Date.now();
	let last;
	while (Date.now() - startedAt < timeoutMs) {
		if (appInstance.child.exitCode !== null) throw new Error(`SSApp exited (${appInstance.child.exitCode}).`);
		try {
			const status = await mcp.call('ssapp_get_status');
			const capabilities = await mcp.call('ssapp_get_capabilities');
			last = { status: apiResult(status.result), capabilities: apiResult(capabilities.result) };
			if (last.status.ok && last.capabilities.payload?.ready === true) return last;
		} catch (error) {
			last = { error: error.message };
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`SSApp did not become MCP-ready: ${JSON.stringify(last)}`);
}

async function waitForSourceStatus(mcp, sourceId, wantedStatus, timeoutMs = 60000) {
	const startedAt = Date.now();
	let lastSource = null;
	while (Date.now() - startedAt < timeoutMs) {
		const call = await mcp.call('ssapp_get_source', { sourceId });
		lastSource = payload(call.result).source || null;
		if (lastSource?.status === wantedStatus) return lastSource;
		if (lastSource?.status === 'error') throw new Error(lastSource.error || `Source entered error before ${wantedStatus}.`);
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out waiting for source ${sourceId} to become ${wantedStatus}: ${JSON.stringify(lastSource)}`);
}

function percentile(values, fraction) {
	if (!values.length) return null;
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function readMainRssKb(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
	if (process.platform === 'linux') {
		try {
			const text = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
			const match = text.match(/^VmRSS:\s+(\d+)\s+kB$/m);
			return Promise.resolve(match ? Number(match[1]) : null);
		} catch (_) {
			return Promise.resolve(null);
		}
	}
	const command = process.platform === 'win32' ? 'powershell.exe' : 'ps';
	const args = process.platform === 'win32'
		? ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`]
		: ['-o', 'rss=', '-p', String(pid)];
	return new Promise(resolve => {
		execFile(command, args, { windowsHide: true, timeout: 5000 }, (error, stdout) => {
			if (error) resolve(null);
			else {
				const bytesOrKb = Number(String(stdout).trim());
				resolve(Number.isFinite(bytesOrKb) ? (process.platform === 'win32' ? Math.round(bytesOrKb / 1024) : bytesOrKb) : null);
			}
		});
	});
}

function writeJsonLine(reportPath, value) {
	fs.appendFileSync(reportPath, `${JSON.stringify(value)}\n`, 'utf8');
}

function newSourceState(username, sourceId) {
	return {
		username,
		sourceId,
		createdAtMs: Date.now(),
		cursor: 0,
		activeAt: null,
		firstMessageAt: null,
		lastMessageAt: null,
		messageCount: 0,
		lastCounters: null,
		statusEvents: new Map(),
		otherStatusEvents: 0,
		diagnosticEvidence: null,
		latencies: [],
		rendererPids: new Set(),
		reloads: [],
		errors: [],
		failures: [],
	};
}

async function captureBlockedPageEvidence(mcp, state, reportPath) {
	const screenshot = await mcp.call('ssapp_capture_source_screenshot', { sourceId: state.sourceId, format: 'png', maxWidth: 1200 });
	const image = (screenshot.result.content || []).find(item => item.type === 'image' && item.mimeType === 'image/png');
	const inspection = payload((await mcp.call('ssapp_inspect_source_page', {
		sourceId: state.sourceId, maxElements: 100, maxTextChars: 10000,
	})).result);
	const outputDir = path.join(repoRoot, 'test-results', 'mcp-tiktok');
	fs.mkdirSync(outputDir, { recursive: true });
	const outputPath = path.join(outputDir, `${path.basename(reportPath, '.jsonl')}-${state.username.replace(/[^a-z0-9_.-]/gi, '_')}.png`);
	if (image?.data) fs.writeFileSync(outputPath, Buffer.from(image.data, 'base64'));
	state.diagnosticEvidence = {
		screenshotPath: image?.data ? outputPath : null,
		title: String(inspection.page?.title || '').slice(0, 200),
		labels: (inspection.elements || []).map(element => `${element.role || 'element'}: ${element.name || ''}`.trim()).filter(Boolean).slice(0, 30),
	};
	writeJsonLine(reportPath, { type: 'diagnostic.evidence', at: new Date().toISOString(), sourceId: state.sourceId, ...state.diagnosticEvidence });
}

function statusEventSummary(state) {
	return {
		values: Array.from(state.statusEvents.values()),
		otherCount: state.otherStatusEvents,
	};
}

function recordStatusEvent(state, event) {
	const safeToken = value => {
		const token = String(value ?? '').trim();
		return /^[a-zA-Z0-9_.:-]{1,80}$/.test(token) ? token : null;
	};
	const status = safeToken(event.data?.status ?? event.data?.state ?? event.data?.phase) || '(missing)';
	const code = safeToken(event.data?.code) || '(none)';
	const key = `${status}\u0000${code}`;
	const existing = state.statusEvents.get(key);
	if (existing) existing.count += 1;
	else if (state.statusEvents.size < 30) state.statusEvents.set(key, { status, code, count: 1 });
	else state.otherStatusEvents += 1;
}

function handleFromTikTokPath(redactedUrl) {
	try {
		const pathname = new URL(String(redactedUrl || '')).pathname;
		const match = pathname.match(/^\/@([^/]+)\/live\/?$/i);
		return match ? decodeURIComponent(match[1]).replace(/^@/, '') : '';
	} catch (_) {
		return '';
	}
}

async function discoverLiveUsers(mcp, states, limit, reportPath, listingUrl) {
	const added = await mcp.call('ssapp_add_source', {
		target: 'tiktok',
		username: 'live-discovery',
		url: listingUrl,
		connectionMode: 'classic',
		isVisible: true,
		isMuted: true,
		idempotencyKey: `mcp-live-discovery-${Date.now()}`,
	});
	const sourceId = payload(added.result).source?.id;
	assert.ok(sourceId, 'TikTok discovery source was not added.');
	states.push(newSourceState('live-discovery', sourceId));
	const discovered = [];
	const attemptedNames = new Set();
	for (let attempt = 0; attempt < limit * 3 && discovered.length < limit; attempt += 1) {
		await mcp.call('ssapp_start_source', { sourceId });
		await waitForSourceStatus(mcp, sourceId, 'active');
		await new Promise(resolve => setTimeout(resolve, 3000));
		let inspection = null;
		for (let retry = 0; retry < 10; retry += 1) {
			inspection = payload((await mcp.call('ssapp_inspect_source_page', {
				sourceId,
				maxElements: 200,
				maxTextChars: 20000,
			})).result);
			if (inspection.elements?.some(element => element.role === 'link' && element.name)) break;
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		const links = (inspection?.elements || [])
			.filter(element => element.role === 'link' && element.ref && element.name)
			.map(element => ({ ...element, normalizedName: element.name.replace(/\s+/g, ' ').trim() }))
			.filter(element => !attemptedNames.has(element.normalizedName))
			.filter(element => !/^(discover live|live|tiktok|home|for you|following|explore|log in|sign up)$/i.test(element.normalizedName));
		const likelyLive = links.find(element => /\blive\b|watch now|viewers?|interact/i.test(element.normalizedName));
		const candidate = likelyLive || links[0];
		if (!candidate) {
			writeJsonLine(reportPath, { type: 'discover.no-candidate', at: new Date().toISOString(), page: inspection?.page || null });
			break;
		}
		attemptedNames.add(candidate.normalizedName);
		try {
			await mcp.call('ssapp_interact_source_page', {
				sourceId,
				ref: candidate.ref,
				action: 'click',
				confirm: true,
			});
		} catch (error) {
			if (!/STALE_PAGE_REF/i.test(error.message)) throw error;
			attemptedNames.delete(candidate.normalizedName);
			writeJsonLine(reportPath, {
				type: 'discover.stale-ref',
				at: new Date().toISOString(),
				clickedName: candidate.normalizedName,
			});
			continue;
		}
		let handle = '';
		let diagnostics = null;
		for (let retry = 0; retry < 30; retry += 1) {
			diagnostics = payload((await mcp.call('ssapp_get_source_diagnostics', { sourceId })).result);
			handle = handleFromTikTokPath(diagnostics.page?.redactedUrl);
			if (handle) break;
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		writeJsonLine(reportPath, {
			type: 'discover.attempt',
			at: new Date().toISOString(),
			clickedName: candidate.normalizedName,
			redactedUrl: diagnostics?.page?.redactedUrl || null,
			handle: handle || null,
		});
		if (handle && !discovered.includes(handle)) discovered.push(handle);
		await mcp.call('ssapp_stop_source', { sourceId });
		await waitForSourceStatus(mcp, sourceId, 'inactive');
		await mcp.call('ssapp_update_source', { sourceId, updates: { url: listingUrl } });
	}
	return discovered;
}

async function drainSourceEvents(mcp, state) {
	let pages = 0;
	let drained = [];
	do {
		const call = await mcp.call('ssapp_get_recent_source_events', {
			sourceId: state.sourceId,
			afterId: state.cursor,
			limit: 200,
		});
		state.latencies.push(call.latencyMs);
		const result = payload(call.result);
		if (result.historyLost) state.failures.push(`Event history was lost after cursor ${state.cursor}.`);
		const events = Array.isArray(result.events) ? result.events : [];
		drained.push(...events);
		if (Number.isInteger(result.cursor)) state.cursor = result.cursor;
		if (!result.hasMore) break;
		pages += 1;
		if (pages >= 20) {
			state.failures.push('More than 4,000 source events accumulated between samples.');
			break;
		}
	} while (true);
	const messages = drained.filter(event => event.type === 'message');
	for (const event of drained) {
		if (event.type === 'status') recordStatusEvent(state, event);
	}
	if (messages.length) {
		state.lastMessageAt = messages[messages.length - 1].at || new Date().toISOString();
		if (!state.firstMessageAt) state.firstMessageAt = messages[0].at || state.lastMessageAt;
	}
	for (const reload of state.reloads) {
		if (reload.resumed || !reload.requestedAt) continue;
		const afterReload = messages.filter(event => Date.parse(event.at || 0) >= Date.parse(reload.requestedAt));
		reload.messagesInFloodWindow += afterReload.filter(event =>
			Date.parse(event.at || 0) - Date.parse(reload.requestedAt) <= reload.floodWindowMs
		).length;
		if (afterReload.length) {
			reload.resumed = true;
			reload.resumedAt = afterReload[0].at;
		}
	}
	return drained;
}

async function requestReload(mcp, state, options, reason = 'message-threshold') {
	const beforeMessages = state.messageCount;
	const call = await mcp.call('ssapp_reload_source_page', { sourceId: state.sourceId, confirm: true });
	state.latencies.push(call.latencyMs);
	state.reloads.push({
		requestedAt: new Date().toISOString(),
		reason,
		beforeMessages,
		resumed: false,
		resumedAt: null,
		messagesInFloodWindow: 0,
		floodWindowMs: options.floodWindowSeconds * 1000,
	});
}

function recordRendererProcess(rendererProcesses, diagnostics, state, options, sampleAt) {
	const pid = Number(diagnostics.process?.pid);
	const privateKb = Number(diagnostics.process?.privateKb);
	if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(privateKb) || privateKb <= 0) return;
	state.rendererPids.add(pid);
	let process = rendererProcesses.get(pid);
	if (!process) {
		process = { pid, type: diagnostics.process?.type || null, sourceIds: new Set(), samples: [], postWarmupPrivateKb: null, failures: [] };
		rendererProcesses.set(pid, process);
	}
	process.sourceIds.add(state.sourceId);
	if (!process.samples.some(sample => sample.at === sampleAt)) process.samples.push({ at: sampleAt, privateKb });
	const warmupComplete = Date.now() - state.createdAtMs >= options.warmupSeconds * 1000;
	if (warmupComplete && process.postWarmupPrivateKb === null) process.postWarmupPrivateKb = privateKb;
	if (warmupComplete && privateKb > options.maxRendererMb * 1024) process.failures.push(`Private memory exceeded ${options.maxRendererMb} MB.`);
	if (warmupComplete && privateKb - process.postWarmupPrivateKb > options.maxRendererGrowthMb * 1024) {
		process.failures.push(`Private memory grew more than ${options.maxRendererGrowthMb} MB.`);
	}
}

async function sampleSource(mcp, state, options, rendererProcesses, sampleAt) {
	const sourceCall = await mcp.call('ssapp_get_source', { sourceId: state.sourceId });
	state.latencies.push(sourceCall.latencyMs);
	const source = payload(sourceCall.result).source || {};
	if (source.status === 'active' && !state.activeAt) state.activeAt = new Date().toISOString();
	if (source.status === 'error') {
		const message = source.error || 'Source entered error state.';
		if (!state.errors.includes(message)) state.errors.push(message);
		if (state.firstMessageAt) state.failures.push(`Source errored after capture began: ${message}`);
	}

	await drainSourceEvents(mcp, state);
	const diagnosticsCall = await mcp.call('ssapp_get_source_diagnostics', { sourceId: state.sourceId });
	state.latencies.push(diagnosticsCall.latencyMs);
	const diagnostics = payload(diagnosticsCall.result);
	const counters = diagnostics.counters || {};
	state.lastCounters = counters;
	state.messageCount = Number(counters.byType?.message || 0);
	if (!options.diagnosticEvidenceCaptured && Number(counters.errorSignals || 0) > 0) {
		options.diagnosticEvidenceCaptured = true;
		try { await captureBlockedPageEvidence(mcp, state, options.reportPath); } catch (error) {
			state.diagnosticEvidence = { error: error.message };
		}
	}
	recordRendererProcess(rendererProcesses, diagnostics, state, options, sampleAt);

	if (Number(counters.buffered || 0) > 1000) state.failures.push(`Observation buffer exceeded 1,000 entries: ${counters.buffered}.`);
	const byTypeTotal = Object.values(counters.byType || {}).reduce((total, count) => total + Number(count || 0), 0);
	const lifecycleTotal = Number(counters.byType?.status || 0) + Number(counters.byType?.navigation || 0) + Number(counters.byType?.reload || 0);
	if (Number(counters.emittedCaptures || 0) + lifecycleTotal !== byTypeTotal) {
		state.failures.push('Capture and lifecycle counters did not reconcile.');
	}
	if (Number(counters.buffered || 0) + Number(counters.historyEvicted || 0) !== byTypeTotal) {
		state.failures.push('Buffered and evicted event counters did not reconcile.');
	}
	for (const reload of state.reloads) {
		if (reload.messagesInFloodWindow > options.floodLimit) {
			state.failures.push(`Reload emitted ${reload.messagesInFloodWindow} messages in ${options.floodWindowSeconds}s (limit ${options.floodLimit}).`);
		}
	}
	return { source, diagnostics };
}

function finalSourceResult(state, options, stoppedAt, rendererProcesses) {
	const p95 = percentile(state.latencies, 0.95);
	const maxLatency = state.latencies.length ? Math.max(...state.latencies) : null;
	if (state.latencies.length >= options.minimumLatencySamples && p95 !== null && p95 > 1000) {
		state.failures.push(`MCP p95 latency was ${p95}ms (limit 1000ms).`);
	}
	if (state.latencies.length >= options.minimumLatencySamples && maxLatency !== null && maxLatency > 5000) {
		state.failures.push(`MCP maximum latency was ${maxLatency}ms (limit 5000ms).`);
	}

	const uniqueFailures = [...new Set(state.failures)];
	const observedLongEnough = Date.parse(stoppedAt) - Date.parse(state.activeAt || stoppedAt) >= options.warmupSeconds * 1000;
	const qualified = state.messageCount >= options.minimum && state.reloads.length >= 2 && state.reloads.every(reload => reload.resumed)
		&& observedLongEnough && state.latencies.length >= options.minimumLatencySamples;
	let outcome = 'PASS';
	let reason = null;
	if (uniqueFailures.length) {
		outcome = 'FAIL';
		reason = uniqueFailures.join(' ');
	} else if (!qualified) {
		outcome = 'INCONCLUSIVE';
		reason = state.errors.length
			? `Stream was unavailable or errored: ${state.errors.join(' ')}`
			: `Only ${state.messageCount}/${options.minimum} messages and ${state.reloads.length}/2 reload cycles completed.`;
	}
	return {
		username: state.username,
		sourceId: state.sourceId,
		outcome,
		reason,
		startedAt: state.activeAt,
		stoppedAt,
		firstMessageAt: state.firstMessageAt,
		lastMessageAt: state.lastMessageAt,
		messageCount: state.messageCount,
		counters: state.lastCounters,
		statusEvents: statusEventSummary(state),
		diagnosticEvidence: state.diagnosticEvidence,
		reloads: state.reloads,
		latencyMs: { samples: state.latencies.length, p95, max: maxLatency },
		rendererProcesses: Array.from(state.rendererPids).map(pid => {
			const process = rendererProcesses.get(pid);
			return { pid, type: process?.type || null, shared: (process?.sourceIds.size || 0) > 1 };
		}),
		failures: uniqueFailures,
		errors: state.errors,
	};
}

function finalRendererProcesses(rendererProcesses) {
	return Array.from(rendererProcesses.values()).map(process => {
		const privateKb = process.samples.map(sample => sample.privateKb);
		return {
			pid: process.pid,
			type: process.type,
			shared: process.sourceIds.size > 1,
			sourceIds: Array.from(process.sourceIds),
			privateKb: {
				samples: privateKb.length,
				first: privateKb[0] || null,
				last: privateKb[privateKb.length - 1] || null,
				max: privateKb.length ? Math.max(...privateKb) : null,
				postWarmup: process.postWarmupPrivateKb,
			},
			failures: [...new Set(process.failures)],
		};
	});
}

async function run() {
	const options = parseArguments(process.argv.slice(2));
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `ssapp-mcp-tiktok-soak-${stamp}-`));
	const reportPath = path.resolve(options.report || path.join(os.tmpdir(), `ssapp-mcp-tiktok-soak-${stamp}.jsonl`));
	options.reportPath = reportPath;
	fs.writeFileSync(reportPath, '', 'utf8');
	const port = await getFreePort();
	const mcp = createMcpSession(port);
	let appInstance = null;
	const states = [];
	const rendererProcesses = new Map();
	const mainRssKb = [];
	let postWarmupMainRssKb = null;
	const startedAt = new Date().toISOString();
	let interrupted = false;
	const interrupt = () => { interrupted = true; };
	process.once('SIGINT', interrupt);
	try {
		const initialized = await mcp.request('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'ssapp-mcp-tiktok-live-soak', version: '1' },
		});
		assert.strictEqual(initialized.response.result?.serverInfo?.name, 'social-stream-ninja');
		const offlineTools = await mcp.request('tools/list');
		const names = new Set((offlineTools.response.result?.tools || []).map(tool => tool.name));
		for (const name of [
			'ssapp_add_source', 'ssapp_start_source', 'ssapp_get_source',
			'ssapp_get_recent_source_events', 'ssapp_get_source_diagnostics',
			'ssapp_reload_source_page', 'ssapp_remove_source', 'ssapp_shutdown',
		]) assert.ok(names.has(name), `MCP tool list omitted ${name}.`);

		appInstance = startApp(port, profileDir);
		await waitForReady(mcp, appInstance);
		writeJsonLine(reportPath, { type: 'start', at: startedAt, options: { ...options, report: reportPath }, pid: appInstance.child.pid });
		options.diagnosticEvidenceCaptured = false;
		if (options.discover) {
			const discovered = await discoverLiveUsers(mcp, states, options.discoverLimit, reportPath, options.discoverUrl);
			const summary = {
				type: 'discover.summary',
				at: new Date().toISOString(),
				outcome: discovered.length ? 'PASS' : 'INCONCLUSIVE',
				discovered,
				soakArguments: discovered.length >= 3 ? `--users=${discovered.join(',')}` : null,
				reportPath,
			};
			writeJsonLine(reportPath, summary);
			console.log(JSON.stringify(summary, null, 2));
			console.log(`Discovery evidence: ${reportPath}`);
			if (!discovered.length) process.exitCode = 2;
			return;
		}

		for (const username of options.users) {
			const added = await mcp.call('ssapp_add_source', {
				target: 'tiktok', username, connectionMode: 'classic',
				isVisible: true, isMuted: true, autoActivate: false,
				idempotencyKey: `mcp-live-soak-${username}-${stamp}`,
			});
			const sourceId = payload(added.result).source?.id;
			assert.ok(sourceId, `TikTok source was not added for ${username}.`);
			states.push(newSourceState(username, sourceId));
		}
		for (const state of states) await mcp.call('ssapp_start_source', { sourceId: state.sourceId });

		const soakStartedAtMs = Date.now();
		const deadline = Date.now() + options.minutes * 60000;
		const firstReloadAt = Math.max(25, Math.floor(options.minimum * 0.25));
		const secondReloadAt = Math.max(50, Math.floor(options.minimum * 0.60));
		while (!interrupted && Date.now() < deadline) {
			const sampleAt = new Date().toISOString();
			for (const state of states) {
				try {
					const sample = await sampleSource(mcp, state, options, rendererProcesses, sampleAt);
					const enoughTimeForReload = deadline - Date.now() > options.reloadGraceSeconds * 1000;
					const stalled = state.firstMessageAt && Date.now() - Date.parse(state.lastMessageAt) >= options.stallSeconds * 1000;
					if (enoughTimeForReload && state.reloads.length === 0 && (state.messageCount >= firstReloadAt || stalled)) {
						await requestReload(mcp, state, options, stalled ? 'capture-stalled' : 'message-threshold');
					} else if (
						enoughTimeForReload && state.reloads.length === 1 && state.reloads[0].resumed &&
						(state.messageCount >= secondReloadAt || stalled)
					) {
						await requestReload(mcp, state, options, stalled ? 'capture-stalled' : 'message-threshold');
					}
					writeJsonLine(reportPath, {
						type: 'source.sample', at: sampleAt, username: state.username, sourceId: state.sourceId,
						status: sample.source.status, error: sample.source.error || null,
						messageCount: state.messageCount, cursor: state.cursor,
						counters: state.lastCounters, reloads: state.reloads,
						statusEvents: statusEventSummary(state),
						rendererPids: Array.from(state.rendererPids),
					});
				} catch (error) {
					state.failures.push(`Sampling failed: ${error.message}`);
				}
			}
			const rssKb = await readMainRssKb(appInstance.child.pid);
			if (rssKb) mainRssKb.push(rssKb);
			writeJsonLine(reportPath, {
				type: 'app.sample', at: sampleAt, mainRssKb: rssKb,
				rendererProcesses: finalRendererProcesses(rendererProcesses),
				uniqueRendererPrivateKb: Array.from(rendererProcesses.values()).reduce((total, process) => {
					const latest = process.samples[process.samples.length - 1];
					return total + Number(latest?.privateKb || 0);
				}, 0),
			});
			const warmupComplete = Date.now() - soakStartedAtMs >= options.warmupSeconds * 1000;
			if (warmupComplete && postWarmupMainRssKb === null && rssKb) postWarmupMainRssKb = rssKb;
			if (warmupComplete && rssKb && rssKb > options.maxMainMb * 1024) {
				for (const state of states) state.failures.push(`Main process RSS exceeded ${options.maxMainMb} MB.`);
			}
			if (warmupComplete && postWarmupMainRssKb !== null && rssKb - postWarmupMainRssKb > options.maxMainGrowthMb * 1024) {
				for (const state of states) state.failures.push(`Main process RSS grew more than ${options.maxMainGrowthMb} MB.`);
			}
			const allDone = states.every(state =>
				state.messageCount >= options.minimum && state.reloads.length >= 2 && state.reloads.every(reload => reload.resumed)
				&& state.latencies.length >= options.minimumLatencySamples
			);
			if ((allDone && warmupComplete) || states.some(state => state.failures.length)) break;
			await new Promise(resolve => setTimeout(resolve, options.sampleSeconds * 1000));
		}

		const stoppedAt = new Date().toISOString();
		for (const process of rendererProcesses.values()) {
			for (const failure of new Set(process.failures)) {
				for (const state of states) {
					if (process.sourceIds.has(state.sourceId)) state.failures.push(`Renderer process ${process.pid}: ${failure}`);
				}
			}
		}
		const results = states.map(state => finalSourceResult(state, options, stoppedAt, rendererProcesses));
		const summary = {
			type: 'summary',
			startedAt,
			stoppedAt,
			interrupted,
			reportPath,
			mainRssKb: {
				samples: mainRssKb.length,
				first: mainRssKb[0] || null,
				last: mainRssKb[mainRssKb.length - 1] || null,
				max: mainRssKb.length ? Math.max(...mainRssKb) : null,
			},
			rendererProcesses: finalRendererProcesses(rendererProcesses),
			results,
			outcome: results.some(result => result.outcome === 'FAIL')
				? 'FAIL'
				: results.every(result => result.outcome === 'PASS') ? 'PASS' : 'INCONCLUSIVE',
		};
		writeJsonLine(reportPath, summary);
		console.log(JSON.stringify(summary, null, 2));
		console.log(`Soak evidence: ${reportPath}`);
		if (summary.outcome === 'FAIL') process.exitCode = 1;
		else if (summary.outcome === 'INCONCLUSIVE') process.exitCode = 2;
	} catch (error) {
		writeJsonLine(reportPath, { type: 'fatal', at: new Date().toISOString(), error: error.stack || error.message });
		throw new Error(`${error.message}\nElectron output:\n${appInstance ? appInstance.output().slice(-12000) : ''}\nReport: ${reportPath}`);
	} finally {
		for (const state of states) {
			try { await mcp.call('ssapp_remove_source', { sourceId: state.sourceId, confirm: true }); } catch (_) { }
		}
		if (appInstance?.child.exitCode === null) {
			try { await mcp.call('ssapp_shutdown', { confirm: true }); } catch (_) { }
		}
		await stopApp(appInstance);
		await mcp.close();
		process.removeListener('SIGINT', interrupt);
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

run().catch(error => {
	console.error(error.stack || error.message);
	process.exit(1);
});
