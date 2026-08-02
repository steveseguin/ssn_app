'use strict';

const assert = require('assert');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const executableOverride = String(process.env.SSAPP_E2E_EXECUTABLE || '').trim();
const electronPath = executableOverride ? path.resolve(executableOverride) : require('electron');
const electronAppArgs = executableOverride ? [] : ['.'];
const socialStreamRootPath = path.resolve(repoRoot, '..', 'social_stream');
const socialStreamRoot = pathToFileURL(socialStreamRootPath + path.sep).href;
const cohostUrl = `${pathToFileURL(path.join(socialStreamRootPath, 'cohost.html')).href}?session=desktop-whisper-e2e`;
const audioFixture = path.resolve(process.env.SSAPP_STT_AUDIO_FIXTURE || path.join(__dirname, 'fixtures', 'cohost-stt.wav'));
const expectSpeech = process.env.SSAPP_STT_EXPECT_SPEECH !== '0';
const runFullLifecycle = process.env.SSAPP_STT_FULL_LIFECYCLE !== '0';
const testTtsLifecycle = process.env.SSAPP_STT_TEST_TTS === '1';
const testActualQwen = process.env.SSAPP_STT_ACTUAL_QWEN === '1';
const qwenProvider = String(process.env.SSAPP_STT_QWEN_PROVIDER || 'localqwen').trim();
if (!/^localqwen(?:2b)?$/.test(qwenProvider)) throw new Error(`Unsupported Qwen test provider: ${qwenProvider}`);
const modelCacheDir = path.resolve(repoRoot, '.codex-tmp', 'whisper-cache');
const userDataOverride = String(process.env.SSAPP_STT_USER_DATA_DIR || '').trim();
const userDataDir = userDataOverride
	? path.resolve(userDataOverride)
	: fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-cohost-stt-profile-'));
fs.mkdirSync(userDataDir, { recursive: true });
const token = `cohost-stt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let mainWindowId = null;
let cohostWindowId = null;

async function getFreePort() {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = address && typeof address === 'object' ? address.port : 0;
			server.close(() => resolve(port));
		});
		server.on('error', reject);
	});
}

function requestJson(port, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : null;
		const request = http.request({
			host: '127.0.0.1',
			port,
			path: `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
			method: payload ? 'POST' : 'GET',
			headers: payload ? {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload),
			} : {},
		}, (response) => {
			let text = '';
			response.setEncoding('utf8');
			response.on('data', chunk => {
				text += chunk;
			});
			response.on('end', () => {
				try {
					const json = text ? JSON.parse(text) : {};
					if (response.statusCode >= 200 && response.statusCode < 300) {
						resolve(json);
						return;
					}
					reject(new Error(`HTTP ${response.statusCode}: ${text}`));
				} catch (error) {
					reject(error);
				}
			});
		});
		request.on('error', reject);
		if (payload) request.write(payload);
		request.end();
	});
}

async function waitForRemoteControl(port, timeoutMs = 60000) {
	const startedAt = Date.now();
	let lastError = null;
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const result = await requestJson(port, '/ping');
			if (result && result.ok) return;
		} catch (error) {
			lastError = error;
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	throw new Error(`Timed out waiting for SSApp remote control: ${lastError ? lastError.message : 'no response'}`);
}

async function waitForWindow(port, predicate, timeoutMs = 60000) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const result = await requestJson(port, '/windows');
		const match = (result.windows || []).find(predicate);
		if (match) return match;
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('Timed out waiting for the requested Electron window.');
}

async function execInWindow(port, windowId, code, label) {
	const response = await requestJson(port, '/exec', { windowId, code });
	if (!response || response.ok !== true) {
		throw new Error(`${label}: ${response && response.error ? response.error : 'renderer execution failed'}`);
	}
	return response.result;
}

