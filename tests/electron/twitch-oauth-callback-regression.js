'use strict';

// Supporting sanity checks only: Electron IPC/launch and the landing-page DOM
// are simulated. The production handler and its loopback HTTP server are real.
// Functional app coverage lives in twitch-oauth-error-e2e.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const handlers = new Map();
let openedUrl = '';
const electron = {
    ipcMain: {
        listenerCount: () => 0,
        handle: (name, handler) => handlers.set(name, handler)
    },
    shell: { openExternal: async url => { openedUrl = url; } },
    dialog: { showMessageBox: async () => ({ response: 0 }) }
};
const filename = path.resolve(__dirname, '../../resources/electron-twitch-handler.js');
const context = {
    module: { exports: {} },
    require: name => name === 'electron' ? electron : require(name),
    console, URL, URLSearchParams, setTimeout, clearTimeout
};
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
context.module.exports.setupTwitchOAuthHandler();

async function callbackCase(label, parameters, expected, options = {}) {
    openedUrl = '';
    const outcome = handlers.get('twitch-oauth')(null, {
        clientId: 'synthetic-client', state: 'synthetic-state',
        authMode: options.hosted ? 'hosted' : 'direct',
        timeoutMs: 1500
    }).then(value => ({ value }), error => ({ error: error.message }));
    const deadline = Date.now() + 1000;
    while (!openedUrl && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert(openedUrl, `${label}: authorization URL should open`);
    const launch = new URL(openedUrl);
    const callback = new URL(launch.searchParams.get(options.hosted ? 'return_to' : 'redirect_uri'));
    callback.hostname = '127.0.0.1';
    if (options.path) callback.pathname = options.path;
    for (const [key, value] of Object.entries(options.search || {})) callback.searchParams.set(key, value);
    if (options.query) {
        for (const [key, value] of Object.entries(parameters)) callback.searchParams.set(key, value);
    } else {
        callback.hash = new URLSearchParams(parameters).toString();
    }
    const response = await fetch(callback, { headers: { Connection: 'close' } });
    assert.equal(response.status, 200, `${label}: callback HTTP status`);
    const html = await response.text();
    // Extract the one script from our known callback template, not arbitrary
    // HTML. These boundaries are fixture assertions, not an HTML sanitizer.
    const scriptParts = html.split('<script>');
    assert.equal(scriptParts.length, 2, `${label}: expected one callback script`);
    const scriptEnd = scriptParts[1].indexOf('</script>');
    assert(scriptEnd >= 0, `${label}: callback script should have a closing tag`);
    const script = scriptParts[1].slice(0, scriptEnd);
    const elements = {
        spinner: { style: {} },
        status: { className: '', textContent: '' }
    };
    const posts = [];
    const page = {
        URLSearchParams,
        window: { location: callback, close() {} },
        document: { getElementById: id => elements[id] },
        atob: value => Buffer.from(value, 'base64').toString('binary'),
        setTimeout: () => 0,
        fetch: (url, init) => {
            const request = fetch(new URL(url, callback), {
                ...init, headers: { ...init.headers, Connection: 'close' }
            });
            posts.push(request);
            return request;
        }
    };
    vm.runInNewContext(script, page);
    await Promise.all(posts);
    const result = await outcome;
    if (expected.error) {
        assert.equal(result.error, expected.error, `${label}: provider error should finish login immediately`);
    } else {
        assert.equal(result.value?.access_token, expected.token, `${label}: token result`);
    }
    if (!options.path) {
        assert.equal(posts.length, 1, `${label}: landing page must report exactly once`);
    }
    console.log(`PASS: ${label}`);
}

async function run() {
    const error = 'Access denied: literal <b>text</b> & 日本語';
    await callbackCase('Direct query denial on callback path',
        { error: 'access_denied', error_description: error, state: 'synthetic-state' },
        { error }, { query: true });
    await callbackCase('Query denial without description',
        { error: 'access_denied' }, { error: 'access_denied' }, { query: true });
    await callbackCase('Query denial on callback alias',
        { error: 'access_denied', error_description: error }, { error }, { query: true, path: '/callback' });
    await callbackCase('Query denial on root alias',
        { error: 'access_denied' }, { error: 'access_denied' }, { query: true, path: '/' });
    await callbackCase('Fragment denial remains supported',
        { error: 'access_denied', error_description: error }, { error });
    await callbackCase('Hosted fragment denial remains supported',
        { twitch_auth_error: Buffer.from(JSON.stringify({ error: 'access_denied', message: error })).toString('base64url') },
        { error }, { hosted: true });
    await callbackCase('Hosted error retains precedence over query error',
        { twitch_auth_error: Buffer.from(JSON.stringify({ error: 'access_denied', message: error })).toString('base64url') },
        { error }, { hosted: true, search: { error: 'query_error', error_description: 'Query description' } });
    await callbackCase('Query error takes precedence over simultaneous token',
        { access_token: 'synthetic-not-accepted-token', state: 'synthetic-state' },
        { error: 'access_denied' }, { search: { error: 'access_denied' } });
    await callbackCase('Direct success remains supported',
        { access_token: 'synthetic-direct-token', state: 'synthetic-state' }, { token: 'synthetic-direct-token' });
    await callbackCase('Hosted success retains query state',
        { twitch_auth_result: Buffer.from(JSON.stringify({ tokens: { access_token: 'synthetic-hosted-token' } })).toString('base64url') },
        { token: 'synthetic-hosted-token' }, { hosted: true });
    await callbackCase('Unrelated query-error path remains supported',
        { error: 'access_denied', error_description: error }, { error }, { query: true, path: '/other-path' });
    console.log('All Twitch callback sanity checks passed; real Electron validation remains separate.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
