#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'resources', 'portable-migration-runner.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-portable-migration-'));
const legacyUserData = path.join(tempRoot, 'legacy-profile');
const dataRoot = path.join(tempRoot, 'SocialStreamNinja-data');
const userData = path.join(dataRoot, 'profile');

async function runRunner(overrides = {}) {
	return await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [runnerPath], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stderr = '';
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.once('error', reject);
		child.once('exit', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Migration runner exited with ${code}: ${stderr}`));
		});
		child.stdin.end(JSON.stringify({
			legacyUserData,
			dataRoot,
			userData,
			parentPid: 0,
			execPath: process.execPath,
			appArgs: ['-e', ''],
			...overrides,
		}));
	});
}

async function run() {
	fs.mkdirSync(path.join(legacyUserData, 'Local Storage'), { recursive: true });
	fs.mkdirSync(path.join(legacyUserData, 'Cache'), { recursive: true });
	fs.mkdirSync(userData, { recursive: true });
	fs.writeFileSync(path.join(legacyUserData, 'config.json'), JSON.stringify({ migrated: true }));
	fs.writeFileSync(path.join(legacyUserData, 'Local Storage', 'state.txt'), 'persistent-session');
	fs.writeFileSync(path.join(legacyUserData, 'Cache', 'discard.txt'), 'cache');
	fs.writeFileSync(path.join(userData, 'temporary.txt'), 'remove-before-copy');

	await runRunner();

	assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')), { migrated: true });
	assert.strictEqual(fs.readFileSync(path.join(userData, 'Local Storage', 'state.txt'), 'utf8'), 'persistent-session');
	assert.strictEqual(fs.existsSync(path.join(userData, 'Cache')), false);
	assert.strictEqual(fs.existsSync(path.join(userData, 'temporary.txt')), false);
	const marker = JSON.parse(fs.readFileSync(path.join(dataRoot, '.profile-initialized.json'), 'utf8'));
	assert.strictEqual(marker.action, 'copy');
	assert.match(fs.readFileSync(path.join(dataRoot, 'portable-migration.log'), 'utf8'), /Profile copy completed/);

	const failedDataRoot = path.join(tempRoot, 'failed-data');
	const failedUserData = path.join(failedDataRoot, 'profile');
	await runRunner({
		legacyUserData: path.join(tempRoot, 'missing-profile'),
		dataRoot: failedDataRoot,
		userData: failedUserData,
	});
	assert.strictEqual(fs.statSync(failedUserData).isDirectory(), true);
	assert.strictEqual(fs.existsSync(path.join(failedDataRoot, '.profile-initialized.json')), false);
	assert.match(fs.readFileSync(path.join(failedDataRoot, 'portable-migration.log'), 'utf8'), /Profile copy failed/);
	console.log('Portable migration runner regression checks passed.');
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
}).finally(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});
