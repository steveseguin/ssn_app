'use strict';

const fs = require('fs');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const packagedApp = process.env.SSAPP_TEST_APP;
const electronPath = packagedApp || require('electron');

const repoRoot = path.resolve(__dirname, '..', '..');
const reportPath = path.join(os.tmpdir(), `ssapp-tts-diagnostics-${Date.now()}.json`);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-tts-diagnostics-profile-'));

function printReport(report) {
	if (!report || typeof report !== 'object') {
		console.error('[tts-diagnostics] No report data available.');
		return;
	}

	console.log('[tts-diagnostics] Summary:', JSON.stringify(report.summary || {}, null, 2));
	if (Array.isArray(report.requests)) {
		for (const item of report.requests) {
			if (item && item.text) {
				console.log(
					`[tts-diagnostics] "${item.text}" ` +
					`bytes=${item.byteLength} riff=${item.riffSignature} wave=${item.waveSignature} ` +
					`elapsedMs=${item.elapsedMs} passed=${item.passed}`
				);
			} else if (item && Array.isArray(item.errors)) {
				console.log(`[tts-diagnostics] ERROR ${item.errors.join('; ')}`);
			}
		}
	}
}

function run() {
	return new Promise((resolve, reject) => {
		const child = spawn(
			electronPath,
			[
				...(packagedApp ? [] : ['.', '--running-from-source']),
				'--tts-diagnostics',
				`--tts-report=${reportPath}`,
				...linuxLaunchArgs(),
			],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					SSAPP_USER_DATA_DIR: userDataDir,
					SSAPP_TTS_DIAGNOSTICS_SAFE_GPU: '1'
				},
				stdio: 'inherit'
			}
		);

		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch (_) { }
			reject(new Error('Timed out waiting for Electron TTS diagnostics to finish.'));
		}, 180000);

		child.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});

		child.on('exit', (code) => {
			clearTimeout(timer);
			try {
				if (!fs.existsSync(reportPath)) {
					reject(new Error(`Diagnostics report was not written: ${reportPath}`));
					return;
				}

				const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
				printReport(report);

				if (code === 0 && report.success) {
					resolve();
					return;
				}

				reject(new Error(`Diagnostics failed with exit code ${code}.`));
			} catch (error) {
				reject(error);
			}
		});
	});
}

run()
	.then(() => {
		process.exit(0);
	})
	.catch((error) => {
		console.error('[tts-diagnostics]', error && error.message ? error.message : error);
		process.exit(1);
	});
