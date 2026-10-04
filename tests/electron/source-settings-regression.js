'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const { captureSettingsPayload, filterSourceSettingsMessage, isTrustedSettingsPage } = require('../../resources/source-settings-response');

const root = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const snapshot = {
    state: false, streamID: 'synthetic-session', password: 'synthetic-password',
    settings: {
        textonlymode: true, bttv: { setting: true }, showviewercount: true,
        captureliketotals: true, customtiktokstate: { setting: false },
        translation: { miscellaneous: { joined: 'Joined' } },
        rumble_api_url: { textsetting: 'https://example.test/synthetic-rumble-api' },
        rumble_stream_id: { textsetting: 'synthetic-stream' },
        openaikey: { textsetting: 'synthetic-key' },
        webhook: { textsetting: 'https://example.test/synthetic-webhook' },
        unknownFuturePrivateSetting: 'synthetic-private-value'
    }
};
const before = JSON.stringify(snapshot);
const sourceUrl = 'https://capture.example.test/live';
const filtered = captureSettingsPayload(snapshot, sourceUrl);
assert.strictEqual(filtered.state, false);
for (const key of ['textonlymode', 'bttv', 'showviewercount', 'captureliketotals', 'customtiktokstate', 'translation']) {
    assert.deepStrictEqual(filtered.settings[key], snapshot.settings[key]);
}
for (const key of ['rumble_api_url', 'rumble_stream_id', 'openaikey', 'webhook', 'unknownFuturePrivateSetting']) {
    assert.strictEqual(Object.hasOwn(filtered.settings, key), false, key);
}
assert.strictEqual(Object.hasOwn(filtered, 'streamID'), false);
assert.strictEqual(Object.hasOwn(filtered, 'password'), false);
assert.strictEqual(JSON.stringify(snapshot), before, 'filtering must not mutate persisted settings');
assert.deepStrictEqual(captureSettingsPayload(snapshot, 'https://rumble.com/live').settings.rumble_api_url, snapshot.settings.rumble_api_url);
assert.strictEqual(captureSettingsPayload(snapshot, 'https://rumble.com.example.test/live').settings.rumble_api_url, undefined);

const shared = { ...snapshot, settings: { ...snapshot.settings, sharestreamid: true } };
assert.strictEqual(captureSettingsPayload(shared, 'https://maestro-launcher.vercel.app/').streamID, snapshot.streamID);
assert.strictEqual(captureSettingsPayload(shared, sourceUrl).streamID, undefined);
assert.strictEqual(captureSettingsPayload(snapshot, 'https://maestro-launcher.vercel.app/').streamID, undefined);
assert.strictEqual(captureSettingsPayload(shared, 'https://maestro-launcher.vercel.app/').password, undefined);

for (const url of ['https://socialstream.ninja/dock.html', 'https://beta.socialstream.ninja/popup.html', pathToFileURL(path.join(root, 'index.html')).href]) {
    assert.strictEqual(isTrustedSettingsPage(url, [root]), true, url);
}
for (const url of [sourceUrl, 'https://socialstream.ninja.example.test/dock.html', 'http://socialstream.ninja/dock.html', 'https://socialstream.ninja:444/dock.html', 'https://user@socialstream.ninja/dock.html', pathToFileURL(path.join(root + '-other', 'index.html')).href, '']) {
    assert.strictEqual(isTrustedSettingsPage(url, [root]), false, url);
}
const message = { text: 'Synthetic outbound chat', ...snapshot };
const updated = filterSourceSettingsMessage(message, sourceUrl);
assert.strictEqual(updated.text, message.text);
assert.strictEqual(updated.password, undefined);
assert.deepStrictEqual(updated.settings, filtered.settings);
assert.strictEqual(filterSourceSettingsMessage(message, sourceUrl, true), message);
assert.strictEqual(filterSourceSettingsMessage('focusChat', sourceUrl), 'focusChat');

