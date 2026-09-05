'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const DEFAULT_API_BASE = 'https://discord.com/api/v10';
const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_CONNECT_TIMEOUT_MS = 25000;
const DEFAULT_USER_AGENT = 'DiscordBot (https://socialstream.ninja, 1.0)';
const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 15); // GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT
const PERMISSION_ADMINISTRATOR = 1n << 3n;
const PERMISSION_VIEW_CHANNEL = 1n << 10n;
const PERMISSION_SEND_MESSAGES = 1n << 11n;
const SUPPORTED_CHANNEL_TYPES = new Set([0, 5]); // Guild text and announcement channels.
const FATAL_GATEWAY_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const NON_RESUMABLE_GATEWAY_CLOSE_CODES = new Set([4007, 4009]);
const MAX_RECENT_MESSAGE_IDS = 2000;
const MAX_OUTBOUND_MESSAGE_IDS = 500;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringValue(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

function parsePermissionBits(value) {
    try {
        return BigInt(String(value || '0'));
    } catch (_) {
        return 0n;
    }
}

/**
 * Resolve a guild member's effective channel permissions using Discord's documented
 * base-role and channel-overwrite ordering.
 */
function computeChannelPermissions(guild, channel, member) {
    if (!guild || !channel || !member) return 0n;

    const roles = Array.isArray(guild.roles) ? guild.roles : [];
    const memberRoleIds = new Set(Array.isArray(member.roles) ? member.roles.map(String) : []);
    let permissions = 0n;

    const everyoneRole = roles.find((role) => String(role.id) === String(guild.id));
    if (everyoneRole) permissions |= parsePermissionBits(everyoneRole.permissions);
    for (const role of roles) {
        if (memberRoleIds.has(String(role.id))) {
            permissions |= parsePermissionBits(role.permissions);
        }
    }

    if ((permissions & PERMISSION_ADMINISTRATOR) === PERMISSION_ADMINISTRATOR) {
        return (1n << 63n) - 1n;
    }

    const overwrites = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites : [];
    const everyoneOverwrite = overwrites.find((overwrite) =>
        Number(overwrite.type) === 0 && String(overwrite.id) === String(guild.id)
    );
    if (everyoneOverwrite) {
        permissions &= ~parsePermissionBits(everyoneOverwrite.deny);
        permissions |= parsePermissionBits(everyoneOverwrite.allow);
    }

    let roleAllow = 0n;
    let roleDeny = 0n;
    for (const overwrite of overwrites) {
        if (Number(overwrite.type) !== 0 || !memberRoleIds.has(String(overwrite.id))) continue;
        roleAllow |= parsePermissionBits(overwrite.allow);
        roleDeny |= parsePermissionBits(overwrite.deny);
    }
    permissions &= ~roleDeny;
    permissions |= roleAllow;

    const memberOverwrite = overwrites.find((overwrite) =>
        Number(overwrite.type) === 1 && String(overwrite.id) === String(member.user?.id || member.id || '')
    );
    if (memberOverwrite) {
        permissions &= ~parsePermissionBits(memberOverwrite.deny);
        permissions |= parsePermissionBits(memberOverwrite.allow);
    }

    return permissions;
}

function hasPermission(permissions, permission) {
    return (permissions & permission) === permission;
}

function resolveAvatarUrl(message) {
    const author = message?.author || {};
    const member = message?.member || {};
    const userId = stringValue(author.id);
    const guildId = stringValue(message?.guild_id);
    const memberAvatar = stringValue(member.avatar);
    const authorAvatar = stringValue(author.avatar);

    if (guildId && userId && memberAvatar) {
        const extension = memberAvatar.startsWith('a_') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${memberAvatar}.${extension}?size=128`;
    }
    if (userId && authorAvatar) {
        const extension = authorAvatar.startsWith('a_') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/avatars/${userId}/${authorAvatar}.${extension}?size=128`;
    }

    const discriminator = Number(author.discriminator || 0);
    let fallbackIndex = discriminator > 0 ? discriminator % 5 : 0;
    if (discriminator <= 0) {
        try {
            fallbackIndex = Number((BigInt(userId || '0') >> 22n) % 6n);
        } catch (_) { }
    }
    return `https://cdn.discordapp.com/embed/avatars/${fallbackIndex}.png`;
}

function resolveRoleColor(message, guild) {
    const memberRoleIds = new Set(Array.isArray(message?.member?.roles) ? message.member.roles.map(String) : []);
    const roles = Array.isArray(guild?.roles) ? guild.roles : [];
    const colored = roles
        .filter((role) => memberRoleIds.has(String(role.id)) && Number(role.color || 0) > 0)
        .sort((left, right) => Number(right.position || 0) - Number(left.position || 0));
    if (!colored.length) return '';
    return `#${Number(colored[0].color).toString(16).padStart(6, '0')}`;
}

function replaceDiscordTokens(content, message, guild, channelLookup, textOnly = false) {
    let output = String(content || '');
    const mentions = new Map((Array.isArray(message?.mentions) ? message.mentions : []).map((user) => [String(user.id), user]));
    const roles = new Map((Array.isArray(guild?.roles) ? guild.roles : []).map((role) => [String(role.id), role]));

    output = output.replace(/<@!?(\d+)>/g, (_match, id) => {
        const user = mentions.get(String(id));
        return `@${user?.global_name || user?.username || 'user'}`;
    });
    output = output.replace(/<@&(\d+)>/g, (_match, id) => `@${roles.get(String(id))?.name || 'role'}`);
    output = output.replace(/<#(\d+)>/g, (_match, id) => `#${channelLookup?.get(String(id))?.name || 'channel'}`);
    if (textOnly) return output.replace(/<a?:([A-Za-z0-9_]+):\d+>/g, ':$1:');
    output = escapeHtml(output);
    output = output.replace(/&lt;(a?):([A-Za-z0-9_]+):(\d+)&gt;/g, (_match, animated, name, id) => {
        const extension = animated ? 'gif' : 'webp';
        const src = `https://cdn.discordapp.com/emojis/${id}.${extension}?size=64&amp;quality=lossless`;
        return `<img src="${src}" alt=":${escapeHtmlAttribute(name)}:" class="zero-width-emote" />`;
    });
    return output.replace(/\r?\n/g, '<br>');
}

function firstMediaUrl(message) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const imageAttachment = attachments.find((attachment) => {
        const contentType = String(attachment?.content_type || '').toLowerCase();
        const filename = String(attachment?.filename || '').toLowerCase();
        return contentType.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif)$/i.test(filename);
    });
    if (imageAttachment?.url) return String(imageAttachment.url);

    const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
    for (const embed of embeds) {
        const url = embed?.image?.url || embed?.thumbnail?.url || embed?.video?.url;
        if (url) return String(url);
    }

    const sticker = Array.isArray(message?.sticker_items) ? message.sticker_items[0] : null;
    if (sticker?.id) {
        const extension = Number(sticker.format_type) === 4 ? 'gif' : 'png';
        return `https://cdn.discordapp.com/stickers/${sticker.id}.${extension}`;
    }
    return '';
}

