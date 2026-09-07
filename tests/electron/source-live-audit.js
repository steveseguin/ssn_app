'use strict';
// Read-only real SSApp source-window audit. Supply a JSON case list via
// SSAPP_AUDIT_CASES; no login, messages, reactions, bids or purchases are made.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const cases = JSON.parse(fs.readFileSync(process.env.SSAPP_AUDIT_CASES, 'utf8').replace(/^\uFEFF/, ''));
if (cases.some(c => /camcam66gaming/i.test(c.url))) throw new Error('Excluded test channel');
const seconds = Number(process.env.SSAPP_AUDIT_SECONDS || 75);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-live-audit-'));
const profile = path.join(out, 'profile');
fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({ streamID: 'live_audit_' + Date.now(), state: true, settings: {} }));
const report = { started: new Date().toISOString(), mode: 'Standard capture, isolated signed-out profile', seconds, cases: [] };
(async () => {
    console.log('OUTPUT', out);
    let app;
    try {
        app = await _electron.launch({ executablePath: require('electron'), cwd: root,
            args: ['.', '--running-from-source', '--multiinstance', '--filesource=' + pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href],
            env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000 });
        const main = await app.firstWindow();
        await main.waitForFunction(() => window.stateManager?.initialized && configReady);
        let bg;
        for (let n = 0; n < 300; n++) {
            bg = main.frames().find(f => f.url().includes('background.html'));
            if (bg && await bg.evaluate(() => typeof processIncomingMessage === 'function' && typeof sendToDestinations === 'function' && isExtensionOn).catch(() => false)) break;
            await main.waitForTimeout(100);
        }
        await bg.evaluate(() => {
            window.__auditCounts = { processed: {}, destinations: {}, events: {} };
            const count = (map, data) => { const key = data?.type || 'unknown'; map[key] = (map[key] || 0) + 1; };
            const originalProcess = processIncomingMessage;
            const originalSend = sendToDestinations;
            processIncomingMessage = function (data) {
                count(window.__auditCounts.processed, data);
                const key = (data?.type || 'unknown') + ':' + (data?.event || 'chat');
                window.__auditCounts.events[key] = (window.__auditCounts.events[key] || 0) + 1;
                return originalProcess.apply(this, arguments);
            };
            sendToDestinations = function (data) {
                count(window.__auditCounts.destinations, data);
                return originalSend.apply(this, arguments);
            };
        });
        for (let offset = 0; offset < cases.length; offset += 3) {
            const group = [];
            for (const test of cases.slice(offset, offset + 3)) {
                const entry = { ...test, samples: [], errors: [] };
                report.cases.push(entry);
                try {
                    const previous = new Set(app.windows());
                    await main.evaluate(async test => {
                        if (test.videoId) await newSourceVideoID(test.target, test.videoId, false, { connectionMode: 'classic' });
                        else await newOtherSource(test.target, test.url, false, { username: 'Audit ' + test.target, connectionMode: 'classic', sourceFile: test.sourceFile || 'sources/' + test.target + '.js' });
                    }, test);
                    entry.source = await main.evaluate(test => stateManager.getSources().find(s => test.videoId ? s.target === test.target && s.videoId === test.videoId : s.url === test.url), test);
                    await main.locator('[data-source-id="' + entry.source.id + '"] [data-activatehtml]').press('Enter');
                    for (let n = 0; n < 100; n++) {
                        entry.page = app.windows().find(p => !previous.has(p));
                        if (entry.page) break;
                        await main.waitForTimeout(100);
                    }
                    if (!entry.page) throw new Error('No source window created');
                    entry.page.on('pageerror', error => { if (entry.errors.length < 12) entry.errors.push(error.message.slice(0,200)); });
                    if (test.clickText) await entry.page.getByText(test.clickText, { exact: true }).click({ timeout: 20000 });
                    group.push(entry);
                    console.log('OPEN', test.target, test.url);
                } catch (error) {
                    entry.error = error.message;
                    if (entry.source) await main.locator('[data-source-id="' + entry.source.id + '"] [data-stophtml]').click().catch(() => {});
                    delete entry.page;
                    delete entry.source;
                }
            }
            for (let elapsed = 0; elapsed < seconds; elapsed += 15) {
                await main.waitForTimeout(Math.min(15, seconds - elapsed) * 1000);
                for (const entry of group) {
                    try {
                        entry.samples.push(await entry.page.evaluate(() => ({
                            url: location.href, title: document.title, bodyLength: document.body?.innerText.length || 0,
                            chatRows: document.querySelectorAll('[class*="ChatMessage_root_"],.chat-line__message,.chat__container > *, .chat-elements-list > *,yt-live-chat-text-message-renderer').length
                        })));
                    } catch (_) { }
                }
                console.log('SAMPLE', Math.min(elapsed + 15, seconds), group.map(e => e.target).join(','), JSON.stringify(await bg.evaluate(() => window.__auditCounts)));
            }
            for (const entry of group) {
                try {
                    entry.pageData = await entry.page.evaluate(() => ({
                        url: location.href, title: document.title, text: document.body?.innerText.slice(0,18000) || '',
                        links: [...document.querySelectorAll('a[href]')].map(a => ({ text: a.innerText.slice(0,90), href: a.href })).filter(a => !/camcam66gaming/i.test(a.href)).slice(0,200)
                    }));
                    entry.screenshot = path.join(out, entry.target + '.png');
                    await entry.page.screenshot({ path: entry.screenshot });
                    entry.counts = await bg.evaluate(target => ({ processed: window.__auditCounts.processed[target] || 0, destinations: window.__auditCounts.destinations[target] || 0, events: Object.fromEntries(Object.entries(window.__auditCounts.events).filter(([key]) => key.startsWith(target + ':'))) }), entry.countType || (entry.target === 'bilibilicom' ? 'bilibili' : entry.target));
                    console.log('RESULT', entry.target, JSON.stringify({ url: entry.pageData.url, title: entry.pageData.title, excerpt: entry.pageData.text.slice(0,450), counts: entry.counts }));
                } catch (error) { entry.error = error.message; }
                await main.locator('[data-source-id="' + entry.source.id + '"] [data-stophtml]').click().catch(() => {});
                delete entry.page;
                delete entry.source;
            }
            fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
        }
        await main.locator('.addnew').evaluate(el => { el.scrollTop = 0; });
        await main.screenshot({ path: path.join(out, 'sidebar-top.png') });
    } finally {
        report.finished = new Date().toISOString();
        report.cases.forEach(entry => { delete entry.page; delete entry.source; });
        fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
        if (app) await app.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
