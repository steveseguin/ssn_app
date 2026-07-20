'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const path = require('path');
const { pipeline } = require('stream/promises');
const { fileURLToPath } = require('url');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3001;
const STORE_KEY = 'localMediaLibrary';
const TOKEN_BYTES = 32;
const MAX_RANGE_SIZE = 64 * 1024 * 1024;

const MIME_TYPES = {
	'.aac': 'audio/aac',
	'.avif': 'image/avif',
	'.css': 'text/css; charset=utf-8',
	'.flac': 'audio/flac',
	'.gif': 'image/gif',
	'.htm': 'text/html; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.ico': 'image/x-icon',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.m4a': 'audio/mp4',
	'.m4v': 'video/mp4',
	'.mov': 'video/quicktime',
	'.mp3': 'audio/mpeg',
	'.mp4': 'video/mp4',
	'.oga': 'audio/ogg',
	'.ogg': 'audio/ogg',
	'.ogv': 'video/ogg',
	'.opus': 'audio/ogg',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.wav': 'audio/wav',
	'.webm': 'video/webm',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
};

const MEDIA_EXTENSIONS = new Set([
	'.aac', '.avif', '.flac', '.gif', '.jpeg', '.jpg', '.m4a', '.m4v', '.mov', '.mp3', '.mp4',
	'.oga', '.ogg', '.ogv', '.opus', '.png', '.svg', '.wav', '.webm', '.webp',
]);

function createError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function normalizePort(value) {
	const port = Number.parseInt(value, 10);
	return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT;
}

function normalizeRuntimeRoot(value) {
	let candidate = String(value || '').trim();
	if (!candidate) return '';
	if (candidate.startsWith('file:')) {
		try {
			candidate = fileURLToPath(candidate);
		} catch (_) {
			return '';
		}
	}
	return path.resolve(candidate);
}

function isPathInside(root, target) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function getMimeType(filePath) {
	return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function getMediaType(filePath) {
	const mimeType = getMimeType(filePath);
	if (mimeType.startsWith('audio/')) return 'audio';
	if (mimeType.startsWith('video/')) return 'video';
	if (mimeType.startsWith('image/')) return 'image';
	return '';
}

function publicAsset(asset, status = 'available') {
	return {
		id: asset.id,
		displayName: asset.displayName,
		fileName: asset.fileName,
		mediaType: asset.mediaType,
		mimeType: asset.mimeType,
		size: asset.size,
		modifiedAt: asset.modifiedAt,
		status,
	};
}

function parseRange(rangeHeader, size) {
	if (!rangeHeader) return null;
	const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
	if (!match || (!match[1] && !match[2])) throw createError('INVALID_RANGE', 'Invalid byte range.');

	let start;
	let end;
	if (!match[1]) {
		const suffixLength = Number.parseInt(match[2], 10);
		if (!Number.isFinite(suffixLength) || suffixLength <= 0) throw createError('INVALID_RANGE', 'Invalid suffix range.');
		start = Math.max(0, size - suffixLength);
		end = size - 1;
	} else {
		start = Number.parseInt(match[1], 10);
		end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
	}

	if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) {
		throw createError('INVALID_RANGE', 'Requested range is outside the file.');
	}
	end = Math.min(end, size - 1, start + MAX_RANGE_SIZE - 1);
	return { start, end };
}

