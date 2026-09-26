'use strict';
// Run with a desktop: node tests/electron/auto-download-e2e.js [--default-settings]
// Real native chat -> Dock -> clicked local page -> download, in a disposable profile.
// Only inert text files are allowed to complete, inside a dedicated temporary folder.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '../..');
const { _electron } = require(path.join(root, 'node_modules/playwright-core'));
const { linuxLaunchArgs, electronTestTarget, electronTestRuntime, electronTestSourceBase } = require('./helpers/electron-launch');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      if (!String(error.message).includes('Execution context was destroyed')) throw error;
    }
    await pause(150);
  }
  throw new Error('Timed out: ' + label);
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function run() {
  const autoSaving = !process.argv.includes('--default-settings');
  const profile = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ssapp-download-audit-'));
  const saveDir = path.join(profile, 'inert-downloads');
  fs.mkdirSync(saveDir);
  const existing = path.join(saveDir, 'existing-fixture.txt');
  fs.writeFileSync(existing, 'ORIGINAL DISPOSABLE CONTENT');
  fs.writeFileSync(path.join(saveDir, 'existing-fixture (1).txt'), 'EXISTING NUMBERED FILE');
  const outside = path.join(profile, 'outside-fixture.txt');
  fs.writeFileSync(outside, 'OUTSIDE DISPOSABLE GUARD');
  const room = 'download_audit_' + Date.now();
  const relayPort = await freePort();
  let sourceBase = pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href;
  fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
    streamID: room, password: 'false', state: true, wsServer: true, settings: { server2: { setting: true } },
  }));
  const filenames = { ordinary: 'ordinary-fixture.txt', collision: 'existing-fixture.txt', traversal: '../outside-fixture.txt' };
  const slowResponses = new Map();
  const slowFiles = {
    'concurrent-one': { name: 'concurrent-fixture.txt', content: 'CONCURRENT ONE'.repeat(1024) },
    'concurrent-two': { name: 'concurrent-fixture.txt', content: 'CONCURRENT TWO'.repeat(1024) },
    cancel: { name: 'cancel-fixture.txt', content: 'CANCEL RETRY'.repeat(1024) },
    'cancel-retry': { name: 'cancel-fixture.txt', content: 'CANCEL RETRY'.repeat(1024) },
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/slow') {
      const id = url.searchParams.get('id');
      const file = slowFiles[id];
      if (!file) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(file.content),
        'Content-Disposition': 'attachment; filename="' + file.name + '"' });
      // Provide enough data for Chromium's MIME sniffing, then keep the transfer pending.
      response.write(file.content.slice(0, 8192));
      slowResponses.set(id, response);
      return;
    }
    if (url.pathname === '/download') {
      const kind = url.searchParams.get('kind');
      if (!filenames[kind]) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="' + filenames[kind] + '"' });
      response.end('INERT DOWNLOAD ' + kind);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><title>Local download review fixture</title><p>Only disposable text files.</p>' +
      Object.keys(filenames).map(kind => '<p><a id="' + kind + '" href="/download?kind=' + kind + '">' + kind + '</a></p>').join('') +
      '<script>const names=' + JSON.stringify(filenames) + ';for(const [kind,name] of Object.entries(names)){const a=document.getElementById(kind);a.href=URL.createObjectURL(new Blob(["INERT DOWNLOAD "+kind],{type:"text/plain"}));a.download=name;}if(location.search.includes("automatic=collision")){setTimeout(()=>document.getElementById("collision").click(),1000);}</script>');
  });
  const report = { profile, saveDir, autoSavingExplicitlyEnabled: autoSaving, mechanism: 'blob and HTTP downloads', cases: [] };
  let app;
  let log;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const targetUrl = 'http://127.0.0.1:' + server.address().port + '/landing?label=https://socialstream.ninja/';
    const env = { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_DEBUG_LOGS: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    const target = electronTestTarget(sourceBase);
    app = await _electron.launch({ executablePath: target.executablePath, cwd: root,
      args: [...target.args, '--multiinstance',
        '--ssapp-local-server-port=' + relayPort, ...(autoSaving ? ['--savefolder=' + saveDir + path.sep + path.sep] : []),
        '--disable-logs', ...linuxLaunchArgs()], env, timeout: 60000 });
    log = fs.createWriteStream(path.join(profile, 'app.log'));
    app.process().stdout.pipe(log, { end: false }); app.process().stderr.pipe(log, { end: false });
    const main = await app.firstWindow();
    await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady && typeof ipcRenderer !== 'undefined');
    report.runtime = await electronTestRuntime(app);
    sourceBase = await electronTestSourceBase(main, sourceBase);
    report.sourceBase = sourceBase;
    const dockUrl = sourceBase + 'dock.html?session=' + room + '&password=false&activelinks&server2&localserver&localserverport=' + relayPort;
    await main.evaluate(url => { window.open(url, '_blank'); }, dockUrl);
    const dock = await until(() => app.context().pages().find(page => page.url() === dockUrl), 'Dock');
    const cdp = await dock.context().newCDPSession(dock);
    await until(async () => (await cdp.send('Runtime.evaluate', {
      expression: 'typeof socketserverExtension !== "undefined" && socketserverExtension.readyState === 1', returnByValue: true,
    })).result.value, 'Dock relay');
    const background = await until(() => main.frames().find(frame => frame.url().includes('/background.html')), 'background');
    await until(() => background.evaluate(() => typeof socketserverDock !== 'undefined' && socketserverDock.readyState === 1), 'background relay');
    await pause(5000);
    await app.evaluate(({ app, BrowserWindow }, targetUrl) => {
      const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const native = req('./tiktok/connection-manager');
      const mainWindow = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/index.html'));
      const env = native.createTikTokEnvironment({ connector: req('tiktok-live-connector'), getMainWindow: () => mainWindow });
      const message = native.__test.composeTikTokChatMessage({ msgId: 'download-audit', uniqueId: 'local_fixture',
        nickname: 'Local fixture', textonly: true, comment: 'Local download fixture ' + targetUrl });
      message.type = 'tiktok';
      env.sendToBackground(message);
    }, targetUrl);
    await dock.locator('a[href="' + targetUrl + '"]').first().click({ timeout: 30000 });
    const page = await until(() => app.context().pages().find(candidate => candidate.url() === targetUrl), 'clicked chat link');
    report.destination = await page.evaluate(() => ({ node: typeof require === 'function', bridge: !!window.ninjafy }));
    report.sessions = await app.evaluate(({ BrowserWindow }, { saveDir, targetUrl }) => {
      const path = process.getBuiltinModule('path');
      const wins = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed());
      const main = wins.find(win => win.webContents.getURL().includes('/index.html'));
      const dest = wins.find(win => win.webContents.getURL() === targetUrl);
      global.__downloadAudit = [];
      global.__downloadAuditItems = [];
      const sessions = new Set(wins.map(win => win.webContents.session));
      for (const session of sessions) session.on('will-download', (event, item, wc) => {
        const entry = { url: item.getURL(), filename: item.getFilename(), savePath: item.getSavePath(), sourceUrl: wc?.getURL() };
        global.__downloadAudit.push(entry);
        global.__downloadAuditItems.push(item);
        const relative = entry.savePath ? path.relative(saveDir, entry.savePath) : null;
        if (relative === null || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(entry.savePath) !== '.txt') {
          entry.safetyCancelled = true;
          entry.reason = relative === null ? 'App did not choose an automatic save path' : 'Outside inert fixture allowlist';
          event.preventDefault();
          return;
        }
        item.on('updated', (_event, state) => { entry.updated = state; entry.receivedBytes = item.getReceivedBytes(); });
        item.once('done', (_event, state) => { entry.state = state; entry.finalPath = item.getSavePath(); });
      });
      return { destinationUsesMainSession: dest.webContents.session === main.webContents.session, sessionCount: sessions.size };
    }, { saveDir, targetUrl });
    for (const phase of ['initial', 'reload']) {
      if (phase === 'reload') await page.reload();
      for (const kind of Object.keys(filenames)) {
        const beforeCount = await app.evaluate(() => global.__downloadAudit.length);
        await page.locator('#' + kind).click();
        const result = await until(() => app.evaluate((_electron, count) => {
          const entry = global.__downloadAudit[count];
          return entry && (entry.safetyCancelled || entry.state) ? entry : null;
        }, beforeCount), 'download ' + kind);
        report.cases.push({ phase, kind, ...result });
        console.log('PASS ' + phase + ' ' + kind + ': ' + (result.savePath ? path.basename(result.savePath) : 'no auto-save'));
        if (autoSaving) assert.equal(result.state, 'completed', 'Isolated auto-save control must complete');
        else assert.equal(result.reason, 'App did not choose an automatic save path');
        assert.equal(fs.readFileSync(existing, 'utf8'), 'ORIGINAL DISPOSABLE CONTENT');
        assert.equal(fs.readFileSync(path.join(saveDir, 'existing-fixture (1).txt'), 'utf8'), 'EXISTING NUMBERED FILE');
        if (autoSaving) assert.equal(fs.readFileSync(result.finalPath, 'utf8'), 'INERT DOWNLOAD ' + kind);
        assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE DISPOSABLE GUARD');
      }
    }
    const automaticUrl = targetUrl + '&automatic=collision';
    await app.evaluate(({ app, BrowserWindow }, automaticUrl) => {
      const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const native = req('./tiktok/connection-manager');
      const mainWindow = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/index.html'));
      const env = native.createTikTokEnvironment({ connector: req('tiktok-live-connector'), getMainWindow: () => mainWindow });
      const message = native.__test.composeTikTokChatMessage({ msgId: 'automatic-download-audit', uniqueId: 'local_fixture',
        nickname: 'Local fixture', textonly: true, comment: 'Local automatic download fixture ' + automaticUrl });
      message.type = 'tiktok'; env.sendToBackground(message);
    }, automaticUrl);
    const beforeAutomatic = await app.evaluate(() => global.__downloadAudit.length);
    fs.writeFileSync(existing, 'ORIGINAL DISPOSABLE CONTENT');
    await dock.locator('a[href="' + automaticUrl + '"]').first().click({ timeout: 30000 });
    const automatic = await until(() => app.evaluate((_electron, count) => {
      const entry = global.__downloadAudit[count];
      return entry && (entry.safetyCancelled || entry.state) ? entry : null;
    }, beforeAutomatic), 'automatic download after chat link');
    report.cases.push({ phase: 'automatic-after-chat-link', kind: 'collision', ...automatic });
    console.log('PASS automatic download after chat link');
    if (autoSaving) {
      assert.equal(automatic.state, 'completed');
      assert.notEqual(automatic.finalPath, existing);
      assert.equal(fs.readFileSync(automatic.finalPath, 'utf8'), 'INERT DOWNLOAD collision');
    } else {
      assert.equal(automatic.reason, 'App did not choose an automatic save path');
      assert.equal(fs.readFileSync(existing, 'utf8'), 'ORIGINAL DISPOSABLE CONTENT');
    }
    assert.equal(fs.readFileSync(existing, 'utf8'), 'ORIGINAL DISPOSABLE CONTENT');
    if (autoSaving) {
      const beforeConcurrent = await app.evaluate(() => global.__downloadAudit.length);
      await page.evaluate(() => {
        for (const id of ['concurrent-one', 'concurrent-two']) {
          const a = document.createElement('a');
          a.href = '/slow?id=' + id;
          a.download = 'concurrent-fixture.txt'; a.click();
        }
      });
      const pending = await until(() => app.evaluate((_electron, offset) => {
        const entries = global.__downloadAudit.slice(offset);
        return entries.length === 2 ? entries : null;
      }, beforeConcurrent), 'two pending downloads');
      assert(pending.every(entry => !entry.state), 'Both downloads must still be pending');
      assert.notEqual(pending[0].savePath, pending[1].savePath, 'Concurrent downloads must reserve different names');
      for (const id of ['concurrent-one', 'concurrent-two']) slowResponses.get(id).end(slowFiles[id].content.slice(8192));
      const completed = await until(() => app.evaluate((_electron, offset) => {
        const entries = global.__downloadAudit.slice(offset);
        return entries.every(entry => entry.state) ? entries : null;
      }, beforeConcurrent), 'concurrent completion');
      assert(completed.every(entry => entry.state === 'completed'));
      assert.deepEqual(completed.map(entry => fs.readFileSync(entry.finalPath, 'utf8')).sort(),
        [slowFiles['concurrent-one'].content, slowFiles['concurrent-two'].content]);
      report.cases.push(...completed.map(entry => ({ phase: 'concurrent', ...entry })));
      console.log('PASS concurrent downloads keep both files');

      // Cancelling a pending download must release its filename reservation.
      const beforeCancel = await app.evaluate(() => global.__downloadAudit.length);
      async function startCancellableDownload(id) {
        await page.evaluate(id => {
          const a = document.createElement('a');
          a.href = '/slow?id=' + id;
          a.download = 'cancel-fixture.txt'; a.click();
        }, id);
      }
      await startCancellableDownload('cancel');
      await until(() => app.evaluate((_electron, offset) => global.__downloadAudit[offset], beforeCancel), 'pending cancellation');
      await app.evaluate((_electron, offset) => global.__downloadAuditItems[offset].cancel(), beforeCancel);
      const cancelled = await until(() => app.evaluate((_electron, offset) => {
        const entry = global.__downloadAudit[offset]; return entry.state === 'cancelled' ? entry : null;
      }, beforeCancel), 'cancellation');
      assert(!fs.existsSync(cancelled.savePath), 'Cancelled fixture must leave its target unused');
      await startCancellableDownload('cancel-retry');
      const retry = await until(() => app.evaluate((_electron, offset) => global.__downloadAudit[offset], beforeCancel + 1), 'cancellation retry');
      assert.equal(retry.savePath, cancelled.savePath, 'Cancelled download must release its reservation');
      slowResponses.get('cancel-retry').end(slowFiles['cancel-retry'].content.slice(8192));
      const retried = await until(() => app.evaluate((_electron, offset) => {
        const entry = global.__downloadAudit[offset]; return entry.state ? entry : null;
      }, beforeCancel + 1), 'retry completion');
      assert.equal(retried.state, 'completed');
      assert.equal(fs.readFileSync(retried.finalPath, 'utf8'), slowFiles['cancel-retry'].content);
      report.cases.push({ phase: 'cancel', ...cancelled }, { phase: 'cancel-retry', ...retried });
      console.log('PASS cancellation releases the filename for retry');

      // A webpage may move its download into a blank or blob child window.
      for (const kind of ['blank', 'blob']) {
        const beforeChild = await app.evaluate(() => global.__downloadAudit.length);
        await page.evaluate(kind => {
          const html = '<!doctype html><title>External child fixture</title><script>' +
            'const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["EXTERNAL CHILD"],{type:"text/plain"}));' +
            'a.download="existing-fixture.txt";setTimeout(()=>a.click(),500);</script>';
          if (kind === 'blob') window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank');
          else { const child = window.open('about:blank', '_blank'); child.document.write(html); child.document.close(); }
        }, kind);
        const child = await until(() => app.evaluate((_electron, offset) => {
          const entry = global.__downloadAudit[offset]; return entry?.state ? entry : null;
        }, beforeChild), kind + ' child download');
        assert.equal(child.state, 'completed');
        assert.equal(fs.readFileSync(child.finalPath, 'utf8'), 'EXTERNAL CHILD');
        assert.equal(fs.readFileSync(existing, 'utf8'), 'ORIGINAL DISPOSABLE CONTENT');
        report.cases.push({ phase: kind + '-child', ...child });
        console.log('PASS ' + kind + ' child preserves existing file');
      }

      // The main page's deliberate same-name export/recording writes stay unchanged.
      for (const content of ['MAIN EXPORT ONE', 'MAIN EXPORT TWO']) {
        const beforeMain = await app.evaluate(() => global.__downloadAudit.length);
        await main.evaluate(content => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
          a.download = 'existing-fixture.txt'; a.click();
        }, content);
        const own = await until(() => app.evaluate((_electron, offset) => {
          const entry = global.__downloadAudit[offset]; return entry?.state ? entry : null;
        }, beforeMain), 'main-page download');
        assert.equal(own.state, 'completed');
        assert.equal(own.finalPath, existing);
        assert.equal(fs.readFileSync(existing, 'utf8'), content);
        report.cases.push({ phase: 'main-page-control', ...own });
      }
      console.log('PASS main-page same-name writes unchanged');
    }
    report.existingContent = fs.readFileSync(existing, 'utf8');
    report.savedFiles = fs.readdirSync(saveDir);
    report.outsideGuardUnchanged = fs.readFileSync(outside, 'utf8') === 'OUTSIDE DISPOSABLE GUARD';
  } catch (error) {
    report.error = error.stack; console.error(error.stack); process.exitCode = 1;
  } finally {
    if (app) report.observedDownloads = await app.evaluate(() => global.__downloadAudit || []).catch(() => []);
    fs.writeFileSync(path.join(profile, 'result.json'), JSON.stringify(report, null, 2));
    console.log('Evidence: ' + path.join(profile, 'result.json'));
    if (app) await app.close().catch(() => {});
    if (log) log.end();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
