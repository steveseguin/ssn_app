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
                    if (input.ids) {
                        const id = input.ids[0];
                        if (id === 'DelayedEvent') await new Promise(resolve => setTimeout(resolve, 1000));
                        if (id === 'UnavailableEvent') return { status: 503, data: '{}' };
                        if (id === 'ChallengeEvent') return { status: 200, data: '<html>Verify your browser</html>' };
                        return { status: 200, data: JSON.stringify({ data: { liveEvents: {
                            events: id === 'MissingEvent' ? [] : [{ id, title: 'Event ' + id, state: 'RECORDED' }]
                        } } }) };
                    }
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
        await input.fill('MissingEvent');
        await proceed.click();
        await status.filter({ hasText: 'event not found' }).waitFor();
        assert.equal(await page.evaluate(() => stateManager.getSources().length), 0);
        await input.fill('UnavailableEvent');
        await proceed.click();
        await status.filter({ hasText: 'Could not verify' }).waitFor();
        await input.fill('ChallengeEvent');
        await proceed.click();
        await status.filter({ hasText: 'Could not verify' }).waitFor();
        assert.equal(await page.evaluate(() => stateManager.getSources().length), 0);
        await input.fill('DelayedEvent');
        await proceed.click();
        await input.fill('EditedEvent');
        await page.waitForTimeout(1200);
        assert.equal(await status.textContent(), '');
        assert.equal(await page.evaluate(() => stateManager.getSources().length), 0, 'stale validation must not save an edited input');
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
        const requests = await app.evaluate(() => global.ebayFixtureRequests.filter(r => r.body.variables.liveEventsInput.sellerId));
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
        // Saved sources (including old imports) must also validate on activation.
        const missing = await page.evaluate(async () => {
            await newOtherSource('ebay', 'https://www.ebay.com/ebaylive/events/MissingEvent/chat', false,
                { username: 'Missing event', videoId: 'MissingEvent', connectionMode: 'classic' });
            return stateManager.getSources().find(s => s.videoId === 'MissingEvent');
        });
        const missingRow = page.locator(`[data-source-id="${missing.id}"]`);
        await missingRow.locator('[data-activatehtml]').press('Enter');
        await page.waitForFunction(id => stateManager.getSource(id)?.status === 'error', missing.id);
        const failed = await page.evaluate(id => stateManager.getSource(id), missing.id);
        assert.match(failed.error, /event not found/);
        assert(!failed.vid, 'invalid saved event must not open a blank capture window');
        assert((await missingRow.textContent()).includes('event not found'), 'activation feedback must remain visible');
        await page.evaluate(id => stateManager.updateSource(id, { url: 'https://www.ebay.com/ebaylive/events/DirectEvent/chat', videoId: 'DirectEvent' }), missing.id);
        await missingRow.locator('[data-activatehtml]').press('Enter');
        await page.waitForFunction(id => !!stateManager.getSource(id)?.vid, missing.id);
        await missingRow.locator('[data-stophtml]').click();
        await page.evaluate(id => stateManager.updateSource(id, { url: 'https://www.ebay.com/ebaylive/events/DelayedEvent/chat', videoId: 'DelayedEvent' }), missing.id);
        await missingRow.locator('[data-activatehtml]').press('Enter');
        await page.waitForFunction(id => stateManager.getSource(id)?.status === 'activating', missing.id);
        await missingRow.locator('[data-stophtml]').evaluate(el => stopThis(el));
        await page.waitForTimeout(1200);
        assert.equal(await page.evaluate(id => stateManager.getSource(id)?.status, missing.id), 'inactive');
        assert.equal(await page.evaluate(id => !!stateManager.getSource(id)?.vid, missing.id), false, 'stopped validation must not create a window');

        // Every existing eBay manifest host must preserve its marketplace.
        const domainChecks = await page.evaluate(() => {
            const hosts = manifest.content_scripts.filter(s => s.js.includes('./sources/ebay.js'))
                .flatMap(s => s.matches).filter(u => u.includes('/ebaylive/events/')).map(u => new URL(u).hostname);
            return hosts.map(host => ({ host, origin: getEbayLiveOrigin('https://' + host + '/ebaylive/events/Test/chat'),
                bare: parseEbayLiveInput('https://' + host.replace(/^www\./, '') + '/ebaylive/events/Test/chat').origin }));
        });
        assert(domainChecks.length >= 21);
        for (const check of domainChecks) {
            assert.equal(check.origin, 'https://' + check.host);
            assert.equal(check.bare, check.origin);
        }
        assert.equal(await page.evaluate(() => { try { getEbayLiveOrigin('https://ebay.ca.evil.example/'); return false; } catch (_) { return true; } }), true);
        for (const host of ['cafr.ebay.ca', 'befr.ebay.be', 'benl.ebay.be']) {
            assert.equal(await page.evaluate(host => getEbayLiveOrigin('https://www.' + host), host), 'https://' + host);
        }

        // Real Sign-in buttons, IPC and BrowserWindows, with local page fixtures.
        await app.context().route(/^https:\/\/(?:www\.|cafr\.|befr\.|benl\.)?ebay\.[^/]+\/$/,
            route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Regional eBay sign-in</title><p>Sign-in fixture</p>' }));
        for (const host of ['www.ebay.co.uk', 'www.ebay.com.au', 'www.ebay.ca', 'cafr.ebay.ca', 'befr.ebay.be', 'www.ebay.com.hk']) {
            await page.evaluate(({ id, host }) => stateManager.updateSource(id, { url: 'https://' + host + '/ebaylive/events/DirectEvent/chat' }), { id: missing.id, host });
            const opened = app.waitForEvent('window');
            await missingRow.locator('[data-signin]').click();
            const signin = await opened;
            await signin.waitForURL('https://' + host + '/');
            await signin.getByText('Sign-in fixture').waitFor();
            const win = await app.browserWindow(signin);
            await win.evaluate(w => w.close());
        }
        // Restart the process, not just the renderer, to validate saved selection.
        await app.close();
        ({ app, page } = await launch());
        const saved = await page.evaluate(id => stateManager.getSource(id), selected.id);
        assert.equal(saved.videoId, 'FixtureEventOne');
        assert.equal(saved.ebaySellerId, 'FixtureSeller');
        assert.equal(saved.url, changed.url);
        assert.equal(saved.sourceFile, 'sources/ebay.js');
        assert(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).build.files.includes('ebay.js'));
        console.log('PASS: eBay event validation/retry/cancellation, regional sign-in windows, manifest host parity, seller picker, source activation/replacement and process-restart persistence.');
        console.log('Screenshot: ' + path.join(profile, 'seller-picker.png'));
    } finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
