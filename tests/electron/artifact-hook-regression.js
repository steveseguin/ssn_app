'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const unzipper = require('unzipper');

const artifactHook = require('../../afterPack').default;
const version = require('../../package.json').version;
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-artifact-hook-'));
const outputDirectory = path.join(testRoot, 'custom-output');

async function readOnlyZipEntry(zipPath) {
	const archive = await unzipper.Open.file(zipPath);
	assert.strictEqual(archive.files.length, 1, `expected one entry in ${zipPath}`);
	return {
		name: archive.files[0].path,
		content: (await archive.files[0].buffer()).toString('utf8'),
	};
}

async function run() {
	fs.mkdirSync(outputDirectory, { recursive: true });
	const portablePath = path.join(outputDirectory, 'socialstreamninja-portable.exe');
	const installerPath = path.join(outputDirectory, `socialstreamninja-setup-${version}.exe`);
	fs.writeFileSync(portablePath, 'current portable artifact');
	fs.writeFileSync(installerPath, 'current installer artifact');

	const created = await artifactHook({
		outDir: outputDirectory,
		artifactPaths: [portablePath, installerPath],
		configuration: {},
		platformToTargets: new Map(),
	});

	const expectedPortableZip = path.join(outputDirectory, `socialstreamninja_win_v${version}_portable.zip`);
	const expectedInstallerZip = path.join(outputDirectory, `socialstreamninja_win_v${version}_installer.zip`);
	assert.deepStrictEqual(created.sort(), [expectedInstallerZip, expectedPortableZip].sort());

	const portableEntry = await readOnlyZipEntry(expectedPortableZip);
	assert.strictEqual(portableEntry.name, path.basename(portablePath));
	assert.strictEqual(portableEntry.content, 'current portable artifact');

	const installerEntry = await readOnlyZipEntry(expectedInstallerZip);
	assert.strictEqual(installerEntry.name, path.basename(installerPath));
	assert.strictEqual(installerEntry.content, 'current installer artifact');

	const emptyOutput = path.join(testRoot, 'directory-only-output');
	fs.mkdirSync(emptyOutput);
	const noArtifacts = await artifactHook({
		outDir: emptyOutput,
		artifactPaths: [],
		configuration: {},
		platformToTargets: new Map(),
	});
	assert.deepStrictEqual(noArtifacts, []);
	assert.deepStrictEqual(fs.readdirSync(emptyOutput), []);

	console.log('artifact-hook-regression: custom output artifacts were packaged without consulting stale dist files');
}

run().catch(error => {
	console.error(error);
	process.exitCode = 1;
}).finally(() => {
	try {
		fs.rmSync(testRoot, { recursive: true, force: true });
	} catch (_) { }
});
