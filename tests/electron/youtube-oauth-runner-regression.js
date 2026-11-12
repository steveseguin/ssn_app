'use strict';

// Exercise the actual runner and child processes, including interrupted checks.
// The preload branch changes only this test process, never the application.
const assert = require('assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fault = process.env.SSAPP_OAUTH_RUNNER_TEST_FAULT;
if (fault) {
	const originalSpawn = childProcess.spawn;
	if (fault === 'signal') {
		childProcess.spawn = function (...args) {
			const child = originalSpawn.apply(this, args);
			child.once('spawn', () => child.kill('SIGTERM'));
			return child;
		};
	} else if (fault === 'spawn-error') {
		childProcess.spawn = function (_executable, args, options) {
			return originalSpawn.call(this, path.join(process.env.SSAPP_OAUTH_RUNNER_TEST_DIR, 'missing-electron'), args, options);
		};
	} else if (fault === 'timeout') {
		const originalSetTimeout = global.setTimeout;
		global.setTimeout = (callback, ms, ...args) => originalSetTimeout(callback, ms === 30000 ? 1 : ms, ...args);
	}
} else {
	const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-oauth-runner-'));
	console.log('Evidence: ' + output);
	const reports = [];
	for (const [scenario, expectedStatus, message] of [
		['none', 0, 'YouTube OAuth loopback end-to-end checks passed.'],
		['signal', 1, 'terminated by SIGTERM'],
		['timeout', 1, 'checks timed out'],
		['spawn-error', 1, 'Could not start'],
	]) {
		const result = childProcess.spawnSync(process.execPath,
			['--require', __filename, path.join(__dirname, 'youtube-oauth-loopback-e2e.js')], {
				cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 45000,
				env: { ...process.env, SSAPP_OAUTH_RUNNER_TEST_FAULT: scenario, SSAPP_OAUTH_RUNNER_TEST_DIR: output },
			});
		const log = (result.stdout || '') + (result.stderr || '');
		fs.writeFileSync(path.join(output, scenario + '.log'), log);
		reports.push({ scenario, status: result.status, signal: result.signal, error: result.error?.message });
		fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(reports, null, 2));
		assert.ifError(result.error);
		assert.equal(result.status, expectedStatus, `${scenario}: runner returned the wrong exit status`);
		assert.ok(log.includes(message), `${scenario}: expected result message was missing`);
		if (scenario !== 'none') assert.ok(!log.includes('checks passed.'), `${scenario}: interrupted checks reported a pass`);
		console.log(`PASS ${scenario}: exit ${result.status}`);
	}
}
