// Experimental read-only transport probe; never forwards network packets to overlays.
'use strict';
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '../..');
const req = createRequire(root + '/package.json');
const { _electron } = req('playwright-core');
const { waitFor } = req('./tests/electron/tiktok-disconnect-validation-e2e');
const out = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ssapp-browser-probe-'));
const profile = path.join(out, 'profile');
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'savedSync.json'), JSON.stringify({streamID:'browser_probe_' + Date.now(),state:true,settings:{}}));
const users = (process.env.SSAPP_PROBE_USERS || 'zachooh,hunterhalifaxx').split(',');
if(users.some(u => !/^[a-z0-9_.]+$/i.test(u) || /camcam66gaming/i.test(u))) throw new Error('Invalid or excluded channel');
const report = {mode:'Real SSApp Standard windows, passive browser WebSocket decoding alongside existing DOM capture',cases:[]};
(async () => {
 let app, log='';
 try {
  app=await _electron.launch({executablePath:req('electron'),cwd:root,args:['.','--running-from-source','--multiinstance','--filesource='+pathToFileURL(path.resolve(root, '../social_stream') + path.sep).href],env:{...process.env,SSAPP_USER_DATA_DIR:profile},timeout:60000});
  for(const s of [app.process().stdout,app.process().stderr]) s.on('data',b=>{log=(log+b).slice(-120000);});
  const main=await app.firstWindow();
  await main.waitForFunction(()=>window.stateManager?.initialized && configReady);
  await main.waitForTimeout(6000);
  await main.evaluate(()=>{config.tiktok={...config.tiktok,websocketMonitoring:'tiktok.com'};});
  await app.evaluate(({app},root)=>{
   const req=process.getBuiltinModule('module').createRequire(root+'/package.json');
   const {deserializeWebSocketMessage}=req('tiktok-live-connector');
   global.__browserProbe={};
   app.on('web-contents-created',(_event,wc)=>{
    const sockets=new Map();
    let queue=Promise.resolve();
    wc.debugger.on('message',(_event,method,params)=>{
     if(method==='Network.webSocketCreated'){
      let url;try{url=new URL(params.url);}catch(_){return;}
      if(!url.hostname.endsWith('.tiktok.com') || !url.pathname.startsWith('/webcast/im/') || !/^https:\/\/www\.tiktok\.com\/@[^/]+\/live/.test(wc.getURL()))return;
      const data=global.__browserProbe[wc.id] ||= {url:wc.getURL(),sockets:[],frames:0,decodedFrames:0,decodeErrors:0,types:{},duplicates:0,chatShape:null};
      const socket={endpoint:url.origin+url.pathname,requestId:params.requestId,openedAt:Date.now(),frames:0};
      data.sockets.push(socket);sockets.set(params.requestId,{socket,data,ids:new Set()});
     } else if(method==='Network.webSocketClosed'){
      const s=sockets.get(params.requestId);if(s)s.socket.closedAt=Date.now();
     } else if(method==='Network.webSocketFrameReceived'){
      const s=sockets.get(params.requestId);if(!s || params.response.opcode!==2)return;
      s.data.frames++;s.socket.frames++;
      const body=Buffer.from(params.response.payloadData,'base64');
      queue=queue.then(async()=>{
       try {
        const frame=await deserializeWebSocketMessage(body);
        const messages=frame.protoMessageFetchResult?.messages;
        if(!messages)return;
        s.data.decodedFrames++;
        for(const m of messages){
         const type=m.decodedData?.type || m.type || m.method || 'unknown';
         s.data.types[type]=(s.data.types[type]||0)+1;
         if(m.decodeError){s.data.decodeErrors++;continue;}
         if(type==='WebcastChatMessage'){
          const d=m.decodedData?.data;
          const id=String(d?.common?.msgId || m.msgId || '');
          if(id && s.ids.has(id))s.data.duplicates++;
          if(id)s.ids.add(id);
          if(!s.data.chatShape)s.data.chatShape={hasText:typeof d?.content==='string',hasUser:!!d?.user,hasMessageId:!!id,keys:Object.keys(d||{}).slice(0,30)};
         }
        }
       }catch(error){s.data.decodeErrors++;s.data.lastDecodeError=error.message.slice(0,180);}
      });
     }
    });
   });
  },root);
  const bg=main.frames().find(f=>f.url().includes('background.html'));
  if(bg)await bg.evaluate(()=>{
   window.__probeDOM={};const original=processIncomingMessage;
   processIncomingMessage=function(data){if(data?.type==='tiktok'){const kind=data.event||'chat';window.__probeDOM[kind]=(window.__probeDOM[kind]||0)+1;}return original.apply(this,arguments);};
  });
  for(const username of users){
   const entry={username,samples:[]};report.cases.push(entry);
   const id=await main.evaluate(username=>stateManager.addSource({target:'tiktok',username,url:`https://www.tiktok.com/@${username}/live`,connectionMode:'classic',autoActivate:false,isVisible:true,isMuted:true}),username);
   const beforeWindows=new Set(app.windows());
   await main.locator(`[data-source-id="${id}"] [data-activatehtml]`).press('Enter');
   let source;
   await waitFor(()=>{source=app.windows().find(p=>!beforeWindows.has(p));return !!source;},'TikTok source window',20000);
   console.log('OPEN',username);
   for(let step=1;step<=6;step++){
    await main.waitForTimeout(20000);
    const network=await app.evaluate(()=>global.__browserProbe);
    const dom=bg ? await bg.evaluate(()=>window.__probeDOM).catch(()=>null):null;
    const sample={seconds:step*20,network,dom};entry.samples.push(sample);
    console.log('SAMPLE',username,JSON.stringify(sample));
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
   }
   entry.page=await source.evaluate(()=>({url:location.href,title:document.title,text:document.body.innerText.slice(0,2500)})).catch(()=>null);
   entry.network=await app.evaluate(()=>global.__browserProbe);
   await main.locator(`[data-source-id="${id}"] [data-stophtml]`).press('Enter');
   await waitFor(()=>source.isClosed(),'source Stop',15000);
   entry.stopped=true;
   await app.evaluate(()=>{global.__browserProbe={};});
   if(bg)await bg.evaluate(()=>{window.__probeDOM={};});
   fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  }
 }catch(error){report.error=error.stack;console.error(error);process.exitCode=1;}
 finally{
  if(app){const child=app.process();await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>/\/index\.html/.test(w.webContents.getURL()));if(w)w.close();}).catch(()=>{});await waitFor(()=>child.exitCode!==null||child.signalCode!==null,'shutdown',10000).catch(()=>child.kill());await app.close().catch(()=>{});}
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(out,'electron.log'),log);console.log('Evidence:',out);
 }
})();
