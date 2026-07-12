#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const path = require('path');

const { LocalMediaService } = require('../../resources/electron-local-media-server');

class MemoryStore {
	constructor() {
		this.values = new Map();
	}

	get(key) {
		return this.values.get(key);
	}

	set(key, value) {
		this.values.set(key, JSON.parse(JSON.stringify(value)));
	}
}

async function getFreePort() {
	const server = http.createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

function request(url, options = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(url, options, (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => resolve({
				statusCode: res.statusCode,
				headers: res.headers,
				body: Buffer.concat(chunks),
			}));
		});
		req.on('error', reject);
		req.end();
	});
}

async function run() {
	const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ssapp-local-media-'));
	const runtimeRoot = path.join(tempRoot, 'runtime');
	const mediaPath = path.join(tempRoot, 'sample.mp4');
	const movedPath = path.join(tempRoot, 'moved.mp4');
	const store = new MemoryStore();
	const port = await getFreePort();
	store.set('localMediaLibrary', { token: 'a'.repeat(64), port, assets: {} });
	await fsp.mkdir(path.join(runtimeRoot, 'thirdparty'), { recursive: true });
	await fsp.writeFile(path.join(runtimeRoot, 'actions.html'), '<!doctype html><script src="thirdparty/test.js"></script>');
	await fsp.writeFile(path.join(runtimeRoot, 'thirdparty', 'test.js'), 'window.runtimeLoaded = true;');
	await fsp.writeFile(mediaPath, Buffer.from(Array.from({ length: 256 }, (_value, index) => index)));
	await fsp.writeFile(movedPath, Buffer.from('replacement'));

	const service = new LocalMediaService({ store, runtimeRoot, logger: { log() {}, warn() {} } });
	try {
		await service.start();
		assert.strictEqual(service.getStatus().running, true);
		const asset = await service.registerFile(mediaPath, { allowedMediaTypes: ['video'] });
		assert.ok(asset.id.startsWith('asset_'));
		assert.strictEqual(asset.mediaType, 'video');
		assert.strictEqual(Object.prototype.hasOwnProperty.call(asset, 'approvedPath'), false);

		const baseUrl = service.getBaseUrl();
		const actions = await request(`${baseUrl}/actions.html`);
		assert.strictEqual(actions.statusCode, 200);
		assert.strictEqual(actions.headers['referrer-policy'], 'no-referrer');
		assert.match(actions.headers['content-type'], /^text\/html/);

		const relativeAsset = await request(`${baseUrl}/thirdparty/test.js`);
		assert.strictEqual(relativeAsset.statusCode, 200);
		assert.match(relativeAsset.headers['content-type'], /^text\/javascript/);

		const wrongToken = await request(`http://127.0.0.1:${port}/wrong/actions.html`);
		assert.strictEqual(wrongToken.statusCode, 404);
		const customJs = await request(`${baseUrl}/actions.html?js=https://example.com/unsafe.js`);
		assert.strictEqual(customJs.statusCode, 400);
		const traversal = await request(`${baseUrl}/%2e%2e/package.json`);
		assert.strictEqual(traversal.statusCode, 404);

		const mediaUrl = service.getMediaUrl(asset.id);
		const full = await request(mediaUrl);
		assert.strictEqual(full.statusCode, 200);
		assert.strictEqual(full.body.length, 256);
		assert.strictEqual(full.headers['accept-ranges'], 'bytes');
		assert.match(full.headers['content-type'], /^video\/mp4/);

		const head = await request(mediaUrl, { method: 'HEAD' });
		assert.strictEqual(head.statusCode, 200);
		assert.strictEqual(Number(head.headers['content-length']), 256);
		assert.strictEqual(head.body.length, 0);

		const range = await request(mediaUrl, { headers: { Range: 'bytes=10-19' } });
		assert.strictEqual(range.statusCode, 206);
		assert.strictEqual(range.headers['content-range'], 'bytes 10-19/256');
		assert.deepStrictEqual(Array.from(range.body), Array.from({ length: 10 }, (_value, index) => index + 10));

		const suffix = await request(mediaUrl, { headers: { Range: 'bytes=-4' } });
		assert.strictEqual(suffix.statusCode, 206);
		assert.deepStrictEqual(Array.from(suffix.body), [252, 253, 254, 255]);
		const invalidRange = await request(mediaUrl, { headers: { Range: 'bytes=999-1000' } });
		assert.strictEqual(invalidRange.statusCode, 416);
		const post = await request(mediaUrl, { method: 'POST' });
		assert.strictEqual(post.statusCode, 405);

		const flowUrl = service.getFlowActionsUrl('room-one', {
			search: '?password=secret&volume=0.5&js=https://example.com/unsafe.js',
			localserver: true,
		});
		const parsedFlowUrl = new URL(flowUrl);
		assert.strictEqual(parsedFlowUrl.searchParams.get('session'), 'room-one');
		assert.strictEqual(parsedFlowUrl.searchParams.get('password'), 'secret');
		assert.strictEqual(parsedFlowUrl.searchParams.get('volume'), '0.5');
		assert.strictEqual(parsedFlowUrl.searchParams.has('localserver'), true);
		assert.strictEqual(parsedFlowUrl.searchParams.has('js'), false);

		await fsp.rm(mediaPath);
		assert.strictEqual((await service.getAsset(asset.id)).status, 'missing');
		const missing = await request(mediaUrl);
		assert.strictEqual(missing.statusCode, 404);
		const relinked = await service.registerFile(movedPath, { assetId: asset.id, allowedMediaTypes: ['video'] });
		assert.strictEqual(relinked.id, asset.id);
		assert.strictEqual((await service.getAsset(asset.id)).status, 'available');

		const oldBaseUrl = service.getBaseUrl();
		service.rotateToken();
		assert.notStrictEqual(service.getBaseUrl(), oldBaseUrl);
		assert.strictEqual((await request(`${oldBaseUrl}/actions.html`)).statusCode, 404);

		const persisted = new LocalMediaService({ store, runtimeRoot, logger: { log() {}, warn() {} } });
		assert.strictEqual((await persisted.getAsset(asset.id)).id, asset.id);
		assert.strictEqual(persisted.state.token, service.state.token);
		console.log('Local media library regression checks passed.');
	} finally {
		await service.stop();
		await fsp.rm(tempRoot, { recursive: true, force: true });
	}
}

run().catch((error) => {
	console.error(error);
	process.exit(1);
});
