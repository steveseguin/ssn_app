'use strict';

// Supporting scope checks; real Electron coverage lives in electron/vk-signin-e2e.js.
const assert = require('assert/strict');
const { normalizeMissingOriginRule, applyMissingOriginRule } = require('../resources/signin-origin-rule');
const config = {
    pageOrigins: ['https://accounts.example.com'],
    requestOrigins: ['https://login.example.com'], methods: ['POST'], includePopups: true
};
const rule = normalizeMissingOriginRule(config);
function headersFor(page, url, method = 'POST', headers = {}, policy = rule) {
    applyMissingOriginRule(headers, { url, method }, page, policy);
    return headers;
}
assert.deepEqual(headersFor('https://accounts.example.com/auth', 'https://login.example.com/token'),
    { Origin: 'https://accounts.example.com' });
for (const [page, url, method] of [
    ['https://unrelated.example.com/', 'https://login.example.com/token', 'POST'],
    ['https://accounts.example.com/', 'https://unrelated.example.com/token', 'POST'],
    ['https://accounts.example.com/', 'https://login.example.com/token', 'GET'],
    ['https://accounts.example.com.attacker.test/', 'https://login.example.com/token', 'POST'],
    ['http://accounts.example.com/', 'https://login.example.com/token', 'POST'],
    ['https://accounts.example.com:444/', 'https://login.example.com/token', 'POST'],
    ['about:blank', 'https://login.example.com/token', 'POST']
]) assert.deepEqual(headersFor(page, url, method), {});
for (const key of ['Origin', 'origin', 'ORIGIN']) {
    assert.deepEqual(headersFor('https://accounts.example.com/', 'https://login.example.com/', 'POST', { [key]: 'null' }),
        { [key]: 'null' });
}
assert.deepEqual(headersFor('https://accounts.example.com/', 'https://login.example.com/', 'POST', {}, null), {});
for (const invalid of [undefined, false, {}, { ...config, pageOrigins: [] },
    { ...config, methods: [] }, { ...config, methods: ['post'] }, { ...config, includePopups: 'true' }]) {
    assert.equal(normalizeMissingOriginRule(invalid), null);
}
for (const origin of ['https://*.example.com', 'https://example.com/auth', 'http://example.com',
    'https://user@example.com', 'https://example.com/?x=1', 'https://example.com/#x']) {
    assert.equal(normalizeMissingOriginRule({ ...config, pageOrigins: [origin] }), null);
    assert.equal(normalizeMissingOriginRule({ ...config, requestOrigins: [origin] }), null);
}
assert.equal(normalizeMissingOriginRule({ ...config, includePopups: undefined }).includePopups, false);
console.log('PASS: missing-Origin rule scope and validation');
