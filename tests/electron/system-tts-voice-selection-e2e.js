#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const electronPath = require('electron');
const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-system-tts-'));
const token = `system-tts-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const audioMeterScript = path.join(__dirname, 'helpers', 'windows-audio-peak-meter.ps1');
const appExecutable = process.env.SSAPP_TTS_E2E_EXECUTABLE || electronPath;

function startWindowsAudioPeakMeter(targetProcessId) {
	const stopFile = path.join(profileDir, `audio-meter-stop-${Date.now()}`);
	const meterArgs = [
		'-NoProfile',
		'-ExecutionPolicy', 'Bypass',
		'-File', audioMeterScript,
		'-StopFile', stopFile,
		'-TargetProcessId', String(targetProcessId),
		'-MaxDurationMs', '60000',
	];
	const child = spawn('powershell.exe', meterArgs, {
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let output = '';
	let errorOutput = '';
	let readyResolved = false;
	let resolveReady;
	let rejectReady;
	const ready = new Promise((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	child.stdout.on('data', chunk => {
		output += chunk.toString();
		if (!readyResolved && output.includes('READY')) {
			readyResolved = true;
			resolveReady();
		}
	});
	child.stderr.on('data', chunk => { errorOutput += chunk.toString(); });
	child.once('error', error => {
		if (!readyResolved) rejectReady(error);
	});
	const result = new Promise((resolve, reject) => {
		child.once('exit', code => {
			if (!readyResolved) {
				rejectReady(new Error(`Windows audio meter exited before it was ready (${code}): ${errorOutput || output}`));
			}
			if (code !== 0) {
				reject(new Error(`Windows audio meter failed (${code}): ${errorOutput || output}`));
				return;
			}
			try {
				const jsonLine = output.trim().split(/\r?\n/).find(line => line.startsWith('{'));
				resolve(JSON.parse(jsonLine));
			} catch (error) {
				reject(new Error(`Windows audio meter returned invalid output: ${output}\n${error.message}`));
			}
		});
	});
	// The app assertion can fail before the meter result is awaited. Attach a handler now so
	// cleanup terminating PowerShell cannot become an unrelated unhandled rejection.
	result.catch(() => {});
	return {
		ready,
		result,
		stop() {
			if (!fs.existsSync(stopFile)) fs.writeFileSync(stopFile, 'stop');
		},
		kill() {
			if (child.exitCode === null) child.kill();
		},
	};
}

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

function encodePowerShellCommand(command) {
	return Buffer.from(command, 'utf16le').toString('base64');
}

function findPackagedMainProcessId() {
	const escapedProfile = profileDir.replace(/'/g, "''");
	const command = [
		`$profile = '${escapedProfile}'`,
		'$content = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) } | Select-Object -First 1',
		'if ($content) { [Console]::Write($content.ParentProcessId) }',
	].join('; ');
	const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encodePowerShellCommand(command)], {
		encoding: 'utf8',
		windowsHide: true,
	});
	const processId = Number(String(result.stdout || '').trim());
	return Number.isInteger(processId) && processId > 0 ? processId : null;
}

function killWindowsProcessTree(processId) {
	if (!processId) return;
	spawnSync('taskkill.exe', ['/pid', String(processId), '/t', '/f'], {
		stdio: 'ignore',
		windowsHide: true,
	});
}

function requestJson(port, pathname, body) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : JSON.stringify(body);
		const request = http.request({
			host: '127.0.0.1',
			port,
			path: `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
			method: payload === null ? 'GET' : 'POST',
			headers: payload === null ? {} : {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload),
			},
		}, response => {
			let text = '';
			response.setEncoding('utf8');
			response.on('data', chunk => { text += chunk; });
			response.on('end', () => {
				try {
					const parsed = text ? JSON.parse(text) : {};
					if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
					else reject(new Error(`HTTP ${response.statusCode}: ${text}`));
				} catch (error) {
					reject(error);
				}
			});
		});
		request.on('error', reject);
		if (payload !== null) request.write(payload);
		request.end();
	});
}

async function waitForControl(port, child, timeoutMs = 60000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (child.exitCode !== null) throw new Error(`SSApp exited early with code ${child.exitCode}.`);
		try {
			const ping = await requestJson(port, '/ping');
			if (ping && ping.ok) return;
		} catch (_) { }
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('Timed out waiting for SSApp remote control.');
}

async function stopApp(child) {
	if (!child || child.exitCode !== null) return;
	if (process.platform === 'win32') {
		killWindowsProcessTree(child.pid);
	} else {
		child.kill();
	}
	await Promise.race([
		new Promise(resolve => child.once('exit', resolve)),
		new Promise(resolve => setTimeout(resolve, 5000)),
	]);
}

