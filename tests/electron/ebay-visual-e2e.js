'use strict';

// Live, read-only visual verification in the actual SSApp runtime.
// No chat messages or auction actions are sent. Override EBAY_TEST_SELLER if offline.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const sellerId = process.env.EBAY_TEST_SELLER || 'lvg7xttgtam';
assert(/^[a-zA-Z0-9_-]+$/.test(sellerId));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-ebay-visual-'));
const profile = path.join(output, 'profile');
fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({ streamID: 'ebay_visual_' + Date.now(), password: 'false', state: true, settings: {} }));
const report = { sellerId, screenshots: [], captures: [], checks: [] };

async function launch() {
    const app = await _electron.launch({ executablePath: require('electron'), cwd: root,
        args: ['.', '--running-from-source', '--multiinstance', '--filesource=' + pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href],
        env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000 });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.stateManager?.initialized && configReady);
    const window = await app.browserWindow(page);
    await window.evaluate(win => win.setSize(1280, 900));
    return { app, page, window };
}

(async () => {
    let app, page, window;
    const shot = async (name, target = page) => {
        const filename = path.join(output, name + '.png');
        await target.screenshot({ path: filename });
        report.screenshots.push(filename);
        console.log('SCREENSHOT', filename);
    };
    try {
        ({ app, page, window } = await launch());
        await page.locator('[data-source-type="ebay"]').click();
        await shot('01-setup');
        await page.locator('#ebay-live-input').fill('https://example.com/not-ebay');
        await page.locator('#ebay-continue').click();
        await page.locator('#ebay-status').filter({ hasText: 'Use an eBay Live link' }).waitFor();
        await shot('02-invalid-link');
        await page.locator('#ebay-live-input').fill('https://www.ebay.com/ebaylive/sellers/' + sellerId);
        await page.locator('#ebay-continue').click();
        await page.waitForFunction(() => document.querySelectorAll('.ebay-event').length >= 2, null, { timeout: 30000 });
        report.events = await page.locator('.ebay-event').allTextContents();
        await page.waitForTimeout(1500); // Let thumbnail images paint.
        await shot('03-live-picker');
        await page.locator('.ebay-event').last().scrollIntoViewIfNeeded();
        await shot('04-picker-bottom');
        await window.evaluate(win => win.setSize(1024, 768));
        await page.locator('#ebay-live-input').scrollIntoViewIfNeeded();
        assert(await page.locator('.ebay-setup').evaluate(el => el.scrollWidth <= el.clientWidth), 'compact modal overflows horizontally');
        await shot('05-compact-picker');
        await window.evaluate(win => win.setSize(1280, 900));
        await page.locator('.ebay-event').first().click();
        await page.waitForFunction(() => stateManager.getSources().some(s => s.target === 'ebay'));
        const source = await page.evaluate(() => stateManager.getSources().find(s => s.target === 'ebay'));
        const sourceId = source.id;
        const row = () => page.locator(`[data-source-id="${sourceId}"]`);
        assert.equal(await row().getAttribute('inert'), null);
        await shot('06-saved-source');

        async function activateAndCapture(label) {
            const bg = page.frames().find(frame => frame.url().includes('background.html'));
            await bg.evaluate(() => {
                window.__ebayVisualCaptures = [];
                if (window.__ebayVisualHook) return;
                window.__ebayVisualHook = true;
                const original = processIncomingMessage;
                window.processIncomingMessage = function (data) {
                    if (data.type === 'ebay') window.__ebayVisualCaptures.push({ event: data.event || 'chat',
                        sourceMode: data.meta?.sourceMode, title: data.meta?.title,
                        listingId: data.meta?.ebay?.listingId, graph: !!data.meta?.ebay?.listing?.listing });
                    return original.apply(this, arguments);
                };
            });
            await row().locator('[data-activatehtml]').press('Enter');
            await page.waitForFunction(id => !!stateManager.getSource(id)?.vid, sourceId);
            const current = await page.evaluate(id => stateManager.getSource(id), sourceId);
            await bg.waitForFunction(() => window.__ebayVisualCaptures.some(e => e.event === 'auction_update' && e.graph), null, { timeout: 45000 });
            report.captures.push({ label, eventId: current.videoId, rows: await bg.evaluate(() => window.__ebayVisualCaptures) });
            const capture = app.windows().find(p => p.url() === current.url);
            assert(capture, 'actual source window missing');
            await shot(label + '-capture-window', capture);
            await page.bringToFront();
            await shot(label + '-active-source');
            return capture;
        }

        const firstCapture = await activateAndCapture('07-first-event');
        await row().locator('.settings-btn').click();
        await shot('08-source-settings');
        await row().locator('[data-ebay-choose-stream]').click();
        await page.waitForFunction(() => document.querySelectorAll('.ebay-event').length >= 2);
        await shot('09-change-event');
        await page.locator('.ebay-event').nth(1).click();
        await page.waitForFunction(({ id, previous }) => stateManager.getSource(id)?.videoId !== previous && stateManager.getSource(id)?.status === 'inactive', { id: sourceId, previous: source.videoId });
        assert(firstCapture.isClosed(), 'old capture window was not closed');
        await shot('10-changed-source');
        await activateAndCapture('11-second-event');
        await row().locator('[data-stophtml]').click();
        const selected = await page.evaluate(id => stateManager.getSource(id), sourceId);
        await app.close();
        ({ app, page, window } = await launch());
        const saved = await page.evaluate(id => stateManager.getSource(id), sourceId);
        assert.equal(saved.videoId, selected.videoId);
        assert.equal(saved.ebaySellerId, sellerId);
        assert.equal(saved.url, selected.url);
        await shot('12-after-restart');
        // Separate direct-event route, normalized without selecting a seller.
        await page.locator('[data-source-type="ebay"]').click();
        await page.locator('#ebay-live-input').fill(source.url.replace('/chat', '/stream') + '?tracking=visual#chat');
        await shot('13-direct-event-input');
        await page.locator('#ebay-continue').click();
        await page.waitForFunction(eventId => stateManager.getSources().some(s => s.videoId === eventId), source.videoId);
        const direct = await page.evaluate(eventId => stateManager.getSources().find(s => s.videoId === eventId), source.videoId);
        assert.equal(direct.url, source.url);
        await shot('14-direct-event-added');
        report.checks = ['invalid URL rejected', 'multiple real live streams selectable', 'compact layout has no horizontal overflow',
            'source activates from the UI', 'both selected events produce GraphQL auction snapshots', 'changing event closes old capture',
            'selected event survives a process restart', 'direct /stream URL normalizes to /chat'];
        console.log('PASS', JSON.stringify(report.checks));
    } catch (error) {
        report.error = error.message;
        if (page && !page.isClosed()) await shot('failure').catch(() => {});
        throw error;
    } finally {
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
        console.log('REPORT', path.join(output, 'report.json'));
        if (app) await app.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
