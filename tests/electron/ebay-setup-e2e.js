'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-ebay-setup-'));

async function launch() {
    const app = await _electron.launch({ executablePath: require('electron'), cwd: root,
        args: ['.', '--running-from-source', '--multiinstance', '--no-hwa',
            '--filesource=' + pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href],
        env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000 });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.stateManager?.initialized && typeof configReady !== 'undefined' && configReady);
    await page.waitForFunction(() => typeof showEbayAddSourcePrompt === 'function');
    return { app, page };
}

(async () => {
    let app;
    try {
        let page;
        ({ app, page } = await launch());
        // Fixture only replaces the public discovery response; the real app's
        // modal, IPC call, source creation, windows and persistence all run.
        await app.evaluate(({ ipcMain, net }) => {
            const fetch = net.fetch.bind(net);
            global.ebayFixtureRequests = [];
            global.ebayFailureCount = 0;
            ipcMain.removeHandler('nodefetch');
            ipcMain.handle('nodefetch', async (_, args) => {
                if (args.url === 'https://www.ebay.com/ebaylive/graphql') {
                    global.ebayFixtureRequests.push(args);
                    const input = args.body.variables.liveEventsInput;
                    if (input.sellerId === 'DelayedSeller') await new Promise(resolve => setTimeout(resolve, 1000));
                    if (input.sellerId === 'FailSeller' && !global.ebayFailureCount++) return { status: 503, data: '{}' };
                    const event = (id, title, state = 'LIVE', sellerId = input.sellerId) => ({
                        id, title, state, watchedCount: 92, hosts: [{ id: sellerId, userAccountName: 'fixture_seller' }],
                        previewImage: { url: 'https://i.ebayimg.com/fixture.png' }
                    });
                    const events = input.sellerId === 'FixtureSeller' ? (input.pagination.pageCursor ?
                        [event('FixtureEventTwo', 'Luna · $2 healing crystals')] :
                        [event('FixtureEventOne', 'Sol · healing crystals'), event('EndedEvent', 'Ended auction', 'ENDED'), event('ForeignEvent', 'Other seller', 'LIVE', 'SomeoneElse')]) : [];
                    return { status: 200, data: JSON.stringify({ data: { liveEvents: { events,
                        nextPageCursor: input.sellerId === 'FixtureSeller' && !input.pagination.pageCursor ? 'page-two' : null } } }) };
                }
                const response = await fetch(args.url, { method: args.method || 'GET', headers: args.headers,
                    body: args.method === 'POST' ? JSON.stringify(args.body) : undefined });
                return { status: response.status, data: await response.text() };
            });
        });
        await app.context().route('https://www.ebay.com/ebaylive/events/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>eBay capture fixture</title><p>Chat capture window</p>' }));
        await app.context().route('https://i.ebayimg.com/fixture.png', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="80"><rect width="64" height="80" fill="#427999"/></svg>' }));
        const open = () => page.locator('[data-source-type="ebay"]').click();
        const input = page.locator('#ebay-live-input');
        const proceed = page.locator('#ebay-continue');
        const status = page.locator('#ebay-status');
        await open();
        await proceed.click();
        await status.filter({ hasText: 'Enter an eBay Live' }).waitFor();
        await input.fill('https://ebay.com.evil.example/ebaylive/events/Bad');
        await proceed.click();
        await status.filter({ hasText: 'Use an eBay Live link' }).waitFor();
        await input.fill('https://www.ebay.com/ebaylive/events/DirectEvent/stream?tracking=1#chat');
        await proceed.click();
        await page.locator('.ebay-setup').waitFor({ state: 'detached' });
        let direct = await page.evaluate(() => stateManager.getSources().find(s => s.videoId === 'DirectEvent'));
        assert.equal(direct.url, 'https://www.ebay.com/ebaylive/events/DirectEvent/chat');
        assert.equal(direct.connectionMode, 'classic');
        await open();
        await input.fill('FixtureSeller');
        await page.locator('#ebay-id-type').selectOption('seller');
        await proceed.click();
        await page.locator('.ebay-event').filter({ hasText: 'Luna' }).waitFor();
        assert.equal(await page.locator('.ebay-event').count(), 2);
        assert.equal(await page.locator('.ebay-setup').evaluate(el => el.scrollWidth <= el.clientWidth), true);
        await page.screenshot({ path: path.join(profile, 'seller-picker.png') });
        await page.locator('.ebay-event').filter({ hasText: 'Luna' }).click();
        await page.locator('.ebay-setup').waitFor({ state: 'detached' });
        const selected = await page.evaluate(() => stateManager.getSources().find(s => s.videoId === 'FixtureEventTwo'));
        assert.equal(selected.ebaySellerId, 'FixtureSeller');
        assert.equal(selected.username, 'Luna · $2 healing crystals');
        const requests = await app.evaluate(() => global.ebayFixtureRequests);
        assert.deepEqual(requests[0].body.variables.liveEventsInput.states, ['LIVE']);
        assert.equal(requests[1].body.variables.liveEventsInput.pagination.pageCursor, 'page-two');
        assert.equal(requests[0].body.variables.includeVideoPreview, false);
        // Actual activation opens a properly configured SSApp source window.
        const row = page.locator(`[data-source-id="${selected.id}"]`);
        assert.equal(await row.getAttribute('inert'), null, 'new source must not inherit the modal-disabled template state');
        await row.locator('[data-activatehtml]').press('Enter');
        await page.waitForFunction(id => !!stateManager.getSource(id)?.vid, selected.id);
        await row.locator('.settings-btn').click();
        await row.locator('[data-ebay-choose-stream]').click();
        await page.locator('.ebay-event').filter({ hasText: 'Sol' }).waitFor();
        await page.locator('.ebay-event').filter({ hasText: 'Sol' }).click();
        await page.locator('.ebay-setup').waitFor({ state: 'detached' });
        const changed = await page.evaluate(id => stateManager.getSource(id), selected.id);
        assert.equal(changed.videoId, 'FixtureEventOne');
        assert.equal(changed.url, 'https://www.ebay.com/ebaylive/events/FixtureEventOne/chat');
        assert(!changed.vid, 'changing event must stop the old source');
        assert.equal(changed.status, 'inactive');
        await open();
        await input.fill('https://www.ebay.com/ebaylive/sellers/EmptySeller');
        await proceed.click();
        await status.filter({ hasText: 'No live streams found' }).waitFor();
        await input.fill('https://www.ebay.com/ebaylive/sellers/FailSeller');
        await proceed.click();
        await status.filter({ hasText: 'Could not load' }).waitFor();
        await page.locator('#ebay-refresh').click();
        await status.filter({ hasText: 'No live streams found' }).waitFor();
        await input.fill('https://www.ebay.com/ebaylive/sellers/DelayedSeller');
        await proceed.click();
        await input.fill('NewDirectEvent');
        await page.locator('#ebay-id-type').selectOption('event');
        await page.waitForTimeout(1200);
        assert.equal(await status.textContent(), '', 'stale discovery must not overwrite edited input');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.ebay-setup').count(), 0);
        assert.equal(await page.locator('body > [inert]').count(), 0);
        // Restart the process, not just the renderer, to validate saved selection.
        await app.close();
        ({ app, page } = await launch());
        const saved = await page.evaluate(id => stateManager.getSource(id), selected.id);
        assert.equal(saved.videoId, 'FixtureEventOne');
        assert.equal(saved.ebaySellerId, 'FixtureSeller');
        assert.equal(saved.url, changed.url);
        assert.equal(saved.sourceFile, 'sources/ebay.js');
        assert(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).build.files.includes('ebay.js'));
        console.log('PASS: eBay setup validation, direct URL normalization, seller pagination/picker, actual source activation, event replacement, errors/refresh, stale requests, Escape and process-restart persistence.');
        console.log('Screenshot: ' + path.join(profile, 'seller-picker.png'));
    } finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
