'use strict';

// Run with a desktop: node tests/electron/twitch-oauth-error-e2e.js
// Real source -> loopback OAuth callback -> status bridge -> main-window toast.
// Only the hosted login page is a fixture. No real account or executable payload.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

const root = path.resolve(__dirname, '../..');
const sourceRoot = path.resolve(root, '../social_stream');
const marker = 'SSAPP_CALLBACK_MARKER <b data-ssapp-callback-marker>literal</b> &amp; <notes> "quotes" \'apostrophe\' \u65e5\u672c\u8a9e';

async function until(check, label) {
	const start = Date.now();
	while (Date.now() - start < 60000) {
		const result = await check();
		if (result) return result;
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error(`Timed out: ${label}`);
}

async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-oauth-error-e2e-'));
	const report = { profile, checks: [] };
	let callbackUrl = '';
	let attempt = 0;
	let app;
	let log;
	const server = http.createServer((_request, response) => {
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.setHeader('Cache-Control', 'no-store');
		response.end('<!doctype html><title>Local callback fixture</title><a id="local-check" href="'
			+ callbackUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">Open fixture response</a>');
	});
	try {
		await new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		const env = { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_DEBUG_LOGS: '0' };
		delete env.ELECTRON_RUN_AS_NODE;
		app = await _electron.launch({
			executablePath: require('electron'), cwd: root,
			args: ['.', '--multiinstance', '--running-from-source', '--disable-logs',
				`--filesource=${pathToFileURL(sourceRoot + path.sep).href}`, ...linuxLaunchArgs()],
			env, timeout: 60000,
		});
		log = fs.createWriteStream(path.join(profile, 'app.log'));
		app.process().stdout.pipe(log, { end: false });
		app.process().stderr.pipe(log, { end: false });
		await app.context().route('https://sso.socialstream.ninja/**', route => route.fulfill({
			contentType: 'text/html', body: '<title>Pending fixture login</title><p>Local test; do not sign in.</p>',
		}));
		const main = await app.firstWindow();
		const mainReady = () => main.waitForFunction(() =>
			typeof configReady !== 'undefined' && configReady && window.stateManager?.initialized);
		await mainReady();
		const sourceId = await main.evaluate(() => stateManager.addSource({
			id: 'oauth-error-local-fixture', target: 'twitch', username: 'ssn_local_fixture',
			url: 'https://www.twitch.tv/ssn_local_fixture', connectionMode: 'websocket',
			isVisible: true, isMuted: true, autoActivate: false, supportsWSS: true,
			sourceFile: 'sources/websocket/twitch.js',
		}));
		await main.locator(`[data-source-id="${sourceId}"]`).waitFor();
		await main.evaluate(async id => {
			const entry = document.querySelector(`[data-source-id="${id}"]`);
			await createWindow(entry.querySelector('[data-activatehtml]'));
		}, sourceId);
		const source = await until(() => app.context().pages().find(page =>
			/\/sources\/websocket\/twitch\.html/.test(page.url())), 'Twitch source');
		const cdp = await source.context().newCDPSession(source);
		await until(async () => {
			const result = await cdp.send('Runtime.evaluate', {
				expression: 'typeof ssWssNotifyTwitch === "function" && !!window.chrome?.runtime', returnByValue: true,
			});
			return result.result.value;
		}, 'source ready');

		const fixtureUrl = `http://127.0.0.1:${server.address().port}/independent-webpage`;
		await app.evaluate(async ({ BrowserWindow }, url) => {
			global.__oauthErrorFixtureWindow = new BrowserWindow({
				width: 600, height: 250, show: true,
				webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
					partition: 'oauth-error-e2e-fixture' },
			});
			await global.__oauthErrorFixtureWindow.loadURL(url);
		}, fixtureUrl);
		const webpage = await until(() => app.context().pages().find(page => page.url() === fixtureUrl), 'fixture');
		assert.deepStrictEqual(await webpage.evaluate(() => ({ node: typeof require, bridge: typeof ninjafy })),
			{ node: 'undefined', bridge: 'undefined' });

		async function startLogin() {
			await main.locator(`[data-source-id="${sourceId}"]`).waitFor();
			await main.evaluate(async id => {
				const entry = document.querySelector(`[data-source-id="${id}"]`);
				await openTwitchBotAccountSettings(entry.querySelector('[data-twitch-bot-account]'));
			}, sourceId);
			await main.locator('#twitch-bot-account-connect').click();
			return until(() => app.context().pages().find(page =>
				page.url().startsWith('https://sso.socialstream.ninja/auth/twitch/start')), 'bot login window');
		}

		async function checkError(auth, expected, label, autoDismiss = false) {
			await main.waitForFunction(({ id, expected }) =>
				stateManager.getSource(id)?.twitchBotAccountError?.includes(expected), { id: sourceId, expected });
			const toast = main.locator('#toastContainer .toast-error').filter({ hasText: expected }).last();
			await toast.waitFor({ state: 'visible' });
			const state = await main.evaluate(id => {
				const source = stateManager.getSource(id);
				return { error: source.twitchBotAccountError, connecting: source.twitchBotAccountConnecting,
					connected: source.twitchBotAccountConnected };
			}, sourceId);
			assert.equal(await toast.locator('.toast-title').textContent(), state.error, 'Error must stay literal');
			assert.equal(await toast.locator('.toast-title *').count(), 0, 'Error must not create HTML elements');
			assert.equal(await toast.locator('.toast-message').textContent(), 'Twitch reply account');
			assert.equal(state.connecting, false);
			assert.equal(state.connected, false);
			await until(() => auth.isClosed(), 'login window cleanup');
			if (!autoDismiss) await toast.locator('.toast-close').click();
			await toast.waitFor({ state: 'detached', timeout: 15000 });
			report.checks.push(label);
			console.log(`PASS: ${label}`);
		}

		async function deliverCallback(url, auth) {
			const callback = new URL(url);
			callback.searchParams.set('fixture_attempt', String(++attempt));
			callbackUrl = callback.toString();
			// Each login creates a fresh listener on the same port. Do not reuse
			// the fixture browser's keep-alive connection to a completed session.
			await app.evaluate(async () => {
				await global.__oauthErrorFixtureWindow.webContents.session.closeAllConnections();
			});
			await webpage.goto(`${fixtureUrl}?attempt=${attempt}`);
			await webpage.bringToFront();
			await webpage.locator('#local-check').click();
			await webpage.waitForURL(callbackUrl);
			await until(() => auth.isClosed(), 'callback handled');
			// The callback response closes its browser window after three seconds.
			// Leave it once the request finishes so the fixture is reusable.
			await webpage.goto(`${fixtureUrl}?done=${attempt}`);
		}

		async function checkUnrelatedCallback(label) {
			const auth = await startLogin();
			const returnUrl = new URL(new URL(auth.url()).searchParams.get('return_to'));
			await deliverCallback(`http://127.0.0.1:${returnUrl.port}/unrelated-error-path?error=cancelled&error_description=${encodeURIComponent(marker)}`, auth);
			await checkError(auth, marker, label);
		}

		await checkUnrelatedCallback('Untrusted callback renders literally; raw error and dismiss button preserved');
		await checkUnrelatedCallback('Repeated login and error delivery remain safe');

		const cancelled = await startLogin();
		await cancelled.close();
		await checkError(cancelled, 'Twitch bot account sign-in was closed.', 'Window-close cancellation and toast timeout work', true);

		const denied = await startLogin();
		const returnUrl = new URL(new URL(denied.url()).searchParams.get('return_to'));
		const denial = 'Authorization declined: Steve\'s account & permissions';
		returnUrl.hash = new URLSearchParams({ twitch_auth_error: Buffer.from(JSON.stringify({
			error: 'access_denied', message: denial,
		})).toString('base64url') }).toString();
		await deliverCallback(returnUrl.toString(), denied);
		await checkError(denied, denial, 'Supported provider-error landing page still reports its error');

		await main.reload();
		await mainReady();
		assert(await main.evaluate(id => !!stateManager.getSource(id), sourceId), 'Source must survive reload');
		await checkUnrelatedCallback('Login retry after main-window reload remains safe');
		console.log('PASS: Real Electron Twitch OAuth error regression; no real credentials or executable markup used.');
	} catch (error) {
		report.error = error.stack;
		console.error(error.stack);
		process.exitCode = 1;
	} finally {
		if (app) await app.close().catch(() => {});
		if (log) await new Promise(resolve => log.end(resolve));
		server.closeAllConnections();
		if (server.listening) await new Promise(resolve => server.close(resolve));
		fs.writeFileSync(path.join(profile, 'result.json'), JSON.stringify(report, null, 2));
		console.log(`Isolated test evidence: ${path.join(profile, 'result.json')}`);
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
