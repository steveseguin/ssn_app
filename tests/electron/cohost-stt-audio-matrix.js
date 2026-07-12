'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const fixturePath = path.resolve(__dirname, 'fixtures', 'cohost-stt.wav');
const e2ePath = path.resolve(__dirname, 'cohost-stt-e2e.js');

function inspectPcm16Wave(buffer) {
	assert(buffer.length >= 44, 'Audio fixture is too small to be a WAV file.');
	assert.strictEqual(buffer.toString('ascii', 0, 4), 'RIFF', 'Audio fixture is not RIFF.');
	assert.strictEqual(buffer.toString('ascii', 8, 12), 'WAVE', 'Audio fixture is not WAVE.');
	let offset = 12;
	let format = null;
	let data = null;
	while (offset + 8 <= buffer.length) {
		const id = buffer.toString('ascii', offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		const payloadOffset = offset + 8;
		if (payloadOffset + size > buffer.length) break;
		if (id === 'fmt ' && size >= 16) {
			format = {
				audioFormat: buffer.readUInt16LE(payloadOffset),
				channels: buffer.readUInt16LE(payloadOffset + 2),
				sampleRate: buffer.readUInt32LE(payloadOffset + 4),
				bitsPerSample: buffer.readUInt16LE(payloadOffset + 14),
			};
		} else if (id === 'data') {
			data = { offset: payloadOffset, size };
		}
		offset = payloadOffset + size + (size % 2);
	}
	assert(format, 'Audio fixture has no fmt chunk.');
	assert(data, 'Audio fixture has no data chunk.');
	assert.deepStrictEqual(format, {
		audioFormat: 1,
		channels: 1,
		sampleRate: 16000,
		bitsPerSample: 16,
	}, 'Audio fixture must be 16 kHz mono PCM16.');
	assert.strictEqual(data.size % 2, 0, 'PCM16 data size must be even.');
	return data;
}

function createNoiseGenerator(seed) {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return (state / 0xffffffff) * 2 - 1;
	};
}

function writeVariant(source, target, transform) {
	const output = Buffer.from(source);
	const data = inspectPcm16Wave(output);
	for (let offset = data.offset, index = 0; offset < data.offset + data.size; offset += 2, index += 1) {
		const sample = output.readInt16LE(offset) / 32768;
		const transformed = Math.max(-1, Math.min(1, transform(sample, index)));
		output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(transformed * 32767))), offset);
	}
	fs.writeFileSync(target, output);
}

function runE2e(variant) {
	return new Promise((resolve, reject) => {
		console.log(`\n[cohost-stt-matrix] Running ${variant.name}`);
		const child = spawn(process.execPath, [e2ePath], {
			env: {
				...process.env,
				SSAPP_STT_AUDIO_FIXTURE: variant.path,
				SSAPP_STT_EXPECT_SPEECH: variant.expectSpeech ? '1' : '0',
				SSAPP_STT_FULL_LIFECYCLE: variant.fullLifecycle ? '1' : '0',
				SSAPP_STT_TEST_TTS: variant.testTts ? '1' : '0',
			},
			stdio: 'inherit',
			windowsHide: true,
		});
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${variant.name} failed with ${signal || `exit code ${code}`}.`));
		});
	});
}

async function run() {
	assert(fs.existsSync(fixturePath), `Missing fixture: ${fixturePath}`);
	const source = fs.readFileSync(fixturePath);
	inspectPcm16Wave(source);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-cohost-stt-audio-'));
	const quietPath = path.join(tempDir, 'quiet-speech.wav');
	const noisyPath = path.join(tempDir, 'speech-with-background-noise.wav');
	const noiseOnlyPath = path.join(tempDir, 'background-noise-only.wav');
	const speechNoise = createNoiseGenerator(0x51a7cafe);
	const backgroundNoise = createNoiseGenerator(0x19b4d00d);

	try {
		writeVariant(source, quietPath, sample => sample * 0.18);
		writeVariant(source, noisyPath, sample => sample * 0.45 + speechNoise() * 0.012);
		writeVariant(source, noiseOnlyPath, () => backgroundNoise() * 0.005);

		const variants = [
			{ name: 'clean speech with TTS and lifecycle checks', path: fixturePath, expectSpeech: true, fullLifecycle: true, testTts: true },
			{ name: 'quiet speech', path: quietPath, expectSpeech: true, fullLifecycle: false },
			{ name: 'speech with steady background noise', path: noisyPath, expectSpeech: true, fullLifecycle: false },
			{ name: 'background noise without speech', path: noiseOnlyPath, expectSpeech: false, fullLifecycle: false },
		];
		for (const variant of variants) await runE2e(variant);
		console.log('\n[cohost-stt-matrix] PASS all audio fixtures');
	} finally {
		const resolvedTempRoot = path.resolve(os.tmpdir()) + path.sep;
		const resolvedTempDir = path.resolve(tempDir);
		if (resolvedTempDir.startsWith(resolvedTempRoot) && path.basename(resolvedTempDir).startsWith('ssapp-cohost-stt-audio-')) {
			fs.rmSync(resolvedTempDir, { recursive: true, force: true });
		}
	}
}

run().catch(error => {
	console.error('[cohost-stt-matrix] FAILED:', error && error.stack ? error.stack : error);
	process.exitCode = 1;
});
