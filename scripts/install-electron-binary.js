/**
 * Downloads the Electron binary that matches the installed `electron` package.
 * Run automatically via `postinstall` in package.json.
 *
 * Electron 42 removed the `postinstall` hook from its own npm package, so installing it no
 * longer fetches a runtime: you get node_modules/electron with an install.js and no dist/.
 * Anything that resolves `require('electron')` to a real binary - npm start, every test
 * script - then fails. Consumers are expected to invoke the download themselves, which is
 * what this does.
 *
 * Skipped when the Electron package is absent (a production install without devDependencies)
 * or when ELECTRON_SKIP_BINARY_DOWNLOAD is set.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function log(message) {
	console.log(`[install-electron-binary] ${message}`);
}

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
	log('ELECTRON_SKIP_BINARY_DOWNLOAD is set; skipping.');
	return;
}

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const installScript = path.join(electronDir, 'install.js');

if (!fs.existsSync(installScript)) {
	log('Electron package is not installed; nothing to download.');
	return;
}

// install.js is a no-op when dist/ already matches the wanted version, so it is safe to run
// on every install. Report the outcome rather than letting a failure pass unnoticed.
log('Checking the Electron binary...');
try {
	require(installScript);
	log('Electron binary is ready.');
} catch (error) {
	console.error(`[install-electron-binary] Failed: ${(error && error.message) || error}`);
	console.error('[install-electron-binary] Run "node node_modules/electron/install.js" to retry.');
	process.exitCode = 1;
}
