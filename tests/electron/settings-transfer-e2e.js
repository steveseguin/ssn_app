'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
	readSettingsBackupFile,
	writeSettingsBackupFile
} = require('../../settings-backup');
const { createTransferBackup } = require('../../transfer-backup');

function assertCondition(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

async function makeTempRoot() {
	return await fsp.mkdtemp(path.join(os.tmpdir(), 'ssapp-settings-transfer-e2e-'));
}

async function writeJson(filePath, value) {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	await fsp.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runNodeScript(scriptPath, payload) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [scriptPath], {
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true
		});

		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(new Error(`Script failed with code ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
		});
		child.stdin.end(JSON.stringify(payload));
	});
}

async function runSettingsExportImportRoundTrip(tempRoot) {
	const filePath = path.join(tempRoot, 'settings-export.data');
	const cachedState = {
		streamID: 'test-session-123',
		password: 'test-password',
		state: true,
		settings: {
			addkarma: { setting: true },
			custombot: { textsetting: 'hello' },
			urls: [{ target: 'twitch', username: 'example' }]
		}
	};
	const localStorageData = {
		socialStreamState: JSON.stringify({
			sources: [['twitch-user-example', { id: 'twitch-user-example', target: 'twitch', username: 'example' }]],
			groups: [],
			global: { betaMode: false }
		}),
		betaMode: 'false',
		lastTikTokMode: 'tiktok-legacy',
		cachedManifest: 'should-not-be-exported'
	};

	const exported = writeSettingsBackupFile(filePath, cachedState, localStorageData);
	const imported = readSettingsBackupFile(filePath);

	assertCondition(fs.existsSync(filePath), 'settings export file was not written');
	assertCondition(exported.settings.addkarma.setting === true, 'exported cached settings missing');
	assertCondition(imported.cachedState.streamID === cachedState.streamID, 'imported streamID mismatch');
	assertCondition(imported.cachedState.password === cachedState.password, 'imported password mismatch');
	assertCondition(imported.cachedState.settings.custombot.textsetting === 'hello', 'imported settings mismatch');
	assertCondition(imported.localStorage.socialStreamState === localStorageData.socialStreamState, 'source-list localStorage was not preserved');
	assertCondition(imported.localStorage.betaMode === 'false', 'app localStorage setting was not preserved');
	assertCondition(!Object.prototype.hasOwnProperty.call(imported.localStorage, 'cachedManifest'), 'cached manifest should not be included in settings backup');

	return {
		filePath,
		settingsCount: Object.keys(imported.cachedState.settings).length,
		localStorageCount: Object.keys(imported.localStorage).length
	};
}

async function runFullTransferRoundTrip(tempRoot) {
	const sourceUserData = path.join(tempRoot, 'source-user-data');
	const targetUserData = path.join(tempRoot, 'target-user-data');
	const backupFilePath = path.join(tempRoot, 'full-session.ssappbk');
	const logPath = path.join(tempRoot, 'restore.log');
	const password = 'transfer-password';

	await fsp.mkdir(sourceUserData, { recursive: true });
	await fsp.mkdir(targetUserData, { recursive: true });

	await writeJson(path.join(sourceUserData, 'savedSync.json'), {
		streamID: 'transfer-session',
		state: true,
		settings: { transferred: { setting: true } }
	});
	await writeJson(path.join(sourceUserData, 'config.json'), {
		localSourcePath: 'file:///valid/source/'
	});
	await fsp.mkdir(path.join(sourceUserData, 'nested'), { recursive: true });
	await fsp.writeFile(path.join(sourceUserData, 'nested', 'marker.txt'), 'restored', 'utf8');
	await fsp.writeFile(path.join(targetUserData, 'stale.txt'), 'old-data', 'utf8');

	await createTransferBackup({
		userDataDir: sourceUserData,
		outputFilePath: backupFilePath,
		password,
		includeCaches: false,
		compressionLevel: 0,
		appName: 'SSAPP Test',
		appVersion: '0.0.0-test',
		scrypt: {
			N: 1024,
			r: 8,
			p: 1,
			maxmem: 32 * 1024 * 1024
		}
	});

	assertCondition(fs.existsSync(backupFilePath), 'full session backup file was not created');

	await runNodeScript(path.resolve(__dirname, '..', '..', 'transfer-restore-runner.js'), {
		backupFilePath,
		password,
		userDataDir: targetUserData,
		parentPid: 0,
		execPath: '',
		appArgs: [],
		logPath
	});

	const restoredState = JSON.parse(await fsp.readFile(path.join(targetUserData, 'savedSync.json'), 'utf8'));
	const restoredMarker = await fsp.readFile(path.join(targetUserData, 'nested', 'marker.txt'), 'utf8');
	const parentEntries = await fsp.readdir(tempRoot);
	const preRestoreDir = parentEntries.find((entry) => entry.startsWith('target-user-data.pre-restore-'));

	assertCondition(restoredState.streamID === 'transfer-session', 'restored savedSync streamID mismatch');
	assertCondition(restoredState.settings.transferred.setting === true, 'restored savedSync settings mismatch');
	assertCondition(restoredMarker === 'restored', 'nested restored marker missing');
	assertCondition(!fs.existsSync(path.join(targetUserData, 'stale.txt')), 'old target userData was not swapped out');
	assertCondition(!!preRestoreDir, 'pre-restore backup directory was not created');
	assertCondition(fs.existsSync(logPath), 'restore runner log was not written');

	return {
		backupFilePath,
		preRestoreDir
	};
}

function runCodePathChecks() {
	const mainPath = path.resolve(__dirname, '..', '..', 'main.js');
	const mainSource = fs.readFileSync(mainPath, 'utf8');
	const checks = [
		{
			id: 'settings_backup_menu_present',
			pass: /label:\s*'Settings Backup'[\s\S]*?label:\s*'Export Settings…'[\s\S]*?label:\s*'Import Settings…'/.test(mainSource)
		},
		{
			id: 'advanced_transfer_menu_present',
			pass: /label:\s*'Advanced Full Session Transfer'/.test(mainSource)
		},
		{
			id: 'saved_local_source_validated',
			pass: /function validateSocialStreamSourceRoot\(/.test(mainSource) &&
				/validateSocialStreamSourceRoot\(savedLocalSource\)/.test(mainSource)
		},
		{
			id: 'local_injection_falls_back_remote',
			pass: /Local Social Stream source failed\. Falling back to remote\/bundled scripts/.test(mainSource) &&
				/if \(!sourceInjectionHandled && selectedSourceFiles\.length\)/.test(mainSource)
		}
	];

	checks.forEach((check) => {
		assertCondition(check.pass, `Missing expected code path: ${check.id}`);
	});

	return checks;
}

async function main() {
	const tempRoot = await makeTempRoot();
	try {
		const codeChecks = runCodePathChecks();
		const settingsResult = await runSettingsExportImportRoundTrip(tempRoot);
		const transferResult = await runFullTransferRoundTrip(tempRoot);

		console.log('settings-transfer-e2e');
		console.log('');
		console.log('Code Path Checks:');
		codeChecks.forEach((check) => console.log(`- PASS ${check.id}`));
		console.log('');
		console.log('Settings Export/Import Round Trip:');
		console.log(`- PASS file: ${settingsResult.filePath}`);
		console.log(`- PASS settings keys: ${settingsResult.settingsCount}`);
		console.log(`- PASS app localStorage keys: ${settingsResult.localStorageCount}`);
		console.log('');
		console.log('Full Session Transfer Round Trip:');
		console.log(`- PASS backup: ${transferResult.backupFilePath}`);
		console.log(`- PASS pre-restore dir: ${transferResult.preRestoreDir}`);
	} finally {
		await fsp.rm(tempRoot, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error('settings-transfer-e2e: failed');
	console.error(error && error.stack ? error.stack : error);
	process.exit(1);
});