function appendAttachmentLinks(chatmessage, message, textOnly = false) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const links = attachments
        .filter((attachment) => {
            if (!attachment?.url) return false;
            const contentType = String(attachment.content_type || '').toLowerCase();
            const filename = String(attachment.filename || '').toLowerCase();
            return !contentType.startsWith('image/') && !/\.(png|jpe?g|gif|webp|avif)$/i.test(filename);
        })
        .map((attachment) => String(attachment.url));
    if (!links.length) return chatmessage;
    const separator = textOnly ? '\n' : '<br>';
    const rendered = links.map((url) => textOnly ? url : escapeHtml(url)).join(separator);
    return chatmessage ? `${chatmessage}${separator}${rendered}` : rendered;
}

function normalizeDiscordMessage(message, context = {}) {
    if (!message || typeof message !== 'object' || !message.author) return null;

    const guild = context.guild || null;
    const channelLookup = context.channelLookup || new Map();
    const displayName = message.member?.nick || message.author.global_name || message.author.username || '';
    let chatmessage = replaceDiscordTokens(message.content || '', message, guild, channelLookup, context.textOnly);

    if (!chatmessage) {
        const embed = Array.isArray(message.embeds) ? message.embeds[0] : null;
        const fallbackText = [embed?.title, embed?.description, embed?.url].filter(Boolean).join('\n');
        chatmessage = replaceDiscordTokens(fallbackText, message, guild, channelLookup, context.textOnly);
    }
    chatmessage = appendAttachmentLinks(chatmessage, message, context.textOnly);

    const contentimg = firstMediaUrl(message);
    if (!displayName && !chatmessage && !contentimg) return null;

    const nameColor = resolveRoleColor(message, guild);
    const payload = {
        id: String(message.id || ''),
        chatname: displayName,
        chatbadges: '',
        backgroundColor: '',
        textColor: '',
        chatmessage,
        chatimg: resolveAvatarUrl(message),
        nameColor,
        hasDonation: '',
        membership: context.discordMemberships && nameColor ? 'MEMBERSHIP' : '',
        contentimg,
        textonly: !!context.textOnly,
        type: 'discord',
        meta: {
            messageId: String(message.id || ''),
            guildId: String(message.guild_id || ''),
            channelId: String(message.channel_id || ''),
        },
    };
    if (message.author.bot === true) payload.bot = true;
    if (message.webhook_id) payload.meta.webhookId = String(message.webhook_id);
    return payload;
}