// Load the actual bridge and handler bodies; Electron, disk I/O and networking
// are replaced with in-memory fixtures. These are supporting sanity checks.
const helpers = require('../../resources/source-settings-response');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const mockPreload = fs.readFileSync(path.join(root, 'preload-mock.js'), 'utf8');
function section(source, first, last, after = 0) {
    const from = source.indexOf(first, after);
    const to = source.indexOf(last, from);
    assert(from >= 0 && to > from, first);
    return source.slice(from, to);
}
const handlers = {}, forwarded = [], timers = [];
const trustedUrl = 'https://socialstream.ninja/popup.html';
let frameUrl = sourceUrl;
const event = () => ({
    senderFrame: frameUrl === null ? null : { url: frameUrl },
    sender: { getURL: () => trustedUrl }
});
const appFrames = ['https://socialstream.ninja/background.html', trustedUrl,
    'https://capture.example.test/background.html', 'https://capture.example.test/popup.html']
    .map(url => ({ url, postMessage: (channel, payload) => forwarded.push({ url, channel, payload }) }));
const context = {
    ...helpers, __dirname: root, Argv: {}, cachedState: JSON.parse(before), cachedStateReady: true,
    normalizeStreamIdValue: value => value, normalizePasswordValue: value => value,
    ipcMain: { on: (channel, callback) => { handlers[channel] = callback; },
        handle: (channel, callback) => { handlers[channel] = callback; } },
    shouldRecoverCachedStateFromBackups: () => false, getActiveBrowserView: () => null,
    queueCachedStateRecovery() {}, recoverCachedStateIfNeeded: async () => {},
    matchesSocialStreamPagePath: (url, page) => url.endsWith('/' + page + '.html'),
    isSocialStreamRemoteUrl: () => false,
    mainWindow: { isDestroyed: () => false, webContents: { mainFrame: { frames: appFrames }, send() {} } },
    attachSourceAccountMetaToPayload: value => value, sourceObservationService: null,
    SETTINGS_VALIDATION: { MIN_EXISTING_KEYS: 10, PARTIAL_THRESHOLD_RATIO: 0.5 },
    areSettingsSnapshotsEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    areStorageValuesEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    storageSavePending: false, storageSavePendingAllowSettingsDowngrade: false, storageSaveDebounceTimer: null,
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    persistCachedStateSafely() {}, buildLocalStorageMirrorPayload: value => value,
    updateLocalStorageBackup() {}, mirrorCachedStateToLocalStorage() {},
    hasPersistedFieldPayload: () => true, applyPersistedStateFieldsFromResponse: () => false,
    wsServer: {}, global: {}, log() {}, console
};
vm.createContext(context);
for (const [first, last] of [
    ['function isTrustedSettingsFrame(', 'function normalizeCachedStateSnapshot('],
    ['ipcMain.on("fromBackground", function', '    ipcMain.on("storageSave", function'],
    ['ipcMain.on("storageSave", function', '    ipcMain.on("PPTHotkey", function'],
    ['ipcMain.on("postMessage", function', '    ipcMain.on("getAppVersion"']
]) vm.runInContext(section(main, first, last), context);
const ipcRenderer = {
    sendSync(channel, ...args) { const e = event(); handlers[channel](e, ...args); return e.returnValue; },
    send(channel, ...args) { handlers[channel](event(), ...args); },
    invoke: (channel, ...args) => handlers[channel](event(), ...args)
};
const exposed = {};
const bridgeContext = { ipcRenderer, window: {}, MESSAGE_AUTH_TOKEN: 'synthetic-auth',
    contextBridge: { exposeInMainWorld: (name, bridge) => { exposed[name] = bridge; } } };
vm.createContext(bridgeContext);
vm.runInContext(section(preload, 'function extractBackgroundCommandRequest(', 'let sttStatusSubscriptionCounter'), bridgeContext);
const fullBridge = vm.runInContext('({' + section(preload,
    'sendMessage: function(ignore=null', '// Expose auth token getter') + '})', bridgeContext);
