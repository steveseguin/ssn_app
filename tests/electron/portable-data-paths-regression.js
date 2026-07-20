#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
	PORTABLE_DATA_FOLDER_NAME,
	PORTABLE_PROFILE_MARKER_NAME,
	resolveEarlyDataPaths,
	prepareEarlyDataPaths,
	initializePortableProfile,
} = require('../../resources/portable-data-paths');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-portable-paths-'));

try {
	assert.strictEqual(resolveEarlyDataPaths({}, 'win32'), null);
	assert.strictEqual(resolveEarlyDataPaths({ PORTABLE_EXECUTABLE_DIR: tempRoot }, 'linux'), null);

	const portable = resolveEarlyDataPaths({ PORTABLE_EXECUTABLE_DIR: tempRoot }, 'win32');
	assert.strictEqual(portable.mode, 'portable');
	assert.strictEqual(portable.dataRoot, path.join(tempRoot, PORTABLE_DATA_FOLDER_NAME));
	assert.strictEqual(portable.userData, path.join(portable.dataRoot, 'profile'));
	assert.strictEqual(portable.sessionData, portable.userData);
	prepareEarlyDataPaths(portable);
	for (const directory of [portable.userData, portable.logs, portable.crashes]) {
		assert.strictEqual(fs.statSync(directory).isDirectory(), true, `${directory} was not created`);
	}
	assert.match(fs.readFileSync(path.join(portable.dataRoot, 'README.txt'), 'utf8'), /Saved sign-ins protected by Windows/);
	const legacyDir = path.join(tempRoot, 'legacy-profile');
	fs.mkdirSync(path.join(legacyDir, 'Local Storage'), { recursive: true });
	fs.writeFileSync(path.join(legacyDir, 'config.json'), JSON.stringify({ migrated: true }));
	fs.writeFileSync(path.join(legacyDir, 'Local Storage', 'state.txt'), 'session-state');
	fs.writeFileSync(path.join(legacyDir, 'SingletonLock'), 'stale-lock');
	fs.mkdirSync(path.join(legacyDir, 'Cache'), { recursive: true });
	fs.writeFileSync(path.join(legacyDir, 'Cache', 'stale-cache'), 'disposable');
	const migration = initializePortableProfile(portable, { legacyUserData: legacyDir, choice: 'copy' });
	assert.strictEqual(migration.action, 'copy');
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(portable.userData, 'config.json'), 'utf8')), { migrated: true });
	assert.strictEqual(fs.readFileSync(path.join(portable.userData, 'Local Storage', 'state.txt'), 'utf8'), 'session-state');
	assert.strictEqual(fs.existsSync(path.join(portable.userData, 'SingletonLock')), false);
	assert.strictEqual(fs.existsSync(path.join(portable.userData, 'Cache')), false);
	assert.strictEqual(fs.existsSync(path.join(portable.dataRoot, PORTABLE_PROFILE_MARKER_NAME)), true);
	assert.strictEqual(initializePortableProfile(portable, { legacyUserData: legacyDir, choice: 'fresh' }).action, 'already-initialized');

	const freshRoot = path.join(tempRoot, 'fresh-bundle');
	const fresh = resolveEarlyDataPaths({ PORTABLE_EXECUTABLE_DIR: freshRoot }, 'win32');
	prepareEarlyDataPaths(fresh);
	assert.strictEqual(initializePortableProfile(fresh, { legacyUserData: legacyDir }).action, 'pending');
	assert.strictEqual(initializePortableProfile(fresh, { legacyUserData: legacyDir, choice: 'fresh' }).action, 'fresh');
	assert.strictEqual(fs.existsSync(path.join(fresh.userData, 'config.json')), false);

	const explicitDir = path.join(tempRoot, 'explicit-profile');
	const explicit = resolveEarlyDataPaths({
		SSAPP_USER_DATA_DIR: explicitDir,
		PORTABLE_EXECUTABLE_DIR: path.join(tempRoot, 'ignored-portable-dir'),
	}, 'win32');
	assert.strictEqual(explicit.mode, 'explicit');
	assert.strictEqual(explicit.userData, explicitDir);
	prepareEarlyDataPaths(explicit);
	assert.strictEqual(fs.existsSync(path.join(explicitDir, 'README.txt')), false);

	const fileInsteadOfDirectory = path.join(tempRoot, 'not-a-directory');
	fs.writeFileSync(fileInsteadOfDirectory, 'occupied');
	assert.throws(
		() => prepareEarlyDataPaths(resolveEarlyDataPaths({ PORTABLE_EXECUTABLE_DIR: fileInsteadOfDirectory }, 'win32')),
		/ENOTDIR|EEXIST/,
	);

	console.log('Portable data path regression checks passed.');
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