function splitDiscordMessage(value, maximum = 2000) {
    const text = String(value || '').trim();
    if (!text) return [];
    const result = [];
    let remaining = text;
    while (Array.from(remaining).length > maximum) {
        const points = Array.from(remaining);
        let index = maximum;
        const candidate = points.slice(0, maximum).join('');
        const newlineIndex = candidate.lastIndexOf('\n');
        const spaceIndex = candidate.lastIndexOf(' ');
        const breakIndex = Math.max(newlineIndex, spaceIndex);
        if (breakIndex > Math.floor(maximum * 0.6)) {
            index = Array.from(candidate.slice(0, breakIndex + 1)).length;
        }
        result.push(points.slice(0, index).join('').trimEnd());
        remaining = points.slice(index).join('').trimStart();
    }
    if (remaining) result.push(remaining);
    return result.filter(Boolean);
}

function gatewayCloseError(code) {
    const details = {
        4004: ['SSAPP_DISCORD_INVALID_TOKEN', 'Discord rejected the bot token. Replace the token and try again.'],
        4013: ['SSAPP_DISCORD_INVALID_INTENTS', 'Discord rejected the requested Gateway intents.'],
        4014: ['SSAPP_DISCORD_MESSAGE_CONTENT_INTENT', 'Enable Message Content Intent on the bot page in the Discord Developer Portal.'],
    };
    const [errorCode, message] = details[code] || ['SSAPP_DISCORD_GATEWAY_CLOSED', `Discord closed the Gateway connection (${code}).`];
    const error = new Error(message);
    error.code = errorCode;
    error.gatewayCloseCode = code;
    return error;
}

