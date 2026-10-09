'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');

// Chromium owns the credential cache. Only in-flight prompts live here, partitioned
// by the existing Electron session, exact origin and HTTP authentication realm.
const pendingSessions = new WeakMap();

function httpUrl(value) {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        return url;
    } catch (_) { return null; }
}

function openAuthDialog(origin, realm, retry, parent, complete) {
    const dialog = new BrowserWindow({
        width: 480, height: 510, minWidth: 360, minHeight: 460,
        title: 'Server sign-in', show: false, autoHideMenuBar: true,
        parent: parent && !parent.isDestroyed() && parent.isVisible() ? parent : undefined,
        minimizable: false, maximizable: false,
        webPreferences: {
            preload: path.join(__dirname, 'source-basic-auth-preload.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            partition: 'source-basic-auth-dialog'
        }
    });
    dialog.setMenu(null);
    dialog.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    dialog.webContents.on('will-navigate', event => event.preventDefault());
    let finished = false;
    function finish(credentials) {
        if (finished) return;
        finished = true;
        if (!dialog.isDestroyed()) dialog.destroy();
        complete(credentials);
    }
    dialog.webContents.on('ipc-message', (event, channel, value) => {
        if (channel !== 'source-basic-auth-response' || event.senderFrame !== dialog.webContents.mainFrame) return;
        if (value === null) return finish(null);
        if (!value || typeof value.username !== 'string' || typeof value.password !== 'string'
            || value.username.includes(':') || /[\r\n]/.test(value.username)
            || value.username.length > 1024 || value.password.length > 4096) return;
        finish({ username: value.username, password: value.password });
    });
    dialog.once('closed', () => finish(null));
    dialog.webContents.once('render-process-gone', () => finish(null));
    dialog.once('ready-to-show', () => { if (!finished) dialog.show(); });
    dialog.loadFile(path.join(__dirname, 'source-basic-auth.html'), {
        query: { origin, realm: String(realm || '').slice(0, 200), retry: retry ? '1' : '0' }
    }).catch(() => finish(null));
    return () => finish(null);
}

function attachSourceBasicAuth(view, args, options = {}) {
    // Read the explicit source config, never inherited global defaults. Unconfigured
    // platforms/windows retain Electron's existing handling (including proxy auth).
    if (args.configs?.[args.platform]?.httpBasicAuth !== true || args.wss) return;
    const sourceUrl = httpUrl(args.url);
    if (!sourceUrl) return;
    const contents = view.webContents;
    let pageOrigin = sourceUrl.origin;
    const waiting = new Set();
    let groups = pendingSessions.get(contents.session);
    if (!groups) {
        groups = new Map();
        pendingSessions.set(contents.session, groups);
    }

    function cancelWaiting() {
        for (const waiter of Array.from(waiting)) {
            waiter.done(null);
            if (!waiter.group.waiters.size) waiter.group.cancel();
        }
    }
    contents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
        if (!isMainFrame || isInPlace) return;
        pageOrigin = httpUrl(url)?.origin || '';
        cancelWaiting();
    });
    contents.on('login', (event, details, authInfo, callback) => {
        const requestUrl = httpUrl(details.url);
        if (!requestUrl || requestUrl.origin !== sourceUrl.origin || pageOrigin !== sourceUrl.origin
            || authInfo.isProxy || String(authInfo.scheme).toLowerCase() !== 'basic') return;
        event.preventDefault();
        if (options.headless) {
            callback();
            console.warn('[Source sign-in] Server authentication requires an interactive sign-in:', sourceUrl.origin);
            return;
        }
        const key = JSON.stringify([sourceUrl.origin, authInfo.realm || '']);
        let group = groups.get(key);
        const isNew = !group;
        if (isNew) {
            group = { waiters: new Set(), cancel: () => {} };
            groups.set(key, group);
        }
        const waiter = {
            group,
            done(credentials) {
                if (!waiting.delete(waiter)) return;
                group.waiters.delete(waiter);
                try {
                    if (credentials && !contents.isDestroyed() && pageOrigin === sourceUrl.origin) {
                        callback(credentials.username, credentials.password);
                    } else callback();
                } catch (_) { }
            }
        };
        waiting.add(waiter);
        group.waiters.add(waiter);
        if (!isNew) return;
        const complete = credentials => {
            groups.delete(key);
            for (const item of Array.from(group.waiters)) item.done(credentials);
        };
        try {
            group.cancel = openAuthDialog(sourceUrl.origin, authInfo.realm,
                details.firstAuthAttempt === false, options.parent, complete);
        } catch (_) { complete(null); }
    });
    contents.once('destroyed', cancelWaiting);
    contents.on('render-process-gone', cancelWaiting);
    // Stop Source removes the webContents listeners before destroying the window.
    view.once('closed', cancelWaiting);
}

module.exports = { attachSourceBasicAuth };
