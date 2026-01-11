'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const PUSHER_KEY = '32cbd69e4b950bf97679';
const PUSHER_QUERY = 'protocol=7&client=js&version=8.4.0&flash=false';
const DEFAULT_CLUSTERS = [
    'us2',
    'us3',
    'mt1',
    'eu',
    'ap1',
    'ap2',
    'ap3',
    'ap4',
    'sa1',
    'ws.pusher.com',
    'ws.pusherapp.com'
];
let cachedCluster = null;

const DEFAULT_SITE_API_BASE = 'https://kick.com/api/v2';
const DEFAULT_SITE_PROXY_BASE = 'https://r.jina.ai/http://kick.com/api/v2';
const DEFAULT_PROXY_USER_AGENT = 'Mozilla/5.0';

function normalizeApiBase(value) {
    if (!value || typeof value !== 'string') return '';
    return value.replace(/\/+$/, '');
}

function buildPusherUrl(cluster, key, query) {
    const chosen = cluster || DEFAULT_CLUSTERS[0];
    const host = chosen.includes('.') ? chosen : `ws-${chosen}.pusher.com`;
    return `wss://${host}/app/${key || PUSHER_KEY}?${query || PUSHER_QUERY}`;
}
const PUBLIC_API_BASE = 'https://api.kick.com/public/v1';

const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function resolveFetch() {
    if (typeof fetch === 'function') {
        return fetch.bind(globalThis);
    }
    try {
        return require('undici').fetch;
    } catch (_) {
        return null;
    }
}

function normalizeSlug(value) {
    if (!value) return '';
    return String(value).trim().replace(/^@+/, '');
}

function parseJsonPayload(text, contextLabel) {
    if (!text || typeof text !== 'string') {
        throw new Error(`Invalid JSON response from ${contextLabel}.`);
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.data && typeof parsed.data.content === 'string') {
            const content = parsed.data.content.trim();
            if (content) {
                try {
                    return JSON.parse(content);
                } catch (_) {
                    throw new Error(`Invalid JSON response from ${contextLabel}.`);
                }
            }
        }
        return parsed;
    } catch (_) {}
    const marker = 'Markdown Content:';
    const idx = text.indexOf(marker);
    if (idx >= 0) {
        const payload = text.slice(idx + marker.length).trim();
        if (payload) {
            try {
                return JSON.parse(payload);
            } catch (_) {}
        }
    }
    const sample = text.slice(0, 200).trim();
    throw new Error(`Invalid JSON response from ${contextLabel}${sample ? `: ${sample}` : ''}`);
}

function isSecurityPolicyError(error) {
    const message = (error?.message || '').toLowerCase();
    const body = (error?.body || '').toLowerCase();
    return (
        error?.status === 403 ||
        message.includes('security policy') ||
        message.includes('captcha') ||
        message.includes('just a moment') ||
        body.includes('security policy') ||
        body.includes('captcha') ||
        body.includes('just a moment')
    );
}

async function fetchKickSiteJson(fetchFn, url, userAgent, slug) {
    const response = await fetchFn(url, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': userAgent,
            'Referer': `https://kick.com/${slug}`,
            'Origin': 'https://kick.com'
        }
    });
    const body = await response.text();
    if (!response.ok) {
        const error = new Error(`Kick site lookup ${response.status}: ${body}`);
        error.status = response.status;
        error.body = body;
        throw error;
    }
    return parseJsonPayload(body, 'Kick site lookup');
}