class DiscordRestClient {
    constructor(token, options = {}) {
        this.token = stringValue(token);
        this.apiBase = String(options.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
        this.fetch = options.fetchImpl || globalThis.fetch;
        this.requestTimeoutMs = Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS;
        this.userAgent = stringValue(options.userAgent) || DEFAULT_USER_AGENT;
        this.channelQueues = new Map();
        if (typeof this.fetch !== 'function') {
            throw new Error('Fetch is unavailable for Discord API requests.');
        }
    }

    async request(pathname, options = {}) {
        const url = `${this.apiBase}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
        const attempts = Math.max(1, Number(options.attempts) || 4);

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
            let response;
            let data = null;
            try {
                response = await this.fetch(url, {
                    method: options.method || 'GET',
                    headers: {
                        Accept: 'application/json',
                        Authorization: `Bot ${this.token}`,
                        'User-Agent': this.userAgent,
                        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                        ...(options.headers || {}),
                    },
                    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
                    signal: controller.signal,
                });
                const text = await response.text();
                if (text) {
                    try {
                        data = JSON.parse(text);
                    } catch (_) {
                        data = { message: text };
                    }
                }
            } catch (error) {
                clearTimeout(timeout);
                if (error?.name === 'AbortError') {
                    const timeoutError = new Error('Discord API request timed out.');
                    timeoutError.code = 'SSAPP_DISCORD_API_TIMEOUT';
                    throw timeoutError;
                }
                throw error;
            } finally {
                clearTimeout(timeout);
            }

            if (response.status === 429 && attempt < attempts) {
                const retryAfterSeconds = Number(data?.retry_after || response.headers.get('retry-after') || 1);
                await sleep(Math.max(250, Math.ceil(retryAfterSeconds * 1000)));
                continue;
            }
            if (!response.ok) {
                const error = new Error(data?.message || `Discord API request failed (${response.status}).`);
                error.code = response.status === 401
                    ? 'SSAPP_DISCORD_INVALID_TOKEN'
                    : response.status === 403
                        ? 'SSAPP_DISCORD_FORBIDDEN'
                        : response.status === 429
                            ? 'SSAPP_DISCORD_RATE_LIMITED'
                            : 'SSAPP_DISCORD_API_ERROR';
                error.status = response.status;
                error.discordCode = data?.code || null;
                throw error;
            }
            return data;
        }

        throw new Error('Discord API request failed.');
    }

    queueChannelRequest(channelId, task) {
        const key = String(channelId || 'global');
        const previous = this.channelQueues.get(key) || Promise.resolve();
        const next = previous.catch(() => {}).then(task);
        const tracked = next.catch(() => {}).finally(() => {
            if (this.channelQueues.get(key) === tracked) this.channelQueues.delete(key);
        });
        this.channelQueues.set(key, tracked);
        return next;
    }
}

class DiscordBotClient extends EventEmitter {
    constructor(token, options = {}) {
        super();
        this.token = stringValue(token);
        this.rest = new DiscordRestClient(this.token, options);
        this.WebSocketImpl = options.WebSocketImpl || WebSocket;
        this.gatewayUrl = stringValue(options.gatewayUrl);
        this.connectTimeoutMs = Number(options.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS;
        this.random = typeof options.random === 'function' ? options.random : Math.random;
        this.getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => ({});

        this.botUser = null;
        this.application = null;
        this.guilds = new Map();
        this.guildDetails = new Map();
        this.channels = new Map();
        this.subscriptions = new Map();
        this.recentMessageIds = new Set();
        this.recentMessageOrder = [];
        this.outboundMessageIds = new Set();
        this.outboundMessageOrder = [];
        this.outboundNonces = new Set();
        this.outboundNonceOrder = [];

        this.socket = null;
        this.sessionId = null;
        this.resumeGatewayUrl = null;
        this.lastSequence = null;
        this.heartbeatTimer = null;
        this.firstHeartbeatTimer = null;
        this.awaitingHeartbeatAck = false;
        this.connectPromise = null;
        this.connectResolve = null;
        this.connectReject = null;
        this.connectTimeout = null;
        this.reconnectTimer = null;
        this.invalidSessionTimer = null;
        this.reconnectAttempt = 0;
        this.manualClose = false;
        this.ready = false;
    }

    async validate() {
        const [botUser, application] = await Promise.all([
            this.rest.request('/users/@me'),
            this.rest.request('/oauth2/applications/@me'),
        ]);
        if (!botUser?.bot) {
            const error = new Error('This token does not belong to a Discord bot.');
            error.code = 'SSAPP_DISCORD_NOT_A_BOT';
            throw error;
        }
        this.botUser = botUser;
        this.application = application;
        return { botUser, application };
    }

    async discoverGuilds() {
        if (!this.botUser || !this.application) await this.validate();
        const guilds = [];
        let after = '';
        for (let page = 0; page < 100; page += 1) {
            const query = after ? `?limit=200&after=${encodeURIComponent(after)}` : '?limit=200';
            const batch = await this.rest.request(`/users/@me/guilds${query}`);
            const pageGuilds = Array.isArray(batch) ? batch : [];
            guilds.push(...pageGuilds);
            if (pageGuilds.length < 200) break;
            after = String(pageGuilds[pageGuilds.length - 1]?.id || '');
            if (!after) break;
        }
        const output = [];
        const list = Array.isArray(guilds) ? guilds : [];

        for (let index = 0; index < list.length; index += 4) {
            const batch = list.slice(index, index + 4);
            const discovered = await Promise.all(batch.map((guildSummary) => this._discoverGuild(guildSummary)));
            output.push(...discovered.filter(Boolean));
        }
        return output.sort((left, right) => left.name.localeCompare(right.name));
    }

    async _discoverGuild(guildSummary) {
        const guildId = String(guildSummary?.id || '');
        if (!guildId) return null;

        let guild = guildSummary;
        let channels = [];
        let member = null;
        const [guildResult, channelsResult, memberResult] = await Promise.allSettled([
            this.rest.request(`/guilds/${encodeURIComponent(guildId)}`),
            this.rest.request(`/guilds/${encodeURIComponent(guildId)}/channels`),
            this.rest.request(`/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(this.botUser.id)}`),
        ]);
        if (guildResult.status === 'fulfilled') guild = guildResult.value;
        if (memberResult.status === 'fulfilled') member = memberResult.value;
        if (channelsResult.status === 'fulfilled') {
            channels = channelsResult.value;
        } else {
            this.emit('warning', {
                code: channelsResult.reason?.code || 'SSAPP_DISCORD_DISCOVERY_WARNING',
                message: `Could not inspect ${guildSummary?.name || 'a Discord server'}: ${channelsResult.reason?.message || channelsResult.reason}`,
            });
            return null;
        }

        this.guilds.set(guildId, { id: guildId, name: guild?.name || guildSummary?.name || 'Discord Server' });
        this.guildDetails.set(guildId, guild || guildSummary);

        const allChannels = Array.isArray(channels) ? channels : [];
        const categoryNames = new Map(allChannels
            .filter((channel) => Number(channel?.type) === 4 && channel?.id)
            .map((channel) => [String(channel.id), channel.name || 'Category']));
        for (const channel of allChannels) {
            if (!channel?.id) continue;
            this.channels.set(String(channel.id), {
                id: String(channel.id),
                guildId,
                name: channel.name || 'channel',
                type: Number(channel.type),
            });
        }

        const availableChannels = [];
        for (const channel of allChannels) {
            if (!SUPPORTED_CHANNEL_TYPES.has(Number(channel?.type))) continue;
            const permissions = member && guild?.roles
                ? computeChannelPermissions(guild, channel, member)
                : parsePermissionBits(guildSummary?.permissions);
            const canView = hasPermission(permissions, PERMISSION_VIEW_CHANNEL);
            if (!canView) continue;
            const normalized = {
                id: String(channel.id),
                guildId,
                name: channel.name || 'channel',
                type: Number(channel.type),
                position: Number(channel.position || 0),
                parentId: channel.parent_id ? String(channel.parent_id) : null,
                categoryName: channel.parent_id ? (categoryNames.get(String(channel.parent_id)) || '') : '',
                canView,
                canSend: hasPermission(permissions, PERMISSION_SEND_MESSAGES),
            };
            this.channels.set(normalized.id, normalized);
            availableChannels.push(normalized);
        }

        availableChannels.sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));
        return {
            id: guildId,
            name: guild?.name || guildSummary?.name || 'Discord Server',
            icon: guild?.icon || guildSummary?.icon || null,
            channels: availableChannels,
        };
    }

    addSource(source) {
        if (!source?.sourceId || !source?.channelId || !source?.guildId) {
            throw new Error('Discord source is missing a source, server, or channel ID.');
        }
        this.subscriptions.set(String(source.sourceId), {
            ...source,
            sourceId: String(source.sourceId),
            guildId: String(source.guildId),
            channelId: String(source.channelId),
        });
    }

    removeSource(sourceId) {
        this.subscriptions.delete(String(sourceId || ''));
        if (!this.subscriptions.size) this.close();
    }

    async validateSourceChannel(guildId, channelId) {
        const expectedGuildId = String(guildId || '');
        const expectedChannelId = String(channelId || '');
        const channel = await this.rest.request(`/channels/${encodeURIComponent(expectedChannelId)}`);
        if (!channel?.id || String(channel.id) !== expectedChannelId || String(channel.guild_id || '') !== expectedGuildId) {
            const error = new Error('The selected Discord channel no longer belongs to the saved server. Choose the channel again.');
            error.code = 'SSAPP_DISCORD_CHANNEL_MISMATCH';
            throw error;
        }
        if (!SUPPORTED_CHANNEL_TYPES.has(Number(channel.type))) {
            const error = new Error('Native Discord sources currently support text and announcement channels only.');
            error.code = 'SSAPP_DISCORD_CHANNEL_UNSUPPORTED';
            throw error;
        }
        this.channels.set(expectedChannelId, {
            id: expectedChannelId,
            guildId: expectedGuildId,
            name: channel.name || 'channel',
            type: Number(channel.type),
        });
        return channel;
    }

    emitSourceStatus(sourceId, status, message, extra = {}) {
        const source = this.subscriptions.get(String(sourceId || ''));
        if (!source) return false;
        this.emit('status', {
            sourceId: source.sourceId,
            virtualTabId: source.virtualTabId,
            status,
            message,
            ...extra,
        });
        return true;
    }

    async connect() {
        if (this.ready && this.socket && this.socket.readyState === this.WebSocketImpl.OPEN) return true;
        if (this.connectPromise) return this.connectPromise;
        if (!this.botUser || !this.application) await this.validate();

        this.manualClose = false;
        const pendingConnection = new Promise((resolve, reject) => {
            this.connectResolve = resolve;
            this.connectReject = reject;
            this.connectTimeout = setTimeout(() => {
                const error = new Error('Timed out while connecting to the Discord Gateway.');
                error.code = 'SSAPP_DISCORD_CONNECT_TIMEOUT';
                this._settleConnect(error);
            }, this.connectTimeoutMs);
        });
        this.connectPromise = pendingConnection;
        try {
            await this._openGateway();
        } catch (error) {
            this._settleConnect(error);
            throw error;
        }
        return pendingConnection;
    }

    async _openGateway() {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;

        if (!this.gatewayUrl) {
            try {
                const gateway = await this.rest.request('/gateway/bot');
                const base = stringValue(gateway?.url) || 'wss://gateway.discord.gg';
                this.gatewayUrl = `${base.replace(/\/+$/, '')}/?v=10&encoding=json`;
            } catch (_) {
                this.gatewayUrl = DEFAULT_GATEWAY_URL;
            }
        }

        const baseUrl = this.sessionId && this.resumeGatewayUrl ? this.resumeGatewayUrl : this.gatewayUrl;
        const socketUrl = baseUrl.includes('?') ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/?v=10&encoding=json`;
        const socket = new this.WebSocketImpl(socketUrl);
        this.socket = socket;
        this.ready = false;
        this._emitStatus('connecting', this.sessionId ? 'Resuming Discord connection…' : 'Connecting to Discord…');

        socket.on('message', (data) => this._handleGatewayMessage(data));
        socket.on('error', (error) => {
            this.emit('warning', { code: 'SSAPP_DISCORD_GATEWAY_ERROR', message: error?.message || String(error) });
        });
        socket.on('close', (code) => this._handleGatewayClose(Number(code || 0)));
    }

