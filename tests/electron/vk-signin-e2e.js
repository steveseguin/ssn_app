'use strict';

// Read-only live VK sign-in check. Never submits credentials or completes login.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-vk-signin-'));
const target = process.env.SIGNIN_ORIGIN_TEST_SOURCE || 'vkvideo';
const disabled = process.env.SIGNIN_ORIGIN_TEST_DISABLED === '1';

(async () => {
    let app;
    try {
        console.log('OUTPUT', out);
        app = await _electron.launch({
            executablePath: require('electron'), cwd: root,
            args: ['.', '--running-from-source', '--multiinstance',
                '--filesource=' + pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href],
            env: { ...process.env, SSAPP_USER_DATA_DIR: path.join(out, 'profile') }, timeout: 60000
        });
        const main = await app.firstWindow();
        assert(await app.evaluate(({ app }) => app.commandLine.hasSwitch('disable-web-security')),
            'The VK fix must preserve the app-wide startup flag');
        await main.waitForFunction(() => window.stateManager?.initialized && configReady);
        await main.evaluate(async ({ target, disabled }) => {
            // A second source key proves this is configuration-driven, not VK-gated code.
            if (target !== 'vkvideo') config[target] = JSON.parse(JSON.stringify(config.vkvideo));
            if (disabled) delete config[target].signin.fillMissingOrigin;
            await newOtherSource(target, 'https://live.vkvideo.ru/brm/only-chat', false, {
                username: 'VK sign-in check', connectionMode: 'classic', sourceFile: 'sources/vkvideo.js'
            });
        }, { target, disabled });
        const sourceId = await main.evaluate(target => stateManager.getSources().find(s => s.target === target).id, target);
        const opened = app.waitForEvent('window');
        opened.catch(() => {});
        await main.evaluate(async id => {
            const button = document.querySelector('[data-source-id="' + id + '"] [data-signin]');
            if (!button) throw new Error('VK source row missing');
            const result = await signin(button, false, { skipMethodChoice: true });
            if (!result) throw new Error('VK sign-in did not create a window');
        }, sourceId);
        const signinPage = await opened;
        await signinPage.waitForURL('https://live.vkvideo.ru/', { waitUntil: 'domcontentloaded' });
        for (let attempt = 0; attempt < 2; attempt++) {
            const loginResponse = main.context().waitForEvent('response', {
                predicate: response => /^https:\/\/login\.vk\.(ru|com)\//.test(response.url())
                    && response.request().method() === 'POST', timeout: 30000
            });
            loginResponse.catch(() => {});
            const popupOpened = app.waitForEvent('window');
            popupOpened.catch(() => {});
            await signinPage.getByRole('button', { name: /^(\u0412\u043e\u0439\u0442\u0438|Log in|Sign in)$/i }).click();
            const popup = await popupOpened;
            await popup.waitForURL(/https:\/\/id\.vk\.(ru|com)\/auth/, { waitUntil: 'domcontentloaded' });
            const response = await loginResponse;
            const headers = await response.request().allHeaders();
            if (disabled) {
                assert.equal(headers.origin, undefined);
                assert.equal((await response.json()).error_code, 'wrong_host');
                await popup.getByText('Invalid URL', { exact: true }).waitFor();
                await popup.close();
                console.log('PASS: source without rule retains original behavior', target);
                break;
            }
            assert.equal(headers.origin, new URL(popup.url()).origin);
            assert.notEqual((await response.json()).error_code, 'wrong_host');
            await popup.locator('input[type="tel"]').waitFor({ timeout: 30000 });
            await popup.waitForTimeout(10000);
            assert(!/Invalid URL/.test(await popup.locator('body').innerText()));
            assert(await popup.locator('input[type="tel"]').isVisible());
            const parentWindow = await app.browserWindow(signinPage);
            const popupWindow = await app.browserWindow(popup);
            assert(await app.evaluate((_, { parentWindow, popupWindow }) =>
                parentWindow.webContents.session === popupWindow.webContents.session,
                { parentWindow, popupWindow }));
            await popup.screenshot({ path: path.join(out, 'login-' + attempt + '.png') });
            await popup.close();
            await main.waitForTimeout(2000);
            console.log('PASS: VK phone sign-in form and shared session, source', target, 'attempt', attempt + 1);
        }
        await signinPage.close();
    } finally {
        if (app) await app.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
