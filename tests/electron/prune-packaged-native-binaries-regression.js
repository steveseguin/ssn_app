#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const prunePackagedNativeBinaries = require('../../scripts/prunePackagedNativeBinaries');

function createRuntimeTree(appOutDir) {
	const nodeModulesRoot = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules');
	const roots = [
		path.join(nodeModulesRoot, 'onnxruntime-node', 'bin', 'napi-v3'),
		path.join(nodeModulesRoot, 'kokoro-js', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3'),
	];
	for (const root of roots) {
		for (const platformName of ['win32', 'linux', 'darwin']) {
			for (const archName of ['x64', 'arm64']) {
				const runtimeDirectory = path.join(root, platformName, archName);
				fs.mkdirSync(runtimeDirectory, { recursive: true });
				fs.writeFileSync(path.join(runtimeDirectory, 'runtime.node'), `${platformName}/${archName}`);
			}
		}
	}
	return roots;
}

async function verifyTarget(platformName, arch, expectedArch) {
	const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), `ssapp-prune-${platformName}-`));
	try {
		const roots = createRuntimeTree(appOutDir);
		await prunePackagedNativeBinaries({ electronPlatformName: platformName, arch, appOutDir });
		for (const root of roots) {
			assert.strictEqual(fs.existsSync(path.join(root, platformName, expectedArch, 'runtime.node')), true);
			for (const otherPlatform of ['win32', 'linux', 'darwin']) {
				if (otherPlatform !== platformName) assert.strictEqual(fs.existsSync(path.join(root, otherPlatform)), false);
			}
			const otherArch = expectedArch === 'x64' ? 'arm64' : 'x64';
			assert.strictEqual(fs.existsSync(path.join(root, platformName, otherArch)), false);
		}
	} finally {
		fs.rmSync(appOutDir, { recursive: true, force: true });
	}
}

async function verifyMissingRequiredRuntimeFailsSafe() {
	const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-prune-safe-'));
	try {
		const roots = createRuntimeTree(appOutDir);
		for (const root of roots) fs.rmSync(path.join(root, 'linux', 'x64'), { recursive: true, force: true });
		await prunePackagedNativeBinaries({ electronPlatformName: 'linux', arch: 1, appOutDir });
		for (const root of roots) {
			assert.strictEqual(fs.existsSync(path.join(root, 'win32', 'x64')), true);
			assert.strictEqual(fs.existsSync(path.join(root, 'darwin', 'arm64')), true);
		}
	} finally {
		fs.rmSync(appOutDir, { recursive: true, force: true });
	}
}

(async () => {
	await verifyTarget('win32', 1, 'x64');
	await verifyTarget('linux', 1, 'x64');
	await verifyTarget('darwin', 3, 'arm64');
	await verifyMissingRequiredRuntimeFailsSafe();
	console.log('Packaged native runtime pruning regression checks passed.');
})().catch(error => {
	console.error(error);
	process.exit(1);
});