async function fetchKickChannel(slug, options = {}) {
    const safeSlug = normalizeSlug(slug);
    if (!safeSlug) {
        throw new Error('Kick channel slug required.');
    }

    const fetchFn = resolveFetch();
    if (!fetchFn) {
        throw new Error('No fetch implementation available for Kick channel lookup.');
    }

    const userAgent = options.userAgent || DEFAULT_USER_AGENT;
    const accessToken = options.accessToken || options.token || null;
    const clientId = options.clientId || options.clientID || null;
    let lastError = null;
    const siteApiBase = normalizeApiBase(options.siteApiBase) || DEFAULT_SITE_API_BASE;
    const siteProxyBase = normalizeApiBase(options.siteApiProxyBase) || DEFAULT_SITE_PROXY_BASE;
    const allowProxy = options.allowProxy !== false;
    const siteLookupOptions = {
        siteApiBase,
        siteProxyBase: allowProxy ? siteProxyBase : '',
        proxyUserAgent: options.proxyUserAgent || DEFAULT_PROXY_USER_AGENT,
        logger: options.logger
    };
    let result = null;

    if (accessToken) {
        try {
            result = await fetchKickChannelFromApi(fetchFn, safeSlug, userAgent, accessToken, clientId);
        } catch (error) {
            lastError = error;
            if (typeof options.logger === 'function') {
                options.logger('[KickWs] Token channel lookup failed', error?.message || error);
            }
        }
    }

    if (!result || !result.chatroomId || !result.channelId) {
        try {
            const siteResult = await fetchKickChannelFromSite(fetchFn, safeSlug, userAgent, siteLookupOptions);
            if (!result) {
                result = siteResult;
            } else {
                result.chatroomId = result.chatroomId || siteResult.chatroomId;
                result.channelId = result.channelId || siteResult.channelId;
                result.userId = result.userId || siteResult.userId;
                result.slug = result.slug || siteResult.slug;
                if (!result.data) {
                    result.data = siteResult.data;
                }
            }
        } catch (error) {
            lastError = error;
        }
    }

    if (result && !result.chatroomId) {
        try {
            const chatroomResult = await fetchKickChatroomFromSite(fetchFn, safeSlug, userAgent, siteLookupOptions);
            if (chatroomResult?.chatroomId) {
                result.chatroomId = chatroomResult.chatroomId;
            }
        } catch (error) {
            lastError = error;
        }
    }

    if (result) {
        return result;
    }

    throw lastError || new Error('Kick channel lookup failed.');
}

