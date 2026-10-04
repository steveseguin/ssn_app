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

// Exercise the actual IPC handler rather than a copy of the response logic.
let handler;
const context = {
    __dirname: root, Argv: {}, cachedState: snapshot, cachedStateReady: true,
    captureSettingsPayload, filterSourceSettingsMessage, isTrustedSettingsPage,
    normalizeStreamIdValue: value => value, normalizePasswordValue: value => value,
    ipcMain: { on: (_channel, callback) => { handler = callback; } },
    shouldRecoverCachedStateFromBackups: () => false, getActiveBrowserView: () => null,
    matchesSocialStreamPagePath: () => false, isSocialStreamRemoteUrl: () => false,
    mainWindow: null, log() {}, console
};
vm.createContext(context);
const helpersStart = main.indexOf('function getSettingsResponseForSender(');
const helpersEnd = main.indexOf('function normalizeCachedStateSnapshot(', helpersStart);
assert(helpersStart >= 0 && helpersEnd > helpersStart);
vm.runInContext(main.slice(helpersStart, helpersEnd), context);
const start = main.indexOf('ipcMain.on("postMessage", function');
const end = main.indexOf('    ipcMain.on("getAppVersion"', start);
assert(start >= 0 && end > start);
vm.runInContext(main.slice(start, end), context);
function response(frameUrl, request) {
    const event = { senderFrame: { url: frameUrl }, sender: { getURL: () => 'https://socialstream.ninja/index.html' } };
    handler(event, request);
    return event.returnValue;
}
for (const request of [{ getSettings: true }, {}]) {
    const result = response(sourceUrl, request);
    assert.strictEqual(result.password, undefined, 'use the source frame, not the top-level URL');
    assert.strictEqual(result.streamID, undefined);
    assert.strictEqual(result.settings.openaikey, undefined);
    assert.strictEqual(result.settings.textonlymode, true);
}
assert.strictEqual(response(pathToFileURL(path.join(root, 'index.html')).href, { getSettings: true }).password, snapshot.password);
assert.strictEqual(response('https://socialstream.ninja/popup.html', { getSettings: true }).settings.openaikey, snapshot.settings.openaikey);

// Cover both injected-cache paths and both settings broadcast transports.
assert.strictEqual((main.match(/JSON\.stringify\(captureSettingsPayload\(cachedState, wc\.getURL\(\)\)\)/g) || []).length, 2);
assert(!main.includes('const cachedSettings = ${JSON.stringify(cachedState)};'));
assert(main.includes('message: filterCaptureSettingsMessage(view, args.message)'));
assert(main.includes('view.webContents.send("sendToTab", filterCaptureSettingsMessage(view, message))'));
console.log('Source settings response regression checks passed (synthetic data only).');
