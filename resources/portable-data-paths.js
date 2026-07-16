'use strict';

const fs = require('fs');
const path = require('path');

const PORTABLE_DATA_FOLDER_NAME = 'SocialStreamNinja-data';
const PORTABLE_PROFILE_MARKER_NAME = '.profile-initialized.json';
const MIGRATION_EXCLUDED_NAMES = new Set([
	'SingletonLock',
	'SingletonSocket',
	'SingletonCookie',
	'DevTools Active Port',
	'LOCK',
	'Cache',
	'Code Cache',
	'GPUCache',
	'DawnCache',
	'ShaderCache',
	'GrShaderCache',
	'Crashpad',
]);
const PORTABLE_DATA_README = `Social Stream Ninja portable data
=================================

This folder contains the portable app's settings, browser sessions, cache, logs, and crash reports.

Keep this folder beside socialstreamninja-portable.exe. You can replace the EXE during an update without
losing these files, or move the EXE and this folder together.

Important limitations:
- Saved sign-ins protected by Windows may require you to sign in again after moving to another computer or Windows account.
- Local media and custom file selections still point to their original file locations. Move those files separately or relink them.
- Windows itself may keep system-level records such as Defender scans or Prefetch entries outside this folder.
`;

function normalizeEnvironmentPath(value) {
	const normalized = String(value || '').trim();
	return normalized ? path.resolve(normalized) : '';
}

/**
 * Resolve data paths that must be applied before Electron creates stores or sessions.
 * SSAPP_USER_DATA_DIR remains the highest-priority override for diagnostics and automation.
 */
function resolveEarlyDataPaths(environment = process.env, platform = process.platform) {
	const explicitUserDataDir = normalizeEnvironmentPath(environment.SSAPP_USER_DATA_DIR);
	if (explicitUserDataDir) {
		return {
			mode: 'explicit',
			dataRoot: explicitUserDataDir,
			userData: explicitUserDataDir,
			sessionData: explicitUserDataDir,
			logs: path.join(explicitUserDataDir, 'logs'),
			crashes: path.join(explicitUserDataDir, 'crashes'),
		};
	}

	const portableExecutableDir = normalizeEnvironmentPath(environment.PORTABLE_EXECUTABLE_DIR);
	if (platform !== 'win32' || !portableExecutableDir) return null;

	const dataRoot = path.join(portableExecutableDir, PORTABLE_DATA_FOLDER_NAME);
	const profile = path.join(dataRoot, 'profile');
	return {
		mode: 'portable',
		dataRoot,
		userData: profile,
		sessionData: profile,
		logs: path.join(dataRoot, 'logs'),
		crashes: path.join(dataRoot, 'crashes'),
	};
}

function verifyDirectoryWritable(directory) {
	const probePath = path.join(
		directory,
		`.ssapp-write-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
	);
	let descriptor = null;
	try {
		descriptor = fs.openSync(probePath, 'wx');
	} finally {
		if (descriptor !== null) fs.closeSync(descriptor);
		try {
			fs.unlinkSync(probePath);
		} catch (_) { }
	}
}

function writePortableReadme(dataRoot) {
	const readmePath = path.join(dataRoot, 'README.txt');
	try {
		fs.writeFileSync(readmePath, PORTABLE_DATA_README, { encoding: 'utf8', flag: 'wx' });
	} catch (error) {
		if (!error || error.code !== 'EEXIST') throw error;
	}
}

function directoryHasData(directory) {
	try {
		return fs.readdirSync(directory).length > 0;
	} catch (_) {
		return false;
	}
}

function copyLegacyProfile(sourceDirectory, destinationDirectory) {
	for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
		if (MIGRATION_EXCLUDED_NAMES.has(entry.name)) continue;
		const sourcePath = path.join(sourceDirectory, entry.name);
		const destinationPath = path.join(destinationDirectory, entry.name);
		fs.cpSync(sourcePath, destinationPath, {
			recursive: true,
			force: true,
			filter: (candidate) => !MIGRATION_EXCLUDED_NAMES.has(path.basename(candidate)),
		});
	}
}

function markPortableProfileInitialized(paths, action) {
	const markerPath = path.join(paths.dataRoot, PORTABLE_PROFILE_MARKER_NAME);
	fs.writeFileSync(markerPath, JSON.stringify({
		action,
		initializedAt: new Date().toISOString(),
	}, null, 2));
}

/**
 * Handle data left by older portable builds, which used the installed AppData profile.
 * The caller supplies the choice UI so this module remains testable without Electron.
 */
function initializePortableProfile(paths, options = {}) {
	if (!paths || paths.mode !== 'portable') return { action: 'not-portable' };
	const markerPath = path.join(paths.dataRoot, PORTABLE_PROFILE_MARKER_NAME);
	if (fs.existsSync(markerPath)) return { action: 'already-initialized' };

	if (directoryHasData(paths.userData)) {
		markPortableProfileInitialized(paths, 'existing');
		return { action: 'existing' };
	}

	const legacyUserData = normalizeEnvironmentPath(options.legacyUserData);
	if (!legacyUserData || path.resolve(legacyUserData) === path.resolve(paths.userData) || !directoryHasData(legacyUserData)) {
		markPortableProfileInitialized(paths, 'new');
		return { action: 'new' };
	}

	const requestedChoice = String(options.choice || '').trim().toLowerCase();
	if (requestedChoice !== 'copy' && requestedChoice !== 'fresh' && typeof options.choose !== 'function') {
		return { action: 'pending', legacyUserData };
	}
	const choice = requestedChoice === 'copy' || requestedChoice === 'fresh'
		? requestedChoice
		: (typeof options.choose === 'function' && options.choose(legacyUserData) === 'copy' ? 'copy' : 'fresh');
	if (choice === 'copy') copyLegacyProfile(legacyUserData, paths.userData);

	markPortableProfileInitialized(paths, choice);
	return { action: choice, legacyUserData };
}

/**
 * Create and validate every persistent directory before Electron starts writing to it.
 */
function prepareEarlyDataPaths(paths) {
	if (!paths) return;
	const directories = [...new Set([paths.dataRoot, paths.userData, paths.sessionData, paths.logs, paths.crashes])];
	for (const directory of directories) {
		fs.mkdirSync(directory, { recursive: true });
		verifyDirectoryWritable(directory);
	}
	if (paths.mode === 'portable') writePortableReadme(paths.dataRoot);
}

module.exports = {
	PORTABLE_DATA_FOLDER_NAME,
	PORTABLE_PROFILE_MARKER_NAME,
	resolveEarlyDataPaths,
	prepareEarlyDataPaths,
	initializePortableProfile,
	copyLegacyProfile,
	markPortableProfileInitialized,
};
