#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const prunePackagedNativeBinaries = require('../../scripts/prunePackagedNativeBinaries');

async function createSharpArchive(resourcesDir, arch, mismatch = null) {
	const source = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-sharp-fixture-'));
	try {
		const packages = {
			sharp: { version: '0.35.4', optionalDependencies: {
				[`@img/sharp-darwin-${arch}`]: '0.35.4',
				[`@img/sharp-libvips-darwin-${arch}`]: '1.3.3',
			} },
			[`@img/sharp-darwin-${arch}`]: { version: mismatch === 'binding' ? '0.35.3' : '0.35.4' },
			[`@img/sharp-libvips-darwin-${arch}`]: { version: mismatch === 'libvips' ? '1.3.2' : '1.3.3' },
		};
		if (mismatch === 'missing') delete packages[`@img/sharp-libvips-darwin-${arch}`];
		for (const [name, data] of Object.entries(packages)) {
			const directory = path.join(source, 'node_modules', name);
			fs.mkdirSync(directory, { recursive: true });
			fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(data));
		}
		await require('@electron/asar').createPackage(source, path.join(resourcesDir, 'app.asar'));
	} finally {
		fs.rmSync(source, { recursive: true });
	}
}

function createRuntimeTree(appOutDir, resourcesDir = path.join(appOutDir, 'resources')) {
	const nodeModulesRoot = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules');
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
				if (platformName === 'linux') {
					fs.writeFileSync(path.join(runtimeDirectory, 'libonnxruntime_providers_shared.so'), 'required');
					fs.writeFileSync(path.join(runtimeDirectory, 'libonnxruntime_providers_cuda.so'), 'optional');
					fs.writeFileSync(path.join(runtimeDirectory, 'libonnxruntime_providers_tensorrt.so'), 'optional');
				}
			}
		}
	}
	return roots;
}

async function verifyTarget(platformName, arch, expectedArch) {
	const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), `ssapp-prune-${platformName}-`));
	try {
		const resourcesDir = platformName === 'darwin'
			? path.join(appOutDir, 'socialstream.app', 'Contents', 'Resources')
			: path.join(appOutDir, 'resources');
		const roots = createRuntimeTree(appOutDir, resourcesDir);
		if (platformName === 'darwin') await createSharpArchive(resourcesDir, expectedArch);
		await prunePackagedNativeBinaries({ electronPlatformName: platformName, arch, appOutDir,
			packager: { getResourcesDir: () => resourcesDir } });
		for (const root of roots) {
			assert.strictEqual(fs.existsSync(path.join(root, platformName, expectedArch, 'runtime.node')), true);
			for (const otherPlatform of ['win32', 'linux', 'darwin']) {
				if (otherPlatform !== platformName) assert.strictEqual(fs.existsSync(path.join(root, otherPlatform)), false);
			}
			const otherArch = expectedArch === 'x64' ? 'arm64' : 'x64';
			assert.strictEqual(fs.existsSync(path.join(root, platformName, otherArch)), false);
			if (platformName === 'linux') {
				assert.strictEqual(fs.existsSync(path.join(root, platformName, expectedArch, 'libonnxruntime_providers_shared.so')), true);
				assert.strictEqual(fs.existsSync(path.join(root, platformName, expectedArch, 'libonnxruntime_providers_cuda.so')), false);
				assert.strictEqual(fs.existsSync(path.join(root, platformName, expectedArch, 'libonnxruntime_providers_tensorrt.so')), false);
			}
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
	for (const mismatch of ['binding', 'libvips', 'missing']) {
		const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-sharp-reject-'));
		try {
			await createSharpArchive(resourcesDir, 'x64', mismatch);
			assert.throws(() => prunePackagedNativeBinaries.validateMacSharp(resourcesDir, 'x64'), /expected .*found/);
		} finally {
			fs.rmSync(resourcesDir, { recursive: true });
		}
	}
	console.log('Packaged native runtime pruning regression checks passed.');
})().catch(error => {
	console.error(error);
	process.exit(1);
});
