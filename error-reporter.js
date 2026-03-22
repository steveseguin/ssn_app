'use strict';

// ── Configuration ─────────────────────────────────────────────────────────────
// Fill these in after deploying the Cloudflare Worker (see cloudflare/README.md)
const WORKER_URL   = 'https://ssapp-error-logger.vdo.workers.dev/log';
const WORKER_TOKEN = 'a6c3fc19c152a994375a57099544bab678fe3a1f3bc4c476d35fbe4cc3ef4537';
// ──────────────────────────────────────────────────────────────────────────────

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
]);

function sanitizedSettings() {
    const raw = _store.store;
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (!SENSITIVE_KEYS.has(k)) out[k] = v;
    }
    return out;
}

async function _send(type, messageOrError, context) {
    if (!isEnabled() || !_store) return;
    if (isRateLimited(type)) return;

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

    await fetch(WORKER_URL, {
        method:  'POST',
        headers: {
            'Content-Type':   'application/json',
            'X-Report-Token': WORKER_TOKEN,
        },
        body: JSON.stringify(payload),
    });
}

module.exports = { init, isEnabled, enable, disable, report };
