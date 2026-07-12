'use strict';

const { parentPort, workerData } = require('worker_threads');

const DEFAULT_MODEL_ID = 'Xenova/whisper-tiny.en';
const SAMPLE_RATE = 16000;

const modelId = String(workerData && workerData.modelId ? workerData.modelId : DEFAULT_MODEL_ID);
const cacheDir = String(workerData && workerData.cacheDir ? workerData.cacheDir : '');

let transcriberPromise = null;
let modelLoadCount = 0;
let currentRequestId = null;
const progressBuckets = new Map();

function postStatus(phase, detail = {}) {
	parentPort.postMessage({
		type: 'status',
		id: currentRequestId,
		phase,
		model: modelId,
		...detail,
	});
}

function handleModelProgress(progress) {
	if (!progress || typeof progress !== 'object') return;
	const file = typeof progress.file === 'string' ? progress.file : '';
	const status = typeof progress.status === 'string' ? progress.status : '';
	if (status === 'progress' && Number.isFinite(progress.progress)) {
		const percent = Math.max(0, Math.min(100, Math.round(progress.progress)));
		const bucket = percent === 100 ? 100 : Math.floor(percent / 5) * 5;
		const key = file || 'model';
		if (progressBuckets.get(key) === bucket) return;
		progressBuckets.set(key, bucket);
		postStatus('download', { file, progress: bucket });
		return;
	}
	if (status === 'ready' || status === 'done') {
		postStatus('model-file-ready', { file, progress: 100 });
	}
}

async function getTranscriber() {
	if (transcriberPromise) return transcriberPromise;
	modelLoadCount += 1;
	progressBuckets.clear();
	postStatus('model-loading');
	transcriberPromise = (async () => {
		const transformers = await import('@huggingface/transformers');
		if (cacheDir) {
			transformers.env.cacheDir = cacheDir;
		}
		transformers.env.allowLocalModels = true;
		transformers.env.allowRemoteModels = true;
		const transcriber = await transformers.pipeline('automatic-speech-recognition', modelId, {
			cache_dir: cacheDir || null,
			device: 'cpu',
			dtype: 'q8',
			progress_callback: handleModelProgress,
		});
		postStatus('model-ready', { modelLoadCount });
		return transcriber;
	})().catch((error) => {
		transcriberPromise = null;
		throw error;
	});
	return transcriberPromise;
}

function normalizeAudio(audioBuffer) {
	if (!(audioBuffer instanceof ArrayBuffer)) {
		throw new Error('STT worker expected an ArrayBuffer.');
	}
	if (audioBuffer.byteLength === 0 || audioBuffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
		throw new Error('STT worker received invalid PCM audio.');
	}
	const audio = new Float32Array(audioBuffer);
	for (let index = 0; index < audio.length; index += 1) {
		const sample = audio[index];
		if (!Number.isFinite(sample)) {
			audio[index] = 0;
		} else if (sample > 1) {
			audio[index] = 1;
		} else if (sample < -1) {
			audio[index] = -1;
		}
	}
	return audio;
}

function normalizeTranscript(value) {
	return String(value || '')
		.replace(/\[(?:blank_audio|music|silence|inaudible)\]/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

parentPort.on('message', async (message) => {
	const requestId = message && Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : null;
	currentRequestId = requestId;
	const startedAt = Date.now();
	try {
		const audio = normalizeAudio(message && message.audioBuffer);
		postStatus('transcribing', {
			durationMs: Math.round((audio.length / SAMPLE_RATE) * 1000),
		});
		const transcriber = await getTranscriber();
		const output = await transcriber(audio);
		parentPort.postMessage({
			type: 'result',
			id: requestId,
			text: normalizeTranscript(output && output.text),
			model: modelId,
			modelLoadCount,
			elapsedMs: Date.now() - startedAt,
		});
	} catch (error) {
		parentPort.postMessage({
			type: 'result',
			id: requestId,
			error: error && error.message ? error.message : String(error),
			model: modelId,
			modelLoadCount,
			elapsedMs: Date.now() - startedAt,
		});
	} finally {
		currentRequestId = null;
	}
});