async function waitForExecResult(port, windowId, code, label, timeoutMs = 120000) {
	const startedAt = Date.now();
	let lastError = null;
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const result = await execInWindow(port, windowId, code, label);
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		await new Promise(resolve => setTimeout(resolve, 300));
	}
	throw new Error(`${label}: timed out${lastError ? ` (${lastError.message})` : ''}`);
}

async function waitForStablePromptCount(port, cohostWindowId, waitMs) {
	await new Promise(resolve => setTimeout(resolve, 1000));
	const baseline = await execInWindow(port, cohostWindowId, '(window.__desktopSttPrompts || []).length', 'read prompt baseline');
	await new Promise(resolve => setTimeout(resolve, waitMs));
	const after = await execInWindow(port, cohostWindowId, '(window.__desktopSttPrompts || []).length', 'read prompt count');
	assert.strictEqual(after, baseline, `Expected prompt count to stay at ${baseline}, got ${after}.`);
	return baseline;
}

async function run() {
	assert(fs.existsSync(audioFixture), `Missing fake microphone fixture: ${audioFixture}`);
	fs.mkdirSync(modelCacheDir, { recursive: true });
	const port = await getFreePort();
	const child = spawn(electronPath, [
		'--use-fake-device-for-media-stream',
		'--use-fake-ui-for-media-stream',
		`--use-file-for-fake-audio-capture=${audioFixture}`,
		...electronAppArgs,
		'--running-from-source',
		'--filesource',
		socialStreamRoot,
		'--remote-control',
		...linuxLaunchArgs(),
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			...(testActualQwen ? {} : { SSAPP_DIAGNOSTICS_SAFE_GPU: '1' }),
			SSAPP_USER_DATA_DIR: userDataDir,
			SSAPP_REMOTE_CONTROL: '1',
			SSAPP_REMOTE_CONTROL_PORT: String(port),
			SSAPP_REMOTE_CONTROL_TOKEN: token,
			SSAPP_STT_MODEL_CACHE_DIR: modelCacheDir,
			SSAPP_DEBUG_LOGS: '0',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});

	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', chunk => {
		stdout += chunk;
	});
	child.stderr.on('data', chunk => {
		stderr += chunk;
	});
	const timer = setTimeout(() => {
		try {
			child.kill();
		} catch (_) { }
	}, (testActualQwen ? 15 : 8) * 60 * 1000);

	try {
		await waitForRemoteControl(port);
		const mainWindow = await waitForWindow(port, win => typeof win.url === 'string' && win.url.includes('index.html'));
		mainWindowId = mainWindow.id;
		const forbidden = await execInWindow(port, mainWindowId, `(async () => {
			try {
				await window.ninjafy.getSttCapabilities();
				return 'allowed';
			} catch (error) {
				return String(error && error.message ? error.message : error);
			}
		})()`, 'verify STT sender restriction');
		assert(/SSAPP_STT_FORBIDDEN/.test(forbidden), `Main app unexpectedly accessed cohost STT: ${forbidden}`);

		await execInWindow(port, mainWindowId, `window.open(${JSON.stringify(cohostUrl)}, '_blank'); true;`, 'open cohost');
		const cohostWindow = await waitForWindow(port, win => typeof win.url === 'string' && win.url.includes('cohost.html'));
		cohostWindowId = cohostWindow.id;
		await waitForExecResult(port, cohostWindow.id, `!!document.getElementById('providerSelect')`, 'wait for cohost controls', 30000);
		await execInWindow(port, cohostWindow.id, `(async () => {
			const devices = await navigator.mediaDevices.enumerateDevices();
			window.__cohostE2eDevices = devices.map(device => ({ kind: device.kind, label: device.label, deviceId: device.deviceId }));
			const video = document.getElementById('videoSource');
			const audio = document.getElementById('audioSource');
			if (!video.options.length) {
				video.appendChild(new Option('No Video', 'none'));
				video.appendChild(new Option('Screen Share', 'screen'));
				devices.filter(device => device.kind === 'videoinput').forEach(device => video.appendChild(new Option(device.label || 'Camera', device.deviceId)));
			}
			if (!audio.options.length) {
				audio.appendChild(new Option('No Audio', 'none'));
				devices.filter(device => device.kind === 'audioinput').forEach(device => audio.appendChild(new Option(device.label || 'Microphone', device.deviceId)));
			}
			return true;
		})()`, 'refresh cohost devices');
		if (testActualQwen) {
			const qwenPreflight = await execInWindow(port, cohostWindow.id, `({
				localBrowserPublisher: typeof LocalBrowserPublisher,
				optionConstructor: typeof Option,
				deviceCount: (window.__cohostE2eDevices || []).length,
				providerReady: !!document.getElementById('providerSelect')
			})`, 'read Qwen preflight');
			console.log('[cohost-stt-e2e] Qwen preflight:', JSON.stringify(qwenPreflight));
		}

		const setup = await execInWindow(port, cohostWindow.id, `(() => {
			window.__desktopSttPrompts = [];
			window.__desktopSttStatuses = [];
			window.__desktopRecognitionEvents = [];
			window.__desktopTtsCalls = [];
			window.__desktopQwenCompletions = [];
			window.__desktopCapturedFrames = 0;
			window.__desktopAttachedFrames = 0;
			require('electron').ipcRenderer.on('stt:status', (_event, status) => window.__desktopSttStatuses.push(status));
			if (${testTtsLifecycle ? 'true' : 'false'}) {
				const originalStart = DesktopWhisperRecognition.prototype.start;
				const originalStop = DesktopWhisperRecognition.prototype.stop;
				DesktopWhisperRecognition.prototype.start = function () {
					window.__desktopRecognitionEvents.push('start');
					return originalStart.apply(this, arguments);
				};
				DesktopWhisperRecognition.prototype.stop = function () {
					window.__desktopRecognitionEvents.push('stop');
					return originalStop.apply(this, arguments);
				};
				if (!window.TTS) throw new Error('Cohost TTS runtime is unavailable.');
				if (typeof window.TTS.finishedAudio !== 'function') window.TTS.finishedAudio = function () {};
				window.TTS.speak = function (text) {
					window.__desktopTtsCalls.push(String(text || ''));
					setTimeout(() => window.TTS.finishedAudio(), 650);
				};
			}
			if (${testActualQwen ? 'true' : 'false'}) {
				const originalSendPromptNow = LocalBrowserPublisher.prototype.sendPromptNow;
				LocalBrowserPublisher.prototype.sendPromptNow = async function (prompt, source) {
					window.__desktopSttPrompts.push(String(prompt || ''));
					try {
						const result = await originalSendPromptNow.apply(this, arguments);
						window.__desktopQwenCompletions.push({ prompt: String(prompt || ''), source: String(source || ''), ok: true });
						return result;
					} catch (error) {
						window.__desktopQwenCompletions.push({ prompt: String(prompt || ''), source: String(source || ''), ok: false, error: String(error?.message || error || '') });
						throw error;
					}
				};
				const originalCaptureFrame = LocalBrowserPublisher.prototype.captureFrameDataUrl;
				LocalBrowserPublisher.prototype.captureFrameDataUrl = function () {
					const frame = originalCaptureFrame.apply(this, arguments);
					if (frame) window.__desktopCapturedFrames += 1;
					return frame;
				};
				const originalRequestWorker = LocalBrowserPublisher.prototype.requestWorker;
				LocalBrowserPublisher.prototype.requestWorker = function (type, payload) {
					if (type === 'generate' && Array.isArray(payload?.images) && payload.images.length) window.__desktopAttachedFrames += payload.images.length;
					return originalRequestWorker.apply(this, arguments);
				};
			} else {
				probeConfiguredLLMBridge = function () { return Promise.resolve(); };
				requestConfiguredLLM = async function (prompt) {
					window.__desktopSttPrompts.push(String(prompt || ''));
					return { text: 'Desktop Whisper bridge response.' };
				};
			}
			const provider = document.getElementById('providerSelect');
			provider.value = ${testActualQwen ? JSON.stringify(qwenProvider) : "'configuredllm'"};
			provider.dispatchEvent(new Event('change', { bubbles: true }));
			const responseType = document.getElementById('responseType');
			responseType.value = ${testTtsLifecycle ? "'audio'" : "'text'"};
			responseType.dispatchEvent(new Event('change', { bubbles: true }));
			const video = document.getElementById('videoSource');
			const testDevices = window.__cohostE2eDevices || [];
			video.innerHTML = '';
			video.appendChild(new Option('No Video', 'none'));
			video.appendChild(new Option('Screen Share', 'screen'));
			testDevices.filter(device => device.kind === 'videoinput').forEach(device => video.appendChild(new Option(device.label || 'Camera', device.deviceId)));
			if (${testActualQwen ? 'true' : 'false'}) {
				const selectedVideo = Array.from(video.options).find(option => option.value !== 'none' && !/screen|share|window|entire/i.test(option.value + ' ' + option.text));
				if (!selectedVideo) throw new Error('Fake camera option was not found.');
				video.value = selectedVideo.value;
			} else {
				video.value = 'none';
			}
			const audio = document.getElementById('audioSource');
			audio.innerHTML = '';
			audio.appendChild(new Option('No Audio', 'none'));
			testDevices.filter(device => device.kind === 'audioinput').forEach(device => audio.appendChild(new Option(device.label || 'Microphone', device.deviceId)));
			const selected = Array.from(audio.options).find(option => /fake/i.test(option.text)) || Array.from(audio.options).find(option => option.value !== 'none');
			if (!selected) throw new Error('Fake microphone option was not found.');
			audio.value = selected.value;
			return { audioLabel: selected.text, audioValue: selected.value, videoValue: video.value };
		})()`, 'configure cohost');
		assert(setup && setup.audioValue !== 'none', `No fake microphone selected: ${JSON.stringify(setup)}`);
		const desktopUx = await execInWindow(port, cohostWindow.id, `({
			inputMode: document.getElementById('voiceInputMode')?.textContent || '',
			deviceNotice: document.getElementById('realtime-device-notice')?.textContent || ''
		})`, 'read Desktop voice UX');
		assert(/Desktop Whisper/i.test(desktopUx.inputMode), `Desktop input mode is unclear: ${desktopUx.inputMode}`);
		assert(/local Whisper/i.test(desktopUx.deviceNotice) && /selected microphone/i.test(desktopUx.deviceNotice), `Desktop device notice is unclear: ${desktopUx.deviceNotice}`);
		assert(/42 MB/i.test(desktopUx.deviceNotice) && /offline/i.test(desktopUx.deviceNotice), `Desktop first-use notice is incomplete: ${desktopUx.deviceNotice}`);

		const capabilities = await execInWindow(port, cohostWindow.id, 'window.ninjafy.getSttCapabilities()', 'read STT capabilities');
		assert(capabilities && capabilities.available === true, `Desktop STT unavailable: ${JSON.stringify(capabilities)}`);
		assert.strictEqual(capabilities.engine, 'whisper');
		assert.strictEqual(capabilities.sampleRate, 16000);

		const invalidAudioChecks = await execInWindow(port, cohostWindow.id, `(async () => {
			async function captureError(audio, sampleRate) {
				try {
					await require('electron').ipcRenderer.invoke('stt:transcribe', { audio: audio.buffer, sampleRate });
					return 'allowed';
				} catch (error) {
					return String(error && error.message ? error.message : error);
				}
			}
			return {
				short: await captureError(new Float32Array(100), 16000),
				wrongRate: await captureError(new Float32Array(8000), 8000),
				long: await captureError(new Float32Array(16000 * 20 + 1), 16000)
			};
		})()`, 'verify STT payload validation');
		assert(/SSAPP_STT_AUDIO_SHORT/.test(invalidAudioChecks.short), `Short STT audio was not rejected: ${invalidAudioChecks.short}`);
		assert(/SSAPP_STT_SAMPLE_RATE/.test(invalidAudioChecks.wrongRate), `Wrong-rate STT audio was not rejected: ${invalidAudioChecks.wrongRate}`);
		assert(/SSAPP_STT_AUDIO_LONG/.test(invalidAudioChecks.long), `Oversized STT audio was not rejected: ${invalidAudioChecks.long}`);
		const validationDiagnostics = await execInWindow(port, cohostWindow.id, 'window.ninjafy.getSttDiagnostics()', 'read pre-transcription STT diagnostics');
		assert.strictEqual(validationDiagnostics.workerCreateCount, 0, `Invalid audio created a Whisper worker: ${JSON.stringify(validationDiagnostics)}`);

		const childFrameSecurity = await execInWindow(port, cohostWindow.id, `new Promise(resolve => {
			const marker = 'stt-child-' + Date.now();
			const listener = event => {
				if (!event.data || event.data.marker !== marker) return;
				window.removeEventListener('message', listener);
				event.source.frameElement.remove();
				resolve(event.data.result);
			};
			window.addEventListener('message', listener);
			const frame = document.createElement('iframe');
			frame.srcdoc = '<script>(async function(){try{await require("electron").ipcRenderer.invoke("stt:get-capabilities");parent.postMessage({marker:' + JSON.stringify(marker) + ',result:"allowed"},"*");}catch(e){parent.postMessage({marker:' + JSON.stringify(marker) + ',result:String(e&&e.message?e.message:e)},"*");}})();<\\/script>';
			document.body.appendChild(frame);
			setTimeout(() => resolve('timeout'), 5000);
		})`, 'verify child-frame STT restriction');
		assert(/SSAPP_STT_FORBIDDEN/.test(childFrameSecurity), `Child frame unexpectedly accessed STT: ${childFrameSecurity}`);

		await execInWindow(port, cohostWindow.id, `document.getElementById('startButton').click(); true;`, 'start cohost');
		await waitForExecResult(port, cohostWindow.id, `document.getElementById('startButton').dataset.started === 'true'`, 'wait for cohost start', testActualQwen ? 900000 : 30000);

		let recognized = null;
		let diagnostics = null;
		if (expectSpeech) {
			recognized = await waitForExecResult(port, cohostWindow.id, `(() => {
				const heard = document.getElementById('voiceHeardSummary')?.textContent || '';
				const prompts = window.__desktopSttPrompts || [];
				const userMessages = ${testActualQwen ? 'prompts' : `prompts.map(prompt => {
					const match = String(prompt).match(/\\nUser:\\n([\\s\\S]*?)\\n\\nAssistant:\\s*$/);
					return match ? match[1].trim() : '';
				})`};
				const firstSegment = userMessages.find(message => /cobalt/i.test(message) && /lantern/i.test(message));
				const secondSegment = userMessages.find(message => /microphone/i.test(message) && /working/i.test(message));
				if (!firstSegment || (${testTtsLifecycle ? 'false' : 'true'} && !secondSegment)) return null;
				return {
					heard,
					speechPrompt: firstSegment + (${testTtsLifecycle ? "' / TTS pause-resume verified'" : "' / ' + secondSegment"}),
					promptCount: prompts.length,
					inputMode: document.getElementById('voiceInputMode')?.textContent || '',
					inputState: document.getElementById('voiceInputState')?.textContent || ''
				};
			})()`, 'wait for real Whisper transcript', 180000);
			assert(/Desktop Whisper/i.test(recognized.inputMode), `Wrong input mode: ${recognized.inputMode}`);

			diagnostics = await execInWindow(port, cohostWindow.id, 'window.ninjafy.getSttDiagnostics()', 'read STT diagnostics');
			assert(diagnostics.completedRequestCount >= 1, `No completed STT request: ${JSON.stringify(diagnostics)}`);
			assert.strictEqual(diagnostics.workerCreateCount, 1, `Whisper worker was recreated: ${JSON.stringify(diagnostics)}`);
			assert.strictEqual(diagnostics.workerModelLoadCount, 1, `Whisper model loaded more than once: ${JSON.stringify(diagnostics)}`);
			const statusPhases = await execInWindow(port, cohostWindow.id, `(window.__desktopSttStatuses || []).map(status => status.phase)`, 'read STT status phases');
			assert(statusPhases.includes('model-loading') && statusPhases.includes('model-ready') && statusPhases.includes('transcribing'), `Missing user-visible STT phases: ${JSON.stringify(statusPhases)}`);
			if (!capabilities.modelCached) {
				assert(statusPhases.includes('model-download-needed'), `Cold start did not report its download: ${JSON.stringify(statusPhases)}`);
			}
			if (testTtsLifecycle) {
				const ttsState = await execInWindow(port, cohostWindow.id, `({
					calls: window.__desktopTtsCalls || [],
					events: window.__desktopRecognitionEvents || []
				})`, 'read TTS recognition lifecycle');
				assert(ttsState.calls.length >= 2, `Expected greeting and response TTS calls: ${JSON.stringify(ttsState)}`);
				assert(ttsState.events.filter(event => event === 'start').length >= 2 && ttsState.events.includes('stop'), `Recognition did not pause and resume around TTS: ${JSON.stringify(ttsState)}`);
			}
			if (testActualQwen) {
				const qwenResult = await waitForExecResult(port, cohostWindow.id, `(() => {
					const completions = window.__desktopQwenCompletions || [];
					const completion = completions.find(item => /cobalt/i.test(item.prompt) && /lantern/i.test(item.prompt));
					const microphoneCompletion = completions.find(item => /microphone/i.test(item.prompt) && /working/i.test(item.prompt));
					if (!completion || !microphoneCompletion || publisher.activeRequestId) return null;
					return {
						completion,
						microphoneCompletion,
						capturedFrames: window.__desktopCapturedFrames || 0,
						attachedFrames: window.__desktopAttachedFrames || 0,
						diagnosticsState: document.getElementById('diagState')?.textContent || '',
						diagnosticsEvent: document.getElementById('diagEvent')?.textContent || '',
						responses: document.getElementById('responses')?.textContent?.trim() || ''
					};
				})()`, 'wait for Qwen response to synthetic speech', 360000);
				assert.strictEqual(qwenResult.completion.ok, true, `Qwen generation failed: ${JSON.stringify(qwenResult)}`);
				assert.strictEqual(qwenResult.microphoneCompletion.ok, true, `Qwen microphone generation failed: ${JSON.stringify(qwenResult)}`);
				assert(qwenResult.capturedFrames >= 1, `Qwen did not receive a camera frame: ${JSON.stringify(qwenResult)}`);
				assert(qwenResult.attachedFrames >= 1, `Qwen did not attach a camera frame to generation: ${JSON.stringify(qwenResult)}`);
				assert(qwenResult.responses.length > 0, `Qwen returned no visible response: ${JSON.stringify(qwenResult)}`);
				console.log('[cohost-stt-e2e] Qwen:', JSON.stringify(qwenResult));
				await execInWindow(port, cohostWindow.id, `(() => {
					const muteButton = document.getElementById('muteMic');
					if (muteButton?.getAttribute('aria-pressed') !== 'true') muteButton.click();
					return true;
				})()`, 'mute synthetic speech before memory test');
				await waitForExecResult(port, cohostWindow.id, `(async () => {
					const diagnostics = await window.ninjafy.getSttDiagnostics();
					return !diagnostics.activeRequestId && diagnostics.queueLength === 0;
				})()`, 'drain synthetic speech before memory test', 60000);
				const memoryResult = await execInWindow(port, cohostWindow.id, `(async () => {
					const prompts = [
						'Remember exactly: my project codename is Blue Heron 42. Reply only with: remembered.',
						'We are planning a weekly technology podcast. Give one concrete opening segment idea without asking me a question.',
						'What project codename did I tell you earlier? Answer with only the codename.'
					];
					const replies = [];
					for (const prompt of prompts) {
						await publisher.sendPrompt(prompt, 'manual');
						const responseNodes = Array.from(document.querySelectorAll('#responses > div'));
						replies.push(responseNodes.at(-1)?.textContent?.trim() || '');
					}
					return { prompts, replies };
				})()`, 'run scripted Qwen memory conversation');
				assert(/blue\s+heron\s+42/i.test(memoryResult.replies[2]), `Qwen did not recall the codename: ${JSON.stringify(memoryResult)}`);
				assert(new Set(memoryResult.replies.map(reply => reply.toLowerCase().replace(/\s+/g, ' ').trim())).size === memoryResult.replies.length, `Qwen repeated a scripted reply: ${JSON.stringify(memoryResult)}`);
				console.log('[cohost-stt-e2e] Memory:', JSON.stringify(memoryResult));
			}

			if (runFullLifecycle) {
				await execInWindow(port, cohostWindow.id, `(() => {
					const muteButton = document.getElementById('muteMic');
					if (muteButton?.getAttribute('aria-pressed') !== 'true') muteButton.click();
					return true;
				})()`, 'mute local STT');
				const mutedPromptCount = await waitForStablePromptCount(port, cohostWindow.id, 9000);
				await execInWindow(port, cohostWindow.id, `document.getElementById('muteMic').click(); true;`, 'unmute local STT');
				await waitForExecResult(port, cohostWindow.id, `(window.__desktopSttPrompts || []).length > ${mutedPromptCount}`, 'wait for STT after unmute', 60000);
			}
		} else {
			await waitForExecResult(port, cohostWindow.id, `(window.__desktopSttPrompts || []).length >= 1`, 'wait for greeting prompt', 30000);
			const silentPromptCount = await waitForStablePromptCount(port, cohostWindow.id, 12000);
			assert.strictEqual(silentPromptCount, 1, `Silence unexpectedly produced speech prompts: ${silentPromptCount}`);
			diagnostics = await execInWindow(port, cohostWindow.id, 'window.ninjafy.getSttDiagnostics()', 'read silence STT diagnostics');
			assert.strictEqual(diagnostics.workerCreateCount, 0, `Silence created a Whisper worker: ${JSON.stringify(diagnostics)}`);
			assert.strictEqual(diagnostics.completedRequestCount, 0, `Silence was transcribed: ${JSON.stringify(diagnostics)}`);
		}

		await execInWindow(port, cohostWindow.id, `document.getElementById('startButton').click(); true;`, 'stop cohost');
		await waitForExecResult(port, cohostWindow.id, `document.getElementById('startButton').dataset.started === 'false'`, 'wait for cohost stop', 30000);
		await waitForStablePromptCount(port, cohostWindow.id, runFullLifecycle ? 9000 : 3000);

		console.log('[cohost-stt-e2e] Fixture:', path.basename(audioFixture));
		console.log('[cohost-stt-e2e] Result:', recognized ? recognized.speechPrompt : 'silence correctly ignored');
		console.log('[cohost-stt-e2e] Diagnostics:', JSON.stringify(diagnostics));
	} catch (error) {
		console.error('[cohost-stt-e2e] FAILED:', error && error.stack ? error.stack : error);
		if (cohostWindowId) {
			try {
				const state = await execInWindow(port, cohostWindowId, `(async () => ({
					buttonText: document.getElementById('startButton')?.textContent || '',
					started: document.getElementById('startButton')?.dataset.started || '',
					error: document.getElementById('error')?.textContent || '',
					diagnosticsState: document.getElementById('diagnosticsState')?.textContent || '',
					diagnosticsError: document.getElementById('diagnosticsError')?.textContent || '',
					configuredInfo: document.getElementById('configuredLLMInfo')?.textContent || '',
					voiceState: document.getElementById('voiceInputState')?.textContent || '',
					heard: document.getElementById('voiceHeardSummary')?.textContent || '',
					prompts: window.__desktopSttPrompts || [],
					audioValue: document.getElementById('audioSource')?.value || '',
					audioTracks: typeof stream !== 'undefined' && stream ? stream.getAudioTracks().map(track => ({ label: track.label, readyState: track.readyState })) : [],
					recognition: typeof publisher !== 'undefined' && publisher?.recognition ? {
						capturing: publisher.recognition.capturing,
						captureStarting: publisher.recognition.captureStarting,
						audioContextState: publisher.recognition.audioContext?.state || '',
						audioContextRate: publisher.recognition.audioContext?.sampleRate || 0,
						keepAliveContextState: publisher.recognition.keepAliveContext?.state || '',
						noiseFloor: publisher.recognition.noiseFloor,
						preRollSamples: publisher.recognition.preRollSampleCount,
						speechStartChunks: publisher.recognition.speechStartChunks,
						speaking: publisher.recognition.speaking,
						utteranceSamples: publisher.recognition.utteranceSampleCount,
						voicedSamples: publisher.recognition.voicedSampleCount,
						pendingTranscriptions: publisher.recognition.pendingTranscriptions
					} : null,
					directDevices: await Promise.race([
						navigator.mediaDevices.enumerateDevices().then(devices => devices.map(device => ({ kind: device.kind, label: device.label, deviceId: device.deviceId }))),
						new Promise(resolve => setTimeout(() => resolve('enumerateDevices timed out'), 5000))
					]),
					frames: Array.from(document.querySelectorAll('iframe')).map(frame => ({
						src: frame.getAttribute('src') || '',
						srcdocLength: (frame.srcdoc || '').length,
						body: frame.contentDocument?.body?.textContent || ''
					}))
				}))()`, 'read failed cohost state');
				console.error('[cohost-stt-e2e] Cohost state:', JSON.stringify(state, null, 2));
				const failedDiagnostics = await execInWindow(port, cohostWindowId, 'window.ninjafy.getSttDiagnostics()', 'read failed STT diagnostics');
				console.error('[cohost-stt-e2e] STT diagnostics:', JSON.stringify(failedDiagnostics, null, 2));
			} catch (_) { }
		}
		if (stdout.trim()) console.error('[cohost-stt-e2e] Electron stdout:\n' + stdout.trim());
		if (stderr.trim()) console.error('[cohost-stt-e2e] Electron stderr:\n' + stderr.trim());
		throw error;
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) {
			try {
				child.kill();
			} catch (_) { }
			await new Promise(resolve => {
				const exitTimer = setTimeout(resolve, 5000);
				child.once('exit', () => {
					clearTimeout(exitTimer);
					resolve();
				});
			});
		}
		const resolvedTempRoot = path.resolve(os.tmpdir()) + path.sep;
		const resolvedUserDataDir = path.resolve(userDataDir);
		if (resolvedUserDataDir.startsWith(resolvedTempRoot) && path.basename(resolvedUserDataDir).startsWith('ssapp-cohost-stt-profile-')) {
			try {
				fs.rmSync(resolvedUserDataDir, { recursive: true, force: true });
			} catch (error) {
				console.warn('[cohost-stt-e2e] Could not remove temporary profile:', error.message);
			}
		}
	}
}

run().catch(() => {
	process.exitCode = 1;
});
