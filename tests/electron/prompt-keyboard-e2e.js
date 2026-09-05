'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const { linuxLaunchArgs } = require('./helpers/electron-launch');

async function run() {
	const root = path.resolve(__dirname, '../..');
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-prompt-keyboard-'));
	let app;
	try {
		app = await _electron.launch({
			executablePath: require('electron'), cwd: root,
			args: ['.', '--running-from-source', '--multiinstance', '--no-hwa',
				`--filesource=${pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href}`, ...linuxLaunchArgs()],
			env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000,
		});
		const main = await app.firstWindow();
		await main.waitForFunction(() => window.stateManager?.initialized);
		const open = async (options = {}) => {
			const next = app.waitForEvent('window');
			await main.evaluate(options => {
				window.__promptResult = 'pending';
				setTimeout(() => { window.__promptResult = ipcRenderer.sendSync('prompt', options); }, 0);
			}, { title: 'Prompt keyboard review', value: 'fixture', ...options });
			const prompt = await next;
			await prompt.waitForFunction(() => document.getElementById('input')?.value === 'fixture');
			return prompt;
		};
		const result = {};
		const closingAction = async (prompt, action) => {
			try { await action(); } catch (error) { if (!prompt.isClosed()) throw error; }
		};
		let prompt = await open({ showShortsCheckbox: true });
		await prompt.locator('#isShorts').focus();
		await closingAction(prompt, () => prompt.locator('#isShorts').press('Escape'));
		await new Promise(resolve => setTimeout(resolve, 250));
		result.escapeFromCheckbox = prompt.isClosed();
		if (!prompt.isClosed()) await closingAction(prompt, () => prompt.getByRole('button', { name: 'Cancel', exact: true }).click());
		await main.waitForFunction(() => window.__promptResult === null);

		prompt = await open();
		// Reproduce the Enter key delivered while an IME is still composing;
		// this exercises the real dialog's event handler and its real IPC response.
		await prompt.locator('#input').dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
			.catch(error => { if (!prompt.isClosed()) throw error; });
		await new Promise(resolve => setTimeout(resolve, 250));
		result.compositionStaysOpen = !prompt.isClosed();
		if (!prompt.isClosed()) await closingAction(prompt, () => prompt.getByRole('button', { name: 'Cancel', exact: true }).click());
		await main.waitForFunction(() => window.__promptResult !== 'pending');

		prompt = await open({ message: Array(45).fill('Detailed instructions for the current prompt.').join('\n'), errorMessage: 'Please check the value.' });
		result.longPromptScrollable = await prompt.evaluate(() => {
			const dialog = document.querySelector('.dialog');
			return ['auto', 'scroll'].includes(getComputedStyle(dialog).overflowY) && dialog.scrollHeight > dialog.clientHeight;
		});
		result.inputNamed = await prompt.locator('#input').evaluate(input => !!input.getAttribute('aria-labelledby'));
		console.log('Prompt review reproduction', JSON.stringify(result));
		assert.strictEqual(await prompt.getByRole('textbox', { name: 'Prompt keyboard review' }).getAttribute('aria-invalid'), 'true');
		await prompt.locator('#input').fill('corrected');
		assert.strictEqual(await prompt.locator('#input').getAttribute('aria-invalid'), null);
		await closingAction(prompt, () => prompt.getByRole('button', { name: 'Cancel', exact: true }).click());
		assert.deepStrictEqual(result, { escapeFromCheckbox: true, compositionStaysOpen: true, longPromptScrollable: true, inputNamed: true });

		prompt = await open({ showShortsCheckbox: true });
		await prompt.locator('#input').fill('confirmed fixture');
		await prompt.locator('#isShorts').check();
		await closingAction(prompt, () => prompt.getByRole('button', { name: 'OK', exact: true }).press('Enter'));
		await main.waitForFunction(() => window.__promptResult?.value === 'confirmed fixture');
		assert.deepStrictEqual(await main.evaluate(() => window.__promptResult), { value: 'confirmed fixture', isShorts: true });
		prompt = await open();
		await prompt.locator('#input').fill('plain response');
		await closingAction(prompt, () => prompt.locator('#input').press('Enter'));
		await main.waitForFunction(() => window.__promptResult === 'plain response');
		console.log('Prompt keyboard Electron E2E passed.');
	} finally {
		if (app) await app.close();
		const resolved = path.resolve(profile);
		if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ssapp-prompt-keyboard-')) {
			throw new Error('Unexpected prompt test profile path.');
		}
		fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
