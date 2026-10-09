// Real Electron layout and Windows printer capabilities; output goes only to PDFs.
'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-thermal-layout-'));
const printerName = process.env.SSAPP_THERMAL_TEST_PRINTER || 'POS-58';
(async () => {
 let app;
 try {
  const wrapper = path.join(dir, 'bootstrap.cjs');
  fs.writeFileSync(wrapper, `globalThis.testRequire=require;const {app}=require('electron');app.whenReady().then(()=>{new(require('electron').BrowserWindow)({show:false}).loadURL('about:blank')});`);
  app = await _electron.launch({executablePath:require('electron'),args:[wrapper,'--no-hwa'],env:{...process.env,SSAPP_USER_DATA_DIR:dir}});
  const results = await app.evaluate(async ({BrowserWindow}, args) => {
   const {ElectronThermalPrinter} = globalThis.testRequire(args.module);
   const fs = globalThis.testRequire('fs');
   const captures = [];
   class PDFWindow {
    constructor(options) {
     const window = new BrowserWindow(options);
     window.webContents.print = (printOptions, callback) => {
      (async () => {
       const metrics = await window.webContents.executeJavaScript(`(() => { const root=document.getElementById('ssapp-thermal-print-root'); const rect=root.getBoundingClientRect(); const style=getComputedStyle(root); return {width:rect.width,height:rect.height,left:style.paddingLeft,right:style.paddingRight,scrollWidth:root.scrollWidth}; })()`);
       // Simulate a PDF page with the real driver's imageable width, without ever
       // sending a job to Windows. The production document keeps its safe padding.
       const pdf = await window.webContents.printToPDF({pageSize:{width:metrics.width/96,height:printOptions.pageSize.height/25400},margins:{top:0,right:0,bottom:0,left:0},preferCSSPageSize:false,printBackground:true});
       fs.writeFileSync(args.dir+'/receipt-'+captures.length+'.pdf',pdf);
       captures.push({printOptions,metrics}); callback(true);
      })().catch(error=>callback(false,error.message));
     };
     return window;
    }
   }
   const printer = new ElectronThermalPrinter({BrowserWindow:PDFWindow});
   const html = '<div style="font:12pt monospace;white-space:pre-wrap">SSN MARGIN TEST\nThis deliberately long receipt line must wrap within the print head.\nEND OF RECEIPT</div>';
   const first = await printer.print(html,{printerName:args.printer,width:'58mm',marginLeft:'2mm',marginRight:'2mm'});
   const second = await printer.print(html,{printerName:args.printer,width:'58mm',marginLeft:'6mm',marginRight:'6mm'});
   const none = await printer.print(html,{printerName:args.printer,width:'58mm',marginType:'none',marginLeft:'2mm',marginRight:'2mm'});
   printer.stop();
   return {first,second,none,captures};
  },{module:path.join(root,'resources/electron-thermal-printer.js'),dir,printer:printerName});
  assert(results.first.printableWidthMicrons <= results.first.widthMicrons);
  assert(results.first.printableWidthMicrons < 50000, 'POS-58 imageable width must reflect its 384-dot print head');
  for(const capture of results.captures.slice(0,2)) {
   assert(capture.metrics.width < 190,'Receipt layout must fit the actual print head, not the 580px helper window');
   assert.equal(capture.metrics.scrollWidth,Math.round(capture.metrics.width));
   assert(capture.printOptions.pageSize.height >= capture.metrics.height*25400/96);
  }
  assert(results.captures[1].metrics.height > results.captures[0].metrics.height,'Larger margins must reflow text and increase requested paper length');
  assert(Math.abs(parseFloat(results.captures[0].metrics.left)-2*96/25.4)<0.02);
  assert(Math.abs(parseFloat(results.captures[1].metrics.right)-6*96/25.4)<0.02);
  assert.equal(results.none.printableWidthMicrons,58000);
  assert.equal(results.captures[2].printOptions.margins.marginType,'none');
  fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({passed:true,dir,...results},null,2));
 } finally { if(app) await app.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
