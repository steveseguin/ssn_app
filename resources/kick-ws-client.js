'use strict';

const { EventEmitter } = require('events');

// Kick chat and channel resolution are handled by kick.js + bridge server.
// This file exists only for backward compatibility with the Electron preload.

class KickWsClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.slug = options.slug || '';
        this.chatroomId = options.chatroomId ?? null;
        this.channelId = options.channelId ?? null;
        this.userId = options.userId ?? null;
        this.status = 'disconnected';
    }
    async connect() { this._emitStatus('connected'); return true; }
    async resolveIds() { return {}; }
    stop() { this._emitStatus('disconnected'); }
    _emitStatus(s, meta = {}) {
        this.status = s;
        this.emit('status', { status: s, ...meta });
    }
}

module.exports = { KickWsClient, fetchKickChannel: async () => ({}) };
