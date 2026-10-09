'use strict';

// Requires the published 0.3.113 and 0.4.21 archives/runtimes from the API
// diagnostic, or SSAPP_LEGACY_UPGRADE_ARTIFACTS with the same directory layout.
// Real Electron windows and storage; the external relay is replaced with an
// isolated loopback fixture and HTTPS assets use the sibling source checkout.
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { _electron } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const site = path.resolve(root, '../social_stream');
const artifacts = process.env.SSAPP_LEGACY_UPGRADE_ARTIFACTS || path.join(root, '.codex-tmp/api-repro');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-session-migration-e2e-'));
const sessionId = 'legacy-private';
const scope = `session-${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`;
const room = `qa${crypto.randomBytes(12).toString('hex')}`;
const originalSettings = {
    socketserver: { setting: true },
    server2: { setting: true },
    server3: { setting: true },
    ollamaoverlayonly: { setting: true },
    ollamaTTS: { setting: true },
    textonlymode: { setting: true },
    capturejoinedevent: { setting: true },
    qaMigrationMarker: { textsetting: 'original-settings' }
};
const report = { output, rows: [] };
let relay, relayPort;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = dir => path.join(dir, 'appData/SocialStream');
const configPath = dir => path.join(profile(dir), 'config.json');
const scopedPath = dir => path.join(profile(dir), `savedSync.${scope}.json`);
const readConfig = dir => JSON.parse(fs.readFileSync(configPath(dir), 'utf8'));
function editConfig(dir, edit) {
    const config = readConfig(dir);
    edit(config);
    fs.writeFileSync(configPath(dir), JSON.stringify(config));
}
function clone(from, name) {
    const dir = path.join(output, name);
    fs.cpSync(from, dir, { recursive: true });
    return dir;
}
function replaceScopedState(dir, state) {
    for (const suffix of ['', '.bak']) fs.writeFileSync(scopedPath(dir) + suffix, JSON.stringify(state));
    editConfig(dir, config => {
        config.userSessionData[scope] = { cachedStateBackup: state, cachedStateBackupTime: Date.now() };
    });
}
function migrationOutcome(dir) {
    return readConfig(dir).userSessionData?.[scope]?.legacySettingsMigration?.outcome;
}
async function launch(dir, version = 'current', failBackup = false) {
    const appPath = version === 'current' ? root : path.join(artifacts, `v${version}/app/resources/app.asar`);
    const wrapper = path.join(dir, `launch-${version}.cjs`);
    fs.writeFileSync(wrapper, `
const {app,net,dialog}=require('electron'),fs=require('fs'),path=require('path');
app.setAppPath(${JSON.stringify(appPath)});
const pkg=require(${JSON.stringify(path.join(appPath, 'package.json'))});
app.setName(pkg.name);app.setVersion(pkg.version);
app.setPath('appData',${JSON.stringify(path.join(dir, 'appData'))});
app.setPath('userData',${JSON.stringify(profile(dir))});
app.setPath('sessionData',${JSON.stringify(profile(dir))});
global.qaDialogs=[];
for(const name of ['showMessageBox','showMessageBoxSync','showErrorBox']) {
 const original=dialog[name].bind(dialog);
 dialog[name]=(...args)=>{global.qaDialogs.push(name);return original(...args);};
}
if(${JSON.stringify(failBackup)}) {
 const write=fs.writeFileSync;
 let failed=false;
 fs.writeFileSync=function(file,...args){
  if(!failed && ((${JSON.stringify(failBackup)}==='persist' && String(file)===${JSON.stringify(scopedPath(dir) + '.tmp')})
    || (${JSON.stringify(failBackup)}===true && String(file).endsWith('.before-legacy-recovery')))) {
   failed=true;throw new Error('QA simulated migration write failure');
  }
  return write.call(this,file,...args);
 };
}
app.on('session-created',s=>{
 const site=${JSON.stringify(site)};
 const hosts=['socialstream.ninja','beta.socialstream.ninja','cache.socialstream.ninja','raw.githubusercontent.com'];
 s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(d,cb)=>{
  const u=new URL(d.url);
  cb({cancel:!['127.0.0.1',...hosts].includes(u.hostname)});
 });
 s.protocol.handle('https',async request=>{
  const u=new URL(request.url);
  if(!hosts.includes(u.hostname))return new Response('',{status:503});
  const relative=decodeURIComponent(u.pathname).replace(/^\\/steveseguin\\/social_stream\\/(main|beta)\\//,'/').replace(/^\\/(beta\\/)?/,'');
  const file=path.resolve(site,relative||'index.html');
  if(!file.startsWith(site+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return new Response('',{status:404});
  const mime={'.html':'text/html','.js':'application/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml'};
  let body=fs.readFileSync(file);
  // Substitute only the fixture's upstream endpoint. The actual background
  // connection, API ingestion, settings, partitions and migration stay intact.
  if(relative==='background.js')body=body.toString().replaceAll('wss://io.socialstream.ninja/api','ws://127.0.0.1:${relayPort}/api').replaceAll('wss://io.socialstream.ninja/dock','ws://127.0.0.1:${relayPort}/dock');
  return new Response(body,{headers:{'content-type':mime[path.extname(file)]||'application/octet-stream'}});
 });
});
require(${JSON.stringify(appPath)});
`);
    const env = { ...process.env, SSAPP_DIAGNOSTICS_SAFE_GPU: '1', SSAPP_PREFER_LOCAL_ASSETS: '0', SSAPP_DEBUG_LOGS: '1' };
    for (const key of ['SSAPP_USER_DATA_DIR', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE', 'SSAPP_PORTABLE_MIGRATION_CHOICE', 'SSAPP_PORTABLE_LEGACY_USER_DATA_DIR']) delete env[key];
    const app = await _electron.launch({
        executablePath: version === 'current' ? require('electron') : path.join(artifacts, `v${version}/runtime/socialstream.exe`),
        cwd: root, args: [wrapper, '--multiinstance', '--no-hwa', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'], env, timeout: 60000
    });
    try {
        assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile(dir));
        const main = await app.firstWindow();
        let background;
        for (let n = 0; n < 240; n++) {
            background = main.frames().find(frame => frame.url().includes('/background.html'));
            try { if (background && await background.evaluate(() => typeof applyBotActions === 'function')) break; } catch (_) {}
            await delay(250);
        }
        assert(background?.url().startsWith('https:'), 'App uses its normal HTTPS background origin');
        await delay(1500);
        return { app, main, background, dir, version };
    } catch (error) {
        await app.close();
        throw error;
    }
}
async function snapshot(run) {
    return run.background.evaluate(() => ({ room: streamID, on: isExtensionOn, settings, socket: socketserver?.readyState ?? null }));
}
async function receive(run) {
    await run.background.waitForFunction(() => socketserver?.readyState === 1, null, { timeout: 15000 });
    const message = `Migration fixture ${crypto.randomBytes(6).toString('hex')}`;
    await run.background.evaluate(() => {
        window.qaReceived = [];
        if (window.qaOriginalApplyBotActions) return;
        window.qaOriginalApplyBotActions = applyBotActions;
        applyBotActions = async function(data, ...args) { qaReceived.push(data.chatmessage); return qaOriginalApplyBotActions(data, ...args); };
    });
    const receivers = [...relay.clients].filter(client => client.readyState === WebSocket.OPEN && client.join?.join === room && client.join.in === 1);
    assert(receivers.length > 0, 'Background joined its API channel on the isolated relay');
    for (const client of receivers) client.send(JSON.stringify({ action: 'extContent', apiid: room,
        value: JSON.stringify({ chatname: 'QA', chatmessage: message, type: 'generic' }) }));
    await run.background.waitForFunction(message => qaReceived.includes(message), message, { timeout: 10000 });
}
async function preserveProfile(run) {
    assert.equal(await run.main.evaluate(() => localStorage.getItem('qaProfileSentinel')), 'keep-me');
    assert.equal(await run.main.evaluate(() => stateManager.state.global.qaMigrationFixture), 'keep-me');
    const cookies = await run.app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({ name: 'migration_fixture' }));
    assert.equal(cookies[0]?.value, 'keep-me');
}
async function check(name, dir, operation, version = 'current', failBackup = false) {
    const run = await launch(dir, version, failBackup);
    const row = { name, version };
    report.rows.push(row);
    try {
        await operation(run);
        await delay(1000);
        assert.deepEqual(await run.app.evaluate(() => global.qaDialogs), [], 'No migration dialogs');
        row.state = await snapshot(run);
        row.passed = true;
        console.log('PASS ' + name);
    } finally {
        await run.app.close();
        row.migrationOutcome = migrationOutcome(dir);
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    }
}
function expectSettings(actual) {
    for (const [key, value] of Object.entries(originalSettings)) assert.deepEqual(actual[key], value, key);
}

(async () => {
    relay = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve, reject) => { relay.once('listening', resolve); relay.once('error', reject); });
    relayPort = relay.address().port;
    relay.on('connection', client => client.on('message', data => {
        const packet = JSON.parse(data.toString());
        if (packet.join) client.join = packet;
    }));
    console.log('Evidence: ' + output);
    const old = path.join(output, 'old');
    fs.mkdirSync(profile(old), { recursive: true });
    fs.writeFileSync(configPath(old), JSON.stringify({ currentSession: sessionId, sessions: { default: { name: 'Default' }, [sessionId]: { name: 'Legacy private' } } }));
    fs.writeFileSync(path.join(profile(old), 'savedSync.json'), JSON.stringify({ streamID: room, password: 'false', state: true, settings: originalSettings, wsServer: false }));
    await check('published old app receives API', old, async run => {
        await receive(run);
        await run.main.evaluate(() => {
            localStorage.setItem('qaProfileSentinel', 'keep-me');
            stateManager.state.global.qaMigrationFixture = 'keep-me';
            stateManager.persist();
        });
        await run.app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.cookies.set({ url: 'https://example.invalid', name: 'migration_fixture', value: 'keep-me', expirationDate: Date.now() / 1000 + 86400 }));
    }, '0.3.113');

    const direct = clone(old, 'direct');
    const originalBytes = fs.readFileSync(path.join(profile(direct), 'savedSync.json'), 'utf8');
    await check('direct upgrade migrates and preserves profile', direct, async run => {
        expectSettings((await snapshot(run)).settings);
        await receive(run);
        await preserveProfile(run);
        assert.equal(migrationOutcome(direct), 'recovered');
        await run.main.evaluate(() => stateManager.addSource({ id: 'migration-fixture', target: 'custom', username: 'inactive-fixture', url: 'https://example.invalid/', autoActivate: false }));
    });
    assert.equal(fs.readFileSync(path.join(profile(direct), 'savedSync.json'), 'utf8'), originalBytes, 'Legacy file unchanged');
    const recoveryBackup = fs.readFileSync(scopedPath(direct) + '.before-legacy-recovery', 'utf8');
    await check('restart and user disabling API are respected', direct, async run => {
        expectSettings((await snapshot(run)).settings);
        await receive(run);
        assert.equal(await run.main.evaluate(() => stateManager.getSource('migration-fixture')?.username), 'inactive-fixture');
        const popup = run.main.frames().find(frame => frame.url().includes('/popup.html'));
        assert(popup, 'Actual settings page loaded');
        await popup.evaluate(() => document.querySelector('[data-setting="socketserver"]').click());
        await run.background.waitForFunction(() => !settings.socketserver, null, { timeout: 10000 });
    });
    await check('later restart does not resurrect disabled setting', direct, async run => {
        assert.equal((await snapshot(run)).settings.socketserver, undefined);
        await preserveProfile(run);
        assert.equal(fs.readFileSync(scopedPath(direct) + '.before-legacy-recovery', 'utf8'), recoveryBackup);
    });

    const broken = clone(old, 'broken');
    await check('published upgrade reproduces settings loss', broken, async run => {
        assert.equal((await snapshot(run)).settings.socketserver, undefined);
        await preserveProfile(run);
    }, '0.4.21');
    const recovered = clone(broken, 'recovered');
    const brokenBytes = fs.readFileSync(scopedPath(recovered), 'utf8');
    await check('existing broken upgrade recovers without reset', recovered, async run => {
        expectSettings((await snapshot(run)).settings);
        await receive(run);
        await preserveProfile(run);
        const backup = JSON.parse(fs.readFileSync(scopedPath(recovered) + '.before-legacy-recovery', 'utf8'));
        assert.equal(backup.files[path.basename(scopedPath(recovered))], brokenBytes);
    });
    await check('recovered settings survive restart', recovered, async run => { expectSettings((await snapshot(run)).settings); await receive(run); });

    for (const mismatch of ['streamID', 'password']) {
        const dir = clone(broken, 'mismatched-' + mismatch);
        const file = path.join(profile(dir), 'savedSync.json');
        const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
        legacy[mismatch] = 'different-fixture-value';
        fs.writeFileSync(file, JSON.stringify(legacy));
        await check('reject mismatched ' + mismatch, dir, async run => {
            assert.equal((await snapshot(run)).settings.socketserver, undefined);
            assert.equal(migrationOutcome(dir), 'no-matching-legacy-settings');
            assert(!fs.existsSync(scopedPath(dir) + '.before-legacy-recovery'));
        });
    }
    for (const [name, settings, outcome] of [
        ['newer preferences', { socketserver: false, qaNewPreference: { textsetting: 'keep-new' } }, 'existing-settings'],
        ['intentionally cleared settings', {}, 'no-upgrade-placeholder']
    ]) {
        const dir = clone(broken, name.replaceAll(' ', '-'));
        replaceScopedState(dir, { streamID: room, password: 'false', state: false, settings });
        await check('preserve ' + name, dir, async run => {
            assert.equal(migrationOutcome(dir), outcome);
            assert(!fs.existsSync(scopedPath(dir) + '.before-legacy-recovery'));
            assert.equal((await snapshot(run)).on, false);
            assert.equal((await snapshot(run)).settings.ollamaoverlayonly, undefined);
        });
    }
    const failed = clone(broken, 'backup-write-failure');
    await check('backup failure leaves app usable and original safe', failed, async run => {
        assert.equal((await snapshot(run)).settings.socketserver, undefined);
        assert.equal(migrationOutcome(failed), undefined);
        await preserveProfile(run);
    }, 'current', true);
    await check('backup failure can recover on next launch', failed, async run => { expectSettings((await snapshot(run)).settings); await receive(run); });

    const interrupted = clone(broken, 'interrupted');
    await check('interrupted persistence keeps recovery backup', interrupted, async run => {
        assert.equal((await snapshot(run)).settings.socketserver, undefined);
        assert.equal(migrationOutcome(interrupted), undefined);
        assert(fs.existsSync(scopedPath(interrupted) + '.before-legacy-recovery'));
    }, 'current', 'persist');
    const interruptedBackup = fs.readFileSync(scopedPath(interrupted) + '.before-legacy-recovery', 'utf8');
    await check('interrupted migration resumes with original backup', interrupted, async run => {
        expectSettings((await snapshot(run)).settings);
        await receive(run);
        assert.equal(fs.readFileSync(scopedPath(interrupted) + '.before-legacy-recovery', 'utf8'), interruptedBackup);
    });

    const defaults = clone(old, 'default-and-new');
    editConfig(defaults, config => { config.currentSession = 'default'; });
    await check('default unchanged and new session marked ineligible', defaults, async run => {
        expectSettings((await snapshot(run)).settings);
        await receive(run);
        const created = await run.main.evaluate(() => require('electron').ipcRenderer.invoke('createSession', { id: 'brand-new', name: 'Brand new' }));
        assert.equal(created.success, true);
        const newScope = `session-${crypto.createHash('sha256').update('brand-new').digest('hex').slice(0, 24)}`;
        assert.equal(readConfig(defaults).userSessionData[newScope].legacySettingsMigration.outcome, 'new-session');
        assert.equal(readConfig(defaults).legacySettingsMigration, undefined);
    });
    editConfig(defaults, config => { config.currentSession = 'brand-new'; });
    await check('new session does not inherit legacy preferences', defaults, async run => {
        const state = await snapshot(run);
        assert.notEqual(state.room, room);
        assert.equal(state.settings.socketserver, undefined);
        assert.equal(state.settings.qaMigrationMarker, undefined);
    });
    const deleted = clone(recovered, 'deleted');
    editConfig(deleted, config => { config.currentSession = 'default'; });
    await check('deleting a session removes recovery backup', deleted, async run => {
        assert.equal(await run.main.evaluate(id => require('electron').ipcRenderer.invoke('deleteSession', id).then(result => result.success), sessionId), true);
        assert(!fs.existsSync(scopedPath(deleted) + '.before-legacy-recovery'));
        assert(!fs.existsSync(scopedPath(deleted)));
    });
    console.log('PASS legacy User Session upgrade/recovery and safety checks: ' + output);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    if (relay) { for (const client of relay.clients) client.terminate(); relay.close(); }
});
