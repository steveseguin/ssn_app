'use strict';

const crypto = require('crypto');
const https = require('https');
const WebSocket = require('ws');
const { createToken } = require('./edge-tts-token');

// Protocol reference: https://github.com/rany2/edge-tts (LGPL-3.0).
const HOST = 'speech.platform.bing.com';
const BASE_PATH = '/consumer/speech/synthesize/readaloud';
const CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const VERSION = '143.0.3650.75';
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_LENGTH = 10000;
const DEFAULT_VOICE = 'en-US-EmmaMultilingualNeural';

function headers() {
	return {
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
		'Accept-Language': 'en-US,en;q=0.9',
		Cookie: 'muid=' + crypto.randomBytes(16).toString('hex').toUpperCase() + ';',
	};
}
function escapeXml(text) {
	return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}
function signed(value, unit) {
	return (value >= 0 ? '+' : '') + value + unit;
}
// Split before XML escaping so neither Unicode characters nor entities are divided.
function splitText(text) {
	const parts = [];
	let part = '', bytes = 0;
	for (const char of text) {
		const size = Buffer.byteLength(escapeXml(char));
		if (bytes + size > 4000) { parts.push(part); part = ''; bytes = 0; }
		part += char; bytes += size;
	}
	if (part) parts.push(part);
	return parts;
}
class EdgeTts {
	constructor() {
		this.clockOffset = 0;
		this.voiceCache = null;
		this.voicePromise = null;
		this.active = new Set();
		this.queue = [];
		this.running = 0;
		this.stopped = false;
	}
	query() {
		return 'TrustedClientToken=' + CLIENT_TOKEN + '&Sec-MS-GEC=' + createToken(CLIENT_TOKEN, Date.now() + this.clockOffset) + '&Sec-MS-GEC-Version=2-' + VERSION;
	}
	adjustClock(date) {
		const serverTime = Date.parse(date || '');
		if (!Number.isFinite(serverTime)) return false;
		this.clockOffset = serverTime - Date.now();
		return true;
	}
	async voices(refresh = false) {
		if (this.stopped) throw new Error('Edge Natural has stopped.');
		if (refresh === true) this.voiceCache = null;
		if (this.voiceCache && Date.now() - this.voiceCache.time < 86400000) return this.voiceCache.voices;
		if (!this.voicePromise) {
			this.voicePromise = this.fetchVoices().then(voices => {
				this.voiceCache = { voices, time: Date.now() };
				return voices;
			}).finally(() => { this.voicePromise = null; });
		}
		return this.voicePromise;
	}
	async fetchVoices(retry = true) {
		return new Promise((resolve, reject) => {
			const request = https.get('https://' + HOST + BASE_PATH + '/voices/list?' + this.query(), { headers: headers() }, response => {
				if (response.statusCode === 403 && retry && this.adjustClock(response.headers.date)) {
					response.resume(); resolve(this.fetchVoices(false)); return;
				}
				if (response.statusCode !== 200) { response.resume(); reject(new Error('Edge voice list returned HTTP ' + response.statusCode)); return; }
				const chunks = []; let bytes = 0;
				response.on('data', chunk => {
					bytes += chunk.length;
					if (bytes > 2 * 1024 * 1024) request.destroy(new Error('Edge voice list is too large.'));
					else chunks.push(chunk);
				});
				response.on('error', reject);
				response.on('end', () => {
					try {
						const list = JSON.parse(Buffer.concat(chunks).toString('utf8'));
						if (!Array.isArray(list) || !list.length) throw new Error('Edge returned no voices.');
						resolve(list.filter(v => typeof v.ShortName === 'string' && typeof v.Locale === 'string').map(v => ({ name: v.ShortName, label: v.FriendlyName || v.ShortName, lang: v.Locale, gender: v.Gender || '' })));
					} catch (error) { reject(error); }
				});
			});
			this.active.add(request);
			request.on('close', () => this.active.delete(request));
			request.on('error', reject);
			request.setTimeout(15000, () => request.destroy(new Error('Edge voice list timed out.')));
		});
	}
	synthesize(payload = {}) {
		if (this.stopped) return Promise.reject(new Error('Edge Natural has stopped.'));
		if (!payload || typeof payload !== 'object') return Promise.reject(new Error('Invalid Edge Natural speech request.'));
		let text = typeof payload.text === 'string' ? payload.text : '';
		text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').trim();
		if (!text || text.length > MAX_TEXT_LENGTH) return Promise.reject(new Error('Edge Natural needs between 1 and 10,000 characters.'));
		const voice = payload.voice || DEFAULT_VOICE;
		if (typeof voice !== 'string' || !/^[a-z]{2,3}-[A-Za-z0-9-]+Neural$/.test(voice) || voice.length > 100) return Promise.reject(new Error('Invalid Edge voice.'));
		const rate = payload.rate === undefined ? 1 : Number(payload.rate);
		const pitch = payload.pitch === undefined ? 0 : Number(payload.pitch);
		if (!Number.isFinite(rate) || rate < 0.5 || rate > 2 || !Number.isFinite(pitch) || pitch < -100 || pitch > 100) return Promise.reject(new Error('Edge speed must be 0.5–2 and pitch -100–100 Hz.'));
		if (this.queue.length >= 32) return Promise.reject(new Error('Edge Natural is busy. Try again after the speech queue drains.'));
		return new Promise((resolve, reject) => {
			const job = { text, voice, rate, pitch, resolve, reject, deadline: Date.now() + 75000 };
			job.timer = setTimeout(() => {
				const index = this.queue.indexOf(job);
				if (index !== -1) this.queue.splice(index, 1);
				reject(new Error('Edge Natural speech queue timed out.'));
			}, 75000);
			this.queue.push(job);
			this.drain();
		});
	}
	drain() {
		while (!this.stopped && this.running < 2 && this.queue.length) {
			const job = this.queue.shift();
			clearTimeout(job.timer);
			this.running++;
			this.generate(job).then(job.resolve, job.reject).finally(() => { this.running--; this.drain(); });
		}
	}
	async generate(job) {
		const voices = await this.voices();
		if (!voices.some(voice => voice.name === job.voice)) throw new Error('This Edge voice is unavailable. Refresh the voice list.');
		const buffers = []; let bytes = 0;
		for (const part of splitText(job.text)) {
			if (this.stopped) throw new Error('Edge Natural has stopped.');
			if (Date.now() >= job.deadline) throw new Error('Edge Natural speech timed out.');
			const audio = await this.speakPart(part, job);
			bytes += audio.length;
			if (bytes > MAX_AUDIO_BYTES) throw new Error('Edge audio exceeded the size limit.');
			buffers.push(audio);
		}
		return { audio: Buffer.concat(buffers).toString('base64'), mimeType: 'audio/mpeg', voice: job.voice };
	}
	speakPart(text, settings, retry = true) {
		return new Promise((resolve, reject) => {
			const id = crypto.randomBytes(16).toString('hex');
			const socket = new WebSocket('wss://' + HOST + BASE_PATH + '/edge/v1?' + this.query() + '&ConnectionId=' + id, {
				headers: { ...headers(), Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', Pragma: 'no-cache', 'Cache-Control': 'no-cache' },
				handshakeTimeout: 15000, maxPayload: MAX_AUDIO_BYTES, perMessageDeflate: false,
			});
			this.active.add(socket);
			const chunks = []; let bytes = 0, settled = false;
			const timer = setTimeout(() => finish(new Error('Edge Natural speech timed out.')), Math.max(1, Math.min(60000, settings.deadline - Date.now())));
			const finish = (error, result) => {
				if (settled) return;
				settled = true; clearTimeout(timer); this.active.delete(socket);
				socket.terminate();
				if (error) reject(error); else resolve(result);
			};
			socket.on('unexpected-response', (request, response) => {
				response.resume();
				if (response.statusCode === 403 && retry && this.adjustClock(response.headers.date)) {
					finish(null, this.speakPart(text, settings, false));
				} else finish(new Error('Edge Natural returned HTTP ' + response.statusCode));
			});
			socket.on('error', error => finish(error));
			socket.on('close', () => finish(new Error('Edge Natural disconnected before completing speech.')));
			socket.on('open', () => {
				const timestamp = new Date(Date.now() + this.clockOffset).toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
				const config = { context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } };
				socket.send('X-Timestamp:' + timestamp + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' + JSON.stringify(config) + '\r\n');
				const lastDash = settings.voice.lastIndexOf('-');
				const name = 'Microsoft Server Speech Text to Speech Voice (' + settings.voice.slice(0, lastDash) + ', ' + settings.voice.slice(lastDash + 1) + ')';
				const ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="' + escapeXml(name) + '"><prosody rate="' + signed(Math.round((settings.rate - 1) * 100), '%') + '" pitch="' + signed(Math.round(settings.pitch), 'Hz') + '" volume="+0%">' + escapeXml(text) + '</prosody></voice></speak>';
				socket.send('X-RequestId:' + id + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + timestamp + 'Z\r\nPath:ssml\r\n\r\n' + ssml);
			});
			socket.on('message', (data, binary) => {
				if (settled) return;
				if (!binary) {
					if (/^Path:turn.end\r?$/mi.test(data.toString())) finish(bytes ? null : new Error('Edge Natural returned no audio.'), bytes ? Buffer.concat(chunks) : undefined);
					return;
				}
				if (data.length < 2) return finish(new Error('Invalid Edge audio frame.'));
				const offset = 2 + data.readUInt16BE(0);
				if (offset > data.length) return finish(new Error('Invalid Edge audio header.'));
				const header = data.subarray(2, offset).toString();
				if (!/^Path:audio\r?$/mi.test(header)) return finish(new Error('Unexpected Edge audio frame.'));
				if (offset === data.length) return;
				if (!/^Content-Type:audio\/mpeg\r?$/mi.test(header)) return finish(new Error('Unexpected Edge audio format.'));
				bytes += data.length - offset;
				if (bytes > MAX_AUDIO_BYTES) return finish(new Error('Edge audio exceeded the size limit.'));
				chunks.push(data.subarray(offset));
			});
		});
	}
	stop() {
		this.stopped = true;
		for (const job of this.queue.splice(0)) {
			clearTimeout(job.timer);
			job.reject(new Error('Edge Natural has stopped.'));
		}
		for (const connection of this.active) {
			if (connection.terminate) connection.terminate(); else connection.destroy(new Error('Edge Natural has stopped.'));
		}
		this.active.clear();
	}
}
module.exports = { EdgeTts };