    _handleGatewayMessage(raw) {
        let packet;
        try {
            packet = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
        } catch (_) {
            return;
        }

        if (packet.s !== null && packet.s !== undefined) this.lastSequence = packet.s;
        switch (packet.op) {
            case 0:
                this._handleDispatch(packet.t, packet.d || {});
                break;
            case 1:
                this._sendHeartbeat();
                break;
            case 7:
                this._restartSocket(true);
                break;
            case 9:
                if (packet.d !== true) this._clearSession();
                clearTimeout(this.invalidSessionTimer);
                this.invalidSessionTimer = setTimeout(() => {
                    this.invalidSessionTimer = null;
                    if (!this.manualClose) this._restartSocket(packet.d === true);
                }, 1000 + Math.floor(this.random() * 4000));
                break;
            case 10:
                this._startHeartbeat(Number(packet.d?.heartbeat_interval || 45000));
                if (this.sessionId && this.lastSequence !== null) this._sendResume();
                else this._sendIdentify();
                break;
            case 11:
                this.awaitingHeartbeatAck = false;
                break;
            default:
                break;
        }
    }

    _handleDispatch(type, data) {
        if (type === 'READY') {
            this.botUser = data.user || this.botUser;
            this.sessionId = data.session_id || null;
            this.resumeGatewayUrl = data.resume_gateway_url || null;
            for (const guild of Array.isArray(data.guilds) ? data.guilds : []) {
                const id = String(guild.id || '');
                if (id) this.guilds.set(id, { id, name: guild.name || this.guilds.get(id)?.name || 'Discord Server' });
            }
            this._markReady();
            return;
        }
        if (type === 'RESUMED') {
            this._markReady();
            return;
        }
        if (type === 'GUILD_CREATE') {
            const guildId = String(data.id || '');
            if (guildId) {
                this.guilds.set(guildId, { id: guildId, name: data.name || 'Discord Server' });
                this.guildDetails.set(guildId, data);
                for (const channel of Array.isArray(data.channels) ? data.channels : []) {
                    if (!channel?.id) continue;
                    this.channels.set(String(channel.id), {
                        id: String(channel.id),
                        guildId,
                        name: channel.name || 'channel',
                        type: Number(channel.type),
                    });
                }
            }
            return;
        }
        if (type === 'CHANNEL_CREATE' || type === 'CHANNEL_UPDATE') {
            if (data?.id) {
                this.channels.set(String(data.id), {
                    id: String(data.id),
                    guildId: String(data.guild_id || ''),
                    name: data.name || 'channel',
                    type: Number(data.type),
                });
            }
            return;
        }
        if (type === 'CHANNEL_DELETE') {
            if (data?.id) this.channels.delete(String(data.id));
            return;
        }
        if (type === 'MESSAGE_CREATE') this._handleMessageCreate(data);
    }

