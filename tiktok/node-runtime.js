'use strict';

// One environment per Node worker. Each source retains its own manager and key.
if (process.versions.electron) throw new Error('Use the desktop TikTok environment inside Electron.');
const { createTikTokEnvironment } = require('./connection-manager');
const baseConnector = require('tiktok-live-connector');
const connector = process.env.SSN_TIKTOK_RECOVERY === '1'
    ? require('./node-recovery').createRecoveryConnector(baseConnector)
    : baseConnector;
const connections = Object.create(null);
const entries = new Map();
const owners = new Map();
let nextId = 0;

const runtime = createTikTokEnvironment({
    connector,
    quiet: true,
    websocketConnections: connections,
    browserViews: Object.create(null),
    connectionStates: new Map(),
    // Capture event data once; display filtering belongs to each destination.
    isCaptureEventsEnabled: () => true,
    dedupeLikeMessageIds: true,
    isCaptureJoinedEventEnabled: () => false,
    isViewerUpdateAllowed: () => false,
    log: () => {},
    onStatus(update) {
        const entry = entries.get(Number(update.wssID));
        if (!entry || entry.closed || entry.state === 'needs-attention') return;
        const recoveryFailure = entry.connection()?.recoveryFailure;
        if (recoveryFailure) { entry.fail(recoveryFailure); return; }
        if (update.status === 'connection_diagnostic') {
            if (update.diagnostic?.origin === 'disconnected' || update.diagnostic?.stage === 'connection_error') {
                entry.fail('TikTok disconnected. Retry to resume capture; messages during the interruption may be unavailable.');
            }
            return;
        }
        if (update.status === 'connected') {
            entry.state = 'running';
            entry.reason = '';
        } else if (update.status === 'connecting' || update.status === 'reconnecting') {
            entry.state = 'connecting';
            entry.reason = 'Connecting to TikTok.';
        } else if (['failed', 'error', 'fatal_error', 'stopped', 'disconnected', 'euler_rate_limit'].includes(update.status)) {
            // Never expose provider error bodies, URLs or signing credentials.
            entry.fail(entry.disconnectedReason);
        }
    },
    postToBackground(packet) {
        for (const message of packet.messages || [packet.message]) {
            const entry = entries.get(Number(message?.tid) - 900000);
            if (!entry || entry.closed || entry.state === 'needs-attention') continue;
            try {
                if (packet.target) throw new Error('Unexpected direct message target.');
                const payload = { ...message };
                delete payload.tid;
                // Server transports scope replay IDs to the current room.
                // Existing transports may ignore this optional second argument.
                const connection = entry.connection();
                const roomId = connection?.roomId || connection?.webClient?.roomId || connection?.clientParams?.room_id;
                entry.deliver(payload, { roomId: roomId == null ? null : String(roomId) });
                entry.delivered++;
            } catch (_) {
                entry.fail('TikTok overlay delivery stopped. Check the overlay before restarting this connection.');
            }
        }
        return true;
    }
});

function createCapture({ workspaceId, sourceId, channel, apiKey, bootstrap, deliver }) {
    if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 256 ||
        typeof sourceId !== 'string' || !sourceId || sourceId.length > 256) throw new Error('Invalid TikTok source owner.');
    if (typeof channel !== 'string' || !/^[a-z0-9_.][a-z0-9_.-]{0,49}$/.test(channel) || channel === 'camcam66gaming') throw new Error('Invalid TikTok channel.');
    if (bootstrap === undefined && (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(apiKey))) throw new Error('A TikTok signing API key is required.');
    if (bootstrap !== undefined && apiKey !== undefined) throw new Error('Choose one TikTok connection method.');
    if (typeof deliver !== 'function') throw new Error('TikTok delivery transport is required.');
    const browserSigner = bootstrap === undefined ? null : require('./node-bootstrap').createBrowserBootstrap(channel, bootstrap);
    bootstrap = null;
    const retryReason = browserSigner ? 'TikTok could not connect. Open its browser setup again, then Retry.' :
        'TikTok could not connect. Check the channel and signing key, then Retry.';
    const owner = JSON.stringify([workspaceId, sourceId]);
    let manager, id, started = false;
    const entry = {
        closed: false, state: 'idle', reason: '', delivered: 0, deliver,
        disconnectedReason: browserSigner ? 'TikTok disconnected. Open its browser setup again, then Retry.' :
            'TikTok disconnected. Check that the channel is live and the signing key is valid, then Retry.',
        connection() { return manager?.connection; },
        fail(reason) {
            entry.state = 'needs-attention';
            entry.reason = reason;
            if (manager) manager.isStopped = true;
            queueMicrotask(() => entry.stopManager());
        },
        stopManager() {
            browserSigner?.clear();
            if (id) runtime.cleanupConnection(id);
            // Keep the paused source status, not its old connector and caches.
            manager = null;
        }
    };
    return {
        async start() {
            if (started || entry.closed) return;
            if (owners.has(owner)) throw new Error('This TikTok source is already running.');
            if (nextId >= Number.MAX_SAFE_INTEGER - 900001) throw new Error('Restart the TikTok worker.');
            started = true;
            id = ++nextId;
            owners.set(owner, id);
            entries.set(id, entry);
            entry.state = 'connecting';
            try {
                manager = new runtime.ConnectionManager(channel, id, null, null, {
                    signingProvider: browserSigner ? 'local' : 'custom', signing: browserSigner ? null : { apiKey }, autoMode: false
                });
                if (browserSigner) manager.localSigner = browserSigner;
                apiKey = null;
                manager.sourceId = owner;
                manager.virtualTabId = 900000 + id;
                connections[id] = manager;
                runtime.connectionStates.set(id, { isConnected: false, lastAttempt: Date.now(), isReconnecting: false, attemptInProgress: false });
                runtime.registerActiveTikTokSourceConnection(manager, 'node');
                const connected = await manager.initialize();
                if (!connected && !entry.closed && entry.state !== 'needs-attention') {
                    entry.state = 'needs-attention';
                    entry.reason = retryReason;
                    entry.stopManager();
                }
            } catch (_) {
                entry.state = entry.closed ? 'stopped' : 'needs-attention';
                entry.reason = entry.closed ? '' : retryReason;
                entry.stopManager();
            }
        },
        stop() {
            if (entry.closed) return;
            entry.closed = true;
            entry.stopManager();
            entries.delete(id);
            if (owners.get(owner) === id) owners.delete(owner);
            apiKey = null;
            manager = null;
            entry.state = 'stopped';
            entry.reason = '';
        },
        status() {
            const recovering = !entry.closed && entry.state !== 'needs-attention' && manager?.connection?.recoveryState;
            return { status: recovering || entry.state, reason: recovering ? 'Recovering TikTok chat.' : entry.reason, delivered: entry.delivered };
        }
    };
}

module.exports = { createCapture, browserBootstrap: true, deliveryContext: true };