async function run() {
	// This exercises operating-system speech voices through the Web Speech API, and asserts
	// on Windows voice names. Electron on Linux reports no system voices at all: verified on
	// Electron 43 that speechSynthesis.getVoices() stays empty even with speech-dispatcher
	// installed and working (spd-say lists voices) and with --enable-speech-dispatcher set.
	// macOS has its own voice set and would fail the name assertions. Skip rather than hang
	// for 15 seconds and fail on "Timed out waiting for Windows system voices".
	if (process.platform !== 'win32') {
		console.log(
			`system-tts-voice-selection-e2e: SKIPPED (needs Windows system voices; this is ${process.platform}). ` +
			'On Linux use the bundled TTS engine instead - see the tts diagnostics test.'
		);
		return { skipped: true };
	}

	const port = await getFreePort();
	const appArgs = [
		'--multiinstance',
		'--preferlocalassets',
		`--filesource=${socialStreamRoot}`,
		'--remote-control',
		...linuxLaunchArgs(),
	];
	if (!process.env.SSAPP_TTS_E2E_EXECUTABLE) appArgs.unshift('.');
	const child = spawn(appExecutable, appArgs, {
		cwd: repoRoot,
		env: {
			...process.env,
			SSAPP_USER_DATA_DIR: profileDir,
			SSAPP_REMOTE_CONTROL: '1',
			SSAPP_REMOTE_CONTROL_PORT: String(port),
			SSAPP_REMOTE_CONTROL_TOKEN: token,
			SSAPP_DIAGNOSTICS_SAFE_GPU: '1',
			SSAPP_DEBUG_LOGS: '0',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let output = '';
	let audioMeter = null;
	let packagedMainProcessId = null;
	child.stdout.on('data', chunk => { output += chunk.toString(); });
	child.stderr.on('data', chunk => { output += chunk.toString(); });

	try {
		await waitForControl(port, child);
		const windowStarted = Date.now();
		let windows = null;
		let mainWindow = null;
		while (Date.now() - windowStarted < 30000) {
			windows = await requestJson(port, '/windows');
			mainWindow = (windows.windows || []).find(item => String(item.url || '').includes('index.html'));
			if (mainWindow) break;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.ok(mainWindow, `Main SSApp window was not found: ${JSON.stringify(windows)}`);

		if (process.env.SSAPP_TTS_E2E_EXECUTABLE) {
			packagedMainProcessId = findPackagedMainProcessId();
			assert.ok(packagedMainProcessId, 'Could not identify the packaged app process from its isolated profile.');
		}
		audioMeter = startWindowsAudioPeakMeter(packagedMainProcessId || child.pid);
		await audioMeter.ready;
		const preferredVoiceName = process.env.SSAPP_TTS_E2E_VOICE || 'Microsoft David - English (United States)';
		const response = await requestJson(port, '/exec', {
			windowId: mainWindow.id,
			code: `(async () => {
				const waitUntil = async (predicate, timeoutMs, label) => {
					const started = Date.now();
					while (Date.now() - started < timeoutMs) {
						try {
							const value = predicate();
							if (value) return value;
						} catch (_) { }
						await new Promise(resolve => setTimeout(resolve, 100));
					}
					throw new Error('Timed out waiting for ' + label);
				};

				const runAudioProbe = async (targetWindow, trigger) => {
					const synth = targetWindow.speechSynthesis;
					const originalSpeak = synth.speak;
					const mediaPrototype = targetWindow.HTMLMediaElement.prototype;
					const originalPlay = mediaPrototype.play;
					const probe = {
						speechCalled: false,
						speechStarted: false,
						speechEnded: false,
						assignedVoice: '',
						mediaPlayed: false,
						mediaEnded: false,
						error: '',
					};
					synth.speak = function(utterance) {
						probe.speechCalled = true;
						probe.assignedVoice = utterance.voice && utterance.voice.name || '';
						utterance.addEventListener('start', () => { probe.speechStarted = true; });
						utterance.addEventListener('end', () => { probe.speechEnded = true; });
						utterance.addEventListener('error', event => { probe.error = event.error || 'speech error'; });
						return originalSpeak.call(synth, utterance);
					};
					mediaPrototype.play = function() {
						probe.mediaPlayed = true;
						this.addEventListener('ended', () => { probe.mediaEnded = true; }, { once: true });
						this.addEventListener('error', () => { probe.error = 'media playback error'; }, { once: true });
						return originalPlay.call(this);
					};
					try {
						trigger();
						await waitUntil(
							() => probe.error || probe.speechEnded || probe.mediaEnded,
							30000,
							'system TTS audio to finish'
						);
						return { ...probe };
					} finally {
						if (probe.speechCalled) synth.cancel();
						synth.speak = originalSpeak;
						mediaPrototype.play = originalPlay;
					}
				};

				await waitUntil(() => typeof ensurePopupPanelLoaded === 'function', 30000, 'popup loader');
				const frame = document.getElementById('frame1');
				await waitUntil(() => frame && frame.src && frame.src !== 'about:blank', 30000, 'initial popup frame');
				await new Promise(resolve => setTimeout(resolve, 1000));
				await ensurePopupPanelLoaded(true);
				await waitUntil(
					() => frame && frame.contentWindow &&
						frame.contentWindow.document.readyState === 'complete' &&
						frame.contentWindow.location.pathname.endsWith('/popup.html') &&
						typeof frame.contentWindow.populateSystemVoiceDropdowns === 'function' &&
						frame.contentWindow.document.querySelector('#ttsTestContainer .tts-test-button'),
					30000,
					'local popup TTS controls'
				);
				await new Promise(resolve => setTimeout(resolve, 500));

				const popupWindow = frame.contentWindow;
				await waitUntil(() => popupWindow.speechSynthesis.getVoices().length, 15000, 'Windows system voices');
				const descriptors = popupWindow.populateSystemVoiceDropdowns();
				const preferredName = ${JSON.stringify(preferredVoiceName)};
				const selected = descriptors.find(voice => voice.name === preferredName) ||
					descriptors.find(voice => !voice.default) || descriptors[0];
				if (!selected) throw new Error('No system voice was available for the popup test.');

				const languageToggle = popupWindow.document.querySelector('input[data-param1="lang"]');
				const voiceSelect = popupWindow.document.getElementById('systemLanguageSelect');
				const providerSelect = popupWindow.document.getElementById('ttsProvider');
				if (!languageToggle || !voiceSelect || !providerSelect) throw new Error('Popup system TTS controls were not found.');
				languageToggle.checked = true;
				providerSelect.value = 'system';
				voiceSelect.value = selected.code;
				const popupUrl = popupWindow.location.href;
				const popupSettings = popupWindow.eval('TTSManager.getSettings()');
				const popupProbe = await runAudioProbe(popupWindow, () => {
					popupWindow.document.querySelector('#ttsTestContainer .tts-test-button').click();
				});
				const volumeToggle = popupWindow.document.querySelector('input[data-param1="volume"]');
				const volumeInput = popupWindow.document.querySelector('input[data-numbersetting="volume"]');
				if (!volumeToggle || !volumeInput) throw new Error('Popup TTS volume controls were not found.');
				volumeToggle.checked = true;
				volumeInput.value = '0';
				popupWindow.eval('TTSManager.testTTS()');
				await waitUntil(
					() => popupWindow.document.getElementById('ttsFeedback')?.textContent.includes('volume is set to 0'),
					5000,
					'zero-volume TTS warning'
				);
				const zeroVolumeFeedback = popupWindow.document.getElementById('ttsFeedback').textContent;
				volumeToggle.checked = false;
				volumeInput.value = '1.0';

				const legacyVoiceName = selected.name.replace(/[^a-zA-Z0-9\\s]/g, '').trim().replaceAll(' ', '_');
				const localDockUrl = new URL('dock.html', popupUrl).href;
				const liveUrl = localDockUrl +
					'?session=system-tts-e2e&tts=' + encodeURIComponent(selected.lang) +
					'&lang=' + encodeURIComponent(selected.lang) +
					'&voice=' + encodeURIComponent(legacyVoiceName);
				const dockFrame = document.createElement('iframe');
				dockFrame.id = 'systemTtsE2eDock';
				dockFrame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:2147483647;background:#fff';
				document.body.appendChild(dockFrame);
				dockFrame.src = liveUrl;
				await waitUntil(
					() => dockFrame.contentWindow && dockFrame.contentWindow.location.href.startsWith(localDockUrl) && dockFrame.contentWindow.TTS,
					30000,
					'local dock TTS runtime'
				);
				const dockWindow = dockFrame.contentWindow;
				await waitUntil(
					() => dockWindow.document.readyState === 'complete' && dockWindow.TTS.voiceName === legacyVoiceName,
					15000,
					'dock TTS URL configuration'
				);
				await waitUntil(() => dockWindow.speechSynthesis.getVoices().length, 15000, 'dock Windows system voices');
				const dockProbe = await runAudioProbe(dockWindow, () => {
					dockWindow.TTS.speak('Live system voice test.', true);
				});

				const result = {
					popupUrl,
					dockUrl: dockWindow.location.href,
					preferredVoiceAvailable: descriptors.some(voice => voice.name === preferredName),
					selectedVoice: selected.name,
					selectedLanguage: selected.lang,
					storedCode: selected.code,
					popupSettingsVoice: popupSettings.system.voice,
					popupNativeBridgeAvailable: typeof (popupWindow.ninjafy || popupWindow.electronApi)?.systemTts === 'function',
					popupNativeResult: popupWindow.eval('TTSManager.lastDesktopSystemTts || null'),
					zeroVolumeFeedback,
					popupProbe,
					legacyVoiceName,
					dockRequestedVoice: dockWindow.TTS.voiceName,
					dockRequestedNormalized: dockWindow.TTS.normalizeSystemVoiceIdentifier(dockWindow.TTS.voiceName),
					dockAvailableVoices: dockWindow.TTS.voices.map(voice => ({
						name: voice.name,
						lang: voice.lang,
						normalized: dockWindow.TTS.normalizeSystemVoiceIdentifier(voice.name),
					})),
					dockResolvedVoice: dockWindow.TTS.voice && dockWindow.TTS.voice.name || '',
					dockNativeBridgeAvailable: !!dockWindow.TTS.getDesktopSystemTtsBridge(),
					dockNativeResult: dockWindow.TTS.lastDesktopSystemTts || null,
					dockProbe,
				};
				dockFrame.remove();
				return result;
			})()`,
		});

		assert.strictEqual(response.ok, true, JSON.stringify(response));
		const result = response.result;
		assert.ok(String(result.popupUrl).startsWith('file:'), result.popupUrl);
		assert.ok(String(result.dockUrl).startsWith('file:'), result.dockUrl);
		assert.strictEqual(result.popupSettingsVoice, result.selectedVoice, JSON.stringify(result));
		assert.ok(result.zeroVolumeFeedback.includes('volume is set to 0'), JSON.stringify(result));
		assert.strictEqual(result.popupProbe.error, '', JSON.stringify(result));
		if (!result.dockNativeBridgeAvailable) {
			assert.strictEqual(result.dockResolvedVoice, result.selectedVoice, JSON.stringify(result));
		}
		assert.strictEqual(result.dockProbe.error, '', JSON.stringify(result));
		for (const [name, probe] of [['popup', result.popupProbe], ['dock', result.dockProbe]]) {
			const webSpeechCompleted = probe.speechCalled && probe.speechStarted && probe.speechEnded;
			const nativeAudioCompleted = probe.mediaPlayed && probe.mediaEnded;
			assert.ok(webSpeechCompleted || nativeAudioCompleted, `${name} TTS did not complete audio playback: ${JSON.stringify(result)}`);
			if (webSpeechCompleted) {
				assert.strictEqual(probe.assignedVoice, result.selectedVoice, JSON.stringify(result));
			}
		}
		if (result.popupNativeBridgeAvailable) {
			assert.strictEqual(result.popupProbe.mediaEnded, true, JSON.stringify(result));
			assert.ok(result.popupNativeResult?.voice, JSON.stringify(result));
			assert.ok(result.selectedVoice.startsWith(result.popupNativeResult.voice), JSON.stringify(result));
		}
		if (result.dockNativeBridgeAvailable) {
			assert.strictEqual(result.dockProbe.mediaEnded, true, JSON.stringify(result));
			assert.ok(result.dockNativeResult?.voice, JSON.stringify(result));
			assert.ok(result.selectedVoice.startsWith(result.dockNativeResult.voice), JSON.stringify(result));
		}

		audioMeter.stop();
		const audioMeasurement = await audioMeter.result;
		const requiredPeak = 0.005;
		assert.ok(
			audioMeasurement.baselineMaxPeak < requiredPeak,
			`The app was already producing audio before the TTS probe: ${JSON.stringify(audioMeasurement)}`
		);
		assert.ok(
			audioMeasurement.maxPeak > requiredPeak && audioMeasurement.activeSamples >= 5,
			`System TTS events completed but the Windows output was silent: ${JSON.stringify(audioMeasurement)}`
		);

		console.log(
			`System TTS Electron end-to-end checks passed with ${result.selectedVoice}; ` +
			`Windows output peak ${audioMeasurement.maxPeak.toFixed(4)}.`
		);
		if (!result.preferredVoiceAvailable) {
			console.log(`${preferredVoiceName} was not installed; the end-to-end check used another installed Windows voice.`);
		}
		const holdMs = Number(process.env.SSAPP_TTS_E2E_HOLD_MS || 0);
		if (holdMs > 0) await new Promise(resolve => setTimeout(resolve, holdMs));
	} catch (error) {
		throw new Error(`${error.message}\n${output.slice(-5000)}`);
	} finally {
		if (audioMeter) {
			audioMeter.stop();
			audioMeter.kill();
		}
		if (packagedMainProcessId) killWindowsProcessTree(packagedMainProcessId);
		await stopApp(child);
		fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	}
}

run().catch(error => {
	console.error(error);
	process.exit(1);
});
