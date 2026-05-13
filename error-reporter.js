'use strict';

// ── Configuration ─────────────────────────────────────────────────────────────
// Fill these in after deploying the Cloudflare Worker (see cloudflare/README.md)
const WORKER_URL   = 'https://ssapp-error-logger.vdo.workers.dev/log';
const WORKER_TOKEN = 'a6c3fc19c152a994375a57099544bab678fe3a1f3bc4c476d35fbe4cc3ef4537';
// ──────────────────────────────────────────────────────────────────────────────

const crypto = require('node:crypto');
const { app } = require('electron');

const OPT_IN_KEY    = 'errorReportingEnabled';
const INSTALL_ID_KEY = 'errorReportingInstallId';
const RATE_LIMIT_MS  = 60_000; // max one report per type per minute

let _store = null;
const _lastReportAt = new Map();

function init(store) {
    _store = store;
}

function isEnabled() {
    return _store ? _store.get(OPT_IN_KEY, false) === true : false;
}

function enable() {
    if (_store) _store.set(OPT_IN_KEY, true);
}

function disable() {
    if (_store) _store.set(OPT_IN_KEY, false);
}

function getInstallId() {
    let id = _store.get(INSTALL_ID_KEY);
    if (!id) {
        id = crypto.randomUUID();
        _store.set(INSTALL_ID_KEY, id);
    }
    return id;
}

function isRateLimited(type) {
    const now  = Date.now();
    const last = _lastReportAt.get(type) || 0;
    if (now - last < RATE_LIMIT_MS) return true;
    _lastReportAt.set(type, now);
    return false;
}

// Fire-and-forget — never throws, never blocks the caller.
// type:           string key, e.g. 'uncaught_exception', 'tiktok_ws_close'
// messageOrError: string or Error
// context:        optional plain object with extra structured data
function report(type, messageOrError, context = {}) {
    _send(type, messageOrError, context).catch(() => {});
}

function send(type, messageOrError, context = {}, options = {}) {
    return _send(type, messageOrError, context, options);
}

// Keys that contain OAuth tokens, session snapshots, or encrypted credentials.
// These are stripped before the settings object is sent.
const SENSITIVE_KEYS = new Set([
    'localStorageBackup',       // webview localStorage snapshot — OAuth tokens for YouTube/Twitch/Spotify/TikTok
    'localStorageBackupTime',
    'cachedStateBackup',        // cached webview state, may also contain tokens
    'cachedStateBackupTime',
    'sessions',                 // per-session localStorage blobs
    'pendingSessionImport',     // imported session data
    'password',                 // transfer-backup encrypted password config
    'tiktokSigningApiKey',
    'tiktokSigningParameters',
    'tiktokSessionId',
    'tiktokSigningEmail',
    'tiktokSigningRoomId',
    'streamID',
    'streamId',
]);

const SENSITIVE_KEY_PATTERNS = [
    /token/i,
    /cookie/i,
    /secret/i,
    /password/i,
    /credential/i,
    /authorization/i,
    /oauth/i,
    /api[_-]?key/i,
    /jwt/i,
    /session/i,
    /local[_-]?storage/i,
    /cached[_-]?state/i,
    /signing[_-]?parameters/i,
    /signing[_-]?api[_-]?key/i,
    /ms[_-]?token/i,
    /x[_-]?bogus/i,
    /x[_-]?gnarly/i,
    /_signature/i,
    /all[_-]?cookies/i,
    /stream[_-]?id/i,
];

function isSensitiveKey(key) {
    if (!key) return false;
    if (SENSITIVE_KEYS.has(key)) return true;
    return SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test(key));
}

function sanitizeSettingsValue(value, key, depth = 0) {
    if (isSensitiveKey(String(key || ''))) {
        return '[redacted]';
    }
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value !== 'object') {
        return value;
    }
    if (depth >= 8) {
        return '[max-depth]';
    }
    if (Array.isArray(value)) {
        return value.map(item => sanitizeSettingsValue(item, '', depth + 1));
    }
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
        out[childKey] = sanitizeSettingsValue(childValue, childKey, depth + 1);
    }
    return out;
}

function sanitizedSettings() {
    const raw = _store.store;
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (!SENSITIVE_KEYS.has(k)) out[k] = sanitizeSettingsValue(v, k);
    }
    return out;
}

async function _send(type, messageOrError, context, options = {}) {
    if (!_store) return { sent: false, reason: 'store_unavailable' };
    if (options.requireEnabled !== false && !isEnabled()) return { sent: false, reason: 'disabled' };
    if (!options.bypassRateLimit && isRateLimited(type)) return { sent: false, reason: 'rate_limited' };

    const isError = messageOrError instanceof Error;
    const payload = {
        install_id: getInstallId(),
        version:    app.getVersion(),
        type,
        message:    isError ? messageOrError.message : String(messageOrError),
        stack:      isError && messageOrError.stack ? messageOrError.stack : undefined,
        context,
        settings:   sanitizedSettings(),
        timestamp:  new Date().toISOString(),
    };

    const response = await fetch(WORKER_URL, {
        method:  'POST',
        headers: {
            'Content-Type':   'application/json',
            'X-Report-Token': WORKER_TOKEN,
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`Report upload failed: ${response.status} ${response.statusText || ''}`.trim());
    }

    return { sent: true, install_id: payload.install_id, timestamp: payload.timestamp };
}

module.exports = { init, isEnabled, enable, disable, report, send };