vm.runInContext(section(mockPreload, "contextBridge.exposeInMainWorld('__ipc', {", '  // Expose OAuth methods'), bridgeContext);
const isolatedMock = exposed.__ipc.ipcRenderer;
vm.runInContext(section(mockPreload, 'window.__ipc = {', '  // Expose OAuth methods'), bridgeContext);
const nonisolatedMock = bridgeContext.window.__ipc.ipcRenderer;
function assertProjected(result) {
    assert.strictEqual(result.password, undefined);
    assert.strictEqual(result.streamID, undefined);
    assert.strictEqual(result.settings.openaikey, undefined);
    assert.strictEqual(result.settings.textonlymode, true);
}

async function checkBridges() {
    // A trusted top-level URL must not grant access to an external child frame.
    for (frameUrl of [sourceUrl, '', null]) {
        assertProjected(isolatedMock.sendSync('storageSave', {}));
        for (const channel of ['storageSave', 'fromBackground', 'fromPopup']) {
            assertProjected(nonisolatedMock.sendSync(channel, { cmd: 'getSettings' }));
        }
        const keys = ['settings', 'password', 'streamID', 'state', '__proto__'];
        assertProjected(nonisolatedMock.sendSync('storageGet', keys));
        assertProjected(await nonisolatedMock.invoke('storageGetAsync', keys));
        for (const request of [{ getSettings: true }, {}]) {
            fullBridge.sendMessage(null, request, assertProjected, 12345);
        }
    }
    frameUrl = sourceUrl;
    const persisted = JSON.stringify(context.cachedState);
    const writes = { settings: { sharestreamid: true }, streamID: 'synthetic-new-session', state: true };
    for (const channel of ['storageSave', 'fromBackground', 'fromBackgroundResponse',
        'fromBackgroundPopupResponse', 'fromPopupResponse']) {
        nonisolatedMock.sendSync(channel, writes);
    }
    nonisolatedMock.sendSync('fromPopup', { cmd: 'setOnOffState', data: { value: true } });
    assert.strictEqual(JSON.stringify(context.cachedState), persisted, 'capture frames cannot persist state');
    assert.strictEqual(forwarded.filter(item => item.channel === 'fromPopup').length, 0);
    for (const cmd of ['saveSetting', 'setOnOffState', 'sidUpdated', 'bigwipe', 'import', 'spotifySignOut', 'unknownControllerCommand']) {
        const request = { cmd, setting: 'sharestreamid', value: true };
        const count = forwarded.length;
        fullBridge.sendMessage(null, request, result => assert.strictEqual(result.ok, false));
        // Without a callback the real preload routes this wrapper via postMessage.
        fullBridge.sendMessage(null, { type: 'toBackground', data: request }, false);
        assert.strictEqual(forwarded.length, count, 'settings commands cannot be forwarded from capture frames');
    }
    for (const cmd of ['getOnOffState', 'claimInstagramInboxPoller', 'filterInstagramInboxStories',
        'ebaySellerStats', 'resolveRumblePopupUrl', 'joystickFetchJson', 'vpzoneFetchJson',
        'rumbleFetchHtml', 'rumbleFetchJson', 'rumbleFetchSseBatch']) {
        const count = forwarded.length;
        fullBridge.sendMessage(null, { cmd }, false);
        assert.strictEqual(forwarded.length, count + 1, cmd);
    }
    for (frameUrl of [trustedUrl, pathToFileURL(path.join(root, 'index.html')).href]) {
        assert.strictEqual(nonisolatedMock.sendSync('storageSave', {}).password, snapshot.password);
        assert.strictEqual(nonisolatedMock.sendSync('storageGet', ['password']).password, snapshot.password);
        assert.strictEqual((await nonisolatedMock.invoke('storageGetAsync', ['password'])).password, snapshot.password);
        fullBridge.sendMessage(null, { getSettings: true }, result => assert.strictEqual(result.password, snapshot.password));
    }
    frameUrl = trustedUrl;
    nonisolatedMock.sendSync('storageSave', { state: true, appOnlyField: 'synthetic-app-state' });
    assert.strictEqual(context.cachedState.state, true, 'trusted saves still update state');
    assert.strictEqual(nonisolatedMock.sendSync('storageGet', ['appOnlyField']).appOnlyField, 'synthetic-app-state');
    timers.splice(0).forEach(callback => callback());
    context.storageSavePending = true;
    context.flushPendingStorageSave();
    nonisolatedMock.sendSync('fromBackground', {});
    nonisolatedMock.sendSync('fromBackgroundPopupResponse', { ...snapshot, callbackId: 'synthetic-callback' });
    nonisolatedMock.sendSync('fromPopup', { cmd: 'getSettings' });
    nonisolatedMock.sendSync('fromPopupResponse', { ...snapshot });
    fullBridge.sendMessage(null, { cmd: 'saveSetting', setting: 'textonlymode', value: true }, false);
    assert(forwarded.some(item => item.url === trustedUrl && item.payload.password === snapshot.password));
    assert(forwarded.some(item => item.channel === 'fromPopup'));
    assert(forwarded.every(item => item.url.startsWith('https://socialstream.ninja/')),
        'a navigated popup/background must not receive trusted settings or commands');
}

