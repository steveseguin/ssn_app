#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const electronPath = require('electron');
const profilePrefix = 'ssapp-rumble-persistence-';
const partition = 'persist:custom-rumble-persistence-test';
const cookieName = 'ssapp_rumble_persistence_test';
const cookieValue = `persisted-${Date.now()}`;
const tiktokCookieName = 'sessionid';
const tiktokCookieValue = `tiktok-persisted-${Date.now()}`;
const googleCookieName = 'ssapp_google_filter_test';

function delay(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function removeProfile(profileDir) {
	const resolved = path.resolve(profileDir);
	if (path.dirname(resolved).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(resolved).startsWith(profilePrefix)) {
		throw new Error(`Refused to remove unexpected persistence test profile: ${resolved}`);
	}
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			fs.rmSync(resolved, { recursive: true, force: true });
			return;
		} catch (_) {
			await delay(250);
		}
	}
}

async function runElectronPass(mode, profileDir) {
	return await new Promise((resolve, reject) => {
		const child = spawn(electronPath, [__filename, ...linuxLaunchArgs()], {
			cwd: path.resolve(__dirname, '..', '..'),
			env: {
				...process.env,
				SSAPP_RUMBLE_PERSISTENCE_CHILD: mode,
				SSAPP_RUMBLE_PERSISTENCE_PROFILE: profileDir,
				SSAPP_RUMBLE_PERSISTENCE_VALUE: cookieValue,
				SSAPP_TIKTOK_PERSISTENCE_VALUE: tiktokCookieValue,
				SSAPP_DIAGNOSTICS_SAFE_GPU: '1'
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		let output = '';
		child.stdout.on('data', chunk => { output += chunk.toString(); });
		child.stderr.on('data', chunk => { output += chunk.toString(); });
		const timeout = setTimeout(() => {
			try { child.kill(); } catch (_) { }
			reject(new Error(`Electron ${mode} pass timed out.\n${output}`));
		}, 30000);
		child.once('exit', code => {
			clearTimeout(timeout);
			if (code === 0 && output.includes(`RUMBLE_PERSISTENCE_${mode.toUpperCase()}_OK`)) {
				resolve(output);
				return;
			}
			reject(new Error(`Electron ${mode} pass failed with code ${code}.\n${output}`));
		});
	});
}

async function runChild() {
	const { app, session } = require('electron');
	const { importPlatformCookies, importRumbleCookies } = require('../../resources/electron-rumble-handler');
	const mode = process.env.SSAPP_RUMBLE_PERSISTENCE_CHILD;
	const profileDir = process.env.SSAPP_RUMBLE_PERSISTENCE_PROFILE;
	const expectedValue = process.env.SSAPP_RUMBLE_PERSISTENCE_VALUE;
	const expectedTikTokValue = process.env.SSAPP_TIKTOK_PERSISTENCE_VALUE;
	app.setPath('userData', profileDir);
	await app.whenReady();
	try {
		const destinationSession = session.fromPartition(partition);
		if (mode === 'write') {
			await importRumbleCookies(destinationSession, [{
				name: cookieName,
				value: expectedValue,
				domain: '.rumble.com',
				path: '/',
				secure: true,
				httpOnly: true,
				sameSite: 'Lax',
				expires: Math.floor(Date.now() / 1000) + 3600
			}]);
			await importPlatformCookies(destinationSession, 'tiktok', [
				{
					name: tiktokCookieName,
					value: expectedTikTokValue,
					domain: '.tiktok.com',
					path: '/',
					secure: true,
					httpOnly: true,
					sameSite: 'Lax',
					expires: Math.floor(Date.now() / 1000) + 3600
				},
				{
					name: googleCookieName,
					value: 'must-not-import',
					domain: '.google.com',
					path: '/',
					secure: true,
					httpOnly: true
				}
			]);
			console.log('RUMBLE_PERSISTENCE_WRITE_OK');
		} else {
			const selectedCookies = await destinationSession.cookies.get({ name: cookieName });
			const selectedTikTokCookies = await destinationSession.cookies.get({ name: tiktokCookieName });
			const selectedGoogleCookies = await destinationSession.cookies.get({ name: googleCookieName });
			const defaultCookies = await session.fromPartition('persist:rumble').cookies.get({ name: cookieName });
			const defaultTikTokCookies = await session.fromPartition('persist:tiktok').cookies.get({ name: tiktokCookieName });
			assert(selectedCookies.some(cookie => cookie.value === expectedValue), 'the selected named profile lost its imported Rumble cookie after restart');
			assert(selectedTikTokCookies.some(cookie => cookie.value === expectedTikTokValue), 'the selected named profile lost its imported TikTok cookie after restart');
			assert.strictEqual(selectedGoogleCookies.length, 0, 'a Google cookie was copied into the named SSApp profile');
			assert.strictEqual(defaultCookies.length, 0, 'the imported cookie leaked into the default Rumble profile');
			assert.strictEqual(defaultTikTokCookies.length, 0, 'the imported cookie leaked into the default TikTok profile');
			console.log('RUMBLE_PERSISTENCE_READ_OK');
		}
	} finally {
		app.quit();
	}
}

async function runParent() {
	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), profilePrefix));
	try {
		await runElectronPass('write', profileDir);
		await runElectronPass('read', profileDir);
		console.log('Rumble Chrome sign-in profile persistence checks passed.');
	} finally {
		await removeProfile(profileDir);
	}
}

if (process.versions.electron && process.env.SSAPP_RUMBLE_PERSISTENCE_CHILD) {
	runChild().catch(error => {
		console.error(error && error.stack ? error.stack : error);
		process.exitCode = 1;
		try { require('electron').app.quit(); } catch (_) { }
	});
} else {
	runParent().catch(error => {
		console.error(error && error.stack ? error.stack : error);
		process.exitCode = 1;
	});
}
