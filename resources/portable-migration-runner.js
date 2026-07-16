'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const {
	copyLegacyProfile,
	markPortableProfileInitialized,
} = require('./portable-data-paths');

function readStdinJson() {
	return new Promise((resolve, reject) => {
		let data = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (chunk) => { data += chunk; });
		process.stdin.on('end', () => {
			try {
				resolve(JSON.parse(data || '{}'));
			} catch (error) {
				reject(error);
			}
		});
		process.stdin.on('error', reject);
	});
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPidExit(pid, timeoutMs = 120000) {
	if (!Number.isFinite(pid) || pid <= 0) return;
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error && error.code === 'ESRCH') return;
		}
		await sleep(250);
	}
	throw new Error(`Timed out waiting for PID ${pid} to exit`);
}

function appendLog(logPath, message) {
	try {
		fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
	} catch (_) { }
}

async function main() {
	const config = await readStdinJson();
	const legacyUserData = path.resolve(String(config.legacyUserData || ''));
	const dataRoot = path.resolve(String(config.dataRoot || ''));
	const userData = path.resolve(String(config.userData || ''));
	const parentPid = Number(config.parentPid);
	const execPath = path.resolve(String(config.execPath || ''));
	const appArgs = Array.isArray(config.appArgs) ? config.appArgs.map(String) : [];
	const logPath = path.join(dataRoot, 'portable-migration.log');

	if (!fs.existsSync(execPath)) throw new Error('Portable executable was not found for restart.');
	fs.mkdirSync(dataRoot, { recursive: true });

	try {
		appendLog(logPath, `Waiting for app PID ${parentPid} to exit.`);
		await waitForPidExit(parentPid);
		if (!fs.existsSync(legacyUserData)) throw new Error('Existing AppData profile was not found.');
		appendLog(logPath, `Copying existing profile from ${legacyUserData}.`);
		await fsp.rm(userData, { recursive: true, force: true });
		await fsp.mkdir(userData, { recursive: true });
		copyLegacyProfile(legacyUserData, userData);
		markPortableProfileInitialized({ dataRoot }, 'copy');
		appendLog(logPath, 'Profile copy completed.');
	} catch (error) {
		appendLog(logPath, `Profile copy failed: ${error && error.stack ? error.stack : String(error)}`);
		await fsp.rm(userData, { recursive: true, force: true });
		await fsp.mkdir(userData, { recursive: true });
	}

	const environment = { ...process.env };
	delete environment.ELECTRON_RUN_AS_NODE;
	delete environment.SSAPP_PORTABLE_MIGRATION_CHOICE;
	const child = spawn(execPath, appArgs, { detached: true, stdio: 'ignore', env: environment });
	child.unref();
}

main().catch((error) => {
	try {
		process.stderr.write(`[PortableMigrationRunner] ${error && error.stack ? error.stack : String(error)}\n`);
	} catch (_) { }
	process.exitCode = 1;
});
