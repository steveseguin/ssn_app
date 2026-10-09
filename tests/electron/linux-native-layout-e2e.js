'use strict';

// Run with node, DISPLAY (X11) or WAYLAND_DISPLAY and --ozone-platform=wayland.
// No debugger: attaching one can itself wake a stalled source renderer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '../..');
const sourceRoot = path.resolve(root, '../social_stream');
const base = pathToFileURL(sourceRoot + path.sep).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!process.versions.electron) {
	const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-linux-layout-'));
	fs.mkdirSync(path.join(output, 'profile'));
	const child = require('child_process').spawn(require('electron'), [__filename, '--no-sandbox', '--multiinstance',
		'--running-from-source', '--filesource=' + base, ...process.argv.slice(2)], {
		cwd: root, stdio: 'inherit', env: { ...process.env, SSAPP_USER_DATA_DIR: path.join(output, 'profile'), SSAPP_LAYOUT_OUTPUT: output }
	});
	console.log('Report: ' + path.join(output, 'report.json'));
	child.on('exit', code => { process.exitCode = code === null ? 1 : code; });
} else {
	void run().catch(error => { console.error(error); require('electron').app.exit(1); });
}

async function run() {
	const { app, BrowserWindow, ipcMain } = require('electron');
	const output = process.env.SSAPP_LAYOUT_OUTPUT;
	if (!output) throw new Error('Run this test with node to isolate the app profile.');
	const report = { runtime: process.versions, cases: [], captured: [], expected: [], snapshots: [] };
	const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
	function check(name, pass, details) { report.cases.push({ name, pass, details }); save(); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); }
	async function until(fn, label, timeout = 40000) {
		const end = Date.now() + timeout;
		while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (_) {} await sleep(100); }
		throw new Error('Timed out: ' + label);
	}
	const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(fixture()); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const portServer = http.createServer();
	await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
	const relayPort = portServer.address().port;
	await new Promise(resolve => portServer.close(resolve));
	const room = 'linux_layout_' + Date.now();
	fs.writeFileSync(path.join(process.env.SSAPP_USER_DATA_DIR, 'savedSync.json'), JSON.stringify({
		streamID: room, password: 'false', state: true, wsServer: true, settings: { server2: { setting: true } }
	}));
	app.setAppPath(root);
	app.commandLine.appendSwitch('ssapp-local-server-port', String(relayPort));
	process.argv.push('--ssapp-local-server-port=' + relayPort);
	require(path.join(root, 'bootstrap'));
	const watchdog = setTimeout(() => { save(); app.exit(2); }, 300000);
	await app.whenReady();
	const main = await until(async () => {
		const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/index.html'));
		return win && await win.webContents.executeJavaScript('typeof configReady!=="undefined"&&configReady') ? win : null;
	}, 'main');
	async function create(args) {
		const id = await main.webContents.executeJavaScript(`ipcRenderer.sendSync('createWindow', (()=>{const a=${JSON.stringify(args)}; if(a.platform){a.config={...config.global,...config[a.platform]};a.configs=config;}return a;})())`);
		return BrowserWindow.getAllWindows().find(w => w.tabID === id);
	}
	ipcMain.on('postMessage', (_event, packet) => {
		const message = packet?.message;
		if (message?.type === 'blaze') report.captured.push(String(message.chatmessage || '').trim());
	});
	const dock = await create({ url: base + `dock.html?session=${room}&password=false&server2&localserver&localserverport=${relayPort}`, visible: false });
	await until(() => dock.webContents.executeJavaScript("typeof socketserverExtension!=='undefined'&&socketserverExtension?.readyState===1"), 'dock relay');
	await dock.webContents.executeJavaScript(`(()=>{window.layoutDelivery=[];const seen=new WeakSet();new MutationObserver(()=>{
		document.querySelectorAll('.highlight-chat').forEach(row=>{if(row.rawContents?.type==='blaze'&&!seen.has(row)){seen.add(row);layoutDelivery.push(String(row.rawContents.chatmessage||'').trim())}})
	}).observe(document.body,{childList:true,subtree:true});})()`);
	const url = 'http://127.0.0.1:' + server.address().port + '/blaze.stream/fixture';
	const source = await create({ url, visible: false, platform: 'blaze', sourceFiles: ['sources/blaze.js'], filesource: base });
	let shown = 0;
	source.on('show', () => shown++);
	async function phase(name, count = 20) {
		await until(() => source.webContents.executeJavaScript('!!window.layoutProbe'), 'fixture ready');
		await sleep(5000); // Let real source injection establish its history boundary.
		const expected = Array.from({ length: count }, (_, n) => 'LAYOUT-' + name + '-' + n);
		report.expected.push(...expected);
		await source.webContents.executeJavaScript(`(${JSON.stringify(expected)}).forEach((token,i)=>setTimeout(()=>addLayoutRow(token),i*120))`);
		await sleep(count * 120 + 2500);
		const snapshot = await source.webContents.executeJavaScript('({...layoutProbe,hidden:document.hidden,visibility:document.visibilityState})');
		report.snapshots.push({ name, nativeVisible: source.isVisible(), ...snapshot });
		check(name + ': native layout and early rAF', snapshot.nativeFrames > 0 && snapshot.measured >= count, snapshot);
		check(name + ': no hidden browser signal', snapshot.visibility === 'visible' && !snapshot.hidden && snapshot.visibilityEvents.every(v => v === 'visible'));
		report.dock = await dock.webContents.executeJavaScript('layoutDelivery');
		for (const stage of ['captured', 'dock']) {
			const counts = new Map(); report[stage].forEach(token => counts.set(token, (counts.get(token) || 0) + 1));
			const missing = report.expected.filter(token => !counts.has(token));
			const duplicates = report.expected.filter(token => counts.get(token) > 1);
			const unexpected = report[stage].filter(token => !report.expected.includes(token));
			check(name + ': exact ' + stage, !missing.length && !duplicates.length && !unexpected.length, { expected: report.expected.length, missing, duplicates, unexpected });
		}
	}
	await phase('startup');
	check('never shown at startup', shown === 0 && !source.isVisible());
	source.webContents.reload(); await sleep(1000); await phase('reload');
	await source.webContents.loadURL(url + '?navigation=2'); await phase('navigation');
	await main.webContents.executeJavaScript(`ipcRenderer.invoke('showWindow',{vid:${source.tabID},state:false})`);
	await phase('revealed', 10);
	await main.webContents.executeJavaScript(`ipcRenderer.invoke('showWindow',{vid:${source.tabID},state:true})`);
	await sleep(20000); await phase('hidden-again');
	check('hidden again native state', !source.isVisible());
	clearTimeout(watchdog); save(); server.close(); app.exit(report.cases.every(c => c.pass) ? 0 : 1);
}

