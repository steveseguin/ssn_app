'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getSignToolPath } = require('app-builder-lib/out/toolsets/windows');

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const ENV_FILES = ['build-config.env', 'electron-builder.env'];

function loadLocalEnvFiles() {
	for (const envFile of ENV_FILES) {
		const envPath = path.join(__dirname, envFile);
		if (!fs.existsSync(envPath)) continue;

		const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;

			const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
			if (!match) continue;

			const name = match[1];
			let value = match[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}

			if (!process.env[name]) {
				process.env[name] = value;
			}
		}
	}
}

function resolveCertificateFile(certificateFile) {
	if (!certificateFile || typeof certificateFile !== 'string') return null;
	if (path.isAbsolute(certificateFile) && fs.existsSync(certificateFile)) return certificateFile;

	const projectRelativePath = path.resolve(__dirname, certificateFile);
	if (fs.existsSync(projectRelativePath)) return projectRelativePath;

	const cwdRelativePath = path.resolve(process.cwd(), certificateFile);
	if (fs.existsSync(cwdRelativePath)) return cwdRelativePath;

	return null;
}

function getPassword(configuration) {
	return configuration?.cscInfo?.password || process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD || '';
}

function sanitizeOutput(value, password) {
	let sanitized = String(value || '');
	if (password) {
		sanitized = sanitized.split(password).join('***');
	}
	return sanitized.trim();
}

async function runSignTool(toolPath, args, toolEnv, password) {
	const timeout = Number.parseInt(process.env.SIGNTOOL_TIMEOUT, 10) || DEFAULT_TIMEOUT_MS;

	try {
		await execFileAsync(toolPath, args, {
			cwd: __dirname,
			env: { ...process.env, ...(toolEnv || {}) },
			timeout,
			windowsHide: true,
			maxBuffer: 1024 * 1024 * 10,
		});
	} catch (error) {
		const stdout = sanitizeOutput(error.stdout, password);
		const stderr = sanitizeOutput(error.stderr, password);
		const details = [stdout, stderr].filter(Boolean).join('\n');
		throw new Error(`signtool failed for ${path.basename(args[args.length - 1])}${details ? `\n${details}` : ''}`);
	}
}

exports.default = async function(configuration, packager) {
	loadLocalEnvFiles();

	const certificateFile = resolveCertificateFile(configuration?.cscInfo?.file || 'certs/socialstream.pfx');
	if (!certificateFile) {
		console.log('  * skipping signing  reason=certificate not found at certs/socialstream.pfx');
		return false;
	}

	const password = getPassword(configuration);
	if (!password) {
		console.log('  * skipping signing  reason=WIN_CSC_KEY_PASSWORD not set');
		return false;
	}

	if (!configuration?.path || typeof configuration.computeSignToolArgs !== 'function') {
		throw new Error('Invalid signing configuration from electron-builder');
	}

	configuration.cscInfo = {
		...(configuration.cscInfo || {}),
		file: certificateFile,
		password,
	};

	const isWin = process.platform === 'win32';
	const winCodeSign = packager?.config?.toolsets?.winCodeSign;
	const toolInfo = await getSignToolPath(winCodeSign, isWin);
	const args = configuration.computeSignToolArgs(isWin);

	console.log(`  * signing         file=${configuration.path} certificateFile=${path.relative(__dirname, certificateFile)}`);
	await runSignTool(toolInfo.path, args, toolInfo.env, password);
	return true;
};
