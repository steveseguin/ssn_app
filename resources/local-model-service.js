'use strict';

const path = require('path');
const { createHash } = require('crypto');
const { webContents } = require('electron');

module.exports = function setupLocalModelService({ app, BrowserWindow, ipcMain, getClientFrame }) {
    const services = new Map();
    let nextId = 0;

    function createService(url) {
        let service;
        let host = null;
        let ready = null;
        let resolveReady = null;
        let rejectReady = null;
        let monitor = null;
        let lastHeartbeat = 0;
        const clients = new Map();

        function sharesRenderer(window) {
            const pid = window.webContents.getOSProcessId();
            return !pid || webContents.getAllWebContents().some(contents => contents !== window.webContents
                && !contents.isDestroyed() && contents.mainFrame.framesInSubtree.some(frame => frame.osProcessId === pid));
        }

        function reply(message) {
            const owner = clients.get(message.id);
            try { if (owner && !owner.detached) owner.send('ssapp:local-model-event', message); } catch (_) {}
        }

        function stop(error) {
            const window = host;
            host = null;
            clearInterval(monitor);
            monitor = null;
            if (rejectReady) rejectReady(new Error(error || 'Local AI stopped.'));
            resolveReady = rejectReady = ready = null;
            if (error) clients.forEach((frame, id) => reply({ id, error }));
            clients.clear();
            if (services.get(url) === service) services.delete(url);
            if (window && !window.isDestroyed()) {
                // Only terminate the isolated renderer, never an app/source process.
                window.webContents.__ssappLocalModelRestarting = true;
                if (error && !sharesRenderer(window)) window.webContents.forcefullyCrashRenderer();
                window.destroy();
            }
        }

        async function start() {
            if (host) return ready;
            const window = new BrowserWindow({
                show: false,
                skipTaskbar: true,
                webPreferences: {
                    // A separate session guarantees process isolation even when
                    // Chromium is under its renderer-process limit.
                    partition: 'persist:ssn-local-models-' + createHash('sha256').update(url).digest('hex').slice(0, 16),
                    preload: path.join(__dirname, 'local-model-preload.js'),
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: true,
                    backgroundThrottling: false
                }
            });
            host = window;
            ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
            // Loading may fail before an invoke handler has awaited this promise.
            ready.catch(() => {});
            window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            window.webContents.on('will-navigate', event => event.preventDefault());
            window.webContents.on('render-process-gone', () => {
                if (host === window) stop('Local AI process stopped. Try the request again.');
            });
            window.on('closed', () => {
                if (host === window) stop('Local AI process closed.');
            });
            lastHeartbeat = Date.now();
            let lastCheck = lastHeartbeat;
            monitor = setInterval(() => {
                clients.forEach((frame, id) => {
                    if (frame.isDestroyed() || frame.detached) {
                        clients.delete(id);
                        window.webContents.send('ssapp:local-model-host-command', { op: 'terminate', id });
                    }
                });
                if (!clients.size && !resolveReady) return stop();
                const now = Date.now();
                // Give the renderer a fresh interval after sleep or a system-wide
                // stall that also prevented this main-process timer from running.
                if (now - lastCheck > 5000) lastHeartbeat = now;
                lastCheck = now;
                if (now - lastHeartbeat > 15000) {
                    stop('Local AI stopped responding. Try the request again to restart it.');
                }
            }, 1000);
            const loading = ready;
            window.loadURL(url).catch(error => {
                if (host === window) stop('Could not start local AI: ' + error.message);
            });
            return loading;
        }

        function onHostEvent(event, message) {
            if (!host || host.isDestroyed() || event.sender !== host.webContents
                || event.senderFrame !== host.webContents.mainFrame || !message) return;
            if (message.ready) {
                if (sharesRenderer(host)) {
                    stop('Local AI could not start in a separate process.');
                    return;
                }
                lastHeartbeat = Date.now();
                if (resolveReady) resolveReady();
                resolveReady = rejectReady = null;
            } else if (message.heartbeat) {
                lastHeartbeat = Date.now();
            } else if (clients.has(message.id)) {
                reply(message);
            }
        }

        async function handle(frame, command) {
            if (command.op === 'create') {
                await start();
                if (!host || frame.isDestroyed() || frame.detached) throw new Error('Local AI was stopped.');
                if (Array.from(services.values()).reduce((total, entry) => total + entry.size(), 0) >= 4) throw new Error('Too many local AI clients.');
                const id = ++nextId;
                clients.set(id, frame);
                host.webContents.send('ssapp:local-model-host-command', { op: 'create', id });
                return id;
            }
            if (!host || clients.get(command.id) !== frame) {
                if (command.op === 'terminate') return;
                throw new Error('Local AI worker is unavailable.');
            }
            if (command.op === 'post') {
                if (!command.data || !['init', 'generate', 'reset', 'dispose'].includes(command.data.type)) {
                    throw new Error('Unsupported local AI request.');
                }
                host.webContents.send('ssapp:local-model-host-command', command);
            } else if (command.op === 'terminate') {
                clients.delete(command.id);
                if (!clients.size) stop();
                else host.webContents.send('ssapp:local-model-host-command', command);
            } else {
                throw new Error('Unsupported local AI operation.');
            }
        }
        service = { handle, onHostEvent, stop, size: () => clients.size };
        return service;
    }

    ipcMain.on('ssapp:local-model-host-event', (event, message) => {
        services.forEach(service => service.onHostEvent(event, message));
    });
    ipcMain.handle('ssapp:local-model', (event, command = {}) => {
        const frame = getClientFrame(event);
        if (!frame) throw new Error('Local AI requires the app background or co-host.');
        const url = new URL('local-browser-model-host.html', frame.url).href;
        let service = services.get(url);
        if (!service) {
            if (command.op === 'terminate') return;
            if (command.op !== 'create') throw new Error('Local AI worker is unavailable.');
            if (services.size >= 4) throw new Error('Too many local AI hosts.');
            service = createService(url);
            services.set(url, service);
        }
        return service.handle(frame, command);
    });
    app.on('before-quit', () => services.forEach(service => service.stop()));
};
