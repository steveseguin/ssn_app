'use strict';
// Edge Read Aloud token protocol, adapted to Node.js from rany2/edge-tts.
// https://github.com/rany2/edge-tts (LGPL-3.0; see edge-tts-LICENSE.txt).
// Fixed protocol constants are intentionally separate from the speech client.
const INITIAL = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
const STATE = [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
const SCHEDULE = [0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564];
const ROUNDS = [0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174, 0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA, 0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967, 0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070, 0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3, 0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2];
const COEFFICIENTS = [0xE82E91B1, 0xB32700D0, 0x44DE24C6, 0x88DFF51D, 0x3BEB65BC, 0x29514038, 0xC89C5933, 0xB328CBDF, 0x8D1EC211, 0xD405B4D5, 0x314EF5D5, 0x26E55F3C, 0xE92491B1, 0x607801C6, 0xF0A5B9D5, 0x82B2C1FB, 0x06064CF3, 0xFA51A3DA, 0xDA79FA60, 0x207CC464, 0xBED20560, 0x3C3C74F3, 0x89F9C9F8, 0xD2D14B61, 0x35FA38C6, 0xBB04A2C1, 0xCB49E3C6, 0xC5626167];
const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
const swap = value => rotate(value, 16) >>> 0;
const sigma0 = value => (rotate(value, 7) ^ rotate(value, 18) ^ (value >>> 3)) >>> 0;
const sigma1 = value => (rotate(value, 17) ^ rotate(value, 19) ^ (value >>> 10)) >>> 0;
function expand(words, start = 16) {
	for (let i = start; i < 64; i++) words[i] = (sigma1(words[i - 2]) + words[i - 7] + sigma0(words[i - 15]) + words[i - 16]) >>> 0;
}
function compress(state, words, start = 0) {
	let [a, b, c, d, e, f, g, h] = state;
	for (let i = start; i < 64; i++) {
		const constant = start === 14 && i === 14 ? 0xC9DC06A7 : ROUNDS[i];
		const first = (h + ((rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) >>> 0) + ((g ^ (e & (f ^ g))) >>> 0) + constant + words[i]) >>> 0;
		const second = (((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) >>> 0) + (((a & b) | (c & (a | b))) >>> 0)) >>> 0;
		[h, g, f, e, d, c, b, a] = [g, f, e, (d + first) >>> 0, c, b, a, (first + second) >>> 0];
	}
	return [a, b, c, d, e, f, g, h];
}
function digest(data) {
	const words = new Array(14).fill(0);
	words.push(data.readUIntBE(0, 3), data.readUInt32BE(3));
	for (let i = 16; i < 30; i++) {
		let value = SCHEDULE[i - 16];
		if (i - 2 >= 14) value += (sigma1(words[i - 2]) ^ (i === 16 ? 0x000B92C0 : 0)) >>> 0;
		if (i - 7 >= 14) value += words[i - 7];
		if (i - 15 >= 14) value += (sigma0(words[i - 15]) ^ (i === 29 ? 0x059C0B80 : 0)) >>> 0;
		words.push(value >>> 0);
	}
	words.push((sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + 0xC9DC06A7 - ROUNDS[14]) >>> 0);
	expand(words, 31);
	let state = compress(STATE, words, 14).map((value, i) => (value + INITIAL[i]) >>> 0);
	const length = 57 + data.length;
	const padding = (55 - length % 64 + 64) % 64;
	const tail = Buffer.alloc(data.length - 7 + 1 + padding + 8);
	data.copy(tail, 0, 7);
	tail[data.length - 7] = 0x80;
	tail.writeBigUInt64BE(BigInt(length * 8), tail.length - 8);
	for (let offset = 0; offset < tail.length; offset += 64) {
		const block = Array.from({ length: 16 }, (_, i) => tail.readUInt32BE(offset + i * 4));
		expand(block);
		state = compress(state, block).map((value, i) => (value + state[i]) >>> 0);
	}
	const result = Buffer.alloc(32);
	state.forEach((value, i) => result.writeUInt32BE(value, i * 4));
	return result;
}
function checksum(data, hash) {
	const keys = [hash.readUInt32LE(0) | 1, hash.readUInt32LE(4) | 1];
	const factors = keys.map(value => Math.imul(value, 0x82893933));
	const terms = [], offsets = [];
	for (let i = 0; i < COEFFICIENTS.length; i += 2) {
		terms.push(Math.imul(COEFFICIENTS[i], factors[(i / 2) % 2]));
		offsets.push(COEFFICIENTS[i + 1]);
	}
	const padded = Buffer.alloc(Math.ceil((data.length + 1) / 8) * 8);
	data.copy(padded, 1);
	for (let i = 0; i < padded.length / 4; i++) {
		const word = padded.readUInt32LE(i * 4);
		terms.push((Math.imul(word, keys[i % 2]) + (i === 0 ? Math.imul(0xF2F90B1A, factors[0]) : 0)) >>> 0);
		offsets.push((Math.imul(swap(word), i % 2 ? 0xC31713DB : 0xEF0569FB) + (i === 0 ? 0x0B1A0000 : 0)) >>> 0);
	}
	let swapped = 0, last = 0, state = 0, accumulated = 0;
	for (let i = 0; i < terms.length; i += 2) {
		let q = Math.imul(swap((offsets[i] + terms[i]) >>> 0), 0x76F50F34);
		swapped = (swapped + Math.imul(swap(q), 0xC3EFEA97) + q) >>> 0;
		q = Math.imul(swap((offsets[i + 1] + terms[i + 1]) >>> 0), 0x1881CE3C);
		last = (Math.imul(swap(q), 0x35BD1EC9) + q) >>> 0;
		swapped = (swapped + last) >>> 0;
		state = (Math.imul(state, keys[0]) + terms[i]) >>> 0;
		for (const factor of [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83]) state = Math.imul(swap(state), factor) >>> 0;
		accumulated = (accumulated + state) >>> 0;
		state = (Math.imul(state, keys[1]) + terms[i + 1]) >>> 0;
		for (const factor of [0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69]) state = Math.imul(swap(state), factor) >>> 0;
		accumulated = (accumulated + state) >>> 0;
	}
	const result = Buffer.alloc(8);
	result.writeUInt32LE((last ^ state) >>> 0, 0);
	result.writeUInt32LE((swapped ^ accumulated) >>> 0, 4);
	return result;
}
function createToken(clientToken, now = Date.now()) {
	const seconds = BigInt(Math.floor(now / 1000)) + 11644473600n;
	const ticks = (seconds - seconds % 300n) * 10000000n;
	const data = Buffer.from(ticks.toString() + clientToken, 'ascii');
	const hash = digest(data);
	return (checksum(data, hash).toString('hex') + '-' + hash.toString('hex')).toUpperCase();
}
module.exports = { createToken };