function safeEqual(value, expected) {
	const left = Buffer.from(String(value || ''));
	const right = Buffer.from(String(expected || ''));
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class LocalMediaService {
	constructor(options = {}) {
		this.store = options.store;
		this.host = options.host || DEFAULT_HOST;
		this.logger = options.logger || console;
		this.getRuntimeRoot = options.getRuntimeRoot || (() => options.runtimeRoot || '');
		this.createReadStream = options.createReadStream || fs.createReadStream;
		this.server = null;
		this.lastError = '';
		this.runtimeRoot = '';
		this.runtimeRealRoot = '';
		this.state = this.loadState();
	}

	loadState() {
		let stored = {};
		try {
			stored = (this.store && this.store.get(STORE_KEY)) || {};
		} catch (_) { }
		return {
			token: typeof stored.token === 'string' && stored.token.length >= 32
				? stored.token
				: crypto.randomBytes(TOKEN_BYTES).toString('hex'),
			port: normalizePort(stored.port),
			assets: stored.assets && typeof stored.assets === 'object' ? stored.assets : {},
		};
	}

	persist() {
		if (!this.store || typeof this.store.set !== 'function') return;
		this.store.set(STORE_KEY, this.state);
	}

	async resolveRuntimeRoot() {
		const rawRoot = await this.getRuntimeRoot();
		const root = normalizeRuntimeRoot(rawRoot);
		if (!root) throw createError('RUNTIME_UNAVAILABLE', 'Local Flow Actions files are unavailable.');
		const realRoot = await fsp.realpath(root);
		const actionsPath = path.join(realRoot, 'actions.html');
		const stat = await fsp.stat(actionsPath);
		if (!stat.isFile()) throw createError('RUNTIME_UNAVAILABLE', 'actions.html was not found in the Social Stream runtime.');
		this.runtimeRoot = root;
		this.runtimeRealRoot = realRoot;
		return realRoot;
	}

	async start() {
		if (this.server && this.server.listening) return this.getStatus();
		await this.resolveRuntimeRoot();
		this.lastError = '';
		this.persist();
		this.server = http.createServer((req, res) => {
			this.handleRequest(req, res).catch((error) => {
				this.logger.warn('[Local Media] Request failed:', error && error.message ? error.message : error);
				if (!res.headersSent) this.sendText(res, 500, 'Local media request failed.');
				else res.destroy();
			});
		});
		this.server.on('clientError', (_error, socket) => {
			try {
				socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
			} catch (_) { }
		});

		await new Promise((resolve, reject) => {
			const onError = (error) => {
				this.server.removeListener('listening', onListening);
				reject(error);
			};
			const onListening = () => {
				this.server.removeListener('error', onError);
				resolve();
			};
			this.server.once('error', onError);
			this.server.once('listening', onListening);
			this.server.listen(this.state.port, this.host);
		}).catch((error) => {
			this.lastError = error && error.code === 'EADDRINUSE'
				? `Port ${this.state.port} is already in use.`
				: (error && error.message ? error.message : 'Unable to start the local media server.');
			try {
				this.server.close();
			} catch (_) { }
			this.server = null;
			throw createError('SERVER_START_FAILED', this.lastError);
		});

		this.logger.log(`[Local Media] Server listening on http://${this.host}:${this.state.port}`);
		return this.getStatus();
	}

	async stop() {
		const server = this.server;
		this.server = null;
		if (!server) return;
		await new Promise((resolve) => server.close(() => resolve()));
	}

	async setPort(value) {
		const port = Number.parseInt(value, 10);
		if (!Number.isInteger(port) || port < 1024 || port > 65535) {
			throw createError('INVALID_PORT', 'Choose a port from 1024 through 65535.');
		}
		const wasRunning = this.isRunning();
		const shouldRestart = wasRunning || !!this.lastError;
		if (wasRunning) await this.stop();
		this.state.port = port;
		this.lastError = '';
		this.persist();
		if (shouldRestart) await this.start();
		return this.getStatus();
	}

	isRunning() {
		return !!(this.server && this.server.listening);
	}

	getBaseUrl() {
		return `http://${this.host}:${this.state.port}/${this.state.token}`;
	}

	getStatus() {
		return {
			running: this.isRunning(),
			host: this.host,
			port: this.state.port,
			assetCount: Object.keys(this.state.assets).length,
			lastError: this.lastError,
		};
	}

	getFlowActionsUrl(sessionId, options = {}) {
		const params = new URLSearchParams(String(options.search || '').replace(/^\?/, ''));
		params.delete('js');
		if (sessionId && !params.has('session')) params.set('session', String(sessionId));
		if (options.localserver === true && !params.has('localserver')) params.set('localserver', '');
		const query = params.toString().replace('localserver=', 'localserver');
		return `${this.getBaseUrl()}/actions.html${query ? `?${query}` : ''}`;
	}

	getMediaUrl(assetId) {
		if (!this.state.assets[assetId]) throw createError('ASSET_NOT_FOUND', 'Local media item was not found.');
		return `${this.getBaseUrl()}/media/${encodeURIComponent(assetId)}`;
	}

	async registerFile(filePath, options = {}) {
		const resolved = path.resolve(String(filePath || ''));
		const realPath = await fsp.realpath(resolved);
		const stat = await fsp.stat(realPath);
		if (!stat.isFile()) throw createError('INVALID_MEDIA', 'Select a media file.');
		const extension = path.extname(realPath).toLowerCase();
		if (!MEDIA_EXTENSIONS.has(extension)) throw createError('UNSUPPORTED_MEDIA', 'That file type is not supported.');
		const mediaType = getMediaType(realPath);
		if (Array.isArray(options.allowedMediaTypes) && options.allowedMediaTypes.length && !options.allowedMediaTypes.includes(mediaType)) {
			throw createError('UNSUPPORTED_MEDIA', 'That media type is not allowed here.');
		}

		const existingId = String(options.assetId || '');
		const existing = existingId ? this.state.assets[existingId] : null;
		if (existingId && !existing) throw createError('ASSET_NOT_FOUND', 'The media item to relink was not found.');
		const id = existingId || `asset_${crypto.randomUUID().replace(/-/g, '')}`;
		const asset = {
			id,
			displayName: String(options.displayName || (existing && existing.displayName) || path.basename(realPath, extension)).slice(0, 200),
			fileName: path.basename(realPath),
			mediaType,
			mimeType: getMimeType(realPath),
			approvedPath: realPath,
			size: stat.size,
			modifiedAt: stat.mtimeMs,
		};
		this.state.assets[id] = asset;
		this.persist();
		return publicAsset(asset);
	}

	async describeAsset(asset) {
		try {
			const realPath = await fsp.realpath(asset.approvedPath);
			const stat = await fsp.stat(realPath);
			if (!stat.isFile() || realPath !== asset.approvedPath) return publicAsset(asset, 'missing');
			return publicAsset(asset, 'available');
		} catch (_) {
			return publicAsset(asset, 'missing');
		}
	}

	async listAssets() {
		return Promise.all(Object.values(this.state.assets).map((asset) => this.describeAsset(asset)));
	}

	async getAsset(assetId) {
		const asset = this.state.assets[String(assetId || '')];
		if (!asset) return null;
		return this.describeAsset(asset);
	}

	removeAsset(assetId) {
		const id = String(assetId || '');
		if (!this.state.assets[id]) return false;
		delete this.state.assets[id];
		this.persist();
		return true;
	}

	rotateToken() {
		this.state.token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
		this.persist();
		return this.getStatus();
	}

	setCommonHeaders(res) {
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('Referrer-Policy', 'no-referrer');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
	}

	sendText(res, statusCode, message) {
		this.setCommonHeaders(res);
		const body = Buffer.from(String(message || ''));
		res.writeHead(statusCode, {
			'Content-Type': 'text/plain; charset=utf-8',
			'Content-Length': body.length,
		});
		res.end(body);
	}

	async handleRequest(req, res) {
		this.setCommonHeaders(res);
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.setHeader('Allow', 'GET, HEAD');
			this.sendText(res, 405, 'Method not allowed.');
			return;
		}

		let url;
		try {
			url = new URL(req.url, `http://${this.host}:${this.state.port}`);
		} catch (_) {
			this.sendText(res, 400, 'Invalid request URL.');
			return;
		}
		let segments;
		try {
			segments = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
		} catch (_) {
			this.sendText(res, 400, 'Invalid path encoding.');
			return;
		}
		if (!segments.length || !safeEqual(segments.shift(), this.state.token)) {
			this.sendText(res, 404, 'Not found.');
			return;
		}

		if (segments[0] === 'health' && segments.length === 1) {
			const body = Buffer.from(JSON.stringify(this.getStatus()));
			res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'], 'Content-Length': body.length });
			res.end(req.method === 'HEAD' ? undefined : body);
			return;
		}
		if (segments[0] === 'media' && segments.length === 2) {
			await this.serveMedia(req, res, segments[1]);
			return;
		}
		await this.serveRuntime(req, res, segments);
	}

	async serveRuntime(req, res, segments) {
		if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
			this.sendText(res, 404, 'Not found.');
			return;
		}
		if (segments[segments.length - 1].toLowerCase() === 'actions.html') {
			const jsValue = new URL(req.url, `http://${this.host}:${this.state.port}`).searchParams.get('js');
			if (jsValue) {
				this.sendText(res, 400, 'Custom JavaScript is disabled on Local Flow Actions.');
				return;
			}
		}
		const candidate = path.resolve(this.runtimeRealRoot, ...segments);
		if (!isPathInside(this.runtimeRealRoot, candidate)) {
			this.sendText(res, 404, 'Not found.');
			return;
		}
		let realPath;
		try {
			realPath = await fsp.realpath(candidate);
			if (!isPathInside(this.runtimeRealRoot, realPath)) throw createError('PATH_ESCAPE', 'Runtime path escaped its root.');
			const stat = await fsp.stat(realPath);
			if (!stat.isFile()) throw createError('NOT_FILE', 'Not a file.');
			await this.streamFile(req, res, realPath, stat, false);
		} catch (_) {
			this.sendText(res, 404, 'Not found.');
		}
	}

	async serveMedia(req, res, assetId) {
		const asset = this.state.assets[assetId];
		if (!asset) {
			this.sendText(res, 404, 'Local media item not found.');
			return;
		}
		try {
			const realPath = await fsp.realpath(asset.approvedPath);
			if (realPath !== asset.approvedPath) throw createError('ASSET_MOVED', 'Media item moved.');
			const stat = await fsp.stat(realPath);
			if (!stat.isFile()) throw createError('ASSET_MISSING', 'Media item missing.');
			await this.streamFile(req, res, realPath, stat, true);
		} catch (_) {
			this.sendText(res, 404, 'Local media item is missing. Relink it in Event Flow.');
		}
	}

	async streamFile(req, res, filePath, stat, allowRanges) {
		let range = null;
		if (allowRanges && req.headers.range) {
			try {
				range = parseRange(req.headers.range, stat.size);
			} catch (_) {
				res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 });
				res.end();
				return;
			}
		}
		const start = range ? range.start : 0;
		const end = range ? range.end : stat.size - 1;
		const contentLength = stat.size === 0 ? 0 : end - start + 1;
		const headers = {
			'Content-Type': getMimeType(filePath),
			'Content-Length': contentLength,
		};
		if (allowRanges) headers['Accept-Ranges'] = 'bytes';
		if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
		res.writeHead(range ? 206 : 200, headers);
		if (req.method === 'HEAD' || stat.size === 0) {
			res.end();
			return;
		}
		const stream = this.createReadStream(filePath, { start, end });
		try {
			await pipeline(stream, res);
		} catch (error) {
			if (req.destroyed || res.destroyed || error?.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
			throw error;
		}
	}
}

