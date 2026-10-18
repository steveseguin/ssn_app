'use strict';

const crypto = require('crypto');

const MAX_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const TTL_MS = 5 * 60 * 1000;
const artifactId = { type: 'string', pattern: '^export_[a-f0-9]{32}$' };
const confirm = { type: 'boolean', const: true };
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const EXPORT_COMMANDS = Object.freeze({
	exportSettingsBackup: {
		name: 'ssapp_export_settings_backup', title: 'Export settings backup', readOnly: false,
		description: 'Create a temporary settings backup without a save dialog. Includes saved credentials; require user approval. Returns metadata only. Read within five minutes, then release.',
		schema: schema({ confirm }, ['confirm']),
	},
	readSettingsExport: {
		name: 'ssapp_read_settings_export', title: 'Read settings export', readOnly: true,
		description: 'Read metadata and a bounded base64 chunk from a settings export created by automation. No host paths accepted. Set length to 0 for metadata only. Save bytes to a file; do not print backup contents.',
		schema: schema({ artifactId, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 0, maximum: CHUNK_BYTES } }, ['artifactId']),
	},
	releaseSettingsExport: {
		name: 'ssapp_release_settings_export', title: 'Release settings export', readOnly: false,
		description: 'Discard a temporary settings export, including a cancelled transfer. Does not delete files already saved on the agent computer.',
		schema: schema({ artifactId, confirm }, ['artifactId', 'confirm']),
	},
});

const fail = (code, message) => Object.assign(new Error(message), { code });

class SettingsExportService {
	constructor(collect) {
		this.collect = collect;
		this.exports = new Map();
		this.pending = false;
		this.closed = false;
	}
	discard(id) {
		const entry = this.exports.get(id);
		if (!entry) return;
		clearTimeout(entry.timer);
		entry.bytes.fill(0);
		this.exports.delete(id);
	}
	async execute(action, value) {
		try {
			const command = EXPORT_COMMANDS[action];
			if (!command || !value || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(command.schema.properties, key))) throw fail('INVALID_ARGUMENT', 'Invalid settings export arguments.');
			if (this.closed) throw fail('SSAPP_UNAVAILABLE', 'Settings exports are closed.');
			if (!command.readOnly && value.confirm !== true) throw fail('CONFIRMATION_REQUIRED', 'Confirm this settings export action.');
			if (action === 'exportSettingsBackup') {
				if (this.pending || this.exports.size >= 4) throw fail('EXPORT_LIMIT', 'Release previous exports before creating another backup.');
				this.pending = true;
				let timer;
				try {
					// A timed-out renderer read may still be running. Keep one collection
					// in flight until it settles; never create a late artifact after timeout.
					const collection = Promise.resolve().then(() => this.collect()).finally(() => { this.pending = false; });
					const backup = await Promise.race([
						collection,
						new Promise((_, reject) => { timer = setTimeout(() => reject(fail('EXPORT_TIMEOUT', 'Settings collection timed out; no export was retained.')), 10000); }),
					]);
					if (this.closed) throw fail('SSAPP_UNAVAILABLE', 'Settings exports are closed.');
					const bytes = Buffer.from(JSON.stringify(backup.payload, null, 2), 'utf8');
					if (bytes.length > MAX_BYTES) { bytes.fill(0); throw fail('EXPORT_TOO_LARGE', 'Settings backup exceeds the 8 MiB automation limit. Use the ordinary File menu export.'); }
					const id = 'export_' + crypto.randomBytes(16).toString('hex');
					const metadata = { artifactId: id, status: 'completed', fileName: backup.fileName, mimeType: 'application/json', size: bytes.length,
						sha256: crypto.createHash('sha256').update(bytes).digest('hex'), expiresAt: new Date(Date.now() + TTL_MS).toISOString(), chunkBytes: CHUNK_BYTES };
					const expiry = setTimeout(() => this.discard(id), TTL_MS);
					expiry.unref();
					this.exports.set(id, { metadata, bytes, timer: expiry });
					return { ok: true, payload: metadata };
				} finally { clearTimeout(timer); }
			}
			if (typeof value.artifactId !== 'string' || !/^export_[a-f0-9]{32}$/.test(value.artifactId)) throw fail('INVALID_ARGUMENT', 'Use an artifactId returned by exportSettingsBackup.');
			let entry = this.exports.get(value.artifactId);
			if (entry && Date.parse(entry.metadata.expiresAt) <= Date.now()) { this.discard(value.artifactId); entry = null; }
			if (!entry) throw fail('EXPORT_NOT_FOUND', 'Export is unavailable, released, expired, or from a previous app instance.');
			if (action === 'releaseSettingsExport') {
				this.discard(value.artifactId);
				return { ok: true, payload: { artifactId: value.artifactId, status: 'released' } };
			}
			const offset = value.offset === undefined ? 0 : value.offset;
			const length = value.length === undefined ? CHUNK_BYTES : value.length;
			if (!Number.isInteger(offset) || offset < 0 || offset > entry.bytes.length || !Number.isInteger(length) || length < 0 || length > CHUNK_BYTES) throw fail('INVALID_ARGUMENT', 'Invalid export chunk range.');
			const end = Math.min(entry.bytes.length, offset + length);
			return { ok: true, payload: { ...entry.metadata, offset, nextOffset: end, eof: end === entry.bytes.length, dataBase64: entry.bytes.subarray(offset, end).toString('base64') } };
		} catch (error) {
			return { ok: false, error: { code: error.code || 'EXPORT_FAILED', message: error.code ? error.message : 'Unable to collect settings for export.' } };
		}
	}
	close() { this.closed = true; for (const id of this.exports.keys()) this.discard(id); }
}

module.exports = { EXPORT_COMMANDS, SettingsExportService };
