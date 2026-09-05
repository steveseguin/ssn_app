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
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-bulk-state-'));
	let app;
	try {
		const launchOptions = {
			executablePath: require('electron'), cwd: root,
			args: ['.', '--running-from-source', '--multiinstance', '--no-hwa',
				`--filesource=${pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href}`, ...linuxLaunchArgs()],
			env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000,
		};
		app = await _electron.launch(launchOptions);
		let page = await app.firstWindow();
		await page.waitForFunction(() => window.stateManager?.initialized);
		for (const clearAll of [false, true]) {
			const result = await page.evaluate(async clearAll => {
				await clearAllSources();
				const groupId = stateManager.addGroup({ target: 'custom', username: 'bulk_fixture', autoActivate: false });
				for (let i = 0; i < 40; i++) stateManager.addSource({ target: 'custom', username: `bulk_fixture_${i}`, groupId, autoActivate: false });
				const survivor = stateManager.addSource({ target: 'custom', username: 'survivor', autoActivate: false });
				const original = Storage.prototype.setItem;
				let writes = 0;
				let bytes = 0;
				let removed = 0;
				const unsubscribe = stateManager.on('sourceRemoved', () => { removed++; });
				Storage.prototype.setItem = function (key, value) {
					if (this === localStorage && ['settings', 'socialStreamState'].includes(key)) {
						writes++;
						bytes += String(value).length;
					}
					return original.call(this, key, value);
				};
				try {
					if (clearAll) await clearAllSources();
					else await deleteThis(document.querySelector(`[data-group-id="${groupId}"]`));
				} finally {
					Storage.prototype.setItem = original;
					unsubscribe();
				}
				return { writes, bytes, removed, survivor,
					sources: stateManager.getSources().map(source => source.id),
					groups: stateManager.getGroups().length,
					rows: document.querySelectorAll('#sources [data-source-id]').length,
					saved: JSON.parse(localStorage.getItem('socialStreamState')),
					legacy: JSON.parse(localStorage.getItem('settings')) };
			}, clearAll);
			console.log('Bulk deletion measurement', JSON.stringify({ clearAll, writes: result.writes, bytes: result.bytes }));
			assert.strictEqual(result.removed, clearAll ? 41 : 40);
			assert.strictEqual(result.groups, 0);
			assert.deepStrictEqual(result.sources, clearAll ? [] : [result.survivor]);
			assert.strictEqual(result.rows, clearAll ? 0 : 1);
			assert.strictEqual(result.saved.sources.length, clearAll ? 0 : 1);
			assert.strictEqual(result.saved.groups.length, 0);
			assert.strictEqual(result.legacy.urls.length, clearAll ? 0 : 1);
			assert.strictEqual(result.legacy.groups.length, 0);
			assert.strictEqual(result.writes, 2, 'Bulk deletion should save each settings format once.');
			await page.reload();
			await page.waitForFunction(() => window.stateManager?.initialized);
			assert.deepStrictEqual(await page.evaluate(() => stateManager.getSources().map(source => source.id)), result.sources);
		}
		const groupId = await page.evaluate(() => stateManager.addGroup({
			target: 'custom', username: 'empty_group_fixture', customSession: 'group-session-fixture',
			userAgent: 'group-agent-fixture', autoActivate: false
		}));
		await page.reload();
		await page.waitForFunction(() => window.stateManager?.initialized);
		const emptyGroup = await page.evaluate(id => stateManager.getGroup(id), groupId);
		console.log('Empty group reload reproduction', JSON.stringify(emptyGroup));
		assert.strictEqual(emptyGroup.customSession, 'group-session-fixture', 'Reload replaced the empty group with its incomplete legacy copy.');
		assert.strictEqual(emptyGroup.userAgent, 'group-agent-fixture');
		assert.deepStrictEqual(emptyGroup.streams, []);
		await app.close();
		app = await _electron.launch(launchOptions);
		page = await app.firstWindow();
		await page.waitForFunction(() => window.stateManager?.initialized);
		assert.strictEqual(await page.evaluate(id => stateManager.getGroup(id)?.customSession, groupId), 'group-session-fixture', 'Group session did not survive a full app restart.');
		const sessionSourceId = await page.evaluate(groupId => {
			localStorage.setItem('customSessions', JSON.stringify([{ name: 'removed-session' }, { name: 'kept-session' }]));
			stateManager.updateGroup(groupId, { customSession: 'removed-session' });
			const historical = stateManager.addSource({ target: 'custom', username: 'historical_session_fixture', customSession: 'removed-session' });
			stateManager.removeSource(historical);
			stateManager.addSource({ target: 'custom', username: 'kept_session_fixture', customSession: 'kept-session' });
			return stateManager.addSource({ target: 'custom', username: 'session_dialog_fixture', customSession: 'removed-session' });
		}, groupId);
		await page.locator(`[data-source-id="${sessionSourceId}"]`).waitFor({ state: 'attached' });
		await page.evaluate(id => openSessionSettings(document.querySelector(`[data-source-id="${id}"]`)), sessionSourceId);
		page.once('dialog', dialog => dialog.accept());
		await page.locator('.session-item[data-session-value="removed-session"] .session-remove-btn').click();
		const removedSession = await page.evaluate(groupId => {
			const readded = stateManager.addSource({ target: 'custom', username: 'historical_session_fixture' });
			return { groupSession: stateManager.getGroup(groupId).customSession,
				readdedSession: stateManager.getSource(readded).customSession || 'AUTO',
				keptSession: stateManager.getSource('custom-user-kept_session_fixture').customSession };
		}, groupId);
		console.log('Removed session reproduction', removedSession);
		assert.strictEqual(removedSession.groupSession, 'default-custom', 'Group retained a removed session.');
		assert.strictEqual(removedSession.readdedSession, 'AUTO', 'Remembered bindings resurrected a removed session.');
		assert.strictEqual(removedSession.keptSession, 'kept-session');
		await page.locator('.session-item[data-session-value="kept-session"]').click();
		await page.locator('#sessionModal').getByRole('button', { name: 'Save', exact: true }).click();
		await page.evaluate(id => openSessionSettings(document.querySelector(`[data-source-id="${id}"]`)), sessionSourceId);
		const defaultOption = page.locator('.session-item[data-session-value="default-custom"]');
		assert.strictEqual(await defaultOption.count(), 1, 'Custom-platform sources have no way to select their default session.');
		await defaultOption.focus();
		await page.keyboard.press('Enter');
		assert.strictEqual(await defaultOption.getAttribute('aria-pressed'), 'true');
		await page.locator('#sessionModal').getByRole('button', { name: 'Save', exact: true }).click();
		await page.reload();
		await page.waitForFunction(() => window.stateManager?.initialized);
		assert.strictEqual(await page.evaluate(id => stateManager.getSource(id).customSession, sessionSourceId), 'default-custom');
		await page.evaluate(() => closeSessionModal());
		await page.evaluate(async () => {
			await clearAllSources();
			localStorage.setItem('settings', JSON.stringify({ urls: [{ target: 'custom', username: 'stale_fixture', state: {} }], groups: [] }));
		});
		await page.reload();
		await page.waitForFunction(() => window.stateManager?.initialized);
		assert.strictEqual(await page.evaluate(() => stateManager.getSources().length), 0, 'Legacy data repopulated an intentionally empty current configuration.');
		// A genuinely legacy profile must still migrate when no modern state exists.
		await page.evaluate(() => {
			localStorage.removeItem('socialStreamState');
			localStorage.setItem('settings', JSON.stringify({ urls: [{ target: 'custom', username: 'legacy_fixture', URL: '', state: {} }], groups: [] }));
		});
		await page.reload();
		await page.waitForFunction(() => window.stateManager?.initialized);
		assert.ok(await page.evaluate(() => !!stateManager.getSource('custom-user-legacy_fixture')), 'Legacy-only profile did not migrate.');
		console.log('Bulk deletion, empty group preservation, and legacy migration Electron E2E passed.');
	} finally {
		if (app) await app.close();
		const resolved = path.resolve(profile);
		if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ssapp-bulk-state-')) throw new Error('Unexpected bulk test profile path.');
		fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
}

run().catch(error => { console.error(error); process.exitCode = 1; });
