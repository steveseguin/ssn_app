#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function requestText(target) {
	return new Promise((resolve, reject) => {
		http.get(target, { agent: false, headers: { Connection: 'close' } }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', chunk => { body += chunk; });
			res.on('end', () => resolve({ statusCode: res.statusCode, body }));
		}).on('error', reject);
	});
}

async function captureAuthorizationUrl(runLoopbackOAuthSession, state) {
	let resolveAuthUrl;
	const authUrlPromise = new Promise(resolve => { resolveAuthUrl = resolve; });
	const sessionOutcome = runLoopbackOAuthSession({
		authBase: 'https://example.test/youtube',
		clientId: 'loopback-test',
		scopes: ['scope-a'],
		state,
		timeoutMs: 5000,
	}, {
		openExternal: async (authUrl) => { resolveAuthUrl(authUrl); },
	}).then(
		value => ({ value }),
		error => ({ error })
	);
	const authUrl = await authUrlPromise;
	const parsedAuthUrl = new URL(authUrl);
	const redirectUri = parsedAuthUrl.searchParams.get('redirect_uri');
	const returnedState = parsedAuthUrl.searchParams.get('state');
	assert.ok(redirectUri, 'OAuth URL did not include a redirect URI');
	assert.strictEqual(returnedState, state, 'OAuth URL did not preserve the requested state');
	return { redirectUri, returnedState, sessionOutcome };
}

async function runElectronChecks() {
	const { app } = require('electron');
	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-youtube-oauth-loopback-'));
	app.setPath('userData', profileDir);
	await app.whenReady();
	const { __test } = require('../../resources/electron-youtube-handler');

	try {
		const missingState = await captureAuthorizationUrl(__test.runLoopbackOAuthSession, 'expected-state');
		const missingStateCallback = new URL(missingState.redirectUri);
		missingStateCallback.searchParams.set('code', 'attacker-code');
		const missingStateResponse = await requestText(missingStateCallback);
		assert.strictEqual(missingStateResponse.statusCode, 200);
		assert.match(missingStateResponse.body, /State Mismatch/);
		const missingStateOutcome = await missingState.sessionOutcome;
		assert.strictEqual(missingStateOutcome.error?.code, 'SSAPP_YOUTUBE_OAUTH_STATE_MISMATCH');

		await new Promise(resolve => setTimeout(resolve, 100));

		const validState = await captureAuthorizationUrl(__test.runLoopbackOAuthSession, 'valid-state');
		const validStateCallback = new URL(validState.redirectUri);
		validStateCallback.searchParams.set('code', 'valid-code');
		validStateCallback.searchParams.set('state', validState.returnedState);
		const validResponse = await requestText(validStateCallback);
		assert.strictEqual(validResponse.statusCode, 200);
		assert.match(validResponse.body, /Success!/);
		const validStateOutcome = await validState.sessionOutcome;
		assert.ifError(validStateOutcome.error);
		const result = validStateOutcome.value;
		assert.deepStrictEqual({ code: result.code, state: result.state }, { code: 'valid-code', state: 'valid-state' });

		console.log('YouTube OAuth loopback end-to-end checks passed.');
	} finally {
		try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) { }
	}
}

if (process.versions.electron) {
	const { app } = require('electron');
	runElectronChecks().then(() => {
		app.exit(0);
	}).catch(error => {
		console.error(error && error.stack ? error.stack : error);
		app.exit(1);
	});
} else {
	const electronPath = require('electron');
	const environment = { ...process.env };
	delete environment.ELECTRON_RUN_AS_NODE;
	const child = spawn(electronPath, [__filename], {
		cwd: path.resolve(__dirname, '..', '..'),
		env: environment,
		stdio: 'inherit',
		windowsHide: true,
	});
	const timeout = setTimeout(() => child.kill(), 30000);
	child.once('exit', code => {
		clearTimeout(timeout);
		process.exitCode = code || 0;
	});
}
