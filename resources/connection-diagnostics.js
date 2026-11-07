'use strict';

const os = require('os');

// This collector is called only by the manual issue report. It reads existing
// transports and briefly probes the standard services without joining a room.
// Observation listeners are removed before returning; nothing runs at startup.
const FRAME_LIMIT = 24;
const FRAME_TIMEOUT_MS = 2500;
const REPORT_TIMEOUT_MS = 7000;

async function withTimeout(operation, ms, fallback) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

// Serialized into an SSN background/overlay or its VDO.Ninja transport frame.
// All output is allowlisted. Never return SDP, candidates, messages, arbitrary
// error text, peer IDs, TURN credentials, or complete URLs.
async function readConnectionState(role, probeNetwork) {
    const count = value => Number.isFinite(value) && value >= 0 ? value : null;
    const choice = (value, choices) => choices.includes(value) ? value : null;
    const state = value => choice(value, ['new', 'connecting', 'connected', 'checking', 'completed', 'disconnected',
        'failed', 'closed', 'stable', 'have-local-offer', 'have-remote-offer', 'have-local-pranswer',
        'have-remote-pranswer', 'gathering', 'complete', 'open', 'closing']);
    const flag = value => value && typeof value === 'object' ? flag(value.setting) :
        value === true || value === 1 || /^(true|1|on|yes)$/i.test(String(value));
    const params = new URLSearchParams(location.search);
    const settingsValue = typeof settings === 'object' && settings ? settings : {};
    const result = {
        status: 'ok', role, readyState: document.readyState, visibility: document.visibilityState,
        online: navigator.onLine, secureContext: window.isSecureContext,
        webRTCSupported: typeof RTCPeerConnection !== 'undefined',
        pageAgeMs: Math.round(performance.now()),
        transportFlags: {}, sockets: [], peers: []
    };
    for (const name of ['server', 'server2', 'server3', 'server2additivedelivery', 'lanonly', 'sdk', 'usesdk', 'disablehost']) {
        result.transportFlags[name] = role === 'background' ? flag(settingsValue[name]) : params.has(name);
    }
    result.transportFlags.localserver = params.has('localserver');
    result.transportFlags.transparent = params.has('transparent') || params.has('transparency');
    result.transportFlags.transparentmode = params.has('transparentmode');
    result.linkVersion = /^\d+(?:\.\d+){1,3}$/.test(params.get('v') || '') ? params.get('v') : null;
    result.codeAvailable = { ingestion: typeof processIncomingMessage === 'function', sender: typeof sendDataP2P === 'function',
        renderer: typeof processData === 'function', sanitizer: typeof filterXSS === 'function' };
    result.display = { customCss: params.has('css') || params.has('cssb64') || params.has('b64css'),
        hiddenEvents: params.has('hideallevents'), skippedDonations: params.has('skipdonations'),
        typeFilter: params.has('onlytype') || params.has('hidetype') };
    if (role === 'overlay') {
        const color = getComputedStyle(document.documentElement).getPropertyValue('--background-color').trim();
        result.display.backgroundColor = /^(#[\da-f]{3,8}|rgba?\([\d.,%\s]+\)|transparent)$/i.test(color) ? color : null;
        result.display.paused = typeof pauseState !== 'undefined' ? !!pauseState : null;
        result.display.searchFilterActive = typeof filtering !== 'undefined' ? !!filtering : null;
        result.display.queueLength = typeof queue !== 'undefined' && Array.isArray(queue) ? queue.length : null;
        result.display.rowsPresent = document.querySelectorAll('[data-mid]').length;
        result.display.viewerCountEnabled = typeof showviewercount !== 'undefined' ? !!showviewercount : null;
        result.display.historyBrowsing = typeof historyBrowsing !== 'undefined' ? !!historyBrowsing : null;
        result.display.bodyBackground = getComputedStyle(document.body).backgroundColor;
    }
    if (role === 'background') {
        result.enabled = typeof isExtensionOn !== 'undefined' ? !!isExtensionOn : null;
        result.transport = typeof useNinjaSDK !== 'undefined' && useNinjaSDK ? 'sdk' : 'iframe';
        result.health = { status: 'unavailable' };
        result.filters = {};
        for (const key of ['noduplicates', 'hideevents', 'filtercommands', 'filtercommandscustomtoggle', 'filtereventstoggle', 'showviewercount']) result.filters[key] = flag(settingsValue[key]);
        result.activity = { generatedMessageIds: typeof messageCounter === 'number' && typeof messageCounterBase === 'number' ? count(messageCounter - messageCounterBase) : null,
            sourceActivityTotal: typeof tabMessageActivityCounter === 'object' ? Object.values(tabMessageActivityCounter).reduce((sum, n) => sum + (count(n) || 0), 0) : null,
            lastSendAt: typeof lastSentTimestamp === 'number' ? count(lastSentTimestamp) : null };
    }
    // Used only inside the main process to assign anonymous comparison groups.
    // These two fields are removed before the report is returned to its caller.
    result._room = role === 'background' && typeof streamID !== 'undefined' ? streamID :
        params.get('session') || params.get('room') || params.get('roomid') || '';
    result._password = role === 'background' && typeof password !== 'undefined' ? password :
        params.get('password') || params.get('pass') || params.get('pw') || false;

    if (role === 'popup') {
        result.generatedLinks = ['dock', 'overlay', 'meta'].map(id => {
            const node = document.getElementById(id);
            if (!node?.raw) return { target: id, available: false };
            try {
                const link = new URL(node.raw, location.href);
                const flags = {};
                for (const key of ['server', 'server2', 'server3', 'localserver', 'lanonly', 'transparent', 'transparentmode']) flags[key] = link.searchParams.has(key);
                return { target: id, available: true, flags, _room: link.searchParams.get('session') || '',
                    _password: link.searchParams.get('password') || false };
            } catch (_) { return { target: id, available: false }; }
        });
        result.transportFlags = {};
        for (const key of ['server', 'server2', 'server3']) result.transportFlags[key] = !!document.getElementById(key)?.checked;
    }
    if (role === 'shell') {
        result.shell = { beta: typeof isBetaMode === 'boolean' ? isBetaMode : null,
            backgroundOrigin: choice(document.getElementById('frame2')?.dataset.ssappOrigin, ['remote', 'cache', 'fallback', 'local']),
            backgroundElementPresent: !!document.getElementById('frame2')?.src,
            popupElementPresent: !!document.getElementById('frame1')?.src };
    }

    // Keep only script identifiers we own, without paths, queries or error text.
    const assetNames = ['background.js', 'loader.js', 'popup.js', 'dock.html', 'featured.html', 'index.html', 'ninja-transport.js', 'vdoninja-sdk.js', 'webrtc.js', 'main.js'];
    const assetName = value => {
        try { return choice(new URL(value, location.href).pathname.split('/').pop(), assetNames) || 'other'; }
        catch (_) { return 'other'; }
    };
    const netCode = value => String(value || '').match(/\bERR_[A-Z_]{2,60}\b/)?.[0] || null;
    if (window.ssappBackgroundLoadState) {
        const loader = window.ssappBackgroundLoadState;
        result.loader = { status: choice(loader.status, ['loading', 'ready', 'failed']), currentScript: assetName(loader.currentScript),
            failures: Array.isArray(loader.failures) ? loader.failures.slice(0, 20).map(failure => ({ script: assetName(failure.script), networkError: netCode(failure.error) })) : [] };
    }
    result.assets = performance.getEntriesByType('resource').filter(entry => assetName(entry.name) !== 'other').slice(-20)
        .map(entry => ({ script: assetName(entry.name), durationMs: Math.round(entry.duration), httpStatus: count(entry.responseStatus), transferBytes: count(entry.transferSize) }));
    result.codeHashes = {};
    try {
        for (const name of ['processIncomingMessage', 'sendDataP2P', 'initTransport', 'processData']) {
            if (typeof window[name] !== 'function') continue;
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(Function.prototype.toString.call(window[name])));
            result.codeHashes[name] = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        }
    } catch (_) { result.codeHashesUnavailable = true; }

    function endpoint(value) {
        try {
            const url = new URL(String(value).replace(/^(stuns?|turns?):(?!\/\/)/, '$1://'));
            const protocol = choice(url.protocol, ['https:', 'http:', 'wss:', 'ws:', 'stun:', 'stuns:', 'turn:', 'turns:']);
            if (!protocol) return null;
            // Custom hosts and routes can themselves contain private identifiers.
            const host = ['socialstream.ninja', 'cache.socialstream.ninja', 'beta.socialstream.ninja',
                'vdo.socialstream.ninja', 'wss.socialstream.ninja', 'io.socialstream.ninja',
                'wss.vdo.ninja', 'apibackup.vdo.ninja', 'stun.l.google.com', 'stun.cloudflare.com'].includes(url.hostname)
                ? url.hostname : ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? 'loopback' : 'custom';
            return { protocol, host, port: url.port || null };
        } catch (_) { return null; }
    }
    const observedSockets = [];
    function socket(name, value, configuredUrl, retries) {
        result.sockets.push({ name, present: !!value,
            state: value && Number.isInteger(value.readyState) ? ['connecting', 'open', 'closing', 'closed'][value.readyState] || null : null,
            endpoint: endpoint(value && value.url || configuredUrl), bufferedAmount: value ? count(value.bufferedAmount) : null,
            reconnectAttempts: count(retries) });
        if (value && typeof value.addEventListener === 'function') observedSockets.push({ name, value });
    }
    if (typeof socketserverDock !== 'undefined') socket('dock-relay', socketserverDock, typeof serverURLDock !== 'undefined' ? serverURLDock : '', typeof conConDock !== 'undefined' ? conConDock : null);
    if (typeof socketserver !== 'undefined') socket('api-relay', socketserver, typeof serverURL !== 'undefined' ? serverURL : '', typeof conCon !== 'undefined' ? conCon : null);
    if (typeof socketserverExtension !== 'undefined') socket('extension-relay', socketserverExtension, typeof serverURLExtension !== 'undefined' ? serverURLExtension : '');
    if (typeof socketserverFeatured !== 'undefined') socket('featured-relay', socketserverFeatured, '');

    if (typeof getDockTransportHealth === 'function') {
        try {
            const health = getDockTransportHealth();
            result.health = {};
            for (const key of ['extensionOn', 'webRTCSupported', 'p2pPeerCount', 'signalingPeerCount', 'hasSignalingPeer',
                'lastSignalingPeerAt', 'everHadP2PPeer', 'lastP2PPeerAt', 'lastP2PDisconnectAt', 'lastP2PFailureAt',
                'recentP2PDisconnect', 'recentP2PFailure', 'serverFallbackEnabled', 'serverFallbackDockSocketOpen', 'fakeMessageTransportReady']) {
                if (typeof health[key] === 'boolean' || Number.isFinite(health[key])) result.health[key] = health[key];
            }
            result.health.lastP2PFailureReason = choice(health.lastP2PFailureReason,
                ['', 'unknown', 'sdkInit', 'sdkSend', 'connectionFailed', 'streamDeckDockSend', 'streamDeckFeedSend']);
            const labels = ['SocialStream', 'dock', 'overlay', 'aioverlay', 'cohost', 'tipjar', 'meta', 'ticker',
                'hype', 'streamdeck', 'timer', 'giveaway', 'credits', 'waitlist', 'wordcloud', 'poll', 'map', 'reactions', 'alerts', 'actions', 'bot'];
            for (const key of ['p2pPeerLabels', 'signalingPeerLabels']) {
                result.health[key] = Array.isArray(health[key]) ? health[key].slice(0, 32).map(label => choice(label, labels) || 'other') : [];
            }
        } catch (_) { result.health = { status: 'unavailable' }; }
    }

    const connections = [];
    const seen = new Set();
    function addPeer(pc, direction, channel, detail) {
        if (!pc || typeof pc.getStats !== 'function' || seen.has(pc)) return;
        seen.add(pc);
        connections.push({ pc, direction, channel, detail });
    }
    if (typeof ninjaBridge !== 'undefined' && ninjaBridge && ninjaBridge.vdo) {
        const sdk = ninjaBridge.vdo;
        result.sdk = { ready: !!ninjaBridge.connected, connected: !!sdk.state?.connected,
            roomJoined: !!sdk.state?.roomJoined, publishing: !!sdk.state?.publishing,
            pendingViews: count(sdk._pendingViews?.size), failedViewers: count(sdk._failedViewerConnections?.size),
            signalingQueueLength: Array.isArray(sdk._signalingQueue) ? sdk._signalingQueue.length : null };
        socket('signaling', sdk.signaling, ninjaBridge.opts?.wss, sdk._reconnectAttempts);
        if (sdk.connections instanceof Map) {
            sdk.connections.forEach(pair => {
                for (const direction of ['publisher', 'viewer']) {
                    const connection = pair[direction];
                    if (connection) addPeer(connection.pc, direction, connection.dataChannel, connection);
                }
            });
        }
    }
    if (role === 'bridge') result.legacy = { available: false };
    if (role === 'bridge' && typeof session !== 'undefined' && session) {
        socket('signaling', session.ws, session.wss);
        result.legacy = { available: true, localNetworkOnly: !!session.localNetworkOnly,
            seedAttempts: count(session.seedAttempts), seedRetryPending: !!session.seedRetryTimeout,
            stunOnly: !!session.stunOnly, security: !!session.security, iceTransportPolicy: choice(session.configuration?.iceTransportPolicy, ['all', 'relay']) };
        for (const [key, direction, channel] of [['pcs', 'publisher', 'sendChannel'], ['rpcs', 'viewer', 'receiveChannel']]) {
            Object.values(session[key] || {}).forEach(pc => addPeer(pc, direction, pc[channel], pc));
        }
        result.reliability = {};
        for (const key of ['ice_candidate_errors', 'answer_skipped_invalid_state', 'answer_skipped_session_mismatch',
            'ice_queued_pre_pc', 'ice_queue_expired', 'relay_escalations', 'relay_policy_restores',
            'peer_recovery_attempts', 'connecting_watchdog_fired', 'description_queue_dropped']) {
            if (Number.isFinite(session.reliabilityCounters?.[key])) result.reliability[key] = session.reliabilityCounters[key];
        }
    }
    function addressKind(value) {
        if (typeof value !== 'string' || !value) return null;
        if (/\.local$/i.test(value)) return 'mdns';
        if (/^(127\.|::1$)/.test(value)) return 'loopback';
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd]|fe80:)/i.test(value)) return 'private';
        return value.includes(':') ? 'public-ipv6' : 'public-ipv4';
    }
    function candidate(value) {
        if (!value) return null;
        return { type: choice(value.candidateType, ['host', 'srflx', 'prflx', 'relay']),
            protocol: choice(value.protocol, ['udp', 'tcp']), relayProtocol: choice(value.relayProtocol, ['udp', 'tcp', 'tls']),
            addressKind: addressKind(value.address || value.ip) };
    }
    async function peerSnapshot(entry) {
        const { pc, direction, channel, detail } = entry;
        const peer = { direction, connectionState: state(pc.connectionState), iceConnectionState: state(pc.iceConnectionState),
            iceGatheringState: state(pc.iceGatheringState), signalingState: state(pc.signalingState),
            localDescription: choice(pc.localDescription?.type, ['offer', 'answer', 'pranswer', 'rollback']),
            remoteDescription: choice(pc.remoteDescription?.type, ['offer', 'answer', 'pranswer', 'rollback']),
            dataChannel: channel ? { state: state(channel.readyState), bufferedAmount: count(channel.bufferedAmount) } : null,
            recoveryStage: count(detail?.recoveryStage), missedPings: count(detail?.missedPings) };
        if (pc.lastIceCandidateError) {
            peer.lastIceError = { code: count(Number(pc.lastIceCandidateError.code)), at: count(pc.lastIceCandidateError.ts),
                endpoint: endpoint(pc.lastIceCandidateError.url) };
        }
        try {
            const config = pc.getConfiguration();
            peer.iceTransportPolicy = choice(config.iceTransportPolicy, ['all', 'relay']);
            peer.iceServers = (config.iceServers || []).slice(0, 8).map(server => ({
                endpoints: (Array.isArray(server.urls) ? server.urls : [server.urls]).slice(0, 4).map(endpoint),
                hasCredentials: !!(server.username || server.credential)
            }));
        } catch (_) {}
        let timer;
        try {
            const stats = await Promise.race([pc.getStats(), new Promise(resolve => { timer = setTimeout(() => resolve(null), 800); })]);
            if (!stats) { peer.statsStatus = 'timeout'; return peer; }
            peer.statsStatus = 'ok';
            peer.candidates = { local: [], remote: [] };
            peer.candidatePairStates = {};
            peer.dataChannels = [];
            let selectedId;
            stats.forEach(stat => { if (stat.type === 'transport' && stat.selectedCandidatePairId) selectedId = stat.selectedCandidatePairId; });
            stats.forEach(stat => {
                if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') {
                    const target = stat.type === 'local-candidate' ? peer.candidates.local : peer.candidates.remote;
                    if (target.length < 16) target.push(candidate(stat));
                } else if (stat.type === 'candidate-pair') {
                    const pairState = choice(stat.state, ['frozen', 'waiting', 'in-progress', 'failed', 'succeeded']) || 'unknown';
                    peer.candidatePairStates[pairState] = (peer.candidatePairStates[pairState] || 0) + 1;
                    if (stat.id === selectedId || (!selectedId && stat.nominated && stat.state === 'succeeded')) {
                        peer.selectedPair = { state: pairState, local: candidate(stats.get(stat.localCandidateId)), remote: candidate(stats.get(stat.remoteCandidateId)) };
                        for (const key of ['currentRoundTripTime', 'bytesSent', 'bytesReceived', 'requestsSent', 'responsesReceived', 'consentRequestsSent']) peer.selectedPair[key] = count(stat[key]);
                    }
                } else if (stat.type === 'transport') {
                    peer.dtlsState = choice(stat.dtlsState, ['new', 'connecting', 'connected', 'closed', 'failed']);
                } else if (stat.type === 'data-channel' && peer.dataChannels.length < 8) {
                    const channelStats = { state: state(stat.state) };
                    for (const key of ['messagesSent', 'messagesReceived', 'bytesSent', 'bytesReceived']) channelStats[key] = count(stat[key]);
                    peer.dataChannels.push(channelStats);
                }
            });
        } catch (_) { peer.statsStatus = 'unavailable'; }
        finally { clearTimeout(timer); }
        return peer;
    }
    result.peerCount = connections.length;
    result.peersTruncated = connections.length > 16;
    result.peers = await Promise.all(connections.slice(0, 16).map(peerSnapshot));
    result.bridgeElements = Array.from(document.querySelectorAll('iframe')).slice(0, 24).map(frame => {
        try {
            const url = new URL(frame.src);
            if (url.hostname !== 'vdo.socialstream.ninja') return null;
            return { endpoint: endpoint(url.href), connectedToDocument: frame.isConnected };
        } catch (_) { return null; }
    }).filter(Boolean);

    // One short observation interval supplements existing history. Never read
    // socket payloads or wrap message delivery/processing functions.
    result.observation = { durationMs: 900, events: [] };
    const cleanups = [];
    function listen(target, type, handler) {
        target.addEventListener(type, handler);
        cleanups.push(() => target.removeEventListener(type, handler));
    }
    function record(event) { if (result.observation.events.length < 20) result.observation.events.push(event); }
    const networkProbes = [];
    try {
        for (const entry of observedSockets) {
            for (const type of ['open', 'error', 'close']) listen(entry.value, type, event => record({ kind: 'socket', socket: entry.name, event: type,
                closeCode: type === 'close' ? count(event.code) : null, cleanClose: type === 'close' ? !!event.wasClean : null }));
        }
        listen(window, 'error', event => record({ kind: 'page-error', script: assetName(event.filename), line: count(event.lineno),
            networkError: netCode(event.message), name: choice(event.error?.name, ['TypeError', 'ReferenceError', 'SyntaxError', 'Error', 'SecurityError', 'NetworkError']) }));
        listen(window, 'unhandledrejection', event => record({ kind: 'unhandled-rejection', networkError: netCode(event.reason?.message),
            name: choice(event.reason?.name, ['TypeError', 'ReferenceError', 'SyntaxError', 'Error', 'SecurityError', 'NetworkError']) }));
        if (probeNetwork) {
            for (const url of ['wss://wss.socialstream.ninja/', 'wss://io.socialstream.ninja/dock']) {
                networkProbes.push(new Promise(resolve => {
                    const probe = { endpoint: endpoint(url), status: 'timeout', joinedRoom: false };
                    let ws, timer, done = false;
                    const finish = status => {
                        if (done) return;
                        done = true; clearTimeout(timer); probe.status = status;
                        if (ws) { ws.onopen = ws.onerror = ws.onclose = null; try { ws.close(); } catch (_) {} }
                        resolve(probe);
                    };
                    timer = setTimeout(() => finish('timeout'), 1400);
                    try {
                        ws = new WebSocket(url);
                        ws.onopen = () => finish('open');
                        ws.onerror = () => finish('error');
                        ws.onclose = event => { probe.closeCode = count(event.code); finish('closed'); };
                    } catch (_) { finish('unavailable'); }
                }));
            }
        }
        await new Promise(resolve => setTimeout(resolve, 900));
        result.networkProbes = await Promise.all(networkProbes);
    } finally {
        for (const cleanup of cleanups) cleanup();
    }
    return result;
}

