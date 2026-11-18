'use strict';

// Opt-in Node transport. Desktop connections keep the original connector.
function createRecoveryConnector(connector) {
    const Base = connector.TikTokLiveConnection;
    function identity(message) {
        const type = message.decodedData?.type;
        const data = message.decodedData?.data;
        const id = data?.common?.msgId || data?.msgId;
        if (!id || !['WebcastChatMessage', 'WebcastGiftMessage'].includes(type)) return null;
        return type + ':' + id + (type === 'WebcastGiftMessage' ? ':' + data.repeatCount + ':' + data.repeatEnd : '');
    }
    function compact(frame) {
        const copy = { cursor: frame.cursor, internalExt: frame.internalExt, isFirst: frame.isFirst,
            historyNoMore: frame.historyNoMore, messages: [] };
        let bytes = Buffer.byteLength(frame.cursor || '') + Buffer.byteLength(frame.internalExt || '');
        for (const message of frame.messages || []) {
            let item;
            // Keep the original protobuf while waiting for replay overlap. Its
            // decoded objects can be much larger, even for ordinary room updates.
            if (message.decodedData && message.payload instanceof Uint8Array && message.payload.byteLength &&
                typeof connector.deserializeMessage === 'function') {
                item = { method: message.method, type: message.decodedData.type, payload: Buffer.from(message.payload) };
                bytes += item.payload.length + Buffer.byteLength(item.type || '');
            } else {
                item = { method: message.method, decodedData: message.decodedData };
                bytes += Buffer.byteLength(JSON.stringify(item.decodedData || {}));
            }
            bytes += Buffer.byteLength(item.method || '');
            copy.messages.push(item);
        }
        return { frame: copy, bytes };
    }
    function expand(frame) {
        return { ...frame, messages: frame.messages.map(message => message.payload
            ? { method: message.method, decodedData: {
                type: message.type, data: connector.deserializeMessage(message.method, message.payload)
            } }
            : message) };
    }
    class RecoveringConnection extends Base {
        constructor(...args) {
            super(...args);
            this.recoveryState = '';
            this.recoveryFailure = '';
            this.recoveryStopped = false;
            this.recoveryQueue = [];
            this.recoveryBytes = 0;
            this.recoveryMessages = 0;
            this.recoverySeen = new Set();
            this.recoveryCursor = null;
            this.recoveryBoundary = null;
            this.recoveryOverlap = false;
            this.recoverySocket = null;
            this.recoveryProcessing = Promise.resolve();
            this.recoveryProcessingActive = false;
            this.recoveryIncoming = [];
            this.recoveryIncomingBytes = 0;
            this.recoveryIncomingMessages = 0;
            this.recoveryDecoding = Promise.resolve();
            this.recoveryDecodeActive = false;
            this.recoveryDecodeQueue = [];
            this.recoveryDecodeBytes = 0;
            const provider = this._wsClientProvider;
            this._wsClientProvider = (...params) => {
                const client = provider.apply(this, params);
                const handlers = client.listeners('message');
                if (typeof client.onMessage !== 'function' || handlers.length !== 1 || handlers[0].name !== 'bound onMessage') {
                    client.once('error', () => {});
                    client.terminate();
                    throw Error('Unsupported TikTok decoder');
                }
                // The connector starts an async gzip decode for every frame.
                // Keep wire order before those decodes can reorder cursors.
                client.removeListener('message', handlers[0]);
                client.on('message', message => this.decodeInOrder(client, message));
                return client;
            };
        }
        decodeInOrder(client, message) {
            if (this.recoveryStopped) return;
            const bytes = message?.byteLength;
            if (!Number.isSafeInteger(bytes) || this.recoveryDecodeQueue.length >= 1000 ||
                this.recoveryDecodeBytes + bytes > 2 * 1024 * 1024) {
                this.failRecovery('TikTok capture fell behind. Retry to resume capture.');
                return;
            }
            this.recoveryDecodeQueue.push({ client, message, bytes });
            this.recoveryDecodeBytes += bytes;
            if (this.recoveryDecodeActive) return;
            this.recoveryDecodeActive = true;
            this.recoveryDecoding = Promise.resolve().then(async () => {
                try {
                    while (this.recoveryDecodeQueue.length && !this.recoveryStopped) {
                        const next = this.recoveryDecodeQueue.shift();
                        try {
                            await next.client.onMessage(next.message);
                            await this.recoveryProcessing;
                        } finally { this.recoveryDecodeBytes = Math.max(0, this.recoveryDecodeBytes - next.bytes); }
                    }
                } catch (_) { this.failRecovery('TikTok chat decoding failed. Retry to resume capture.'); }
                finally { this.recoveryDecodeActive = false; }
            });
        }
        setupWebsocket(url, params, roomId) {
            this.recoverySocket = { url, params: { ...params }, roomId };
            return super.setupWebsocket(url, params, roomId);
        }
        emit(event, ...args) {
            if (event === 'streamEnd') this.recoveryEnded = true;
            if (event === 'disconnected' && !this.recoveryStopped && !this.recoveryEnded &&
                this.recoveryCursor && [0, 1001, 1006, 1011, 1012, 1013].includes(Number(args[0]?.code || 0))) {
                if (this.recoveryState) {
                    this.failRecovery('TikTok disconnected again during recovery. Retry to resume capture.');
                } else {
                    this.recoveryState = 'reconnecting';
                    this.recoveryBoundary = null;
                    this.recoveryOverlap = false;
                    void this.recoverConnection();
                }
                return true;
            }
            return super.emit(event, ...args);
        }
        processProtoMessageFetchResult(frame) {
            if (this.recoveryStopped) return Promise.resolve();
            let bytes;
            try {
                if (!Array.isArray(frame?.messages) || frame.messages.length > 10000) throw Error('Invalid frame');
                bytes = Buffer.byteLength(frame.cursor || '') + Buffer.byteLength(frame.internalExt || '');
                for (const message of frame.messages) {
                    // The connector retains decoded objects alongside these
                    // protobuf bytes. Bound both encoded size and message count.
                    bytes += ArrayBuffer.isView(message.payload) && message.payload.byteLength
                        ? message.payload.byteLength : Buffer.byteLength(JSON.stringify(message.decodedData || {}));
                    if (bytes > 2 * 1024 * 1024) break;
                }
            } catch (_) {
                this.failRecovery('TikTok returned an unreadable frame. Retry to resume capture.');
                return Promise.resolve();
            }
            if (this.recoveryIncoming.length >= 1000 || this.recoveryIncomingMessages + frame.messages.length > 10000 ||
                this.recoveryIncomingBytes + bytes > 2 * 1024 * 1024) {
                this.failRecovery('TikTok capture fell behind. Retry to resume capture.');
                return Promise.resolve();
            }
            const process = async () => {
                if (this.recoveryStopped) return;
                if (this.recoveryState) {
                    const keys = [];
                    for (const message of frame.messages) {
                        const key = identity(message);
                        if (!key) continue;
                        if (String(message.decodedData.data.common?.roomId) !== String(this.recoveryCursor.roomId)) {
                            this.failRecovery('TikTok recovery returned a different room. Retry to resume capture.');
                            return;
                        }
                        keys.push(key);
                    }
                    const copy = compact(frame);
                    if (this.recoveryQueue.length >= 1000 || this.recoveryMessages + frame.messages.length > 10000 ||
                        this.recoveryBytes + copy.bytes > 2 * 1024 * 1024) {
                        this.failRecovery('TikTok recovery buffer is full. Retry to resume capture.');
                        return;
                    }
                    this.recoveryQueue.push(copy);
                    this.recoveryBytes += copy.bytes;
                    this.recoveryMessages += frame.messages.length;
                    if (keys.includes(this.recoveryCursor.anchor)) this.recoveryOverlap = true;
                    if (!frame.isFirst && !this.recoveryBoundary) {
                        this.recoveryBoundary = keys.find(key => !this.recoverySeen.has(key)) || null;
                    }
                    return;
                }
                await this.deliverFrame(frame);
                if (!this.recoveryStopped) this.rememberFrame(frame);
            };
            this.recoveryIncoming.push({ process, bytes, messages: frame.messages.length });
            this.recoveryIncomingBytes += bytes;
            this.recoveryIncomingMessages += frame.messages.length;
            if (!this.recoveryProcessingActive) {
                this.recoveryProcessingActive = true;
                this.recoveryProcessing = Promise.resolve().then(async () => {
                    try {
                        while (this.recoveryIncoming.length && !this.recoveryStopped) {
                            const next = this.recoveryIncoming.shift();
                            try { await next.process(); }
                            finally {
                                this.recoveryIncomingBytes = Math.max(0, this.recoveryIncomingBytes - next.bytes);
                                this.recoveryIncomingMessages = Math.max(0, this.recoveryIncomingMessages - next.messages);
                            }
                        }
                    } catch (_) { this.failRecovery('TikTok chat processing failed. Retry after checking this source.'); }
                    finally { this.recoveryProcessingActive = false; }
                });
            }
            return this.recoveryProcessing;
        }
        clearIncoming() {
            this.recoveryDecodeQueue.length = 0;
            this.recoveryDecodeBytes = 0;
            this.recoveryIncoming.length = 0;
            this.recoveryIncomingBytes = 0;
            this.recoveryIncomingMessages = 0;
        }
        rememberFrame(frame) {
            if (this.availableGifts) this.recoveryGifts = this.availableGifts;
            let anchor = null;
            for (const message of frame.messages || []) {
                const key = identity(message);
                if (key) {
                    // Replayed events cannot move the overlap anchor past
                    // the cursor needed to fetch that event again.
                    if (!this.recoverySeen.has(key)) anchor = key;
                    this.recoverySeen.add(key);
                }
            }
            while (this.recoverySeen.size > 10000) this.recoverySeen.delete(this.recoverySeen.values().next().value);
            if (frame.cursor && frame.internalExt && (!frame.isFirst || frame.historyNoMore)) {
                // Start one frame before a known event, so backfill must prove
                // that it covers both the old feed and the replacement feed.
                if (anchor && this.recoveryLastCursor?.roomId === this.roomId) {
                    this.recoveryCursor = { ...this.recoveryLastCursor, anchor };
                }
                this.recoveryLastCursor = { cursor: frame.cursor, internalExt: frame.internalExt, roomId: this.roomId };
            }
        }
        deliverFrame(frame) {
            // The manager's metadata tap must run when a queued frame is
            // delivered, not when the replacement socket first receives it.
            if (!Base.prototype.__ssappProtoFetchPatched) this.emit('ssappProtoFetch', frame);
            return super.processProtoMessageFetchResult(frame);
        }
        failRecovery(reason) {
            if (this.recoveryStopped) return;
            this.recoveryFailure = reason;
            this.recoveryState = '';
            this.recoveryStopped = true;
            this.clearIncoming();
            clearTimeout(this.recoveryDeadline);
            this.recoveryQueue.length = 0;
            this.recoveryBytes = 0;
            this.recoveryMessages = 0;
            try { this._wsClientInstance?.terminate(); } catch (_) {}
            // The ordinary Node runtime pauses and releases its manager here.
            super.emit('disconnected', { code: 1006, reason });
        }
        async resumeWebsocket(socket, saved) {
            const provider = this._wsClientProvider;
            if (typeof provider !== 'function' || !connector.WebcastPushFrame?.decode ||
                !connector.WebcastImEnterRoomMessage?.encode) throw Error('Missing room resume support');
            this._wsClientProvider = (...args) => {
                const client = provider.apply(this, args), send = client.sendBytes;
                // The connector sends an empty room-entry cursor even when the
                // WebSocket URL has one. Resume both on this replacement socket.
                client.sendBytes = function (bytes) {
                    const frame = connector.WebcastPushFrame.decode(bytes);
                    if (frame.payloadType === 'im_enter_room') {
                        this.sendBytes = send;
                        const enter = connector.WebcastImEnterRoomMessage.decode(frame.payload);
                        if (String(enter.roomId) !== String(saved.roomId)) throw Error('Room changed');
                        enter.cursor = saved.cursor;
                        frame.payload = connector.WebcastImEnterRoomMessage.encode(enter).finish();
                        bytes = connector.WebcastPushFrame.encode(frame).finish();
                    }
                    return send.call(this, bytes);
                };
                return client;
            };
            try {
                await super.setupWebsocket(socket.url, {
                    ...socket.params, cursor: saved.cursor, internal_ext: saved.internalExt
                }, saved.roomId);
            } finally { this._wsClientProvider = provider; }
        }
        async recoverConnection() {
            const savedGifts = this.recoveryGifts || this.availableGifts;
            this.recoveryDeadline = setTimeout(() => this.failRecovery('TikTok recovery timed out. Retry to resume capture.'), 60000);
            try {
                await this.recoveryDecoding;
                await this.recoveryProcessing;
                if (this.recoveryStopped) return;
                const saved = this.recoveryCursor, socket = this.recoverySocket;
                if (!saved?.cursor || !saved.internalExt || !saved.roomId ||
                    !socket?.url || String(socket.roomId) !== String(saved.roomId)) throw Error('Missing recovery context');
                // Resume the existing stream session. A fresh signing request
                // can return a new welcome response instead of missed events.
                this.webClient.roomId = saved.roomId;
                await this.resumeWebsocket(socket, saved);
                if (this.recoveryStopped) { this._wsClientInstance?.terminate(); return; }
                if (String(this.roomId) !== String(saved.roomId)) throw Error('Room changed');
                this._availableGifts = savedGifts;
                this._connectState = 'CONNECTED';
                while ((!this.recoveryOverlap || !this.recoveryBoundary) && !this.recoveryStopped) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (this.recoveryStopped) return;
                // Keep the manager's message IDs and gift streak state while
                // releasing replay and new events in their received order.
                while (this.recoveryQueue.length) {
                    if (this.recoveryStopped) return;
                    const queued = this.recoveryQueue.shift();
                    this.recoveryBytes -= queued.bytes;
                    this.recoveryMessages -= queued.frame.messages.length;
                    const frame = expand(queued.frame);
                    await this.deliverFrame({ ...frame, isFirst: false });
                    this.rememberFrame(frame);
                }
                this.recoveryBytes = 0;
                this.recoveryMessages = 0;
                this.recoveryState = '';
                clearTimeout(this.recoveryDeadline);
            } catch (_) {
                if (!this.recoveryStopped) this.failRecovery('TikTok could not recover the interruption. Retry to resume capture.');
            }
        }
        async disconnect() {
            this.recoveryStopped = true;
            this.clearIncoming();
            this.recoveryState = '';
            clearTimeout(this.recoveryDeadline);
            this.recoveryQueue.length = 0;
            this.recoveryBytes = 0;
            this.recoveryMessages = 0;
            this.recoverySeen.clear();
            this.recoveryGifts = null;
            this.recoveryCursor = null;
            this.recoveryLastCursor = null;
            this.recoverySocket = null;
            this.recoveryOverlap = false;
            const socket = this._wsClientInstance;
            try { await super.disconnect(); } finally { try { socket?.terminate(); } catch (_) {} }
        }
    }
    RecoveringConnection.prototype.__ssappProtoFetchPatched = true;
    return { ...connector, TikTokLiveConnection: RecoveringConnection };
}

module.exports = { createRecoveryConnector };