function checkInjectedFrames() {
    // Exercise each actual code builder and the real all_frames injector.
    for (const marker of ['if (loadedSourceTexts.length)', 'runWithWebContents("Remote script injection"']) {
        for (const parentUrl of ['https://rumble.com/live', 'https://maestro-launcher.vercel.app/']) {
            const setup = { ...helpers, cachedState: shared, wc: { getURL: () => parentUrl },
                view: { tabID: 1 }, args: {}, INJECTED_SCRIPT_FLAG: 'synthetic-flag',
                text: 'chrome.runtime.sendMessage(1,{getSettings:true},function(r){window.captured=r;});' };
            vm.createContext(setup);
            vm.runInContext(section(main, 'var code =', 'setAllFrameInjectionCode(wc, code);', main.indexOf(marker)), setup);
            function inspect(code, url) {
                const target = { console: { log() {} }, chrome: {}, location: { href: url },
                    window: { ninjafy: { getInjectedScriptFlag: () => 'synthetic-flag' } } };
                target.window.top = target.window;
                vm.runInNewContext(code, target);
                return target.window.captured;
            }
            const own = inspect(setup.code(parentUrl), parentUrl);
            if (parentUrl.includes('rumble.com')) assert(own.settings.rumble_api_url);
            else assert.strictEqual(own.streamID, snapshot.streamID);
            let childCode, childResponse;
            const childUrl = 'https://chatroll.com/embed/chat/synthetic';
            const frame = { parent: {}, url: childUrl, processId: 1, routingId: 2,
                isDestroyed: () => false, executeJavaScript: code => {
                    childCode = code; childResponse = inspect(code, childUrl); return Promise.resolve();
                } };
            const injection = { URL, allFramesEnabled: true, frameInjectionCode: setup.code,
                injectedFrameKeys: new Set(), log() {},
                manifestInjectionRules: [{ allFrames: true, regexes: [/^https:\/\/chatroll\.com\/embed\/chat\//] }] };
            vm.createContext(injection);
            vm.runInContext(section(main, 'function getManifestUrlCandidates(', 'function bindAllFrameInjectionHandlers('), injection);
            injection.injectSourceIntoFrame(frame, 'synthetic regression');
            assertProjected(childResponse);
            for (const secret of ['synthetic-session', 'synthetic-password', 'synthetic-key', 'synthetic-rumble-api']) {
                assert(!childCode.includes(secret), 'excluded values must not occur in child script bytes');
            }
        }
    }
}

checkBridges().then(() => {
    checkInjectedFrames();
    assert(main.includes('message: filterCaptureSettingsMessage(view, args.message)'));
    assert(main.includes('view.webContents.send("sendToTab", filterCaptureSettingsMessage(view, message))'));
    console.log('Source settings bridge, storage and per-frame injection sanity checks passed (synthetic data only).');
}).catch(error => { console.error(error); process.exitCode = 1; });
