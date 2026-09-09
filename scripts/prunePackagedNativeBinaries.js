'use strict';

const fs = require('fs');
const path = require('path');

const ARCH_NAMES = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
};

function removeIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) return false;
  fs.rmSync(targetPath, { recursive: true, force: true });
  return true;
}

function validateMacSharp(resourcesDir, archName) {
  const asar = require('@electron/asar');
  const archive = path.join(resourcesDir, 'app.asar');
  const sharp = JSON.parse(asar.extractFile(archive, 'node_modules/sharp/package.json'));
  for (const name of [`@img/sharp-darwin-${archName}`, `@img/sharp-libvips-darwin-${archName}`]) {
    const expected = sharp.optionalDependencies?.[name];
    if (!expected) throw new Error(`[packaging] Sharp does not declare ${name}.`);
    let installed;
    // Match the dependency lookup from Sharp, including npm's nested native packages.
    for (const directory of ['node_modules/sharp/node_modules', 'node_modules']) {
      let contents;
      try { contents = asar.extractFile(archive, `${directory}/${name}/package.json`); }
      catch (_) { continue; }
      installed = JSON.parse(contents).version;
      break;
    }
    if (installed !== expected) {
      throw new Error(`[packaging] ${name}: expected ${expected}, found ${installed || 'missing'}. Install the matching Mac native dependency before rebuilding.`);
    }
  }
  console.log(`[packaging] Sharp native dependencies match for darwin/${archName}.`);
}

module.exports = async function prunePackagedNativeBinaries(context) {
  if (!context || !['win32', 'linux', 'darwin'].includes(context.electronPlatformName)) return;

  const archName = ARCH_NAMES[context.arch] || String(context.arch || '');
  if (!['x64', 'arm64'].includes(archName)) return;
  const resourcesDir = context.packager?.getResourcesDir
    ? context.packager.getResourcesDir(context.appOutDir)
    : path.join(context.appOutDir, 'resources');
  const nodeModulesRoot = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules');
  if (context.electronPlatformName === 'darwin') validateMacSharp(resourcesDir, archName);
  const onnxRoots = [
    path.join(nodeModulesRoot, 'onnxruntime-node', 'bin', 'napi-v3'),
    path.join(nodeModulesRoot, 'kokoro-js', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3'),
  ];

  let removed = 0;
  for (const onnxRoot of onnxRoots) {
    const requiredRuntime = path.join(onnxRoot, context.electronPlatformName, archName);
    if (!fs.existsSync(requiredRuntime)) {
      console.warn(`[packaging] Required ONNX runtime missing at ${requiredRuntime}; skipping native runtime pruning.`);
      continue;
    }

    for (const platformName of ['win32', 'linux', 'darwin']) {
      if (platformName !== context.electronPlatformName && removeIfExists(path.join(onnxRoot, platformName))) {
        removed += 1;
      }
    }

    const targetPlatformRoot = path.join(onnxRoot, context.electronPlatformName);
    for (const entry of fs.readdirSync(targetPlatformRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== archName && removeIfExists(path.join(targetPlatformRoot, entry.name))) {
        removed += 1;
      }
    }

    if (context.electronPlatformName === 'linux') {
      for (const providerName of ['libonnxruntime_providers_cuda.so', 'libonnxruntime_providers_tensorrt.so']) {
        if (removeIfExists(path.join(requiredRuntime, providerName))) removed += 1;
      }
    }
  }

  if (removed > 0) {
    console.log(`[packaging] Pruned ${removed} unused ONNX native runtime entries for ${context.electronPlatformName}/${archName}.`);
  }
};

module.exports.validateMacSharp = validateMacSharp;
