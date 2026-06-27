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

module.exports = async function prunePackagedNativeBinaries(context) {
  if (!context || context.electronPlatformName !== 'win32') return;

  const archName = ARCH_NAMES[context.arch] || String(context.arch || '');
  const nodeModulesRoot = path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules');
  const onnxRoots = [
    path.join(nodeModulesRoot, 'onnxruntime-node', 'bin', 'napi-v3'),
    path.join(nodeModulesRoot, 'kokoro-js', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3'),
  ];
  const removableByArch = new Set(['darwin', 'linux']);

  if (archName === 'x64') removableByArch.add(path.join('win32', 'arm64'));
  if (archName === 'arm64') removableByArch.add(path.join('win32', 'x64'));

  let removed = 0;
  for (const onnxRoot of onnxRoots) {
    for (const relativePath of removableByArch) {
      if (removeIfExists(path.join(onnxRoot, relativePath))) removed += 1;
    }
  }

  if (removed > 0) {
    console.log(`[packaging] Pruned ${removed} unused ONNX native runtime directories for win32/${archName}.`);
  }
};
