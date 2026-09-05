'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { _electron } = require('playwright-core');

async function run() {
	const root = path.resolve(__dirname, '../..');
	const profile = process.env.SSAPP_TEST_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-practical-'));
	fs.mkdirSync(profile, {recursive: true});
	const output = process.env.SSAPP_TEST_OUTPUT || '/tmp/ssapp-practical-results';
	fs.mkdirSync(output, {recursive: true});
	const server = http.createServer((req,res) => {
		res.setHeader('Content-Type', 'text/html');
		res.end('<!doctype html><title>SSApp live capture fixture</title><style>body{background:#152238;color:white;font:22px system-ui;padding:30px}li{padding:8px}</style><h1>Live source window</h1><p>Messages update every second.</p><ul id="chat"></ul><script>window.ticks=0;setInterval(()=>{ticks++;let li=document.createElement("li");li.textContent="Viewer "+ticks+": Linux capture is running";chat.prepend(li);if(chat.children.length>12)chat.lastChild.remove()},1000)</script>');
	});
	await new Promise(r=>server.listen(0,'127.0.0.1',r));
	const url = `http://127.0.0.1:${server.address().port}/`;
	let app;
	const metrics=[];
	try {
		for (let launch=0;launch<Number(process.env.SSAPP_TEST_LAUNCHES || 5);launch++) {
			app=await _electron.launch({executablePath:process.env.SSAPP_TEST_APP || require('electron'),cwd:root,
				args:[...(process.env.SSAPP_TEST_APP ? [] : ['.','--running-from-source','--filesource',path.resolve(root,'../social_stream')+'/']), '--multiinstance','--no-hwa','--no-sandbox',`--ozone-platform=${process.env.SSAPP_TEST_OZONE || 'x11'}`],
				env:{...process.env,SSAPP_USER_DATA_DIR:profile,SSAPP_PREFER_LOCAL_ASSETS:process.env.SSAPP_TEST_APP?'1':'0'},timeout:60000});
			const page=await app.firstWindow();
			const screenshot = async name => {
				const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).webContents.capturePage()).toPNG().toString('base64'));
				assert.ok(png.length>1000, 'Empty main-window screenshot');
				fs.writeFileSync(path.join(output,name),Buffer.from(png,'base64'));
			};
			await page.waitForFunction(()=>window.stateManager?.initialized,null,{polling:100});
			await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).setSize(1440,1000));
			if(process.env.SSAPP_TEST_EXPECT_EXISTING === '1') assert.ok(await page.evaluate(()=>stateManager.getSources().some(s=>s.username==='practical_fixture')), 'Upgrade lost the saved source');
			const id=await page.evaluate(url=>{
				const previous=stateManager.getSources().find(s=>s.username==='practical_fixture');
				if(previous) stateManager.updateSource(previous.id, {url});
				return previous?.id || stateManager.addSource({target:'youtube',username:'practical_fixture',url,autoActivate:false});
			},url);
			await page.waitForTimeout(2000);
			const row=page.locator(`[data-source-id="${id}"]`);
			for(let cycle=0;cycle<3;cycle++) {
				const activate = async control => {
					if(cycle === 1) {
						const box=await control.boundingBox();
						assert.ok(box, 'Mouse target has no visible bounds');
						await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
					} else await control.press('Enter');
				};
				await activate(row.locator('[data-activatehtml]'));
				await page.waitForFunction(id=>stateManager.getSource(id)?.status==='active',id,{polling:100});
				await page.waitForTimeout(2500);
				assert.ok(await app.evaluate(async({BrowserWindow},url)=>{
					const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url);
					return !!win && await win.webContents.executeJavaScript('window.ticks >= 2');
				},url));
				const toggle=row.locator('[data-togglehtml]');
				const before=await app.evaluate(({BrowserWindow},url)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url).isVisible(),url);
				await toggle.press('Enter');
				await page.waitForTimeout(400);
				assert.strictEqual(await app.evaluate(({BrowserWindow},url)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url).isVisible(),url),!before);
				await toggle.press('Enter');
				if(launch===0 && cycle===0 && process.env.SSAPP_TEST_SKIP_SCREENSHOTS !== '1') {
					await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).focus());
					await page.waitForTimeout(500);
					await screenshot('dashboard.png');
					const shot=await app.evaluate(async({BrowserWindow},url)=>{
						const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url);
						win.show();
						return (await win.webContents.capturePage()).toPNG().toString('base64');
					},url);
					fs.writeFileSync(path.join(output,'source-window.png'),Buffer.from(shot,'base64'));
					await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).setSize(800,850));
					await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).focus());
					await page.waitForTimeout(500);
					await screenshot('compact.png');
					const overflow=await row.evaluate(el=>{
						const edge=el.getBoundingClientRect().right;
						return Array.from(el.querySelectorAll('.mode-option')).some(button=>button.getBoundingClientRect().right>edge+1);
					});
					if(process.env.SSAPP_TEST_LEGACY_LAYOUT !== '1') assert.ok(!overflow,'Connection mode buttons overflow the source card at compact width');
					await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).setSize(1440,1000));
				}
				await activate(row.locator('[data-stophtml]'));
				await page.waitForFunction(id=>stateManager.getSource(id)?.status==='inactive',id,{polling:100});
				await page.waitForTimeout(300);
				assert.strictEqual(await app.evaluate(({BrowserWindow},url)=>BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL()===url).length,url),0);
			}
			if(launch===0 && process.env.SSAPP_TEST_WM === '1') {
				await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).minimize());
				await page.waitForTimeout(500);
				assert.ok(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).isMinimized()));
				await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).restore());
				await page.waitForTimeout(500);
				assert.ok(!await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).isMinimized()));
				const browserId=await page.evaluate(()=>stateManager.addSource({target:'youtube',username:'public_browser_fixture',url:'https://example.com/',autoActivate:false}));
				await page.waitForTimeout(1000);
				const browserRow=page.locator(`[data-source-id="${browserId}"]`);
				await browserRow.locator('[data-activatehtml]').press('Enter');
				let found=false;
				for(let attempt=0;attempt<30;attempt++) {
					found=await app.evaluate(async({BrowserWindow})=>{
						const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('https://example.com'));
						return !!win && (await win.webContents.executeJavaScript('document.body.innerText')).includes('Example Domain');
					});
					if(found)break;
					await page.waitForTimeout(1000);
				}
				assert.ok(found,'Public HTTPS page did not load in the real source window');
				const browserShot=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('https://example.com')).webContents.capturePage()).toPNG().toString('base64'));
				fs.writeFileSync(path.join(output,'public-browser.png'),Buffer.from(browserShot,'base64'));
				await browserRow.locator('[data-stophtml]').press('Enter');
				await page.evaluate(id=>deleteThis(document.querySelector(`[data-source-id="${id}"]`)),browserId);
				console.log('PASS window minimize/restore and real-source HTTPS browser load.');
			}
			metrics.push(await app.evaluate(({app})=>app.getAppMetrics().map(m=>({type:m.type,workingSetSize:m.memory.workingSetSize}))));
			const processHandle=app.process();
			await app.close();app=null;
			assert.notStrictEqual(processHandle.exitCode,null,'App process stayed alive after quit');
			console.log(`PASS launch/quit ${launch+1}/${process.env.SSAPP_TEST_LAUNCHES || 5}; source start/stop 3/3; saved source retained.`);
		}
		fs.writeFileSync(path.join(output,'memory-samples.json'),JSON.stringify(metrics,null,2));
	} finally {
		if(app)await app.close();
		await new Promise(r=>server.close(r));
		if(!process.env.SSAPP_TEST_PROFILE) fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
	}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
