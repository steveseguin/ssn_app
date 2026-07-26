'use strict';

const fs = require('fs');
const path = require('path');

function findArtifact(artifactPaths, expectedName) {
	const normalizedName = expectedName.toLowerCase();
	return artifactPaths.find(artifactPath => path.basename(artifactPath).toLowerCase() === normalizedName) || null;
}

async function createZip(source, destination) {
	const { ZipArchive } = await import('archiver');
	return await new Promise((resolve, reject) => {
		const output = fs.createWriteStream(destination);
		const archive = new ZipArchive({ zlib: { level: 9 } });

		output.once('close', resolve);
		output.once('error', reject);
		archive.once('error', reject);
		archive.pipe(output);
		archive.file(source, { name: path.basename(source) });
		archive.finalize().catch(reject);
	});
}

async function createWindowsZipArtifacts(buildResult, version) {
	const artifactPaths = Array.isArray(buildResult.artifactPaths) ? buildResult.artifactPaths : [];
	const definitions = [
		{
			sourceName: 'socialstreamninja-portable.exe',
			zipName: `socialstreamninja_win_v${version}_portable.zip`,
			label: 'portable',
		},
		{
			sourceName: `socialstreamninja-setup-${version}.exe`,
			zipName: `socialstreamninja_win_v${version}_installer.zip`,
			label: 'installer',
		},
	];
	const created = [];

	for (const definition of definitions) {
		const source = findArtifact(artifactPaths, definition.sourceName);
		if (!source) continue;

		const destination = path.join(path.dirname(source), definition.zipName);
		console.log(`[afterAllArtifactBuild] Creating ${definition.label} zip: ${destination}`);
		await createZip(source, destination);
		created.push(destination);
	}

	return created;
}

async function normalizeMacZipArtifactNames(buildResult, version) {
	const artifactPaths = Array.isArray(buildResult.artifactPaths) ? buildResult.artifactPaths : [];

	for (let index = 0; index < artifactPaths.length; index++) {
		const artifactPath = artifactPaths[index];
		const basename = path.basename(artifactPath);
		if (!/socialstream/i.test(basename) || !/mac/i.test(basename) || !basename.toLowerCase().endsWith('.zip')) {
			continue;
		}

		let arch = 'universal';
		if (/arm64/i.test(basename)) arch = 'arm64';
		else if (/x64/i.test(basename)) arch = 'x64';

		const destination = path.join(path.dirname(artifactPath), `socialstreamninja_mac_v${version}_${arch}.zip`);
		if (path.resolve(destination) === path.resolve(artifactPath)) continue;
		if (fs.existsSync(destination)) {
			throw new Error(`Refusing to overwrite existing macOS artifact: ${destination}`);
		}

		console.log(`[afterAllArtifactBuild] Renaming macOS zip: ${artifactPath} -> ${destination}`);
		await fs.promises.rename(artifactPath, destination);
		artifactPaths[index] = destination;
	}
}

exports.default = async function afterAllArtifactBuild(buildResult) {
	if (!buildResult || typeof buildResult !== 'object') {
		throw new TypeError('afterAllArtifactBuild requires the electron-builder BuildResult.');
	}

	const version = require('./package.json').version;
	console.log(`[afterAllArtifactBuild] Output directory: ${buildResult.outDir || '(unknown)'}`);

	const createdArtifacts = await createWindowsZipArtifacts(buildResult, version);
	await normalizeMacZipArtifactNames(buildResult, version);
	return createdArtifacts;
};

exports.__test = {
	createWindowsZipArtifacts,
	findArtifact,
	normalizeMacZipArtifactNames,
};
