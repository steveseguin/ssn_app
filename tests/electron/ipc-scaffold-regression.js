'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

function readText(relativePath) {
	return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function assertNotContains(source, pattern, message) {
	assert(!pattern.test(source), message);
}

function run() {
	const mainSource = readText('main.js');
	const indexSource = readText('index.html');

	assertNotContains(mainSource, /ipcMain\.on\(['"]ipc-request['"]/, 'main.js should not register the removed universal ipc-request handler');
	assertNotContains(mainSource, /event\.sender\.send\(['"]ipc-response['"]/, 'main.js should not emit removed universal ipc-response messages');
	assertNotContains(mainSource, /Not implemented yet - use sync handler/, 'main.js should not expose unfinished async IPC routes');
	assertNotContains(mainSource, /handle(?:StorageSave|StorageLoad|NodeFetch|CloseWindow|ReloadWindow|GetWindowInfo)\s*\(/, 'main.js should not retain unfinished async IPC handler stubs');

	assertNotContains(indexSource, /class\s+UniversalIPCHandler\b/, 'index.html should not define the removed universal IPC callback manager');
	assertNotContains(indexSource, /window\.ipc\s*=/, 'index.html should not expose window.ipc for the removed universal IPC flow');
	assertNotContains(indexSource, /ipcRenderer\.send\(['"]ipc-request['"]/, 'index.html should not send removed ipc-request messages');
	assertNotContains(indexSource, /['"]ipc-response['"]/, 'index.html should not listen for removed ipc-response messages');

	console.log('ipc-scaffold-regression: removed universal IPC scaffold remains absent');
}

run();