    _handleMessageCreate(message) {
        const messageId = String(message?.id || '');
        if (!messageId || this.recentMessageIds.has(messageId)) return;
        this._rememberBounded(this.recentMessageIds, this.recentMessageOrder, messageId, MAX_RECENT_MESSAGE_IDS);

        if (this.outboundMessageIds.has(messageId) || (message.nonce && this.outboundNonces.has(String(message.nonce)))) return;
        if (this.botUser?.id && String(message.author?.id || '') === String(this.botUser.id)) return;

        const matchingSources = Array.from(this.subscriptions.values()).filter((source) =>
            source.channelId === String(message.channel_id || '') && !source.replyOnly
        );
        if (!matchingSources.length) return;

        const settings = this.getSettings() || {};
        for (const source of matchingSources) {
            if ((message.webhook_id || message.author?.bot) && source.includeWebhookMessages !== true) continue;
            const payload = normalizeDiscordMessage(message, {
                guild: this.guildDetails.get(source.guildId),
                channelLookup: this.channels,
                textOnly: !!settings.textonlymode,
                discordMemberships: !!settings.discordmemberships,
            });
            if (!payload) continue;
            payload.tid = source.virtualTabId;
            payload.meta.ssnSourceId = source.sourceId;
            const accountRole = String(source.accountRole || 'normal').trim().toLowerCase();
            if (['host', 'bot', 'relay'].includes(accountRole)) payload.meta.ssnAccountRole = accountRole;
            if (source.customSession && source.customSession !== 'AUTO') payload.meta.ssnSession = source.customSession;
            this.emit('message', { payload, source });
        }
    }

