'use strict';

// Opt-in real-app lifecycle measurement. These neutral pages test resource cleanup,
// not platform chat delivery. Memory/CPU are reported, not judged by arbitrary limits.
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
	const root = path.resolve(__dirname, '../..');
	const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-lifecycle-performance-'));
	const cycles = Number(process.env.SSAPP_PERF_CYCLES || 6);
	const idleSeconds = Number(process.env.SSAPP_PERF_IDLE_SECONDS || 60);
	assert.ok(Number.isInteger(cycles) && cycles >= 2 && cycles <= 100);
	assert.ok(Number.isInteger(idleSeconds) && idleSeconds >= 10 && idleSeconds <= 3600);
	const report = { output, cycles, idleSeconds, complete: false, samples: [],
		measurement: 'Electron working set in KiB (shared pages may be counted more than once); CPU percent of one core. Debugger attached. No forced GC.' };
	const ticks = new Map();
	const server = http.createServer((request, response) => {
		const url = new URL(request.url, 'http://localhost');
		if (url.pathname === '/tick') {
			const id = url.searchParams.get('id');
			ticks.set(id, (ticks.get(id) || 0) + 1);
			response.writeHead(204).end();
			return;
		}
		response.setHeader('Content-Type', 'text/html');
		response.end(`<!doctype html><title>Lifecycle fixture</title><p>Lifecycle measurement</p>
			<script>setInterval(() => fetch('/tick?id=' + encodeURIComponent(location.pathname)), 250);</script>`);
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const fixture = `http://127.0.0.1:${server.address().port}`;
	let app;
	let child;
	let log;
	let watchdog;
	const knownPids = new Set();
	const started = Date.now();
	const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
	try {
		app = await _electron.launch({
			executablePath: require('electron'), cwd: root,
			args: ['.', '--running-from-source', '--multiinstance',
				`--filesource=${pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href}`, ...linuxLaunchArgs()],
			env: { ...process.env, SSAPP_USER_DATA_DIR: path.join(output, 'profile'), SSAPP_DEBUG_LOGS: '0' }, timeout: 60000,
		});
		child = app.process();
		watchdog = setTimeout(() => child.kill('SIGKILL'), (idleSeconds * 2 + cycles * 90 + 180) * 1000);
		log = fs.createWriteStream(path.join(output, 'electron.log'));
		child.stdout.pipe(log);
		child.stderr.pipe(log);
		const page = await app.firstWindow();
		const ready = () => page.waitForFunction(() => window.stateManager?.initialized && configReady
			&& ipcRenderer.listenerCount('tiktokConnectionStatus') > 0);
		await ready();
		report.startupMs = Date.now() - started;
		await app.evaluate(({ session }) => {
			global.__perfCookieReads = 0;
			for (let index = 0; index < 3; index++) {
				const cookies = session.fromPartition(`persist:custom-perf-${index}`).cookies;
				const original = cookies.get.bind(cookies);
				cookies.get = filter => {
					if (filter?.domain === '.twitch.tv') global.__perfCookieReads++;
					return original(filter);
				};
			}
		});
		async function sample(stage) {
			const data = await app.evaluate(({ app, BrowserWindow, webContents, ipcMain }) => ({
				metrics: app.getAppMetrics(), heap: process.memoryUsage(),
				windows: BrowserWindow.getAllWindows().length,
				contents: webContents.getAllWebContents().map(wc => ({ id: wc.id, type: wc.getType() })),
				listeners: Object.fromEntries(ipcMain.eventNames().filter(name => typeof name === 'string')
					.map(name => [name, ipcMain.listenerCount(name)])),
				cookieReads: global.__perfCookieReads,
			}));
			data.renderer = await page.evaluate(() => ({
				heap: require('v8').getHeapStatistics().used_heap_size,
				sources: stateManager.getSources().length,
				tabs: ipcRenderer.sendSync('getTabs', {}).length,
				listeners: Object.fromEntries(ipcRenderer.eventNames().filter(name => typeof name === 'string')
					.map(name => [name, ipcRenderer.listenerCount(name)])),
			}));
			data.metrics.forEach(metric => knownPids.add(metric.pid));
			data.stage = stage;
			data.elapsedMs = Date.now() - started;
			data.workingSetMiB = data.metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) / 1024;
			data.cpuPercent = data.metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0);
			report.samples.push(data);
			save();
			console.log(JSON.stringify({ stage, seconds: Math.round(data.elapsedMs / 1000),
				workingSetMiB: Math.round(data.workingSetMiB), cpu: Math.round(data.cpuPercent * 10) / 10,
				processes: data.metrics.length, windows: data.windows, cookieReads: data.cookieReads }));
			return data;
		}
		async function observe(stage, seconds) {
			for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
				await pause(Math.min(5, seconds - elapsed) * 1000);
				await sample(stage);
			}
		}
		await sample('startup');
		await observe('baseline', idleSeconds);
		const baseline = report.samples.at(-1);
		for (let cycle = 1; cycle <= cycles; cycle++) {
			const ids = [];
			const paths = [];
			for (let index = 0; index < 3; index++) {
				const pathname = `/cycle-${cycle}-${index}`;
				paths.push(pathname);
				ids.push(await page.evaluate(async ({ url, index }) => {
					const id = stateManager.addSource({ target: 'custom', username: 'perf-' + index, url,
						connectionMode: 'classic', isDirectUrl: true, sourceFile: 'sources/youtube.js',
						autoActivate: false, isVisible: false, isMuted: true, customSession: 'perf-' + index });
					const result = await performActivationAttempt({ sourceId: id, mode: 'classic' });
					if (!result.success) throw new Error(JSON.stringify(result));
					return id;
				}, { url: fixture + pathname, index }));
			}
			await observe(`active-${cycle}`, 10);
			assert.ok(paths.every(name => ticks.get(name) >= 5), 'All fixture windows must run before cleanup');
			for (const id of ids) {
				await page.locator(`[data-source-id="${id}"] [data-stophtml]`).evaluate(button => button.click());
				await page.evaluate(id => deleteThis(document.querySelector(`[data-source-id="${id}"]`)), id);
			}
			await pause(1000);
			const before = paths.map(name => ticks.get(name));
			await observe(`stopped-${cycle}`, 20);
			assert.deepEqual(paths.map(name => ticks.get(name)), before, 'Removed source kept sending requests');
			const settled = report.samples.at(-1);
			assert.equal(settled.windows, baseline.windows, 'Source windows leaked');
			assert.equal(settled.contents.length, baseline.contents.length, 'WebContents leaked');
			assert.equal(settled.renderer.tabs, 0, 'Stale destinations remain');
			assert.equal(settled.renderer.sources, 0, 'Deleted sources remain');
			assert.deepEqual(settled.listeners, baseline.listeners, 'Main IPC listeners accumulated');
			assert.deepEqual(settled.renderer.listeners, baseline.renderer.listeners, 'Renderer IPC listeners accumulated');
			if (cycle % 2 === 0) {
				await page.reload({ waitUntil: 'load' });
				await ready();
			}
		}
		await observe('final-idle', idleSeconds);
		assert.equal(report.samples.at(-1).cookieReads, 0, 'Logging-disabled startup made diagnostic cookie reads');
		const quitStarted = Date.now();
		await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
		while (child.exitCode === null && child.signalCode === null && Date.now() - quitStarted < 8000) await pause(100);
		assert.equal(child.exitCode, 0, 'App did not quit cleanly within 8 seconds');
		report.quitMs = Date.now() - quitStarted;
		await pause(2000);
		report.survivingPids = [...knownPids].filter(pid => {
			try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
		});
		assert.deepEqual(report.survivingPids, [], 'App helper processes survived Quit');
		report.complete = true;
		console.log(`PASS: ${cycles * 3} real source lifecycles; no leftover windows, requests, IPC listeners, or helper processes. Quit ${report.quitMs} ms.`);
	} catch (error) {
		report.error = error.stack;
		throw error;
	} finally {
		if (watchdog) clearTimeout(watchdog);
		if (child?.exitCode === null && child?.signalCode === null) {
			const kill = setTimeout(() => child.kill('SIGKILL'), 10000);
			await app.close().catch(() => {});
			clearTimeout(kill);
		}
		if (log) log.end();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		save();
		console.log('Evidence: ' + output);
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
