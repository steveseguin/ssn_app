'use strict';

// Exercise real capture -> existing SSApp IPC -> background -> local relay -> dock.
// Do not prefill dataset.mid: that hides the broken app callback this test guards.
// Only local chat fixtures are used; no live channels or account actions.
const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '../..');
const sourceRoot = path.resolve(root, '../social_stream');
const base = pathToFileURL(sourceRoot + path.sep).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeout = 20000) {
	const end = Date.now() + timeout;
	let last;
	while (Date.now() < end) {
		try { const value = await check(); if (value) return value; } catch (error) { last = error.message; }
		await delay(100);
	}
	throw new Error(`Timed out: ${label}${last ? ' (' + last + ')' : ''}`);
}

async function freePort() {
	const server = net.createServer();
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

async function run() {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-youtube-mid-'));
	const relayPort = await freePort();
	const room = 'youtube_mid_' + Date.now();
	fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({
		streamID: room, password: 'false', state: true, wsServer: true,
		settings: { server2: { setting: true } },
	}));
	let app;
	try {
        const debugPort = await freePort();
        const child = require('child_process').spawn(require('electron'), ['.', '--running-from-source', '--filesource='+base,
            '--multiinstance','--ssapp-local-server-port='+relayPort,'--remote-debugging-port='+debugPort],
            {cwd:root,env:{...process.env,SSAPP_USER_DATA_DIR:profile,UV_THREADPOOL_SIZE:'2'},windowsHide:true,stdio:'pipe'});
        const runtimeLog=fs.createWriteStream(path.join(profile,'runtime.log')); child.stdout.pipe(runtimeLog); child.stderr.pipe(runtimeLog); console.log('PROFILE',profile);
        const browser = await until(()=>require('playwright-core').chromium.connectOverCDP('http://127.0.0.1:'+debugPort),'Electron CDP');
        app = { windows:()=>browser.contexts().flatMap(c=>c.pages()), on:()=>{}, close:async()=>{await browser.close().catch(()=>{});child.kill();} };

		const main = await until(() => app.windows().find(page => page.url().includes('/index.html')), 'main');
		await main.waitForFunction(() => typeof configReady !== 'undefined' && configReady);
		// Startup can replace the background frame while selecting the local core.
		await delay(5000);
		const background = await until(async () => {
			const frame = main.frames().find(frame => frame.url().includes('/background.html'));
			return frame && await frame.evaluate(() => typeof handleRuntimeMessage === 'function' && loadedFirst) ? frame : null;
		}, 'background');
		async function create(args) {
			await main.evaluate(value => {
				if (value.platform) {
					value.config = { ...config.global, ...config[value.platform] };
					if (value.wss && value.config.wss) value.config = { ...value.config, ...value.config.wss };
					value.configs = config;
				}
				return ipcRenderer.sendSync('createWindow', value);
			}, args);
			return until(() => app.windows().find(page => page.url() === args.url), 'source window');
		}
		const dock = await create({
			url: base + 'dock.html?session=' + room + '&password=false&server2&localserver&localserverport=' + relayPort,
			visible: false,
		});
		const dockCdp = await dock.context().newCDPSession(dock);
		async function dockEval(expression) {
			const result = await dockCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
			if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
			return result.result.value;
		}
		const rows = () => dockEval("Array.from(document.querySelectorAll('.highlight-chat')).map(row => ({mid:row.dataset.mid,text:row.rawContents?.chatmessage,type:row.dataset.sourceType}))");
		await until(() => dockEval("typeof socketserverExtension !== 'undefined' && socketserverExtension?.readyState === 1"), 'dock relay');
		await until(() => background.evaluate(() => typeof socketserverDock !== 'undefined' && socketserverDock?.readyState === 1), 'background relay');
		const fixture = pathToFileURL(path.join(root, 'tests/electron/fixtures/hidden-capture.html')).href;
		async function source(index) {
			const page = await create({ url: fixture + '?platform=youtube&manual=1&window=' + index,
				platform: 'youtube', sourceFiles: ['sources/youtube.js'], filesource: base, visible: false });
			await page.waitForFunction(() => !!document.getElementById('items')?.skip);
			return page;
		}
		const first = await source(1);
		const callbackReply = await first.evaluate(() => new Promise(resolve => {
			chrome.runtime.sendMessage(chrome.runtime.id, {
				message: { type: 'youtube', chatname: 'Callback fixture', chatmessage: 'real-callback' },
			}, resolve);
		}));
		assert.ok(Number.isSafeInteger(callbackReply.id), 'App callback must return the real background MID');
		await until(async () => (await rows()).some(row => row.text === 'real-callback'), 'callback capture');
		assert.equal((await rows()).find(row => row.text === 'real-callback').mid, String(callbackReply.id));
		console.log('PASS original capture callback returns the background MID');
		async function insert(page, key) {
			await page.evaluate(key => {
				const row = document.createElement('yt-live-chat-text-message-renderer');
				row.id = key + '-native-youtube-message-id-longer-than-forty-characters';
				row.dataset.fixtureKey = key;
				row.innerHTML = '<span id="author-name">Same Author</span><span id="message"></span>';
				row.querySelector('#message').textContent = key;
				document.getElementById('items').appendChild(row);
			}, key);
		}
		async function midFor(page, key) {
			return until(() => page.evaluate(key => document.querySelector('[data-fixture-key="' + key + '"]')?.dataset.mid, key),
				'SSN MID returned to captured YouTube row ' + key, 8000);
		}
		async function capture(page, key) {
			await insert(page, key);
			const mid = await midFor(page, key);
			assert.ok(Number.isSafeInteger(Number(mid)) && Number(mid) > 0, 'MID must be numeric');
			await until(async () => (await rows()).some(row => row.text === key), 'dock capture ' + key);
			assert.equal((await rows()).find(row => row.text === key).mid, mid, 'Source and dock must use the same MID');
			return Number(mid);
		}
		async function remove(page, key) {
			await page.evaluate(key => {
				const row = document.querySelector('[data-fixture-key="' + key + '"]');
				row.querySelector('#author-name')?.remove();
				row.setAttribute('is-deleted', '');
			}, key);
		}

        async function mainWorld(page) {
            const cdp = await page.context().newCDPSession(page);
            async function evaluate(fn,arg) {
                const result=await cdp.send('Runtime.evaluate',{expression:'('+fn+')('+JSON.stringify(arg)+')',awaitPromise:true,returnByValue:true});
                if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
                return result.result.value;
            }

            return {evaluate, waitForFunction: async fn => {try{return await until(()=>evaluate(fn),'WSS main-world ready',30000);}catch(e){console.log('FAILED GLOBALS',await evaluate(()=>({title:document.title,len:document.documentElement.outerHTML.length,body:document.body?.innerText?.slice(0,300),audit:!!window.__ytAudit,q:typeof extensionRelayQueue,keys:Object.keys(window).filter(x=>x.toLowerCase().includes('youtube')).slice(0,20)})));throw e;}}};
        }
		const results = [];
		async function check(name, test) {
			try { const details = await test(); results.push({ name, pass: true, details }); console.log('PASS', name, details || ''); }
			catch (error) { process.exitCode = 1; results.push({ name, pass: false, error: error.message }); console.log('FAIL', name, error.message); }
		}
		await background.evaluate(() => {
			window.auditPackets = [];
			window.auditStarted = [];
			const send = sendToDestinations;
			sendToDestinations = function (data, ...args) { auditPackets.push(JSON.parse(JSON.stringify(data))); return send(data, ...args); };
			const actions = applyBotActions;
			applyBotActions = async function (data, ...args) {
				if (String(data.chatmessage).includes('audit-slow-')) {
					auditStarted.push(data.chatmessage);
					await new Promise(resolve => setTimeout(resolve, 1500));
				}
				return actions(data, ...args);
			};
		});
		const ytHtml = path.join(profile, 'youtube-api-fixture.html');
		fs.writeFileSync(ytHtml, fs.readFileSync(path.join(sourceRoot, 'sources/websocket/youtube.html'), 'utf8')
			.replace('<head>', '<head><base href="' + base + 'sources/websocket/">').replace("document.addEventListener('DOMContentLoaded', initializePage);","window.__ytAudit={response:processLiveChatResponseData}; document.addEventListener('DOMContentLoaded', initializePage);"));
		const yt = await mainWorld(await create({ url: pathToFileURL(ytHtml).href + '?ssapp=1', visible: false, wss: true,
			platform: 'youtube', source: path.join(sourceRoot, 'sources/websocket/youtube.js'), filesource: base }));
		await yt.waitForFunction(() => !!window.__ytAudit && typeof extensionRelayQueue !== 'undefined');
        await yt.evaluate(()=>{window.__auditTimestamp=Date.now();return __ytAudit.response({items:[]});});
		async function ytAdd(id, name = 'YT WSS Viewer') {
			await yt.evaluate(({ id, name }) => __ytAudit.response({ items: [{ id,
				snippet: { type: 'textMessageEvent', displayMessage: id, textMessageDetails: { messageText: id }, publishedAt: new Date(++window.__auditTimestamp).toISOString() },
				authorDetails: { displayName: name, channelId: name.replaceAll(' ', '-'), profileImageUrl: '' }
			}] }), { id, name });
		}
		async function ytDelete(id, kind = 'messageDeletedEvent') {
			await yt.evaluate(({ id, kind }) => __ytAudit.response({ items: [{ id: kind === 'tombstone' ? id : 'delete-' + id,
				snippet: { type: kind, messageDeletedDetails: kind === 'messageDeletedEvent' ? { deletedMessageId: id } : undefined,
				message_retracted_details: kind === 'MESSAGE_RETRACTED_EVENT' ? { retracted_message_id: id } : undefined }
			}] }), { id, kind });
		}
		await check('YouTube WSS single message numeric MID and targeted delete', async () => {
			await ytAdd('yt-single-one'); await ytAdd('yt-single-two');
			await until(async () => (await rows()).filter(row => row.text?.startsWith('yt-single-')).length === 2, 'YT WSS rows');
			const captured = (await rows()).filter(row => row.text?.startsWith('yt-single-'));
			assert.ok(captured.every(row => Number.isSafeInteger(Number(row.mid))));
			assert.notEqual(captured[0].mid, captured[1].mid);
			await ytDelete('yt-single-one');
			await until(async () => !(await rows()).some(row => row.text === 'yt-single-one'), 'YT WSS targeted delete');
			assert.ok((await rows()).some(row => row.text === 'yt-single-two'));
			return captured;
		});
		await check('YouTube WSS batched messages unique incremental MIDs', async () => {
			await yt.evaluate(async () => {
				await __ytAudit.response({ items: Array.from({ length: 100 }, (_, i) => ({ id: 'yt-batch-' + i,
					snippet: { type: 'textMessageEvent', displayMessage: 'yt-batch-' + i, textMessageDetails: { messageText: 'yt-batch-' + i }, publishedAt: new Date(++window.__auditTimestamp).toISOString() },
					authorDetails: { displayName: 'Batch Viewer', channelId: 'batch-viewer' } })) });
			});
			await until(() => background.evaluate(() => auditPackets.filter(p => p.chatmessage?.startsWith('yt-batch-')).length === 100), '100 YT batched messages');
			const ids = await background.evaluate(() => auditPackets.filter(p => p.chatmessage?.startsWith('yt-batch-')).map(p => p.id));
			assert.ok(ids.every(Number.isSafeInteger)); assert.equal(new Set(ids).size, 100);
			assert.ok(ids.every((id, index) => index === 0 || id > ids[index - 1]));
			return { count: ids.length, first: ids[0], last: ids.at(-1) };
		});
		for (const kind of ['MESSAGE_RETRACTED_EVENT', 'tombstone']) await check('YouTube WSS ' + kind, async () => {
			const id = 'yt-' + kind; await ytAdd(id);
			await until(async () => (await rows()).some(row => row.text === id), 'YT before moderation');
			await ytDelete(id, kind);
			await until(async () => !(await rows()).some(row => row.text === id), 'YT moderation');
		});
		await check('YouTube WSS ban removes matching user only', async () => {
			await ytAdd('yt-ban-one', 'Banned Viewer'); await ytAdd('yt-ban-two', 'Banned Viewer'); await ytAdd('yt-ban-keep', 'Keep Viewer');
			await until(async () => (await rows()).filter(row => row.text?.startsWith('yt-ban-')).length === 3, 'YT ban rows');
			await yt.evaluate(() => __ytAudit.response({ items: [{ id: 'ban-event', snippet: {
				type: 'userBannedEvent', publishedAt:new Date(++window.__auditTimestamp).toISOString(), userBannedDetails: { banType: 'permanent', bannedUserDetails: { channelId: 'Banned-Viewer', displayName: 'Banned Viewer' } }
			} }] }));
			await until(async () => !(await rows()).some(row => ['yt-ban-one', 'yt-ban-two'].includes(row.text)), 'YT ban');
			assert.ok((await rows()).some(row => row.text === 'yt-ban-keep'));
		});
		await check('YouTube WSS delete during background processing', async () => {
			await ytAdd('audit-slow-yt');
			await until(() => background.evaluate(() => auditStarted.includes('audit-slow-yt')), 'YT background processing started');
			await ytDelete('audit-slow-yt'); await delay(2200);
			assert.ok(!(await rows()).some(row => row.text === 'audit-slow-yt'), 'Deleted YouTube WSS message reappeared after delayed processing');
		});
		const kickCode = path.join(profile, 'kick-wss-audit.js');
		fs.writeFileSync(kickCode, fs.readFileSync(path.join(sourceRoot, 'sources/websocket/kick.js'), 'utf8') + '\nwindow.__audit = {ready: () => extensionInitialized, core: () => kickCoreReady, add: forwardChatMessage, del: forwardDeletedMessage, ban: forwardBannedUser}; void 0;');
		const kick = await mainWorld(await create({ url: base + 'sources/websocket/kick.html?ssapp=1', visible: false, wss: true, platform: 'kick', source: kickCode, filesource: base }));
		await kick.waitForFunction(() => window.__audit?.ready()); await kick.evaluate(() => __audit.core());
		async function kickAdd(id) {
			await kick.evaluate(id => __audit.add({ id, content: id, sender: { id: 7001, username: 'fixtureuser', display_name: 'Kick WSS Viewer', profile_picture: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>' } }), id);
		}
		await check('Kick WSS native IDs survive capture and targeted delete', async () => {
			await kickAdd('kick-wss-one'); await kickAdd('kick-wss-two');
			await until(async () => (await rows()).filter(row => row.text?.startsWith('kick-wss-')).length === 2, 'Kick WSS rows');
			assert.equal((await rows()).find(row => row.text === 'kick-wss-one').mid, 'kick-wss-one');
			await kick.evaluate(() => __audit.del({ message_id: 'kick-wss-one' }));
			await until(async () => !(await rows()).some(row => row.text === 'kick-wss-one'), 'Kick WSS delete');
			assert.ok((await rows()).some(row => row.text === 'kick-wss-two'));
		});
		await check('Kick WSS delete during background processing', async () => {
			await kickAdd('audit-slow-kick');
			await until(() => background.evaluate(() => auditStarted.includes('audit-slow-kick')), 'Kick background processing started');
			await kick.evaluate(() => __audit.del({ message_id: 'audit-slow-kick' })); await delay(2200);
			assert.ok(!(await rows()).some(row => row.text === 'audit-slow-kick'), 'Deleted Kick WSS message reappeared after delayed processing');
		});
		const twitchCode = path.join(profile, 'twitch-wss-audit.js');
		fs.writeFileSync(twitchCode, fs.readFileSync(path.join(sourceRoot, 'sources/websocket/twitch.js'), 'utf8').replace('\n} catch(e){\n\tconsole.error(e);\n}\n\n// --- APPEND', '\nwindow.__audit = {add: processMessage, del: pushDeleteMessage, clear: handleNormalizedClear};\n} catch(e){\n\tconsole.error(e);\n}\n\n// --- APPEND'));
		const twitch = await mainWorld(await create({ url: base + 'sources/websocket/twitch.html?ssapp=1', visible: false, wss: true, platform: 'twitch', source: twitchCode, filesource: base }));
		await twitch.waitForFunction(() => !!window.__audit);
		async function twitchAdd(id) {
			await twitch.evaluate(id => __audit.add({ prefix: 'fixtureuser!fixtureuser@fixtureuser.tmi.twitch.tv', params: ['#fixturechannel'],
				tags: { id, 'display-name': 'Twitch WSS Viewer', 'user-id': '7002', 'room-id': '7003' }, trailing: id }), id);
		}
		await check('Twitch WSS native IDs survive capture and targeted delete', async () => {
			await twitchAdd('twitch-wss-one'); await twitchAdd('twitch-wss-two');
			await until(async () => (await rows()).filter(row => row.text?.startsWith('twitch-wss-')).length === 2, 'Twitch WSS rows');
			assert.equal((await rows()).find(row => row.text === 'twitch-wss-one').mid, 'twitch-wss-one');
			await twitch.evaluate(() => __audit.del({ type: 'twitch', id: 'twitch-wss-one' }));
			await until(async () => !(await rows()).some(row => row.text === 'twitch-wss-one'), 'Twitch WSS delete');
			assert.ok((await rows()).some(row => row.text === 'twitch-wss-two'));
		});
		await check('Twitch WSS delete during background processing', async () => {
			await twitchAdd('audit-slow-twitch');
			await until(() => background.evaluate(() => auditStarted.includes('audit-slow-twitch')), 'Twitch background processing started');
			await twitch.evaluate(() => __audit.del({ type: 'twitch', id: 'audit-slow-twitch' })); await delay(2200);
			assert.ok(!(await rows()).some(row => row.text === 'audit-slow-twitch'), 'Deleted Twitch WSS message reappeared after delayed processing');
		});

        await check('YouTube WSS mock preload callback returns numeric MID', async () => {
            const reply=await yt.evaluate(()=>new Promise(resolve=>chrome.runtime.sendMessage(chrome.runtime.id,{message:{type:'youtube',chatname:'Mock Callback',chatmessage:'mock-preload-callback'}},resolve)));
            await until(async()=>(await rows()).some(r=>r.text==='mock-preload-callback'),'mock callback dock row');
            const row=(await rows()).find(r=>r.text==='mock-preload-callback');
            assert.ok(Number.isSafeInteger(reply?.id),'Mock preload callback: '+JSON.stringify(reply)+'; dock MID: '+row.mid);
            assert.equal(String(reply.id),row.mid);
        });
        await check('YouTube WSS distinct messages with identical timestamps', async () => {
            await yt.evaluate(()=>{
                const timestamp=new Date(++window.__auditTimestamp).toISOString();
                return __ytAudit.response({items:[0,1].map(i=>({id:'same-time-'+i,snippet:{type:'textMessageEvent',displayMessage:'same-time-'+i,textMessageDetails:{messageText:'same-time-'+i},publishedAt:timestamp},authorDetails:{displayName:'Same Time '+i,channelId:'same-time-user-'+i}}))});
            });
            await delay(1500);
            const received=await background.evaluate(()=>auditPackets.filter(p=>p.chatmessage?.startsWith('same-time-')).map(p=>p.chatmessage));
            assert.equal(received.length,2,'Expected both distinct messages; received '+JSON.stringify(received));
            await yt.evaluate(()=>__ytAudit.response({items:[0,1].map(i=>({id:'same-time-'+i,snippet:{type:'textMessageEvent',displayMessage:'same-time-'+i,publishedAt:new Date(window.__auditTimestamp).toISOString()},authorDetails:{displayName:'Same Time '+i,channelId:'same-time-user-'+i}}))}));
            await delay(300);
            assert.equal(await background.evaluate(()=>auditPackets.filter(p=>p.chatmessage?.startsWith('same-time-')).length),2,'Replay must not duplicate messages');
        });

        await check('Deletion during destination lookup is cancelled before relay',async()=>{
            await background.evaluate(()=>{
                window.savedAuditBttv={enabled:settings.bttv,emotes:Globalbttv,get:getBTTVEmotes};
                settings.bttv=true;Globalbttv=null;window.auditLookupStarted=false;
                getBTTVEmotes=async function(){auditLookupStarted=true;await new Promise(resolve=>{window.finishAuditLookup=resolve;});Globalbttv={};};
            });
            try {
                await ytAdd('lookup-delete-yt');
                await until(()=>background.evaluate(()=>auditLookupStarted),'destination lookup');
                await ytDelete('lookup-delete-yt');
                await background.evaluate(()=>finishAuditLookup());
                await delay(500);
                assert.ok(!(await rows()).some(row=>row.text==='lookup-delete-yt'));
            } finally {await background.evaluate(()=>{settings.bttv=savedAuditBttv.enabled;Globalbttv=savedAuditBttv.emotes;getBTTVEmotes=savedAuditBttv.get;});}
        });
        await check('Pending deletion is scoped by platform and does not suppress later messages',async()=>{
            await first.evaluate(()=>{chrome.runtime.sendMessage(chrome.runtime.id,{message:{id:'scope-unrelated-id',type:'discord',chatname:'Scoped Viewer',chatmessage:'audit-slow-scope-discord'}},()=>{});});
            await ytAdd('audit-slow-scope-yt','Scoped Viewer');
            await until(()=>background.evaluate(()=>auditStarted.includes('audit-slow-scope-yt')&&auditStarted.includes('audit-slow-scope-discord')),'scoped processing');
            await ytDelete('audit-slow-scope-yt');await delay(2100);
            assert.ok((await rows()).some(row=>row.text==='audit-slow-scope-discord'));
            assert.ok(!(await rows()).some(row=>row.text==='audit-slow-scope-yt'));
            await ytAdd('scope-after-delete','Scoped Viewer');
            await until(async()=>(await rows()).some(row=>row.text==='scope-after-delete'),'later same author');
            assert.equal(await background.evaluate(()=>pendingModeratedCaptures.size),0,'Completed/cancelled entries must be released');
        });
        await check('Mock preload dispatches both incoming listeners and continues capture',async()=>{
            await yt.evaluate(()=>{
                window.auditMockListeners=[];
                chrome.runtime.onMessage.addListener(message=>{if(message.mockListenerProbe)auditMockListeners.push('first');});
                chrome.runtime.onMessage.addListener(message=>{if(message.mockListenerProbe)auditMockListeners.push('second');});
            });
            const tab=await yt.evaluate(()=>window.__SSAPP_TAB_ID__);
            await background.evaluate(tab=>{chrome.tabs.sendMessage(tab,{mockListenerProbe:true},()=>{});},tab);
            await until(()=>yt.evaluate(()=>auditMockListeners.length===2),'mock listeners');
            assert.deepEqual(await yt.evaluate(()=>auditMockListeners),['first','second']);
            await ytAdd('after-mock-listeners');
            await until(async()=>(await rows()).some(row=>row.text==='after-mock-listeners'),'mock capture after listeners');
        });
        const featured=await mainWorld(await create({url:base+'featured.html?session='+room+'&password=false&server2&localserver&localserverport='+relayPort,visible:false}));
        await featured.waitForFunction(()=>typeof socketserver!=='undefined'&&socketserver?.readyState===1);
        await check('Delayed YouTube avatar cannot restore a deleted row or replace a newer selection', async()=>{
            await capture(first,'avatar-delay-target');
            await capture(first,'avatar-delay-keep');
            await dockEval(`window.avatarTestOriginal = toDataURL;
                window.avatarTestCallbacks = [];
                toDataURL = (url, callback) => avatarTestCallbacks.push(callback);
                var target = Array.from(document.querySelectorAll('.highlight-chat')).find(r=>r.rawContents?.chatmessage==='avatar-delay-target');
                target.rawContents.chatimg = 'https://example.invalid/avatar=s32-fixture';
                selectedMessage(false,target);`);
            try {
                await remove(first,'avatar-delay-target');
                await until(async()=>!(await rows()).some(r=>r.text==='avatar-delay-target'),'pending avatar row deleted');
                await dockEval(`selectedMessage(false,Array.from(document.querySelectorAll('.highlight-chat')).find(r=>r.rawContents?.chatmessage==='avatar-delay-keep'));
                    avatarTestCallbacks.shift()('data:image/png;base64,fixture');`);
                await until(()=>featured.evaluate(()=>document.getElementById('message')?.textContent==='avatar-delay-keep'),'newer selection preserved');
                assert.ok(!(await rows()).some(r=>r.text==='avatar-delay-target'));
            } finally { await dockEval('toDataURL = avatarTestOriginal'); }
        });
        for (const operation of ['delete-current', 'delete-pending', 'clear']) {
            await check('Pending avatar selection handles ' + operation + ' without affecting the wrong message', async () => {
                const current = 'avatar-race-' + operation + '-current';
                const pending = 'avatar-race-' + operation + '-pending';
                await capture(first, current);
                await capture(first, pending);
                await dockEval(`selectedMessage(false, Array.from(document.querySelectorAll('.highlight-chat')).find(row => row.rawContents?.chatmessage === ${JSON.stringify(current)}))`);
                await until(() => featured.evaluate(text => document.getElementById('message')?.textContent === text, current), 'current selection');
                await dockEval(`window.avatarRaceOriginal = toDataURL;
                    window.avatarRaceCallback = null;
                    toDataURL = (url, callback) => { avatarRaceCallback = callback; };
                    var row = Array.from(document.querySelectorAll('.highlight-chat')).find(row => row.rawContents?.chatmessage === ${JSON.stringify(pending)});
                    row.rawContents.chatimg = 'https://example.invalid/avatar=s32-fixture';
                    selectedMessage(false, row);`);
                try {
                    assert.equal(await dockEval('typeof avatarRaceCallback'), 'function');
                    if (operation === 'clear') await dockEval('sendDataP2P(false)');
                    else {
                        const removed = operation === 'delete-current' ? current : pending;
                        await remove(first, removed);
                        await until(async () => !(await rows()).some(row => row.text === removed), 'source deletion reaches dock');
                    }
                    await dockEval("avatarRaceCallback('data:image/png;base64,fixture')");
                    if (operation === 'clear') {
                        await until(() => featured.evaluate(() => lastMessageId === null), 'manual clear remains clear');
                    } else {
                        const expected = operation === 'delete-current' ? pending : current;
                        await until(() => featured.evaluate(text => document.getElementById('message')?.textContent === text && lastMessageId !== null, expected), 'correct selection survives');
                    }
                } finally {
                    await dockEval('toDataURL = avatarRaceOriginal');
                }
            });
        }
        await check('Dock timeout removes detached selected and auto-show queue rows', async()=>{
            await capture(first,'timeout-queue-target');
            await capture(first,'timeout-queue-keep');
            const queues = await dockEval(`(() => {
                var target = Array.from(document.querySelectorAll('.highlight-chat')).find(r=>r.rawContents?.chatmessage==='timeout-queue-target');
                var keep = Array.from(document.querySelectorAll('.highlight-chat')).find(r=>r.rawContents?.chatmessage==='timeout-queue-keep');
                target.dataset.chatname = 'Timed Out Fixture'; target.rawContents.chatname = 'Timed Out Fixture';
                selectedQueue.push(target,keep); autoShowQueue.push(target,keep); target.remove();
                processInput({timeoutUser:{username:'Timed Out Fixture',type:'youtube',duration:60}});
                var result = [selectedQueue,autoShowQueue].map(q=>({removed:!q.includes(target),kept:q.includes(keep)}));
                selectedQueue = selectedQueue.filter(r=>r!==keep); autoShowQueue = autoShowQueue.filter(r=>r!==keep);
                updateQueueButton(true); return result;
            })()`);
            assert.ok(queues.every(queue=>queue.removed&&queue.kept));
        });
        await check('Featured overlay clears a selected YouTube message when source deletes it', async()=>{
            await capture(first,'featured-delete-target');
            await dockEval("selectedMessage(false,Array.from(document.querySelectorAll('.highlight-chat')).find(r=>r.rawContents?.chatmessage==='featured-delete-target'))");
            await until(()=>featured.evaluate(()=>document.getElementById('message')?.textContent==='featured-delete-target'),'featured message');
            await remove(first,'featured-delete-target');
            await until(async()=>!(await rows()).some(r=>r.text==='featured-delete-target'),'deleted in dock');
            await delay(1500);
            await until(()=>featured.evaluate(()=>lastMessageId===null && document.getElementById('output').classList.contains(transitionType)),'featured overlay cleared');
            assert.equal(await featured.evaluate(()=>getComputedStyle(document.getElementById('output')).opacity),'0');
        });
        await check('Featured selection survives unrelated deletion and clears after its dock row is pruned',async()=>{
            await capture(first,'featured-keep'); await capture(first,'featured-unrelated');
            await dockEval("selectedMessage(false,Array.from(document.querySelectorAll('.highlight-chat')).find(r=>r.rawContents?.chatmessage==='featured-keep'))");
            await until(()=>featured.evaluate(()=>document.getElementById('message')?.textContent==='featured-keep' && !document.getElementById('output').classList.contains(transitionType)),'featured keep visible');
            await remove(first,'featured-unrelated'); await delay(400);
            assert.ok(await featured.evaluate(()=>lastMessageId!==null && !document.getElementById('output').classList.contains(transitionType)));
            await dockEval("Array.from(document.querySelectorAll('.highlight-chat')).find(r=>r.rawContents?.chatmessage==='featured-keep').remove()");
            await remove(first,'featured-keep');
            await until(()=>featured.evaluate(()=>lastMessageId===null && document.getElementById('output').classList.contains(transitionType)),'pruned featured cleared');
        });
        await check('onlyLast native-ID deletion does not choose an older featured message',async()=>{
            await kickAdd('featured-native-old');await kickAdd('featured-native-new');
            await until(async()=>(await rows()).some(r=>r.text==='featured-native-new'),'newer native row');
            await dockEval("selectedMessage(false,Array.from(document.querySelectorAll('.highlight-chat')).find(r=>r.rawContents?.chatmessage==='featured-native-old'))");
            await until(()=>featured.evaluate(()=>document.getElementById('message')?.textContent==='featured-native-old'),'old native featured');
            await kick.evaluate(()=>chrome.runtime.sendMessage(chrome.runtime.id,{delete:{type:'kick',chatname:'Kick WSS Viewer',onlyLast:true}},()=>{}));
            await delay(600);
            const list=await rows();assert.ok(list.some(r=>r.text==='featured-native-old'),'older featured row must remain');assert.ok(!list.some(r=>r.text==='featured-native-new'),'newest row must be deleted');
            assert.ok(await featured.evaluate(()=>lastMessageId!==null && !document.getElementById('output').classList.contains(transitionType)));
        });
        const standardSources = [];
        for(const type of ['twitch','kick']) {
            const page=await create({url:fixture+'?platform='+type+'&manual=1&early=1',platform:type,sourceFiles:['sources/'+type+'.js'],filesource:base,visible:false});
            standardSources.push({type, page});
            await page.waitForFunction(()=>!!window.__hiddenCaptureFixture);
            if(type==='kick') await page.evaluate(()=>{const feed=document.getElementById('chatroom');const wrapper=document.createElement('div');wrapper.id='chatroom-messages';feed.parentNode.insertBefore(wrapper,feed);wrapper.appendChild(feed);});
            await delay(6000);
            await check(type+' Standard deletion while awaiting MID preserves other same-author message',async()=>{
                const keeper=type+'-early-keep',target='audit-slow-'+type+'-standard';
                await page.evaluate(id=>__hiddenCaptureFixture.appendRows([id]),keeper);
                await until(async()=>(await rows()).some(r=>r.text==='hidden-capture message '+keeper),'standard keeper');
                await page.evaluate(id=>__hiddenCaptureFixture.appendRows([id]),target);
                await until(()=>background.evaluate(text=>auditStarted.includes(text),'hidden-capture message '+target),'standard target processing');
                await page.evaluate(({type,target})=>{const row=document.getElementById('ssn-hidden-capture-'+target); if(type==='twitch')row.classList.add('chat-line__message--deleted-notice');else{const mark=document.createElement('span');mark.className='deleted-message';row.appendChild(mark);}}, {type,target});
                await delay(2300);
                const current=await rows();
                const kept=current.some(r=>r.text==='hidden-capture message '+keeper),removed=!current.some(r=>r.text==='hidden-capture message '+target);
                assert.ok(kept&&removed,JSON.stringify({keeperRetained:kept,deletedTargetAbsent:removed}));
            });
        }
        await check('Standard source MIDs and moderation survive a 35-second Event Flow delay', async () => {
            const previousFlows = await background.evaluate(() => {
                const previous = eventFlowSystem.flows;
                eventFlowSystem.flows = [{ id: 'mid-long-delay', active: true, nodes: [
                    { id: 'trigger', type: 'trigger', triggerType: 'anyMessage', config: {} },
                    { id: 'delay', type: 'action', actionType: 'delay', config: { delayMs: 35000 } }
                ], connections: [{ from: 'trigger', to: 'delay' }] }];
                return previous;
            });
            const captures = [];
            try {
                for (const {type, page} of [{type: 'youtube', page: first}, ...standardSources]) {
                    for (const deleted of [true, false]) {
                        const key = 'long-delay-' + type + (deleted ? '-deleted' : '-keep');
                        if (type === 'youtube') await insert(page, key);
                        else await page.evaluate(id => __hiddenCaptureFixture.appendRows([id]), key);
                        const text = type === 'youtube' ? key : 'hidden-capture message ' + key;
                        const mid = Number(await until(() => page.evaluate(({type, key}) => {
                            const row = type === 'youtube' ? document.querySelector('[data-fixture-key="' + key + '"]')
                                : document.getElementById('ssn-hidden-capture-' + key);
                            return row?.dataset.mid;
                        }, {type, key}), type + ' MID before processing completes', 3000));
                        assert.ok(Number.isSafeInteger(mid) && mid > 0);
                        assert.equal(await background.evaluate(mid => [...pendingModeratedCaptures].some(p => p.message.id === mid), mid), true);
                        assert.ok(!(await rows()).some(row => row.text === text), 'MID acknowledgement must precede delayed delivery');
                        captures.push({type, page, key, text, mid, deleted});
                    }
                }
                const ids = captures.map(item => item.mid);
                assert.equal(new Set(ids).size, ids.length);
                assert.ok(ids.every((id, index) => index === 0 || id > ids[index - 1]));
                // Cross the preload's 30-second timeout using real time, then moderate.
                await delay(31000);
                for (const {type, page, key, deleted} of captures) {
                    if (!deleted) continue;
                    if (type === 'youtube') await remove(page, key);
                    else await page.evaluate(({type, key}) => {
                        const row = document.getElementById('ssn-hidden-capture-' + key);
                        if (type === 'twitch') row.classList.add('chat-line__message--deleted-notice');
                        else { const mark = document.createElement('span'); mark.className = 'deleted-message'; row.appendChild(mark); }
                    }, {type, key});
                }
                await until(() => background.evaluate(() => pendingModeratedCaptures.size === 0), 'delayed processing settles', 12000);
                await until(async () => {
                    const current = await rows();
                    return captures.filter(c => !c.deleted).every(c => current.some(r => r.text === c.text));
                }, 'unmoderated messages delivered');
                const current = await rows();
                for (const capture of captures) {
                    const row = current.find(row => row.text === capture.text);
                    if (capture.deleted) assert.ok(!row, capture.type + ' deleted message must not reappear');
                    else assert.equal(Number(row.mid), capture.mid, 'Delivery must keep the acknowledged MID');
                }
                return { sources: 3, uniqueMIDs: ids.length, delaySeconds: 35 };
            } finally {
                await background.evaluate(flows => { eventFlowSystem.flows = flows; }, previousFlows);
            }
        });
        // --quick omits only the three-minute sustained capture check.
        if (!process.argv.includes('--quick')) await check('Mixed YouTube Standard and WSS sustained capture, MID uniqueness and relay reconnection',async()=>{
            const second=await source(99);
            const started=Date.now();
            for(let batch=0;batch<60;batch++) {
                await Promise.all([first,second].map((page,windowIndex)=>page.evaluate(({batch,windowIndex})=>{
                    for(let i=0;i<5;i++) {
                        const key='soak-dom-'+batch+'-'+windowIndex+'-'+i;
                        const row=document.createElement('yt-live-chat-text-message-renderer'); row.id=key+'-native-youtube-id-longer-than-forty-characters'; row.dataset.fixtureKey=key;
                        row.innerHTML='<span id="author-name">Soak Viewer</span><span id="message">'+key+'</span>'; document.getElementById('items').appendChild(row);
                    }
                },{batch,windowIndex})));
                await yt.evaluate(batch=>__ytAudit.response({items:Array.from({length:10},(_,i)=>{const id='soak-wss-'+batch+'-'+i; return {id,snippet:{type:'textMessageEvent',displayMessage:id,textMessageDetails:{messageText:id},publishedAt:new Date(++window.__auditTimestamp).toISOString()},authorDetails:{displayName:'Soak WSS Viewer',channelId:'soak-wss'}};})}),batch);
                if(batch===30) {
                    await dockEval('socketserverExtension.close()');
                    await until(()=>dockEval("socketserverExtension?.readyState===1"),'dock reconnect');
                }
                if(batch%10===0)console.log('SOAK progress',batch,'batches',Date.now()-started,'ms');
                await delay(3000);
            }
            await until(()=>background.evaluate(()=>auditPackets.filter(p=>p.chatmessage?.startsWith('soak-')).length===1200),'1200 mixed messages',30000);
            const packets=await background.evaluate(()=>auditPackets.filter(p=>p.chatmessage?.startsWith('soak-')).map(p=>({id:p.id,text:p.chatmessage})));
            const ids=packets.map(p=>p.id); assert.ok(ids.every(Number.isSafeInteger));assert.equal(new Set(ids).size,1200);assert.equal(new Set(packets.map(p=>p.text)).size,1200);
            const sorted=ids.slice().sort((a,b)=>a-b);assert.equal(sorted.at(-1)-sorted[0]+1,1200,'No extra allocations or gaps during soak');
            let sourceRows=[];for(const page of [first,second])sourceRows.push(...await page.evaluate(()=>[...document.querySelectorAll('[data-fixture-key^="soak-dom-"]')].map(r=>({text:r.dataset.fixtureKey,mid:Number(r.dataset.mid)}))));
            assert.equal(sourceRows.length,600);const byText=new Map(packets.map(p=>[p.text,p.id]));assert.ok(sourceRows.every(r=>r.mid===byText.get(r.text)),'Every source DOM row got matching background MID');
            await until(async()=>(await rows()).some(r=>r.text==='soak-wss-59-9'),'dock receiving after reconnect');
            return {messages:1200,dom:600,wss:600,durationSeconds:Math.round((Date.now()-started)/1000),firstMID:sorted[0],lastMID:sorted.at(-1),sourceCallbacksMatched:600};
        });
		console.log('Moderation/MID regression:', results.filter(r=>r.pass).length + '/' + results.length + ' passed');
	} finally { if (app) await app.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
