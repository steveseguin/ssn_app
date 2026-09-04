'use strict';

const { spawn } = require('child_process');

const MAX_TEXT_LENGTH = 10000;
const REQUEST_TIMEOUT_MS = 60000;

// Keep the worker alive between messages. Starting Windows PowerShell and initializing
// Windows.Media.SpeechSynthesis for every chat message adds a noticeable delay.
const POWERSHELL_WORKER = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

function Await-WinRt($operation, $resultType) {
	$method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
		Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
		Select-Object -First 1
	$task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
	$task.Wait()
	return $task.Result
}

function Normalize-VoiceName($value) {
	return ([string]$value).Trim().ToLowerInvariant() -replace "[^a-z0-9]", ""
}

function Find-Voice($requestedName, $requestedLanguage) {
	$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
	$name = Normalize-VoiceName $requestedName
	$language = ([string]$requestedLanguage).Trim()
	if ($name) {
		$exact = $voices | Where-Object {
			$displayName = Normalize-VoiceName $_.DisplayName
			$id = Normalize-VoiceName $_.Id
			$name -eq $displayName -or $name.StartsWith($displayName) -or $id.EndsWith($name)
		} | Select-Object -First 1
		if ($exact) { return $exact }
	}
	if ($language) {
		$languageVoice = $voices | Where-Object { $_.Language -eq $language } | Select-Object -First 1
		if ($languageVoice) { return $languageVoice }
		$languagePrefix = ($language -split "-")[0]
		$languageVoice = $voices | Where-Object { ($_.Language -split "-")[0] -eq $languagePrefix } | Select-Object -First 1
		if ($languageVoice) { return $languageVoice }
	}
	return $null
}

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
	$request = $null
	$synthesizer = $null
	$stream = $null
	$inputStream = $null
	$memoryStream = $null
	try {
		$request = $line | ConvertFrom-Json
		$text = [string]$request.text
		if ([string]::IsNullOrWhiteSpace($text)) { throw "Speech text is required." }
		if ($text.Length -gt ${MAX_TEXT_LENGTH}) { throw "Speech text exceeds ${MAX_TEXT_LENGTH} characters." }

		$synthesizer = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::new()
		$voice = Find-Voice $request.voice $request.lang
		if ($voice) { $synthesizer.Voice = $voice }
		if ($null -ne $request.rate) { $synthesizer.Options.SpeakingRate = [Math]::Max(0.1, [Math]::Min(10.0, [double]$request.rate)) }
		if ($null -ne $request.pitch) { $synthesizer.Options.AudioPitch = [Math]::Max(0.1, [Math]::Min(2.0, [double]$request.pitch)) }

		$stream = Await-WinRt ($synthesizer.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
		$inputStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
		$memoryStream = [System.IO.MemoryStream]::new()
		$inputStream.CopyTo($memoryStream)
		$response = [pscustomobject]@{
			id = [int]$request.id
			audio = [Convert]::ToBase64String($memoryStream.ToArray())
			voice = $synthesizer.Voice.DisplayName
			lang = $synthesizer.Voice.Language
		}
		[Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
	} catch {
		$response = [pscustomobject]@{
			id = if ($null -ne $request.id) { [int]$request.id } else { 0 }
			error = $_.Exception.Message
		}
		[Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
	} finally {
		if ($memoryStream) { $memoryStream.Dispose() }
		if ($inputStream) { $inputStream.Dispose() }
		if ($stream) { $stream.Dispose() }
		if ($synthesizer) { $synthesizer.Dispose() }
		[Console]::Out.Flush()
	}
}
`;

function createSystemTtsError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function normalizeNumber(value, fallback, minimum, maximum) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(minimum, Math.min(maximum, parsed));
}

function normalizeRequest(payload) {
	const text = String(payload && payload.text || '').trim();
	if (!text) throw createSystemTtsError('SSAPP_SYSTEM_TTS_TEXT', 'Speech text is required.');
	if (text.length > MAX_TEXT_LENGTH) {
		throw createSystemTtsError('SSAPP_SYSTEM_TTS_TEXT_LONG', `Speech text exceeds ${MAX_TEXT_LENGTH} characters.`);
	}
	return {
		text,
		voice: String(payload && payload.voice || '').trim(),
		lang: String(payload && payload.lang || '').trim(),
		rate: normalizeNumber(payload && payload.rate, 1, 0.1, 10),
		pitch: normalizeNumber(payload && payload.pitch, 1, 0.1, 2),
	};
}

class WindowsSystemTts {
	constructor() {
		this.child = null;
		this.stdoutBuffer = '';
		this.pending = new Map();
		this.requestId = 0;
		this.readyPromise = null;
		this.readyResolve = null;
		this.readyReject = null;
	}

	start() {
		if (process.platform !== 'win32') {
			return Promise.reject(createSystemTtsError('SSAPP_SYSTEM_TTS_UNAVAILABLE', 'Windows System TTS is only available on Windows.'));
		}
		if (this.child && this.readyPromise) return this.readyPromise;

		const encodedCommand = Buffer.from(POWERSHELL_WORKER, 'utf16le').toString('base64');
		const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		this.child = child;
		this.stdoutBuffer = '';
		this.readyPromise = new Promise((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
		});

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', chunk => this.handleStdout(child, chunk));
		let stderr = '';
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', chunk => { stderr += chunk; });
		child.once('error', error => this.handleExit(child, error));
		child.once('exit', code => {
			const detail = stderr.trim();
			this.handleExit(child, createSystemTtsError(
				'SSAPP_SYSTEM_TTS_WORKER_EXIT',
				`Windows System TTS worker exited with code ${code}${detail ? `: ${detail}` : ''}`
			));
		});
		return this.readyPromise;
	}

	handleStdout(child, chunk) {
		if (this.child !== child) return;
		this.stdoutBuffer += chunk;
		let newlineIndex;
		while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) !== -1) {
			const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			if (!line) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch (_) {
				continue;
			}
			if (message.ready) {
				this.readyResolve?.();
				continue;
			}
			const request = this.pending.get(Number(message.id));
			if (!request) continue;
			this.pending.delete(Number(message.id));
			clearTimeout(request.timeoutId);
			if (message.error) {
				request.reject(createSystemTtsError('SSAPP_SYSTEM_TTS_SYNTHESIS', message.error));
				continue;
			}
			try {
				const wavBuffer = Buffer.from(String(message.audio || ''), 'base64');
				if (wavBuffer.length < 12 || wavBuffer.toString('ascii', 0, 4) !== 'RIFF' || wavBuffer.toString('ascii', 8, 12) !== 'WAVE') {
					throw new Error('Windows returned invalid WAV audio.');
				}
				request.resolve({
					wavBuffer,
					voice: String(message.voice || ''),
					lang: String(message.lang || ''),
				});
			} catch (error) {
				request.reject(createSystemTtsError('SSAPP_SYSTEM_TTS_AUDIO', error.message));
			}
		}
	}

	handleExit(child, error) {
		if (this.child !== child) return;
		this.child = null;
		this.readyReject?.(error);
		this.readyPromise = null;
		this.readyResolve = null;
		this.readyReject = null;
		for (const request of this.pending.values()) {
			clearTimeout(request.timeoutId);
			request.reject(error);
		}
		this.pending.clear();
	}

	async synthesize(payload) {
		const request = normalizeRequest(payload);
		await this.start();
		if (!this.child || !this.child.stdin.writable) {
			throw createSystemTtsError('SSAPP_SYSTEM_TTS_WORKER', 'Windows System TTS worker is unavailable.');
		}

		const id = ++this.requestId;
		return await new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.pending.delete(id);
				reject(createSystemTtsError('SSAPP_SYSTEM_TTS_TIMEOUT', 'Windows System TTS synthesis timed out.'));
				this.stop();
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timeoutId });
			this.child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, error => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				clearTimeout(timeoutId);
				pending.reject(error);
			});
		});
	}

	stop() {
		const child = this.child;
		if (!child) return;
		this.child = null;
		try { child.stdin.end(); } catch (_) { }
		try { child.kill(); } catch (_) { }
		const error = createSystemTtsError('SSAPP_SYSTEM_TTS_SHUTDOWN', 'Windows System TTS is shutting down.');
		for (const request of this.pending.values()) {
			clearTimeout(request.timeoutId);
			request.reject(error);
		}
		this.pending.clear();
		this.readyReject?.(error);
		this.readyPromise = null;
		this.readyResolve = null;
		this.readyReject = null;
	}
}

module.exports = {
	WindowsSystemTts,
	normalizeRequest,
};