async function fetchKickChannelFromApi(fetchFn, slug, userAgent, accessToken, clientId) {
    const url = `${PUBLIC_API_BASE}/channels?slug=${encodeURIComponent(slug)}`;
    const headers = {
        'Accept': 'application/json',
        'User-Agent': userAgent,
        'Authorization': `Bearer ${accessToken}`
    };
    if (clientId) {
        headers['Client-Id'] = clientId;
    }

    const response = await fetchFn(url, { headers });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Kick channel lookup (api) ${response.status}: ${body}`);
    }
    const payload = await response.json();
    const items = Array.isArray(payload?.data) ? payload.data : (payload?.data ? [payload.data] : []);
    const channel = items.find(item => normalizeSlug(item?.slug || item?.username || item?.user?.username) === slug)
        || items[0]
        || payload?.channel
        || payload;
    const chatroomId = channel?.chatroom_id ?? channel?.chatroom?.id ?? channel?.chatroomId ?? null;
    const channelId =
        channel?.chatroom?.channel_id ??
        channel?.channel_id ??
        channel?.channelId ??
        channel?.id ??
        null;
    const userId =
        channel?.user_id ??
        channel?.user?.id ??
        channel?.broadcaster_user_id ??
        null;
    const resolvedSlug = channel?.slug || channel?.username || channel?.user?.username || slug;
    return { data: channel, chatroomId, channelId, userId, slug: resolvedSlug };
}

async function fetchKickChannelFromSite(fetchFn, slug, userAgent, options = {}) {
    const siteApiBase = normalizeApiBase(options.siteApiBase) || DEFAULT_SITE_API_BASE;
    const proxyBase = normalizeApiBase(options.siteProxyBase || '');
    const url = `${siteApiBase}/channels/${encodeURIComponent(slug)}`;
    try {
        const data = await fetchKickSiteJson(fetchFn, url, userAgent, slug);
        const chatroomId = data?.chatroom?.id ?? data?.chatroom_id ?? null;
        const channelId = data?.chatroom?.channel_id ?? data?.channel_id ?? data?.id ?? null;
        const userId =
            data?.user_id ??
            data?.user?.id ??
            data?.broadcaster_user_id ??
            null;
        const resolvedSlug = data?.slug || data?.username || slug;
        return { data, chatroomId, channelId, userId, slug: resolvedSlug };
    } catch (error) {
        if (proxyBase && proxyBase !== siteApiBase && isSecurityPolicyError(error)) {
            if (typeof options.logger === 'function') {
                options.logger('[KickWs] Falling back to Kick site proxy for channel lookup.');
            }
            const proxyUrl = `${proxyBase}/channels/${encodeURIComponent(slug)}`;
            const proxyUserAgent = options.proxyUserAgent || DEFAULT_PROXY_USER_AGENT;
            const data = await fetchKickSiteJson(fetchFn, proxyUrl, proxyUserAgent, slug);
            const chatroomId = data?.chatroom?.id ?? data?.chatroom_id ?? null;
            const channelId = data?.chatroom?.channel_id ?? data?.channel_id ?? data?.id ?? null;
            const userId =
                data?.user_id ??
                data?.user?.id ??
                data?.broadcaster_user_id ??
                null;
            const resolvedSlug = data?.slug || data?.username || slug;
            return { data, chatroomId, channelId, userId, slug: resolvedSlug };
        }
        throw error;
    }
}

async function fetchKickChatroomFromSite(fetchFn, slug, userAgent, options = {}) {
    const siteApiBase = normalizeApiBase(options.siteApiBase) || DEFAULT_SITE_API_BASE;
    const proxyBase = normalizeApiBase(options.siteProxyBase || '');
    const url = `${siteApiBase}/channels/${encodeURIComponent(slug)}/chatroom`;
    try {
        const data = await fetchKickSiteJson(fetchFn, url, userAgent, slug);
        const chatroomId = data?.id ?? data?.chatroom_id ?? null;
        return { data, chatroomId, slug };
    } catch (error) {
        if (proxyBase && proxyBase !== siteApiBase && isSecurityPolicyError(error)) {
            if (typeof options.logger === 'function') {
                options.logger('[KickWs] Falling back to Kick site proxy for chatroom lookup.');
            }
            const proxyUrl = `${proxyBase}/channels/${encodeURIComponent(slug)}/chatroom`;
            const proxyUserAgent = options.proxyUserAgent || DEFAULT_PROXY_USER_AGENT;
            const data = await fetchKickSiteJson(fetchFn, proxyUrl, proxyUserAgent, slug);
            const chatroomId = data?.id ?? data?.chatroom_id ?? null;
            return { data, chatroomId, slug };
        }
        throw error;
    }
}

function buildSubscribePayload(channel) {
    return JSON.stringify({
        event: 'pusher:subscribe',
        data: {
            auth: '',
            channel
        }
    });
}

class KickWsClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.slug = normalizeSlug(options.slug);
        this.chatroomId = options.chatroomId ?? null;
        this.channelId = options.channelId ?? null;
        this.userId = options.userId ?? null;
        this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
        this.origin = options.origin || 'https://kick.com';
        this.accessToken = options.accessToken || null;
        this.clientId = options.clientId || null;
        this.pusherKey = options.pusherKey || PUSHER_KEY;
        this.pusherQuery = options.pusherQuery || PUSHER_QUERY;
        this.siteApiBase = options.siteApiBase || '';
        this.siteApiProxyBase = options.siteApiProxyBase || '';
        this.allowProxy = options.allowProxy !== false;
        this.logger = typeof options.logger === 'function' ? options.logger : null;
        this.reconnectDelayMs = options.reconnectDelayMs || 2000;
        this.maxReconnectDelayMs = options.maxReconnectDelayMs || 15000;
        this.clusterCandidates = Array.isArray(options.clusterCandidates) && options.clusterCandidates.length
            ? options.clusterCandidates.slice()
            : DEFAULT_CLUSTERS.slice();
        this.cluster = options.cluster || cachedCluster || this.clusterCandidates[0];
        this._clusterFailures = 0;

        this.ws = null;
        this.socketId = null;
        this._connectPromise = null;
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this._shouldReconnect = true;
        this._suppressReconnect = false;
        this.status = 'disconnected';
    }

    log(...args) {
        if (this.logger) {
            this.logger(...args);
        }
    }

    async connect() {
        if (this._connectPromise) {
            return this._connectPromise;
        }
        this._shouldReconnect = true;
        this._connectPromise = this._connectInternal()
            .finally(() => {
                this._connectPromise = null;
            });
        return this._connectPromise;
    }

    async _connectInternal() {
        if (!this.slug) {
            throw new Error('Kick channel slug required.');
        }

        if (!this.chatroomId) {
            await this.resolveIds();
        }

        if (!this.chatroomId) {
            const fallbackId = this.channelId || this.userId || null;
            if (fallbackId) {
                this.chatroomId = fallbackId;
                this.log('[KickWs] Using channel/user id as chatroom id fallback:', fallbackId);
            }
        }

        if (!this.chatroomId) {
            throw new Error('Kick chatroom id could not be resolved.');
        }

        await this._openSocket();
        this._subscribe();
        return true;
    }

    async resolveIds() {
        const result = await fetchKickChannel(this.slug, {
            userAgent: this.userAgent,
            accessToken: this.accessToken,
            clientId: this.clientId,
            logger: this.logger,
            siteApiBase: this.siteApiBase,
            siteApiProxyBase: this.siteApiProxyBase,
            allowProxy: this.allowProxy
        });
        if (result.chatroomId) this.chatroomId = result.chatroomId;
        if (result.channelId) this.channelId = result.channelId;
        if (result.userId) this.userId = result.userId;
        if (result.slug) this.slug = result.slug;
        this.emit('resolved', {
            slug: this.slug,
            chatroomId: this.chatroomId,
            channelId: this.channelId,
            userId: this.userId
        });
        return result;
    }

    async _openSocket() {
        this._clearReconnectTimer();
        if (this.ws) {
            try { this.ws.close(); } catch (_) {}
            this.ws = null;
        }
        this._emitStatus('connecting');

        return new Promise((resolve, reject) => {
            let settled = false;
            const ws = new WebSocket(buildPusherUrl(this.cluster, this.pusherKey, this.pusherQuery), {
                headers: {
                    'User-Agent': this.userAgent,
                    'Origin': this.origin
                }
            });
            this.ws = ws;

            ws.on('open', () => {
                this._reconnectAttempts = 0;
                cachedCluster = this.cluster;
                this._emitStatus('connected');
                settled = true;
                resolve();
            });

            ws.on('message', (data) => {
                this._handleMessage(data);
            });

            ws.on('close', (code, reason) => {
                this.socketId = null;
                if (this.status !== 'disconnected') {
                    this._emitStatus('disconnected', {
                        code,
                        reason: reason ? reason.toString() : ''
                    });
                }
                if (!settled) {
                    settled = true;
                    reject(new Error('Kick websocket closed before open.'));
                }
                if (this._suppressReconnect) {
                    this._suppressReconnect = false;
                } else {
                    this._scheduleReconnect();
                }
            });

            ws.on('error', (error) => {
                const message = error?.message || String(error);
                if (!this._handleClusterError({ message })) {
                    this._emitStatus('error', { error: message });
                }
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            });
        });
    }

    _subscribe() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        const chatroomChannel = `chatrooms.${this.chatroomId}.v2`;
        this.ws.send(buildSubscribePayload(chatroomChannel));
        if (this.channelId) {
            const channelChannel = `channel.${this.channelId}`;
            this.ws.send(buildSubscribePayload(channelChannel));
        }
    }

    _handleMessage(raw) {
        let message;
        try {
            const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
            message = JSON.parse(text);
        } catch (_) {
            return;
        }

        if (!message || typeof message !== 'object') return;
        const event = message.event;

        if (event === 'pusher:ping') {
            this._sendPong();
            return;
        }

        if (event === 'pusher:connection_established') {
            try {
                const payload = JSON.parse(message.data || '{}');
                this.socketId = payload.socket_id || null;
            } catch (_) {}
            return;
        }

        if (event === 'pusher:error') {
            const errorData = this._parsePusherError(message.data);
            if (!this._handleClusterError(errorData)) {
                this._emitStatus('error', { error: errorData || 'Pusher error' });
            }
            return;
        }

        if (typeof message.data === 'string' && event) {
            this._emitEvent(event, message.data, message.channel);
        }
    }

    _parsePusherError(data) {
        if (data && typeof data === 'object') {
            return data;
        }
        if (typeof data === 'string') {
            try {
                return JSON.parse(data);
            } catch (_) {
                return { message: data };
            }
        }
        return { message: 'Pusher error' };
    }

    _handleClusterError(errorData) {
        const code = errorData?.code;
        const message = typeof errorData?.message === 'string' ? errorData.message : '';
        const isClusterError =
            code === 4001 || /not in this cluster/i.test(message || '');
        const isDnsError =
            /ENOTFOUND/i.test(message || '') ||
            /EAI_AGAIN/i.test(message || '') ||
            /getaddrinfo/i.test(message || '');
        if (!isClusterError && !isDnsError) {
            return false;
        }
        if (!isClusterError) {
            this.log('[KickWs] Cluster host unreachable', message || 'Unknown error');
        }
        const nextCluster = this._nextCluster();
        if (!nextCluster) {
            this._emitStatus('error', {
                error: message || 'No matching Pusher cluster found.'
            });
            this._shouldReconnect = false;
            return true;
        }
        this._clusterFailures += 1;
        this.log('[KickWs] Switching Pusher cluster', {
            from: this.cluster,
            to: nextCluster
        });
        this.cluster = nextCluster;
        this._reconnectAttempts = 0;
        this._clearReconnectTimer();
        if (this.ws) {
            this._suppressReconnect = true;
            try { this.ws.close(); } catch (_) {}
            this.ws = null;
        }
        setTimeout(() => {
            this.connect().catch((err) => {
                this.log('[KickWs] reconnect failed', err?.message || err);
            });
        }, 100);
        return true;
    }

    _nextCluster() {
        if (!this.clusterCandidates.length) {
            return null;
        }
        const currentIndex = this.clusterCandidates.indexOf(this.cluster);
        const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
        for (let i = startIndex; i < this.clusterCandidates.length; i += 1) {
            const candidate = this.clusterCandidates[i];
            if (candidate && candidate !== this.cluster) {
                return candidate;
            }
        }
        return null;
    }

    _emitEvent(eventName, payload, channel) {
        let parsed = null;
        try {
            parsed = JSON.parse(payload);
        } catch (_) {
            parsed = null;
        }

        if (eventName === 'App\\Events\\ChatMessageEvent' && parsed) {
            this.emit('chat', parsed);
            return;
        }

        this.emit('event', {
            event: eventName,
            data: parsed || payload,
            channel: channel || null
        });
    }

    _sendPong() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        try {
            this.ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
        } catch (_) {}
    }

    _emitStatus(status, meta = {}) {
        this.status = status;
        this.emit('status', { status, ...meta });
    }

    _scheduleReconnect() {
        if (!this._shouldReconnect) return;
        if (this._reconnectTimer) return;
        const attempt = this._reconnectAttempts;
        const delay = Math.min(
            this.reconnectDelayMs * Math.pow(2, attempt),
            this.maxReconnectDelayMs
        );
        this._reconnectAttempts += 1;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect().catch((err) => {
                this.log('[KickWs] reconnect failed', err?.message || err);
            });
        }, delay);
    }

    _clearReconnectTimer() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    stop() {
        this._shouldReconnect = false;
        this._clearReconnectTimer();
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close();
            } catch (_) {}
            this.ws = null;
        }
        this._emitStatus('disconnected');
    }
}

module.exports = {
    KickWsClient,
    fetchKickChannel
};
