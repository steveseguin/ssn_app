'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-flow-fallback-'));
    fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({streamID:'flowfallback'+Date.now(),password:'false',state:false,settings:{},wsServer:false}));
    const launch = () => _electron.launch({executablePath:require('electron'),cwd:root,args:[path.join(__dirname,'outage-bootstrap.js'),'--multiinstance','--no-hwa'],env:{...process.env,SSAPP_USER_DATA_DIR:profile,SSAPP_PREFER_LOCAL_ASSETS:'0'}});
    let app = await launch();
    try {
        let main = await app.firstWindow();
        async function background(protocol) {
            for(let n=0;n<200;n++) {
                const frame=main.frames().find(f=>f.url().startsWith(protocol)&&f.url().includes('/background.html'));
                try { if(frame&&await frame.evaluate(()=>window.eventFlowSystem&&window.eventFlowSystem.db)) return frame; } catch(_) {}
                await delay(250);
            }
            throw Error('Background did not initialize: '+protocol);
        }
        await background('file:');
        await app.evaluate(()=>global.__outage.phase='online');
        await main.reload({waitUntil:'domcontentloaded'});
        let remote=await background('https:');
        await remote.evaluate(async()=>{await window.eventFlowSystem.saveFlow({id:'fallback-flow',name:'Keep this saved flow',active:false,nodes:[],connections:[]});});
        console.log('Remote readiness',await remote.evaluate(()=>({url:location.href,ready:document.readyState,background:typeof window.processIncomingMessage,sanitizer:typeof window.filterXSS})));
        console.log('Parent view',await main.evaluate(()=>{const f=document.getElementById('frame2');try{return{src:f.src,href:f.contentWindow.location.href,background:typeof f.contentWindow.processIncomingMessage,sanitizer:typeof f.contentWindow.filterXSS}}catch(e){return{src:f.src,error:e.message}}}));
        await delay(17000);
        console.log('Settled frame',await main.evaluate(()=>document.getElementById('frame2').src));
        assert(remote.url().startsWith('https:'),'Healthy remote background stays remote');
        const before=await remote.evaluate(()=>({url:location.href,flows:JSON.parse(JSON.stringify(eventFlowSystem.flows))}));
        await app.evaluate(()=>global.__outage.phase='partial');
        await main.reload({waitUntil:'domcontentloaded'});
        const local=await background('file:');
        const after=await local.evaluate(()=>({url:location.href,flows:eventFlowSystem.flows.map(f=>f.id)}));
        await main.screenshot({path:path.join(profile,'fallback.png')});
        await app.evaluate(()=>global.__outage.phase='online');
        await main.reload({waitUntil:'domcontentloaded'});
        remote=await background('https:');
        const recovered=await remote.evaluate(()=>({url:location.href,flows:JSON.parse(JSON.stringify(eventFlowSystem.flows))}));
        // HTTPS and file:// have separate stores. Never merge/overwrite them or
        // interpret an empty offline store as deletion of the online records.
        assert.deepStrictEqual(recovered.flows,before.flows,'Original saved flow survives genuine fallback unchanged');
        await app.close();
        app=await launch(); main=await app.firstWindow();
        await background('file:');
        await app.evaluate(()=>global.__outage.phase='online');
        await main.reload({waitUntil:'domcontentloaded'});
        remote=await background('https:');
        await delay(17000);
        assert(remote.url().startsWith('https:'),'Restart does not falsely switch to offline storage');
        const restarted=await remote.evaluate(()=>JSON.parse(JSON.stringify(eventFlowSystem.flows)));
        assert.deepStrictEqual(restarted,before.flows,'Saved flows persist across closing and restarting the app');
        const report={before,after,recovered,restarted};fs.writeFileSync(path.join(profile,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
        console.log('PASS healthy remote stability, genuine fallback without deletion, reconnect and restart persistence');
    } finally { console.log('Evidence: '+profile);await app.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
