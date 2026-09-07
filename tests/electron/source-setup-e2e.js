'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-source-setup-'));
const profile = path.join(out, 'profile');
fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({ streamID: 'source_setup_' + Date.now(), state: true, settings: {} }));
const report = { checks: [], live: [] };
(async () => {
    console.log('OUTPUT', out);
    let app;
    try {
        app = await _electron.launch({ executablePath: require('electron'), cwd: root,
            args: ['.', '--running-from-source', '--multiinstance', '--filesource=' + pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href],
            env: { ...process.env, SSAPP_USER_DATA_DIR: profile }, timeout: 60000 });
        const main = await app.firstWindow();
        await main.waitForFunction(() => window.stateManager?.initialized && configReady);
        const win = await app.browserWindow(main);
        await win.evaluate(w => w.setSize(1280, 900));
        const shot = async (name, page = main) => page.screenshot({ path: path.join(out, name + '.png') });
        await main.locator('[data-source-type="other"]').click();
        assert.equal(await main.locator('[data-source-type="other"]').innerText(), 'Add other source');
        await main.waitForFunction(() => document.activeElement?.id === 'source-setup-input');
        assert.equal(await main.locator('.source-setup-help').getAttribute('open'), null);
        await shot('other-guidance');
        await main.locator('.source-setup-help summary').click();
        await shot('other-help-expanded');
        assert.equal(await main.locator('.source-setup a').getAttribute('href'), 'https://socialstream.ninja/docs/supported-sites.html');
        const helpPromise = app.waitForEvent('window');
        await main.locator('.source-setup a').click();
        const help = await helpPromise;
        await help.waitForURL('https://socialstream.ninja/docs/supported-sites.html');
        await help.locator('h1').filter({ hasText: 'Supported Sites' }).waitFor();
        await shot('supported-sites-help', help);
        await help.close();
        await main.bringToFront();
        await main.locator('.source-setup-help summary').click();
        await win.evaluate(w => w.setSize(1024, 768));
        assert(await main.locator('.source-setup').evaluate(e => e.scrollWidth <= e.clientWidth));
        await shot('other-compact');
        await main.locator('#source-setup-input').fill('javascript:alert(1)');
        await main.locator('#source-setup-form button[type="submit"]').click();
        await main.locator('#source-setup-error').filter({ hasText: 'http://' }).waitFor();
        await main.locator('#source-setup-input').fill('https://live.vkvideo.ru/brm/only-chat');
        await main.locator('#source-setup-form button[type="submit"]').click();
        await main.waitForFunction(() => stateManager.getSources().some(s => s.url === 'https://live.vkvideo.ru/brm/only-chat'));
        const other = await main.evaluate(() => stateManager.getSources().find(s => s.url === 'https://live.vkvideo.ru/brm/only-chat'));
        assert.equal(other.target, 'vkvideo');
        report.checks.push('Other guidance, supported-sites link, compact layout, invalid scheme rejection and automatic source detection');
        await win.evaluate(w => w.setSize(1280, 900));
        for (const [target, id, expected] of [['bilibilicom', '6', 'https://live.bilibili.com/6'], ['bilibilitv', '123456', 'https://www.bilibili.tv/en/live/123456']]) {
            await main.locator('[data-source-type="bilibili"]').click();
            await main.locator('#bilibili-site').selectOption(target);
            await shot(target + '-chooser');
            await main.locator('#source-setup-input').fill('https://example.com/123');
            await main.locator('#source-setup-form button[type="submit"]').click();
            await main.locator('#source-setup-error').filter({ hasText: 'selected Bilibili site' }).waitFor();
            await main.locator('#source-setup-input').fill(id);
            await main.locator('#source-setup-form button[type="submit"]').click();
            await main.waitForFunction(target => stateManager.getSources().some(s => s.target === target), target);
            assert.equal(await main.evaluate(target => stateManager.getSources().find(s => s.target === target).url, target), expected);
        }
        report.checks.push('One Bilibili button, both choices route correctly, wrong-site inputs rejected (URL mapping only; no live Bilibili capture claimed)');
        // Exercise source creation with pasted URLs in the running renderer.
        for (const [target, input, expected] of [
            ['picarto', 'https://picarto.tv/HuckleberryBleu', 'https://picarto.tv/chatpopout/HuckleberryBleu/public'],
            ['mixcloud', 'www.mixcloud.com/live/MissBlu6/chat/', 'https://www.mixcloud.com/live/MissBlu6/chat/'],
            ['twitcasting', 'https://twitcasting.tv/TJ_Ajianking', 'https://twitcasting.tv/TJ_Ajianking'],
            ['younow', 'https://www.younow.com/FabbyFlorez99', 'https://www.younow.com/FabbyFlorez99'],
            ['chzzk', 'https://chzzk.naver.com/live/4de764d9dad3b25602284be6db3ac647/chat', 'https://chzzk.naver.com/live/4de764d9dad3b25602284be6db3ac647/chat'],
            ['nimo', 'https://www.nimo.tv/live/1563885463', 'https://www.nimo.tv/popout/chat/1563885463'],
            ['sooplive', 'https://play.sooplive.com/bigfishtv/296940097?vtype=chat', 'https://play.sooplive.com/bigfishtv/'],
            ['beamstream', 'https://beamstream.gg/spooky-boogy/chat', 'https://beamstream.gg/spooky-boogy/chat'],
            ['velora', 'https://velora.tv/electriccyder', 'https://velora.tv/electriccyder'],
            ['x', 'https://twitter.com/NASA', 'https://x.com/NASA/livechat'],
            ['arenasocial', 'https://arena.social/live/example', 'https://arena.social/live/example']
        ]) {
            await main.evaluate(async ({target, input}) => newSource(target, input, false, {connectionMode: 'classic'}), {target, input});
            const source = await main.evaluate(url => stateManager.getSources().find(s => s.url === url), expected);
            assert(source, target + ' pasted URL was not normalized');
            assert(!source.username.includes('/'), target + ' saved a URL as the handle');
        }
        const invalidCount = await main.evaluate(async () => {
            const before = stateManager.getSources().length;
            await newSource('mixcloud', 'https://example.com/channel');
            await newSource('picarto', 'https://picarto.tv/');
            return stateManager.getSources().length - before;
        });
        assert.equal(invalidCount, 0);
        assert.equal(await main.evaluate(() => parseNamedSourceInput('vkvideo', 'https://live.vkvideo.ru/absatzmedia/stream/sl_236688').url), 'https://live.vkvideo.ru/absatzmedia/only-chat');
        await shot('pasted-url-sources');
        report.checks.push('Pasted URLs create correct source rows for eleven platforms; invalid URLs rejected; VK stream links accepted');
        if (process.env.SOURCE_SETUP_UI_ONLY === '1') {
            await main.locator('[data-source-type="loco"]').click();
            await main.locator('#source-setup-input').fill('https://example.com/streamers/name');
            await main.locator('#source-setup-form button[type="submit"]').click();
            await main.locator('#source-setup-error').filter({ hasText: 'selected site' }).waitFor();
            await main.keyboard.press('Escape');
            assert.equal(await main.locator('.source-setup').count(), 0);
            assert.equal(await main.locator('#content-pane').getAttribute('inert'), null);
            report.checks.push('Supported-sites link opens its guide; invalid channel URL rejected; Escape restores app interaction');
            console.log('PASS', JSON.stringify(report.checks));
            return;
        }
        const bg = main.frames().find(f => f.url().includes('background.html'));
        await bg.waitForFunction(() => typeof processIncomingMessage === 'function');
        await bg.evaluate(() => {
            window.__sourceSetupCounts = {};
            const original = processIncomingMessage;
            window.processIncomingMessage = function (data) {
                if (['bigo', 'loco', 'vkvideo'].includes(data.type)) window.__sourceSetupCounts[data.type] = (window.__sourceSetupCounts[data.type] || 0) + 1;
                return original.apply(this, arguments);
            };
        });
        for (const [target, input, expected, selector] of [
            ['bigo', '1082331356', 'https://www.bigo.tv/1082331356', '.chat__container'],
            ['loco', 'https://loco.com/streamers/archax13', 'https://loco.com/chat/streamers/archax13', '.chat-elements-list'],
            ['vkvideo', '@highmyside', 'https://live.vkvideo.ru/highmyside/only-chat', '[class^="Chat_root"]']
        ]) {
            await main.locator('[data-source-type="' + target + '"]').click();
            await main.locator('#source-setup-input').fill(input);
            await shot(target + '-setup');
            await main.locator('#source-setup-form button[type="submit"]').click();
            await main.waitForFunction(url => stateManager.getSources().some(s => s.url === url), expected);
            const source = await main.evaluate(url => stateManager.getSources().find(s => s.url === url), expected);
            assert.equal(source.sourceFile, 'sources/' + target + '.js');
            const row = main.locator('[data-source-id="' + source.id + '"]');
            assert.equal(await row.getAttribute('inert'), null);
            await row.locator('[data-activatehtml]').press('Enter');
            await main.waitForTimeout(30000);
            const capture = app.windows().find(p => p.url() === expected);
            assert(capture, 'Generated URL did not stay on the expected page: ' + expected);
            await capture.locator(selector).first().waitFor({ timeout: 15000 });
            await shot(target + '-live', capture);
            const count = await bg.evaluate(target => window.__sourceSetupCounts[target] || 0, target);
            report.live.push({ target, input, url: capture.url(), title: await capture.title(), chatContainer: true, capturedMessages: count });
            console.log('LIVE', JSON.stringify(report.live[report.live.length - 1]));
            await row.locator('[data-stophtml]').click();
        }
        await shot('saved-sources');
        report.checks.push('Three new buttons generate correct live URLs and load chat containers through actual source-window activation');
        // Supporting checks of input forms, without making requests to invented channels.
        const parsed = await main.evaluate(() => ({
            bigo: parseNamedSourceInput('bigo', 'https://www.bigo.tv/user/1082331356'),
            loco: parseNamedSourceInput('loco', '@Archax13'),
            vk: parseNamedSourceInput('vkvideo', 'https://vkplay.live/highmyside/only-chat?theme=dark')
        }));
        assert.equal(parsed.bigo.url, 'https://www.bigo.tv/1082331356');
        assert.equal(parsed.loco.url, 'https://loco.com/chat/streamers/archax13');
        assert.equal(parsed.vk.url, 'https://live.vkvideo.ru/highmyside/only-chat');
        console.log('PASS', JSON.stringify(report.checks));
    } catch (error) { report.error = error.message; throw error; }
    finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