async function collectConnectionDiagnostics({ contents, primaryContents, isSocialStreamUrl, savedState }) {
    const started = Date.now();
    const report = { schemaVersion: 2, capturedAt: new Date(started).toISOString(), scope: 'ssapp',
        externalBrowsersInspected: false, history: 'existing_state_and_report_time_observation',
        deliveryValidation: 'not_performed',
        runtime: { electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform,
            architecture: process.arch, osRelease: os.release(), uptimeSeconds: Math.round(process.uptime()) },
        frames: [], framesTruncated: false, proxyRoutes: [] };
    const targets = [];
    const surfaces = new Map();
    for (const wc of contents) {
        try {
            if (wc.isDestroyed() || wc.getType() === 'devtools') continue;
            const frames = wc.mainFrame.framesInSubtree;
            for (const frame of frames) {
                try {
                    const url = new URL(frame.url);
                    const page = url.pathname.split('/').pop().replace(/\.html$/i, '');
                    let role;
                    if (wc === primaryContents && frame === wc.mainFrame) role = 'shell';
                    else if (isSocialStreamUrl(frame.url) && ['background', 'dock', 'featured', 'popup'].includes(page)) role = ['background', 'popup'].includes(page) ? page : 'overlay';
                    else if (url.hostname === 'vdo.socialstream.ninja' && frame.parent && isSocialStreamUrl(frame.parent.url)) role = 'bridge';
                    if (!role) continue;
                    if (!surfaces.has(wc)) surfaces.set(wc, surfaces.size + 1);
                    targets.push({ frame, wc, role, id: targets.length + 1, page: role === 'bridge' ? 'vdo' : page,
                        asset: url.protocol === 'file:' ? 'local' : url.hostname === 'beta.socialstream.ninja' || url.pathname.startsWith('/beta/') ? 'beta' : 'stable' });
                } catch (_) { /* A detached/blank frame must not hide its siblings. */ }
            }
        } catch (_) {}
    }
    // Collect the active background before optional windows can use the budget.
    const priority = target => target.wc === primaryContents ?
        ({ background: 0, shell: 1, popup: 2, bridge: 3 }[target.role] ?? 4) : 5;
    targets.sort((a, b) => priority(a) - priority(b));
    if (targets.length > FRAME_LIMIT) {
        targets.length = FRAME_LIMIT;
        report.framesTruncated = true;
    }
    const roomGroups = new Map();
    const passwordGroups = new Map();
    const group = (map, value) => {
        if (!map.has(value)) map.set(value, map.size + 1);
        return map.get(value);
    };
    function identify(item) {
        const room = typeof item._room === 'string' ? item._room : '';
        const password = !item._password || ['false', 'off', '0'].includes(item._password) ? '' : String(item._password);
        delete item._room;
        delete item._password;
        item.roomGroup = room ? group(roomGroups, room) : null;
        item.passwordSet = !!password;
        item.passwordGroup = password ? group(passwordGroups, password) : null;
    }
    if (savedState) {
        const flag = value => value && typeof value === 'object' ? flag(value.setting) : value === true || value === 1 || /^(true|1|on|yes)$/i.test(String(value));
        report.saved = { enabled: !!savedState.state, _room: savedState.streamID, _password: savedState.password, transportFlags: {} };
        for (const key of ['server', 'server2', 'server3', 'server2additivedelivery', 'lanonly', 'sdk', 'usesdk', 'disablehost']) report.saved.transportFlags[key] = flag(savedState.settings?.[key]);
        identify(report.saved);
    }
    // Resolve proxy routes for the standard endpoints. Keep proxy types only:
    // proxy addresses and PAC credentials do not belong in reports.
    const sessions = [...new Set(targets.filter(target => target.role === 'background' || target.role === 'shell').map(target => target.wc.session))].slice(0, 2);
    const proxyWork = Promise.all(sessions.map(async (browserSession, index) => {
        for (const host of ['wss.socialstream.ninja', 'io.socialstream.ninja']) {
            const route = { background: index + 1, host, status: 'unavailable' };
            try {
                const value = await withTimeout(browserSession.resolveProxy('https://' + host), 800, null);
                route.status = value === null ? 'timeout' : 'ok';
                route.types = value === null ? [] : value.split(';').map(part => part.trim().split(/\s+/)[0])
                    .filter(type => ['DIRECT', 'PROXY', 'HTTPS', 'SOCKS', 'SOCKS4', 'SOCKS5'].includes(type)).slice(0, 8);
            } catch (_) {}
            report.proxyRoutes.push(route);
        }
    }));
    const networkWork = (async () => {
        report.serviceChecks = [];
        const browserSession = primaryContents?.session || sessions[0];
        if (!browserSession) return;
        const hosts = ['socialstream.ninja', 'vdo.socialstream.ninja', 'wss.socialstream.ninja', 'io.socialstream.ninja'];
        let cursor = 0;
        const errorCode = error => String(error?.message || '').match(/\bERR_[A-Z_]{2,60}\b/)?.[0] || 'unavailable';
        async function probe() {
            while (cursor < hosts.length) {
                const host = hosts[cursor++];
                const entry = { host };
                report.serviceChecks.push(entry);
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 1600);
                try {
                    const dns = withTimeout(browserSession.resolveHost(host).then(value => ({ status: 'resolved',
                        addressFamilies: [...new Set((value.endpoints || []).map(endpoint => endpoint.family).filter(family => family === 'ipv4' || family === 'ipv6'))] }))
                        .catch(error => ({ status: 'failed', code: errorCode(error) })), 1600, { status: 'timeout' });
                    const http = withTimeout(browserSession.fetch('https://' + host + '/', { method: 'HEAD', credentials: 'omit', redirect: 'manual', signal: controller.signal })
                        .then(response => ({ status: 'responded', httpStatus: response.status }))
                        .catch(error => ({ status: controller.signal.aborted ? 'timeout' : 'failed', code: errorCode(error) })), 1700, { status: 'timeout' });
                    [entry.dns, entry.https] = await Promise.all([dns, http]);
                } catch (_) { entry.status = 'unavailable'; }
                finally { clearTimeout(timer); controller.abort(); }
            }
        }
        await Promise.all([probe(), probe()]);
    })();
    let next = 0;
    async function worker() {
        while (next < targets.length && Date.now() - started < REPORT_TIMEOUT_MS) {
            const target = targets[next++];
            const item = { frame: target.id, page: target.page, asset: target.asset, role: target.role, surface: surfaces.get(target.wc) };
            item.primaryBackground = target.role === 'background' && target.wc === primaryContents;
            report.frames.push(item);
            try {
                item.parentFrame = targets.find(parent => parent.frame === target.frame.parent)?.id || null;
                item.rendererCrashed = target.wc.isCrashed();
                item.surfaceLoading = target.wc.isLoading();
                const expectedUrl = target.frame.url;
                const probeNetwork = target.wc === primaryContents && (target.role === 'background' ||
                    (target.role === 'shell' && !targets.some(other => other.wc === primaryContents && other.role === 'background')));
                const data = await withTimeout(target.frame.executeJavaScript(`(${readConnectionState.toString()})(${JSON.stringify(target.role)}, ${probeNetwork})`),
                    Math.min(FRAME_TIMEOUT_MS, REPORT_TIMEOUT_MS - (Date.now() - started)), { status: 'timeout' });
                if (target.frame.url !== expectedUrl) { item.status = 'navigated'; continue; }
                identify(data);
                for (const link of data.generatedLinks || []) identify(link);
                Object.assign(item, data);
            } catch (_) { item.status = 'unavailable'; }
        }
    }
    // Browser-level load/console failures do not always raise a page error.
    // Observe only the inspected app surfaces, only while this report is running.
    report.rendererEvents = [];
    const removeListeners = [];
    for (const wc of new Set(targets.map(target => target.wc))) {
        const record = event => {
            if (report.rendererEvents.length < 40) report.rendererEvents.push({ surface: surfaces.get(wc), ...event });
        };
        const onConsole = event => {
            if (!['warning', 'error'].includes(event.level)) return;
            const networkError = String(event.message || '').match(/\bERR_[A-Z_]{2,60}\b/)?.[0] || null;
            record({ kind: 'console', level: event.level, networkError,
                frame: targets.find(target => target.frame === event.frame)?.id || null,
                line: Number.isFinite(event.lineNumber) ? event.lineNumber : null });
        };
        const onLoadFailed = (_event, code, _description, _url, isMainFrame) => record({ kind: 'load-failed', code, isMainFrame: !!isMainFrame });
        const onGone = (_event, details) => record({ kind: 'renderer-gone',
            reason: ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure'].includes(details.reason) ? details.reason : 'other' });
        for (const [name, listener] of [['console-message', onConsole], ['did-fail-load', onLoadFailed], ['render-process-gone', onGone]]) {
            wc.on(name, listener);
            removeListeners.push(() => wc.removeListener(name, listener));
        }
    }
    try {
        // Bound concurrent renderer work and report latency even with hung pages.
        await Promise.all([worker(), worker()]);
        await Promise.all([proxyWork, networkWork]);
    } finally {
        for (const remove of removeListeners) remove();
    }
    report.framesTruncated = report.framesTruncated || next < targets.length;
    const background = report.frames.find(frame => frame.status === 'ok' &&
        (primaryContents ? frame.primaryBackground : frame.role === 'background'));
    report.backgroundAvailable = !!background;
    report.apiChatExcludesP2P = !!(background?.transportFlags?.server2 && !background.transportFlags.server2additivedelivery &&
        background.sockets?.some(socket => socket.name === 'dock-relay' && socket.state === 'open'));
    for (const frame of report.frames) {
        frame.loadedBridgeFrames = report.frames.filter(child => child.parentFrame === frame.frame && child.role === 'bridge').length;
        frame.bridgeFramesMissing = (frame.bridgeElements?.length || 0) > frame.loadedBridgeFrames;
        if (!background || frame.status !== 'ok' || frame.role === 'background') continue;
        if (frame.role === 'overlay' || frame.role === 'bridge') {
            frame.matchesBackgroundRoom = frame.roomGroup === null || background.roomGroup === null ? null : frame.roomGroup === background.roomGroup;
            frame.matchesBackgroundPassword = frame.passwordGroup === background.passwordGroup;
        }
        for (const link of frame.generatedLinks || []) {
            link.matchesBackgroundRoom = link.roomGroup === null || background.roomGroup === null ? null : link.roomGroup === background.roomGroup;
            link.matchesBackgroundPassword = link.passwordGroup === background.passwordGroup;
        }
    }
    if (background && report.saved) {
        report.saved.matchesActiveRoom = report.saved.roomGroup === background.roomGroup;
        report.saved.matchesActivePassword = report.saved.passwordGroup === background.passwordGroup;
        report.saved.differsFromActiveFlags = Object.keys(report.saved.transportFlags).filter(key => report.saved.transportFlags[key] !== background.transportFlags[key]);
    }
    report.findings = [];
    if (!background) report.findings.push({ code: 'background_unavailable' });
    if (background?.enabled === false) report.findings.push({ code: 'app_disabled' });
    if (report.apiChatExcludesP2P) report.findings.push({ code: 'server_chat_excludes_p2p' });
    if (background?.health?.signalingPeerCount > 0 && background.health.p2pPeerCount === 0) report.findings.push({ code: 'peers_discovered_without_p2p_connection' });
    if (report.saved?.differsFromActiveFlags?.length || report.saved?.matchesActiveRoom === false ||
        report.saved?.matchesActivePassword === false || (background && report.saved && report.saved.enabled !== background.enabled)) {
        report.findings.push({ code: 'saved_active_settings_differ' });
    }
    for (const frame of report.frames) {
        for (const probe of frame.networkProbes || []) {
            if (probe.status !== 'open') report.findings.push({ frame: frame.frame, code: 'websocket_probe_failed', host: probe.endpoint?.host, status: probe.status });
        }
        for (const link of frame.generatedLinks || []) {
            if (link.matchesBackgroundRoom === false || link.matchesBackgroundPassword === false ||
                (link.available && report.apiChatExcludesP2P && !link.flags.server2)) {
                report.findings.push({ frame: frame.frame, target: link.target, code: 'generated_link_settings_differ' });
            }
        }
        for (const [condition, code] of [[frame.matchesBackgroundRoom === false, 'room_mismatch'],
            [frame.matchesBackgroundPassword === false, 'password_mismatch'], [frame.bridgeFramesMissing, 'bridge_not_loaded'],
            [frame.display?.paused, 'overlay_paused'], [frame.display?.searchFilterActive, 'overlay_search_active'],
            [frame.loader?.status === 'failed', 'script_load_failed'],
            [frame.transportFlags?.transparentmode && !frame.transportFlags.transparent, 'unsupported_transparency_parameter'],
            [frame.role === 'overlay' && report.apiChatExcludesP2P && !frame.transportFlags?.server2, 'overlay_missing_server_chat_flag']]) {
            if (condition) report.findings.push({ frame: frame.frame, code });
        }
    }
    for (const check of report.serviceChecks) {
        if (check.dns?.status !== 'resolved') report.findings.push({ code: 'dns_probe_failed', host: check.host, status: check.dns?.status });
        if (check.https?.status !== 'responded') report.findings.push({ code: 'https_probe_failed', host: check.host, status: check.https?.status });
        else if (check.https.httpStatus >= 400 && check.https.httpStatus !== 426) report.findings.push({ code: 'https_error_status', host: check.host, httpStatus: check.https.httpStatus });
    }
    report.durationMs = Date.now() - started;
    report.statsTruncated = false;
    if (JSON.stringify(report).length > 96000) {
        for (const frame of report.frames) {
            for (const peer of frame.peers || []) {
                delete peer.candidates;
                delete peer.iceServers;
            }
        }
        report.statsTruncated = true;
        let size = JSON.stringify(report).length;
        for (const frame of report.frames) {
            while (size > 94000 && frame.peers?.length) {
                size -= JSON.stringify(frame.peers.pop()).length + 1;
                frame.peersTruncated = true;
            }
        }
    }
    report.status = !background || report.framesTruncated || report.statsTruncated || report.proxyRoutes.some(route => route.status !== 'ok') ||
        report.frames.some(frame => frame.status !== 'ok' || frame.peersTruncated || frame.bridgeFramesMissing || frame.legacy?.available === false ||
            frame.health?.status === 'unavailable' || frame.peers?.some(peer => peer.statsStatus !== 'ok')) ? 'partial' : 'ok';
    report.statusMeaning = 'collection_completeness_not_connection_health';
    return report;
}

module.exports = { collectConnectionDiagnostics };
