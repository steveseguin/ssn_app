'use strict';

const fs = require('fs');
const { linuxLaunchArgs } = require('./helpers/electron-launch');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const electronPath = require('electron');

const repoRoot = path.resolve(__dirname, '..', '..');
const reportPath = path.join(os.tmpdir(), `ssapp-window-state-diagnostics-${Date.now()}.json`);

function printReport(report) {
	if (!report || typeof report !== 'object') {
		console.error('[window-state-diagnostics] No report data available.');
		return;
	}

	console.log('[window-state-diagnostics] Summary:', JSON.stringify(report.summary || {}, null, 2));
	if (!Array.isArray(report.cases)) {
		return;
	}

	for (const item of report.cases) {
		if (item.error) {
			console.log(`[window-state-diagnostics] ${item.id}: ERROR ${item.error}`);
			continue;
		}
		console.log(
			`[window-state-diagnostics] ${item.id}: ` +
			`target=${JSON.stringify(item.targetBounds)} ` +
			`restored=${JSON.stringify(item.restoredBounds)} ` +
			`restoredDiff=${JSON.stringify(item.restoredDiff)} ` +
			`reopened=${JSON.stringify(item.reopenedBounds)} ` +
			`reopenedDiff=${JSON.stringify(item.reopenedDiff)} ` +
			`passed=${item.passed}`
		);
	}
}

function run() {
	return new Promise((resolve, reject) => {
		const child = spawn(
			electronPath,
			[
				'.',
				'--running-from-source',
				'--window-state-diagnostics',
				`--window-state-report=${reportPath}`,
				...linuxLaunchArgs(),
			],
			{
				cwd: repoRoot,
				stdio: 'inherit'
			}
		);

		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch (_) { }
			reject(new Error('Timed out waiting for Electron diagnostics to finish.'));
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
		console.error('[window-state-diagnostics]', error && error.message ? error.message : error);
		process.exit(1);
	});
