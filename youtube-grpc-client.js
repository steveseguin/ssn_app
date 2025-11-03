const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const PROTO_PATH = path.join(
  __dirname,
  'resources',
  'social_stream_fallback',
  'main',
  'providers',
  'youtube',
  'proto',
  'stream_list.proto'
);

const loaderOptions = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: false,
  oneofs: true
};

let liveChatServiceCtor = null;

function loadServiceConstructor() {
  if (liveChatServiceCtor) {
    return liveChatServiceCtor;
  }

  if (!fs.existsSync(PROTO_PATH)) {
    console.warn('[YouTube][gRPC] Proto definitions missing. Run `npm run update:fallback` or bundle Social Stream fallback assets.');
    liveChatServiceCtor = null;
    return null;
  }

  try {
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, loaderOptions);
    const descriptor = grpc.loadPackageDefinition(packageDefinition);
    const service = descriptor?.youtube?.api?.v3?.V3DataLiveChatMessageService;
    if (!service) {
      throw new Error('Failed to load YouTube live chat gRPC service definition.');
    }
    liveChatServiceCtor = service;
    return liveChatServiceCtor;
  } catch (error) {
    console.error('[YouTube][gRPC] Failed to load proto definitions:', error && error.message ? error.message : error);
    liveChatServiceCtor = null;
    return null;
  }
}

function toPlainObject(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(data));
  } catch (_) {
    return data;
  }
}

function normalizeGrpcError(error) {
  if (!error) {
    return { message: 'Unknown gRPC error', code: null };
  }

  const metadataMap =
    typeof error.metadata?.getMap === 'function'
      ? Object.fromEntries(
          Object.entries(error.metadata.getMap()).map(([key, value]) => {
            if (Buffer.isBuffer(value)) {
              return [key, value.toString('utf8')];
            }
            if (Array.isArray(value)) {
              return [
                key,
                value.map((item) => (Buffer.isBuffer(item) ? item.toString('utf8') : item))
              ];
            }
            return [key, value];
          })
        )
      : undefined;

  return {
    message: error.message || 'YouTube live chat gRPC error',
    code: typeof error.code === 'number' ? error.code : null,
    details: error.details || null,
    metadata: metadataMap
  };
}

class YouTubeGrpcStreamManager {
  constructor() {
    const Service = loadServiceConstructor();
    this.client = Service
      ? new Service('youtube.googleapis.com:443', grpc.credentials.createSsl())
      : null;
    this.streams = new Map();
  }

  startStream(rawOptions, webContents) {
    if (!this.client) {
      throw new Error('YouTube live chat gRPC support is unavailable (proto files missing).');
    }
    if (!webContents || webContents.isDestroyed()) {
      throw new Error('Invalid renderer target for YouTube live chat stream.');
    }

    const options = rawOptions || {};
    const accessToken = typeof options.accessToken === 'string' ? options.accessToken : '';
    const liveChatId = typeof options.liveChatId === 'string' ? options.liveChatId : '';

    if (!accessToken) {
      throw new Error('YouTube live chat gRPC stream requires an access token.');
    }
    if (!liveChatId) {
      throw new Error('YouTube live chat gRPC stream requires a live chat ID.');
    }

    const streamId = randomUUID();
    const metadata = new grpc.Metadata();
    metadata.set('authorization', `Bearer ${accessToken}`);
    metadata.set('x-goog-api-client', 'ssapp-youtube-grpc/1.0');

    if (typeof options.apiKey === 'string' && options.apiKey.trim()) {
      metadata.set('x-goog-api-key', options.apiKey.trim());
    }

    const request = {
      liveChatId,
      part: Array.isArray(options.part) && options.part.length
        ? options.part
        : ['id', 'snippet', 'authorDetails']
    };

    if (typeof options.pageToken === 'string' && options.pageToken) {
      request.pageToken = options.pageToken;
    }
    if (typeof options.hl === 'string' && options.hl) {
      request.hl = options.hl;
    }
    if (typeof options.profileImageSize === 'number' && Number.isFinite(options.profileImageSize)) {
      request.profileImageSize = options.profileImageSize;
    }
    if (typeof options.maxResults === 'number' && Number.isFinite(options.maxResults)) {
      request.maxResults = options.maxResults;
    }

    const call = this.client.streamList(request, metadata);
    const streamState = { call, webContents };
    this.streams.set(streamId, streamState);

    const safeSend = (payload) => {
      if (webContents.isDestroyed()) {
        return;
      }
      try {
        webContents.send('youtube-livechat-grpc:event', { streamId, ...payload });
      } catch (error) {
        // Ignore delivery failures; renderer may have gone away.
      }
    };

    call.on('data', (response) => {
      if (!this.streams.has(streamId)) {
        return;
      }
      safeSend({ type: 'data', payload: toPlainObject(response) });
    });

    call.on('error', (error) => {
      if (!this.streams.has(streamId)) {
        return;
      }
      this.streams.delete(streamId);
      safeSend({ type: 'error', error: normalizeGrpcError(error) });
    });

    call.on('status', (status) => {
      if (!this.streams.has(streamId)) {
        return;
      }
      safeSend({ type: 'status', status: toPlainObject(status) });
    });

    call.on('end', () => {
      if (!this.streams.has(streamId)) {
        return;
      }
      this.streams.delete(streamId);
      safeSend({ type: 'end' });
    });

    webContents.once('destroyed', () => {
      this.stopStream(streamId);
    });

    return { streamId };
  }

  stopStream(streamId) {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return false;
    }
    this.streams.delete(streamId);
    try {
      stream.call.cancel();
    } catch (_) {
      // Ignore cancellation errors.
    }
    return true;
  }
}

module.exports = new YouTubeGrpcStreamManager();
