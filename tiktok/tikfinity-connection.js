'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');

// TikFinity Desktop's local Events API. It forwards the stream selected in
// TikFinity; it does not accept a creator name or perform TikTok authentication.
class TikFinityConnection extends EventEmitter {
    constructor() {
        super();
        this.isConnected = false;
        this.socket = null;
        this.rejectConnect = null;
        this.hasLiveEvents = false;
    }

    connect() {
        this.disconnect();
        this.hasLiveEvents = false;
        return new Promise((resolve, reject) => {
            this.rejectConnect = reject;
            const socket = new WebSocket('ws://127.0.0.1:21213/', {
                handshakeTimeout: 10000,
                maxPayload: 2 * 1024 * 1024
            });
            this.socket = socket;
            socket.on('open', () => {
                if (this.socket !== socket) return;
                this.rejectConnect = null;
                this.isConnected = true;
                this.emit('websocketConnected');
                resolve(true);
            });
            socket.on('message', raw => {
                if (this.socket !== socket) return;
                this.emit('websocketData', raw);
                let packet;
                try { packet = JSON.parse(raw.toString()); } catch (_) { return; }
                if (!packet || !packet.data || typeof packet.data !== 'object' || Array.isArray(packet.data)) return;
                const event = packet.event;
                if (!['chat', 'gift', 'follow', 'share', 'subscribe', 'member', 'like', 'roomUser', 'emote', 'envelope'].includes(event)) return;
                if (!this.hasLiveEvents) {
                    this.hasLiveEvents = true;
                    this.emit('captureStatus', 'Receiving LIVE events from TikFinity Desktop');
                }
                this.emit('decodedData', event, packet.data);
                this.emit(event, packet.data);
            });
            socket.on('error', () => {
                if (this.socket !== socket) return;
                // Do not include credentials or remote service suggestions in
                // errors for this strictly local, read-only connection.
                const error = new Error('Cannot reach TikFinity Desktop. Open it on this computer and check its Event API page.');
                error.code = 'SSAPP_TIKFINITY_UNAVAILABLE';
                if (this.rejectConnect) {
                    this.rejectConnect(error);
                    this.rejectConnect = null;
                }
            });
            socket.on('close', () => {
                if (this.socket !== socket) return;
                const wasConnected = this.isConnected;
                this.isConnected = false;
                if (this.rejectConnect) {
                    this.rejectConnect(new Error('TikFinity Desktop closed the connection. Check its Events API settings.'));
                    this.rejectConnect = null;
                }
                if (wasConnected) this.emit('disconnected');
            });
        });
    }

    disconnect() {
        const socket = this.socket;
        this.socket = null;
        this.isConnected = false;
        if (this.rejectConnect) {
            const error = new Error('TikTok connection stopped');
            error.code = 'SSAPP_TIKTOK_STOPPED';
            this.rejectConnect(error);
            this.rejectConnect = null;
        }
        if (socket) {
            socket.removeAllListeners();
            socket.on('error', () => {});
            socket.terminate();
        }
    }
}

module.exports = { TikFinityConnection };