function fixture() {
	return `<!doctype html><meta charset="utf-8"><script>
	window.layoutProbe={nativeFrames:0,measured:0,visibilityEvents:[document.visibilityState]};
	document.addEventListener('visibilitychange',()=>layoutProbe.visibilityEvents.push(document.visibilityState));
	const nativeFrame=requestAnimationFrame.bind(window);(function tick(){nativeFrame(()=>{layoutProbe.nativeFrames++;tick()})})();
	</script><div data-viewport-type="element" style="height:400px;overflow:auto"><div data-testid="virtuoso-item-list"><div data-index="0" data-known-size="30"><button title="History" class="truncate text-sm font-semibold text-white">History</button><span class="block min-w-0 break-words">History</span></div></div></div><script>
	const list=document.querySelector('[data-testid]');let index=0;
	const observer=new ResizeObserver(entries=>entries.forEach(e=>{e.target.dataset.knownSize=String(e.contentRect.height);layoutProbe.measured++}));
	window.addLayoutRow=token=>{const row=document.createElement('div');row.dataset.index=String(++index);row.dataset.knownSize='0';row.style.height='30px';
	row.innerHTML='<button title="Fixture" class="truncate text-sm font-semibold text-white">Fixture</button><span class="block min-w-0 break-words"></span>';
	row.querySelector('span').textContent=token;list.append(row);observer.observe(row)};
	</script>`;
}
