'use strict';
// Real SSApp dock playback measured at a dedicated PipeWire/PulseAudio sink.
// No speech, media playback, inference, or network requests are mocked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const output = process.env.SSAPP_TTS_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-linux-tts-'));
fs.mkdirSync(output, { recursive: true });
const sink = 'ssapp_test_' + process.pid;
const bundled = process.env.SSAPP_TEST_BUNDLED === '1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { results: [], output };
const cases = [
 { name: 'system', provider: 'system' },
 { name: 'espeak', provider: 'espeak' },
 ...['en_US-hfc_female-medium','en_US-amy-medium','en_US-danny-low','en_US-ryan-high','en_GB-alan-low','en_GB-alba-medium','es_ES-davefx-medium','es_MX-ald-medium','pt_BR-edresson-low','pt_BR-faber-medium','pt_PT-tugão-medium'].map(voice => ({ name: 'piper-' + voice, provider: 'piper', settings: {voice} })),
 { name: 'kokoro-native', provider: 'kokoro', settings: { voiceName: 'af_heart' } },
 { name: 'kitten-legacy', provider: 'kitten', settings: { model: 'legacy' } },
 ...['nano','micro','mini'].map(model => ({ name: 'kitten-' + model, provider: 'kitten', settings: { model, voice: 'Bella', device: 'wasm' } })),
 { name: 'kokoro-worker', provider: 'kokoro', settings: { background: true, voiceName: 'af_heart', device: 'wasm' } },
 { name: 'kokoro-full', provider: 'kokoro', settings: { background: true, voiceName: 'af_heart', device: 'wasm', dtype: 'fp32' } },
 { name: 'kokoro-stream', provider: 'kokoro', settings: { stream: true, voiceName: 'af_heart', device: 'wasm' } },
 ...(process.env.SSAPP_TTS_GPU === '1' ? [
  { name: 'kokoro-gpu', provider: 'kokoro', settings: { background: true, voiceName: 'af_heart', device: 'webgpu', dtype: 'fp16' } },
  { name: 'kokoro-auto', provider: 'kokoro', settings: { background: true, voiceName: 'af_heart', device: 'auto', dtype: 'auto' } }
 ] : []),
];
(async () => {
 if (process.platform !== 'linux') throw new Error('This audio monitor test requires Linux and pactl/parec.');
 const selected = cases.filter(test => !process.env.SSAPP_TTS_CASES || process.env.SSAPP_TTS_CASES.split(',').includes(test.name));
 if (!selected.length) throw new Error('No matching TTS test cases.');
 let app, moduleId, recorder;
 try {
  moduleId = execFileSync('pactl', ['load-module', 'module-null-sink', 'sink_name=' + sink], {encoding:'utf8'}).trim();
  app = await _electron.launch({ executablePath: process.env.SSAPP_TEST_EXECUTABLE || require('electron'), cwd: root,
   args: [...(process.env.SSAPP_TEST_EXECUTABLE ? [] : ['.']), ...(bundled ? ['--preferlocalassets'] : ['--running-from-source', '--filesource=' + pathToFileURL(path.resolve(root,'../social_stream') + '/').href]),
    '--multiinstance','--no-sandbox','--ozone-platform=' + (process.env.SSAPP_TEST_OZONE || 'x11')],
   env: {...process.env, PULSE_SINK:sink, SSAPP_USER_DATA_DIR:process.env.SSAPP_TTS_PROFILE || path.join(output,'profile')}, timeout:60000 });
  const main = await app.firstWindow();
  await main.waitForFunction(() => window.stateManager?.initialized && typeof configReady !== 'undefined' && configReady);
  report.runtime = await app.evaluate(() => ({electron:process.versions.electron, platform:process.platform}));
  for (const test of selected) {
   const started = Date.now();
   const result = {name:test.name, passed:false, errors:[]};
   let page;
   try {
    const base = bundled ? (await main.evaluate(() => window.ssappFallback.resolveUrl('dock.html', {branch:'main'}))).url : pathToFileURL(path.resolve(root,'../social_stream/dock.html')).href;
    const url = base + '?session=tts_test&speech';
    const pending = app.waitForEvent('window');
    await main.evaluate(url => ipcRenderer.sendSync('createWindow', {url, visible:true, muted:false}), url);
    page = await pending;
    page.on('console', message => { if(message.type()==='error') result.errors.push(message.text().slice(0,500)); });
    await page.waitForLoadState('load');
    const cdp = await app.context().newCDPSession(page);
    const evaluate = async (fn, arg) => {
     const r = await cdp.send('Runtime.evaluate', {expression:`(${fn.toString()})(${JSON.stringify(arg)})`,awaitPromise:true,returnByValue:true});
     if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
     return r.result.value;
    };
    for(let i=0;i<100;i++) { if(await evaluate(()=>typeof TTS!=='undefined' && typeof TTS.speak==='function')) break; await pause(100); }
    await evaluate(async test => {
     window.ttsEvents=[];
     if (test.settings && (test.settings.background || test.settings.stream || ['nano','micro','mini'].includes(test.settings.model))) {
      await import('./shared/tts/neural-client.js');
      const speak = SSNNeuralTTS.Client.prototype.speak;
      SSNNeuralTTS.Client.prototype.speak = async function(...args) {
       const result = await speak.apply(this,args);
       ttsEvents.push({event:'ended',at:performance.now()});
       return result;
      };
     }
     const play = HTMLMediaElement.prototype.play;
     HTMLMediaElement.prototype.play = function(...args) {
      ttsEvents.push({event:'play',at:performance.now()});
      this.addEventListener('ended',()=>ttsEvents.push({event:'ended',at:performance.now()}),{once:true});
      return play.apply(this,args);
     };
     TTS.TTSProvider=test.provider; TTS.speech=true; TTS.volume=0.7;
     if(test.settings) Object.assign(TTS[test.provider+'Settings'],test.settings);
    },test);
    const chunks=[];
    recorder=spawn('parec',['--device='+sink+'.monitor','--raw','--format=s16le','--rate=24000','--channels=1','--latency-msec=20'],{stdio:['ignore','pipe','pipe']});
    recorder.stdout.on('data',b=>chunks.push(b));
    await pause(300);
    await evaluate(()=>{TTS.speak('First speech playback check.',true); TTS.speak('Second speech playback check.',true);});
    const deadline=Date.now()+300000;
    let state;
    while(Date.now()<deadline) {
     await pause(500);
     state=await evaluate(()=>({active:!!TTS.premiumQueueActive, speaking:speechSynthesis.speaking, queued:TTS.premiumQueueTTS?.length||0, events:ttsEvents, status:TTS.neuralStatus, device:TTS.kokoroDevice, dtype:TTS.kokoroDtype, voices:speechSynthesis.getVoices().length}));
     if(Date.now()-started>5000 && !state.active && !state.speaking && !state.queued) break;
    }
    await pause(500);
    recorder.kill(); await new Promise(resolve=>recorder.once('close',resolve)); recorder=null;
    const pcm=Buffer.concat(chunks); let peak=0, sum=0, nonzero=0;
    for(let i=0;i+1<pcm.length;i+=2){const v=pcm.readInt16LE(i)/32768;peak=Math.max(peak,Math.abs(v));sum+=v*v;if(Math.abs(v)>.001)nonzero++;}
    result.audio={seconds:pcm.length/48000,peak,rms:Math.sqrt(sum/(pcm.length/2)),audibleSamples:nonzero};
    result.state=state;
    result.passed=peak>.01 && nonzero>2400 && !state.active && !state.speaking && !state.queued && state.events.filter(e=>e.event==='ended').length===2;
    fs.writeFileSync(path.join(output,test.name+'.pcm'),pcm);
    fs.writeFileSync(path.join(output,test.name+'.png'),await (await app.browserWindow(page)).evaluate(async w=>(await w.capturePage()).toPNG()));
   } catch(error) {result.error=error.stack;}
   finally {if(recorder){recorder.kill();recorder=null;} if(page){const w=await app.browserWindow(page);await w.evaluate(w=>w.destroy()).catch(()=>{});}}
   result.elapsedMs=Date.now()-started;report.results.push(result);
   fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
   console.log(JSON.stringify(result));
  }
 } finally {if(recorder)recorder.kill();if(app)await app.close();if(moduleId)execFileSync('pactl',['unload-module',moduleId]);}
 console.log('Report: '+output);
 if(report.results.some(r=>!r.passed))process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