    async sendToSource(sourceId, value) {
        const source = this.subscriptions.get(String(sourceId || ''));
        if (!source) {
            const error = new Error('Discord source is not connected.');
            error.code = 'SSAPP_DISCORD_SOURCE_DISCONNECTED';
            throw error;
        }
        const text = typeof value === 'string'
            ? value
            : stringValue(value?.text || value?.message || value?.chatmessage);
        const parts = splitDiscordMessage(text);
        if (!parts.length) return { success: false, error: 'Message is empty.' };

        const messages = [];
        for (const part of parts) {
            const result = await this.rest.queueChannelRequest(source.channelId, async () => {
                const nonce = crypto.randomBytes(12).toString('hex');
                this._rememberBounded(this.outboundNonces, this.outboundNonceOrder, nonce, MAX_OUTBOUND_MESSAGE_IDS);
                const response = await this.rest.request(`/channels/${encodeURIComponent(source.channelId)}/messages`, {
                    method: 'POST',
                    body: {
                        content: part,
                        nonce,
                        enforce_nonce: true,
                        allowed_mentions: { parse: [] },
                    },
                });
                if (response?.id) {
                    this._rememberBounded(this.outboundMessageIds, this.outboundMessageOrder, String(response.id), MAX_OUTBOUND_MESSAGE_IDS);
                }
                return response;
            });
            messages.push(result);
        }
        return { success: true, messages };
    }

    _rememberBounded(set, order, value, maximum) {
        if (!value || set.has(value)) return;
        set.add(value);
        order.push(value);
        while (order.length > maximum) {
            set.delete(order.shift());
        }
    }

    _markReady() {
        this.ready = true;
        this.reconnectAttempt = 0;
        this._emitStatus('connected', `Connected as ${this.botUser?.global_name || this.botUser?.username || 'Discord bot'}.`);
        this._settleConnect(null, true);
    }