function defaultTrustedSender(event) {
	try {
		const frame = event && event.senderFrame;
		if (!frame || (frame.mainFrame && frame !== frame.mainFrame)) return false;
		const value = String(frame.url || (event.sender && event.sender.getURL()) || '');
		const parsed = new URL(value);
		return parsed.protocol === 'https:' && ['socialstream.ninja', 'beta.socialstream.ninja'].includes(parsed.hostname.toLowerCase());
	} catch (_) {
		return false;
	}
}

function setupElectronLocalMedia(options = {}) {
	const { ipcMain, dialog, shell, store } = options;
	if (!ipcMain || !dialog || !store) throw new Error('Electron local media dependencies are missing.');
	const service = new LocalMediaService(options);
	const isTrustedSender = options.isTrustedSender || defaultTrustedSender;
	const assertTrusted = (event) => {
		if (!isTrustedSender(event)) throw createError('LOCAL_MEDIA_FORBIDDEN', 'Local media is only available from the Social Stream app.');
	};
	const handle = (channel, handler) => {
		if (typeof ipcMain.removeHandler === 'function') ipcMain.removeHandler(channel);
		ipcMain.handle(channel, async (event, payload = {}) => {
			assertTrusted(event);
			return handler(payload, event);
		});
	};

	handle('local-media:select', async (payload) => {
		const mediaType = ['audio', 'image', 'video'].includes(payload.mediaType) ? payload.mediaType : '';
		const allowedMediaTypes = Array.isArray(payload.allowedMediaTypes)
			? payload.allowedMediaTypes.filter((value) => ['audio', 'image', 'video'].includes(value))
			: [];
		const filters = [];
		if (mediaType === 'audio') filters.push({ name: 'Audio', extensions: ['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav'] });
		else if (mediaType === 'image') filters.push({ name: 'Images', extensions: ['avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'] });
		else if (mediaType === 'video') filters.push({ name: 'Video', extensions: ['m4v', 'mov', 'mp4', 'ogv', 'webm'] });
		else if (allowedMediaTypes.length) {
			const extensionGroups = {
				audio: ['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav'],
				image: ['avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'],
				video: ['m4v', 'mov', 'mp4', 'ogv', 'webm'],
			};
			filters.push({ name: 'Media', extensions: allowedMediaTypes.flatMap((value) => extensionGroups[value]) });
		}
		else filters.push({ name: 'Media', extensions: Array.from(MEDIA_EXTENSIONS, (extension) => extension.slice(1)) });
		const dialogOptions = {
			title: payload.assetId ? 'Relink Local Media' : 'Choose Local Media',
			properties: ['openFile'],
			filters,
		};
		const result = typeof options.showOpenDialog === 'function'
			? await options.showOpenDialog(dialogOptions)
			: await dialog.showOpenDialog(dialogOptions);
		if (result.canceled || !result.filePaths || !result.filePaths[0]) return { success: false, canceled: true };
		const asset = await service.registerFile(result.filePaths[0], {
			assetId: payload.assetId,
			allowedMediaTypes: allowedMediaTypes.length ? allowedMediaTypes : (mediaType ? [mediaType] : []),
		});
		return { success: true, asset };
	});
	handle('local-media:list', () => service.listAssets());
	handle('local-media:get', (payload) => service.getAsset(payload.assetId));
	handle('local-media:remove', (payload) => ({ success: service.removeAsset(payload.assetId) }));
	handle('local-media:status', () => service.getStatus());
	handle('local-media:start', () => service.start());
	handle('local-media:stop', () => service.stop().then(() => service.getStatus()));
	handle('local-media:set-port', (payload) => service.setPort(payload.port));
	handle('local-media:flow-url', (payload) => ({
		url: service.getFlowActionsUrl(payload.sessionId, {
			localserver: payload.localserver === true,
			search: payload.search,
		}),
		status: service.getStatus(),
	}));
	handle('local-media:media-url', (payload) => ({ url: service.getMediaUrl(payload.assetId) }));
	handle('local-media:reveal', async (payload) => {
		const asset = service.state.assets[String(payload.assetId || '')];
		if (!asset || !shell || typeof shell.showItemInFolder !== 'function') return { success: false };
		shell.showItemInFolder(asset.approvedPath);
		return { success: true };
	});
	handle('local-media:rotate-token', () => service.rotateToken());

	return service;
}

module.exports = {
	DEFAULT_HOST,
	DEFAULT_PORT,
	LocalMediaService,
	getMediaType,
	getMimeType,
	parseRange,
	setupElectronLocalMedia,
};
