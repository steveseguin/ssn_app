#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const electronPath = require('electron');
const repoRoot = path.resolve(__dirname, '..', '..');
const socialStreamRoot = path.resolve(repoRoot, '..', 'social_stream');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-system-tts-'));
const token = `system-tts-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
	child.kill();
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
	const child = spawn(electronPath, [
		'.',
		'--multiinstance',
		'--preferlocalassets',
		`--filesource=${socialStreamRoot}`,
		'--remote-control',
		...linuxLaunchArgs(),
	], {
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

				const runSpeechProbe = async (targetWindow, trigger) => {
					const synth = targetWindow.speechSynthesis;
					const originalSpeak = synth.speak;
					const probe = { called: false, started: false, assignedVoice: '', error: '' };
					synth.speak = function(utterance) {
						probe.called = true;
						probe.assignedVoice = utterance.voice && utterance.voice.name || '';
						utterance.addEventListener('start', () => { probe.started = true; });
						utterance.addEventListener('error', event => { probe.error = event.error || 'speech error'; });
						return originalSpeak.call(synth, utterance);
					};
					try {
						trigger();
						await waitUntil(
							() => probe.error || probe.started || synth.speaking,
							15000,
							'system speech to start'
						);
						if (synth.speaking) probe.started = true;
						return { ...probe };
					} finally {
						synth.cancel();
						synth.speak = originalSpeak;
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
				const preferredName = 'Microsoft Sabina - Spanish (Mexico)';
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
				const popupProbe = await runSpeechProbe(popupWindow, () => {
					popupWindow.document.querySelector('#ttsTestContainer .tts-test-button').click();
				});

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
				const dockProbe = await runSpeechProbe(dockWindow, () => {
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
		assert.strictEqual(result.popupProbe.called, true, JSON.stringify(result));
		assert.strictEqual(result.popupProbe.started, true, JSON.stringify(result));
		assert.strictEqual(result.popupProbe.error, '', JSON.stringify(result));
		assert.strictEqual(result.popupProbe.assignedVoice, result.selectedVoice, JSON.stringify(result));
		assert.strictEqual(result.dockResolvedVoice, result.selectedVoice, JSON.stringify(result));
		assert.strictEqual(result.dockProbe.called, true, JSON.stringify(result));
		assert.strictEqual(result.dockProbe.started, true, JSON.stringify(result));
		assert.strictEqual(result.dockProbe.error, '', JSON.stringify(result));
		assert.strictEqual(result.dockProbe.assignedVoice, result.selectedVoice, JSON.stringify(result));

		console.log(`System TTS Electron end-to-end checks passed with ${result.selectedVoice}.`);
		if (!result.preferredVoiceAvailable) {
			console.log('Microsoft Sabina was not installed; the end-to-end check used another installed Windows voice.');
		}
		const holdMs = Number(process.env.SSAPP_TTS_E2E_HOLD_MS || 0);
		if (holdMs > 0) await new Promise(resolve => setTimeout(resolve, holdMs));
	} catch (error) {
		throw new Error(`${error.message}\n${output.slice(-5000)}`);
	} finally {
		await stopApp(child);
		fs.rmSync(profileDir, { recursive: true, force: true });
	}
}

run().catch(error => {
	console.error(error);
	process.exit(1);
});