    _sendGateway(payload) {
        if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) return false;
        this.socket.send(JSON.stringify(payload));
        return true;
    }

    _sendIdentify() {
        this._sendGateway({
            op: 2,
            d: {
                token: this.token,
                intents: DISCORD_INTENTS,
                properties: {
                    os: process.platform,
                    browser: 'social-stream-ninja',
                    device: 'social-stream-ninja',
                },
            },
        });
    }

    _sendResume() {
        this._sendGateway({
            op: 6,
            d: {
                token: this.token,
                session_id: this.sessionId,
                seq: this.lastSequence,
            },
        });
    }

    _startHeartbeat(intervalMs) {
        this._clearHeartbeat();
        const firstDelay = Math.floor(Math.max(1, intervalMs) * this.random());
        this.firstHeartbeatTimer = setTimeout(() => {
            this._sendHeartbeat();
            this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), intervalMs);
        }, firstDelay);
    }

    _sendHeartbeat() {
        if (this.awaitingHeartbeatAck) {
            this._restartSocket(true);
            return;
        }
        if (this._sendGateway({ op: 1, d: this.lastSequence })) {
            this.awaitingHeartbeatAck = true;
        }
    }

    _clearHeartbeat() {
        clearTimeout(this.firstHeartbeatTimer);
        clearInterval(this.heartbeatTimer);
        this.firstHeartbeatTimer = null;
        this.heartbeatTimer = null;
        this.awaitingHeartbeatAck = false;
    }

    _restartSocket(resume = true) {
        if (!resume) this._clearSession();
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            try {
                if (typeof socket.terminate === 'function') socket.terminate();
                else socket.close(4000);
            } catch (_) { }
        }
        this._scheduleReconnect();
    }

    _handleGatewayClose(code) {
        this._clearHeartbeat();
        this.socket = null;
        this.ready = false;
        if (this.manualClose) return;

        if (FATAL_GATEWAY_CLOSE_CODES.has(code)) {
            const error = gatewayCloseError(code);
            this._emitStatus('error', error.message, { code: error.code, fatal: true });
            this._settleConnect(error);
            return;
        }
        if (NON_RESUMABLE_GATEWAY_CLOSE_CODES.has(code)) this._clearSession();
        this._scheduleReconnect();
    }

    _scheduleReconnect() {
        if (this.manualClose || !this.subscriptions.size || this.reconnectTimer) return;
        const baseDelay = Math.min(30000, 1000 * (2 ** Math.min(this.reconnectAttempt, 5)));
        const delay = Math.floor(baseDelay * (0.75 + this.random() * 0.5));
        this.reconnectAttempt += 1;
        this._emitStatus('reconnecting', `Discord disconnected. Reconnecting in ${Math.max(1, Math.ceil(delay / 1000))}s…`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this._openGateway().catch((error) => {
                this.emit('warning', { code: error?.code, message: error?.message || String(error) });
                this._scheduleReconnect();
            });
        }, delay);
    }

    _clearSession() {
        this.sessionId = null;
        this.resumeGatewayUrl = null;
        this.lastSequence = null;
    }

    _settleConnect(error, value = false) {
        if (!this.connectPromise) return;
        clearTimeout(this.connectTimeout);
        const resolve = this.connectResolve;
        const reject = this.connectReject;
        this.connectPromise = null;
        this.connectResolve = null;
        this.connectReject = null;
        this.connectTimeout = null;
        if (error) reject(error);
        else resolve(value);
    }

    _emitStatus(status, message, extra = {}) {
        for (const source of this.subscriptions.values()) {
            this.emit('status', {
                sourceId: source.sourceId,
                virtualTabId: source.virtualTabId,
                status,
                message,
                ...extra,
            });
        }
    }

    close() {
        this.manualClose = true;
        this.ready = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        clearTimeout(this.invalidSessionTimer);
        this.invalidSessionTimer = null;
        this._clearHeartbeat();
        if (this.socket) {
            try { this.socket.close(1000, 'SSApp source stopped'); } catch (_) { }
        }
        this.socket = null;
        this._settleConnect(new Error('Discord connection stopped.'));
    }
}

module.exports = {
    DiscordBotClient,
    DiscordRestClient,
    DISCORD_INTENTS,
    PERMISSION_VIEW_CHANNEL,
    PERMISSION_SEND_MESSAGES,
    __test: {
        appendAttachmentLinks,
        computeChannelPermissions,
        escapeHtml,
        gatewayCloseError,
        normalizeDiscordMessage,
        replaceDiscordTokens,
        resolveAvatarUrl,
        resolveRoleColor,
        splitDiscordMessage,
    },
};
