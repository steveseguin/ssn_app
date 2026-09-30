'use strict';
// Run with a desktop: node tests/electron/tiktok-field-rendering-e2e.js
// Real native composer/forwarder -> background -> local relay -> Dock, in both text modes.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '../..');
const { _electron } = require(path.join(root, 'node_modules/playwright-core'));
const { linuxLaunchArgs, electronTestTarget, electronTestRuntime, electronTestSourceBase } = require('./helpers/electron-launch');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const start = Date.now();
  while (Date.now() - start < 45000) {
    const value = await check();
    if (value) return value;
    await pause(150);
  }
  throw new Error('Timed out: ' + label);
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function run() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-tiktok-fields-'));
  const room = 'fields_local_' + Date.now();
  const relayPort = await freePort();
  let sourceBase = pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href;
  fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
    streamID: room, password: 'false', state: true, wsServer: true, settings: { server2: { setting: true } },
  }));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2sAAAAASUVORK5CYII=', 'base64'));
  });
  const report = { profile, cases: [], executablePayloads: false };
  let app;
  let log;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const quotedUrl = base + '/image.png"onerror=""data-ssapp-injected="';
    const quotedLabel = 'Emote & "quoted" label';
    const signedUrl = base + '/emote.png?expires=123&signature=a%2Fb%3D';
    const smile = { emoteId: 'smile', emoteName: 'Smile', emoteImageUrl: base + '/emote.png' };
    const variants = [
      { name: 'nickname', data: { nickname: 'N<img src=x onerror="">' } },
      { name: 'comment', suffix: ` <img src="${base}/comment.png" onerror="" data-ssapp-injected="comment">` },
      { name: 'emote-label', data: { emotes: [{ emoteId: 'label', emoteName: 'label" onerror="" data-ssapp-injected="', emoteImageUrl: base + '/emote.png' }] } },
      { name: 'emote-id', data: { emotes: [{ emoteId: 'id" onerror="" data-ssapp-injected="', emoteName: 'ID fixture', emoteImageUrl: base + '/emote.png' }] } },
      { name: 'avatar-url', data: { profilePictureUrl: quotedUrl } },
      { name: 'badge-url', data: { userBadges: [{ url: quotedUrl }] } },
      { name: 'quoted-label-control', data: { nickname: 'O\'Neil & Friend', emotes: [{ emoteId: 'ordinary', emoteName: quotedLabel, emoteImageUrl: signedUrl }] } },
      { name: 'plain-control', data: { nickname: 'Ordinary viewer', emotes: [{ emoteId: 'smile', emoteName: 'Smile', emoteImageUrl: base + '/emote.png' }] } },
      // Audience-controlled comment text with ordinary emote metadata. All event
      // attributes and scripts are empty; no supplied JavaScript is executed.
      { name: 'comment-with-emote', suffix: ` <img src="${base}/comment.png" onerror="" data-ssapp-injected="comment"> [smile]`, data: { emotes: [smile] } },
      { name: 'positioned-emote', suffix: ' left & < > [smile] right', positionMarker: '[smile]', data: { emotes: [smile] } },
      { name: 'positioned-attribute', suffix: ' <span title="[smile]" onmouseover="">attribute boundary</span>', positionMarker: '[smile]', expectEmote: false, data: { emotes: [smile] } },
      { name: 'placeholder-attribute', suffix: ' <span title="[smile]" onmouseover="">placeholder boundary</span>', expectEmote: false, data: { emotes: [smile] } },
      { name: 'literal-entities', suffix: ' &lt;b&gt;entity&lt;/b&gt; &amp;lt;double&amp;gt; & "quotes" ${literal} `backticks`', literalCheck: true },
      { name: 'entities-with-emote', suffix: ' &lt;b&gt;entity&lt;/b&gt; &amp;lt;double&amp;gt; [smile]', literalCheck: true, data: { emotes: [smile] } },
      { name: 'unsafe-tags-with-emote', suffix: ' <script></script><svg><g onload=""></g></svg><math></math><iframe></iframe><object></object><embed> [smile]', data: { emotes: [smile] } },
      { name: 'unsafe-links-with-emote', suffix: ' <a href="javascript:/* inert */" onclick="">link</a> <a href="java&#10;script:/* inert */">entity link</a> [smile]', data: { emotes: [smile] } },
      { name: 'formatting-with-emote', suffix: ' <b data-ssapp-audience-format="">audience bold</b> [smile]', data: { emotes: [smile] } },
      { name: 'v3-positioned-emote', schema: 'v3', suffix: ' <b>before</b> & [smile] after', positionMarker: '[smile]', data: { emotes: [smile] } },
    ];
    const env = { ...process.env, SSAPP_USER_DATA_DIR: profile, SSAPP_DEBUG_LOGS: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    const target = electronTestTarget(sourceBase);
    app = await _electron.launch({ executablePath: target.executablePath, cwd: root,
      args: [...target.args, '--multiinstance',
        '--ssapp-local-server-port=' + relayPort, '--disable-logs', ...linuxLaunchArgs()], env, timeout: 60000 });
    log = fs.createWriteStream(path.join(profile, 'app.log'));
    app.process().stdout.pipe(log, { end: false }); app.process().stderr.pipe(log, { end: false });
    const main = await app.firstWindow();
    await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady && typeof ipcRenderer !== 'undefined');
    report.runtime = await electronTestRuntime(app);
    sourceBase = await electronTestSourceBase(main, sourceBase);
    report.sourceBase = sourceBase;
    const dockUrl = sourceBase + 'dock.html?session=' + room + '&password=false&server2&localserver&localserverport=' + relayPort;
    await main.evaluate(url => { window.open(url, '_blank'); }, dockUrl);
    const dock = await until(() => app.context().pages().find(page => page.url() === dockUrl), 'dock');
    const cdp = await dock.context().newCDPSession(dock);
    async function inDock(fn, argument) {
      const result = await cdp.send('Runtime.evaluate', { expression: '(' + fn.toString() + ')(' + JSON.stringify(argument) + ')', returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    }
    await until(() => inDock(() => typeof socketserverExtension !== 'undefined' && socketserverExtension.readyState === 1), 'dock relay');
    let background = await until(() => main.frames().find(frame => frame.url().includes('/background.html')), 'background');
    await until(() => background.evaluate(() => typeof socketserverDock !== 'undefined' && socketserverDock.readyState === 1), 'background relay');
    await pause(5000);
    await app.evaluate(({ app, BrowserWindow }) => {
      const req = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const native = req('./tiktok/connection-manager');
      const mainWindow = BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && !win.webContents.isDestroyed() && win.webContents.getURL().includes('/index.html'));
      global.__nativeFieldsFixture = { native, env: native.createTikTokEnvironment({ connector: req('tiktok-live-connector'), getMainWindow: () => mainWindow }) };
    });
    for (const phase of ['initial', 'background-reload']) {
      if (phase !== 'initial') {
        await background.evaluate(() => location.reload());
        await pause(2500);
        background = await until(() => main.frames().find(frame => frame.url().includes('/background.html')), 'background reload');
        await until(() => background.evaluate(() => typeof socketserverDock !== 'undefined' && socketserverDock.readyState === 1), 'reloaded relay');
        await pause(2500);
      }
      for (const textonly of [false, true]) for (const variant of variants) {
        const key = `${phase}-${textonly}-${variant.name}`;
        const sent = await app.evaluate((_electron, { key, textonly, variant }) => {
          const { native, env } = global.__nativeFieldsFixture;
          const input = {
            msgId: key, uniqueId: 'ssapp_fields_fixture', nickname: 'Local fields fixture', textonly,
            comment: 'FIELDS ' + key + (variant.suffix || ''), ...variant.data,
          };
          if (variant.positionMarker) {
            input.emotes = input.emotes.map(emote => ({ ...emote, placeInComment: input.comment.indexOf(variant.positionMarker) }));
          }
          if (variant.schema === 'v3') {
            input.content = input.comment;
            delete input.comment;
          }
          const message = native.__test.composeTikTokChatMessage(input);
          message.type = 'tiktok';
          env.sendToBackground(message);
          return message;
        }, { key, textonly, variant });
        const expectedImage = textonly || variant.expectEmote === false ? null : variant.data?.emotes?.[0]?.emoteImageUrl;
        const rendered = await until(() => inDock(({ key, nativeHtml, expectedImage }) => {
          const row = [...document.querySelectorAll('.highlight-chat')].find(row => row.textContent.includes('FIELDS ' + key));
          if (!row) return null;
          if (expectedImage && ![...row.querySelectorAll('img')].some(img =>
            img.getAttribute('src') === expectedImage && img.complete && img.naturalWidth > 0)) return null;
          const template = document.createElement('template');
          template.innerHTML = nativeHtml;
          return { text: row.textContent, producerEmptyHandlers: template.content.querySelectorAll('[onerror=""]').length,
            emptyHandlers: [...row.querySelectorAll('*')].flatMap(el =>
            [...el.attributes].filter(attr => /^on/i.test(attr.name) && attr.value === '').map(attr => attr.name)),
            injectedAttributes: row.querySelectorAll('[data-ssapp-injected]').length,
            forbiddenElements: [...row.querySelectorAll('script,iframe,object,embed,math')].map(el => el.tagName),
            unsafeUrls: [...row.querySelectorAll('[href],[src],[xlink\\:href]')].flatMap(el =>
              [...el.attributes].filter(attr => ['href', 'src', 'xlink:href'].includes(attr.name)).filter(attr => {
                try { return ['javascript:', 'vbscript:'].includes(new URL(attr.value, location.href).protocol); }
                catch (_) { return false; }
              }).map(attr => attr.value)),
            audienceBold: [...row.querySelectorAll('b')].some(el => el.textContent === 'audience bold'),
            images: [...row.querySelectorAll('img')].map(img => ({ src: img.getAttribute('src'), alt: img.alt,
              emoteId: img.getAttribute('data-emote-id'), loaded: img.complete && img.naturalWidth > 0 })),
          };
        }, { key, nativeHtml: sent.chatmessage, expectedImage }), key + ' rendered');
        report.cases.push({ phase, textonly, variant: variant.name, sent, rendered });
        assert.equal(rendered.emptyHandlers.length, 0, key + ' retained an untrusted event attribute');
        assert.deepStrictEqual(rendered.forbiddenElements, [], key + ' retained an unsafe element');
        assert.deepStrictEqual(rendered.unsafeUrls, [], key + ' retained an executable URL');
        if (textonly && (variant.literalCheck || variant.suffix)) {
          assert(rendered.text.includes(sent.chatmessage), key + ' changed the literal body');
          assert(!rendered.images.some(img => img.src?.startsWith(base)), key + ' parsed a literal image');
        }
        if (!textonly && ['emote-label', 'emote-id'].includes(variant.name)) {
          assert.equal(rendered.producerEmptyHandlers, 0, key + ' native markup broke out of an emote attribute');
          assert.equal(rendered.injectedAttributes, 0, key + ' added a foreign attribute');
          assert(rendered.images.some(img => img.src === base + '/emote.png' && img.alt === variant.data.emotes[0].emoteName),
            key + ' emote label was changed');
        }
        if (variant.name === 'quoted-label-control') {
          if (textonly) {
            assert(sent.chatmessage.includes(quotedLabel), 'Text-only payload must stay literal');
            assert(rendered.text.includes(quotedLabel), 'Text-only display must stay literal');
            assert(!sent.chatmessage.includes('<img'), 'Text-only payload must not gain image markup');
          } else {
            assert(rendered.images.some(img => img.src === signedUrl && img.alt === quotedLabel),
              'The full label and signed image URL must survive the real relay/rendering path');
          }
        }
        if (variant.name === 'plain-control' && !textonly) {
          assert(rendered.images.some(img => img.src === base + '/emote.png'), 'Normal emote was lost');
        }
        console.log(JSON.stringify({ key, emptyHandlers: rendered.emptyHandlers.length, injectedAttributes: rendered.injectedAttributes,
          emoteAlts: rendered.images.filter(img => img.src?.startsWith(base + '/emote.png')).map(img => img.alt) }));
      }
    }
    report.complete = true;
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
    console.log(`Evidence: ${path.join(profile, 'result.json')}`);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
