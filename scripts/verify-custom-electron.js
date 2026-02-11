#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_VERSION = process.env.SSAPP_CUSTOM_ELECTRON_VERSION || '39.2.16-qp20';
const EXPECTED_PLATFORM = process.env.SSAPP_CUSTOM_ELECTRON_PLATFORM || 'win32';
const EXPECTED_ARCH = process.env.SSAPP_CUSTOM_ELECTRON_ARCH || 'x64';

if (process.env.SSAPP_SKIP_CUSTOM_ELECTRON_VERIFY === '1') {
  console.log('[custom-electron] Verification skipped (SSAPP_SKIP_CUSTOM_ELECTRON_VERIFY=1).');
  process.exit(0);
}

const distDir = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
const versionPath = path.join(distDir, 'version');
const markerPath = path.join(distDir, '.custom-version');

function readTrimmed(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

const version = readTrimmed(versionPath);
const marker = readTrimmed(markerPath);
const expectedMarker = `${EXPECTED_VERSION}:${EXPECTED_PLATFORM}:${EXPECTED_ARCH}`;

if (version !== EXPECTED_VERSION || marker !== expectedMarker) {
  console.error('[custom-electron] Verification failed.');
  console.error(`[custom-electron] Expected version: ${EXPECTED_VERSION}`);
  console.error(`[custom-electron] Actual version:   ${version || '<missing>'}`);
  console.error(`[custom-electron] Expected marker:  ${expectedMarker}`);
  console.error(`[custom-electron] Actual marker:    ${marker || '<missing>'}`);
  console.error('[custom-electron] Re-run npm install to install the custom Windows Electron build.');
  process.exit(1);
}

console.log(`[custom-electron] Verified ${EXPECTED_VERSION} (${EXPECTED_PLATFORM}/${EXPECTED_ARCH}).`);
