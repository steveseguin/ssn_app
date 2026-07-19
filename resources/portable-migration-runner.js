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

function resolveRequiredPath(value, label) {
	const raw = String(value || '').trim();
	if (!raw) throw new Error(`${label} is required.`);
	return path.resolve(raw);
}

function assertSafeUserDataPath(dataRoot, userData) {
	if (path.parse(dataRoot).root === dataRoot) {
		throw new Error('Portable data root cannot be a filesystem root.');
	}
	const relative = path.relative(dataRoot, userData);
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error('Portable profile must be a child of the portable data root.');
	}
}

async function main() {
	const config = await readStdinJson();
	const legacyUserData = resolveRequiredPath(config.legacyUserData, 'Legacy profile path');
	const dataRoot = resolveRequiredPath(config.dataRoot, 'Portable data root');
	const userData = resolveRequiredPath(config.userData, 'Portable profile path');
	const parentPid = Number(config.parentPid);
	const execPath = resolveRequiredPath(config.execPath, 'Portable executable path');
	const appArgs = Array.isArray(config.appArgs) ? config.appArgs.map(String) : [];
	const logPath = path.join(dataRoot, 'portable-migration.log');

	assertSafeUserDataPath(dataRoot, userData);
	if (!fs.existsSync(execPath)) throw new Error('Portable executable was not found for restart.');
	fs.mkdirSync(dataRoot, { recursive: true });

	let destructiveCopyStarted = false;
	try {
		appendLog(logPath, `Waiting for app PID ${parentPid} to exit.`);
		await waitForPidExit(parentPid);
		if (!fs.existsSync(legacyUserData)) throw new Error('Existing AppData profile was not found.');
		appendLog(logPath, `Copying existing profile from ${legacyUserData}.`);
		destructiveCopyStarted = true;
		await fsp.rm(userData, { recursive: true, force: true });
		await fsp.mkdir(userData, { recursive: true });
		copyLegacyProfile(legacyUserData, userData);
		markPortableProfileInitialized({ dataRoot }, 'copy');
		appendLog(logPath, 'Profile copy completed.');
	} catch (error) {
		appendLog(logPath, `Profile copy failed: ${error && error.stack ? error.stack : String(error)}`);
		if (destructiveCopyStarted) {
			await fsp.rm(userData, { recursive: true, force: true });
			await fsp.mkdir(userData, { recursive: true });
		} else if (!fs.existsSync(userData)) {
			await fsp.mkdir(userData, { recursive: true });
		}
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
