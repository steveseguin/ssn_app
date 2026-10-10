'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname,'../..');
const output = fs.mkdtempSync(path.join(os.tmpdir(),'ssapp-tts-settings-'));
const sink = 'ssapp_settings_' + process.pid;
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 let app, moduleId, recorder;
 const report={output,previews:[],screens:[]};
 console.log(output);
 try {
  moduleId=execFileSync('pactl',['load-module','module-null-sink','sink_name='+sink],{encoding:'utf8'}).trim();
  app=await _electron.launch({executablePath:require('electron'),cwd:root,args:['.','--running-from-source','--filesource=file://'+path.resolve(root,'../social_stream')+'/','--multiinstance','--no-sandbox','--ozone-platform=x11'],env:{...process.env,PULSE_SINK:sink,SSAPP_USER_DATA_DIR:path.join(output,'profile')},timeout:60000});
  const main=await app.firstWindow();await main.waitForFunction(()=>typeof configReady!=='undefined'&&configReady);
  await main.evaluate(()=>ensurePopupPanelLoaded());
  if (await main.locator('#popup-handle').getAttribute('aria-expanded') !== 'true') await main.locator('#popup-handle').press('Enter');
  let frame;for(let i=0;i<100;i++){frame=main.frames().find(f=>f.url().includes('/popup.html'));if(frame)break;await sleep(100);}
  await frame.waitForFunction(()=>typeof TTSManager!=='undefined'&&!!document.querySelector('#ttsTestContainer .tts-test-button'));
  const win=await app.browserWindow(main);await win.evaluate(w=>w.setSize(1366,1000));
  await frame.locator('#wrapper-chat-message-tts-options').press('Space');
  for(const provider of ['system','espeak','piper','kokoro','kitten']){
   await frame.locator('#ttsProvider').selectOption(provider);
   const chunks=[];recorder=spawn('parec',['--device='+sink+'.monitor','--raw','--format=s16le','--rate=24000','--channels=1','--latency-msec=20']);recorder.stdout.on('data',b=>chunks.push(b));
   await frame.locator('#ttsTestContainer .tts-test-button').click();
   await frame.waitForFunction(()=>!TTSManager.premiumQueueActive&&document.querySelector('#ttsTestContainer').innerText.includes('Audio played'),null,{timeout:120000});
   await sleep(400);recorder.kill();await new Promise(resolve=>recorder.once('close',resolve));recorder=null;
   const data=Buffer.concat(chunks);let peak=0;for(let i=0;i+1<data.length;i+=2)peak=Math.max(peak,Math.abs(data.readInt16LE(i)/32768));
   assert(peak>.01,provider+' preview produced no audible output');
   report.previews.push({provider,peak});console.log('PASS preview '+provider+' peak '+peak);
   if(['system','espeak'].includes(provider)){
    await frame.locator('#ttsTestContainer .tts-test-button').click();await frame.locator('#ttsTestContainer .tts-test-cancel-button').click();
    assert.equal(await frame.evaluate(()=>TTSManager.premiumQueueActive),false,'cancel resets the preview');
    await sleep(1500);assert.equal(await frame.evaluate(()=>!!TTSManager.activeAudioElement),false,'cancelled synthesis must not start late audio');
   }
  }
  for(const lang of ['en-us','de','fr','es','pt-br','cs','uk','tr','ar','th','zh-CN','zh-TW']){
   await frame.evaluate(lang=>applyPopupTranslationLanguageImmediately(lang),lang);
   await frame.waitForFunction(lang=>document.documentElement.lang===lang,lang);
   for(const theme of ['light','dark']){
    await app.evaluate(({nativeTheme},theme)=>nativeTheme.themeSource=theme,theme);
    await main.emulateMedia({colorScheme:theme});
    assert.equal(await frame.evaluate(()=>matchMedia('(prefers-color-scheme: dark)').matches),theme==='dark');
    for(const provider of ['kokoro','kitten']){
     await frame.locator('#ttsProvider').selectOption(provider);
     await frame.evaluate(provider=>{for(const el of document.querySelectorAll('#'+provider+'TTS details'))el.open=true;},provider);
     await frame.locator('#'+provider+'TTS').scrollIntoViewIfNeeded();
     await sleep(150);
     const name=lang+'-'+theme+'-'+provider;
     const metrics=await frame.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,heading:document.querySelector('#kokoroTTS summary').textContent}));
     assert(metrics.scrollWidth<=metrics.width+1,name+' horizontal overflow');
     fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(await win.evaluate(async w=>(await w.capturePage()).toPNG().toString('base64')),'base64'));
     report.screens.push({name,...metrics});
    }
   }
  }
  // The selected engine is saved through the app's normal settings path.
  await frame.locator('#ttsProvider').selectOption('espeak');await sleep(1000);
  await main.reload();await main.waitForFunction(()=>typeof configReady!=='undefined'&&configReady);
  frame=undefined;
  for(let i=0;i<100;i++){frame=main.frames().find(f=>f.url().includes('/popup.html'));if(frame)break;await sleep(100);}
  await frame.waitForFunction(()=>document.querySelector('#ttsProvider')?.value==='espeak');
  report.persistence=true;
 } catch(error){report.error=error.stack;throw error;}
 finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));if(recorder)recorder.kill();if(app)await app.close();if(moduleId)execFileSync('pactl',['unload-module',moduleId]);}
 console.log('PASS real settings previews, cancellation, translated themes and persistence');
})().catch(error=>{console.error(error);process.exitCode=1;});
