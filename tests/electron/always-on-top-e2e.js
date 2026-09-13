'use strict';

// Real SSApp windows and installed menu handlers, plus a separate foreground app.
// Windows' native topmost flag and Z order verify the visible result after blur.
const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { pathToFileURL } = require('url');
const { _electron } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
    if (process.platform !== 'win32') {
        console.log('SKIP: this test checks Windows native window ordering.');
        return;
    }
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssapp-always-on-top-'));
    const report = { output, cases: [] };
    const bootstrap = path.join(output, 'bootstrap.cjs');
    // Observe the real shortcut and mouse-event calls without replacing their behavior.
    fs.writeFileSync(bootstrap, `
const { globalShortcut, BrowserWindow, Menu } = require('electron');
const register = globalShortcut.register.bind(globalShortcut);
globalShortcut.register = (key, callback) => {
    if (key === 'CommandOrControl+Shift+Alt+X') global.__pinShortcut = callback;
    return register(key, callback);
};
global.__mouseCalls = [];
const ignore = BrowserWindow.prototype.setIgnoreMouseEvents;
BrowserWindow.prototype.setIgnoreMouseEvents = function(value, ...rest) {
    global.__mouseCalls.push({ id: this.id, ignore: value });
    return ignore.call(this, value, ...rest);
};
Menu.prototype.popup = function() {
    global.__contextMenu = this;
    // Capture the real menu built by a renderer right-click. Dispatch its installed
    // item below without leaving a native menu open on the user's desktop.
};
require(${JSON.stringify(path.join(root, 'bootstrap.js'))});
`);
    fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({
        name: 'SocialStream', version: require(path.join(root, 'package.json')).version, main: 'bootstrap.cjs'
    }));
    const otherBootstrap = path.join(output, 'other-app.cjs');
    fs.writeFileSync(otherBootstrap, `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
    const win = new BrowserWindow({ width: 900, height: 700 });
    win.loadURL('data:text/html,<title>Always on Top test - other app</title><h1>Other application</h1>');
});
`);
    const nativeScript = path.join(output, 'window-order.ps1');
    fs.writeFileSync(nativeScript, `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WindowOrder {
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
}
'@
Write-Output 'ready'
while ($query = [Console]::ReadLine()) {
$handles = $query.Split(',')
$Target = [long]$handles[0]
$Other = [long]$handles[1]
$above = $false
$cursor = [WindowOrder]::GetWindow([IntPtr]$Other, 3)
while ($cursor -ne [IntPtr]::Zero) {
    if ($cursor.ToInt64() -eq $Target) { $above = $true; break }
    $cursor = [WindowOrder]::GetWindow($cursor, 3)
}
@{ targetTopmost = (([WindowOrder]::GetWindowLong([IntPtr]$Target, -20) -band 8) -ne 0);
   targetAboveOther = $above;
   foreground = [WindowOrder]::GetForegroundWindow().ToInt64().ToString();
   otherFocused = ([WindowOrder]::GetForegroundWindow().ToInt64() -eq $Other) } | ConvertTo-Json -Compress
}
`);
    let app;
    let otherApp;
    let nativeObserver;
    try {
        // Start the native observer once, before focusing test windows. Starting a
        // new console process for each sample can itself disturb desktop focus.
        let pendingNative;
        const nextNativeResult = () => new Promise((resolve, reject) => { pendingNative = { resolve, reject }; });
        const nativeReady = nextNativeResult();
        nativeObserver = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', nativeScript],
            { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        readline.createInterface({ input: nativeObserver.stdout }).on('line', line => {
            const pending = pendingNative;
            pendingNative = null;
            if (!pending) return;
            try { pending.resolve(line === 'ready' ? true : JSON.parse(line)); } catch (error) { pending.reject(error); }
        });
        nativeObserver.on('error', error => pendingNative?.reject(error));
        nativeObserver.on('exit', code => pendingNative?.reject(new Error('Native observer exited: ' + code)));
        nativeObserver.stderr.on('data', data => process.stderr.write(data));
        await nativeReady;
        const readNativeOrder = (target, other) => {
            const result = nextNativeResult();
            nativeObserver.stdin.write(target + ',' + other + '\n');
            return result;
        };
        const socialRoot = path.resolve(root, '../social_stream');
        app = await _electron.launch({ executablePath: require('electron'), cwd: root,
            args: [output, '--running-from-source', '--multiinstance', '--renderer-process-limit=4',
                '--filesource=' + pathToFileURL(socialRoot + path.sep).href],
            env: { ...process.env, SSAPP_USER_DATA_DIR: path.join(output, 'profile'), UV_THREADPOOL_SIZE: '2' }, timeout: 60000 });
        const main = await app.firstWindow();
        await main.waitForFunction(() => window.stateManager?.initialized, null, { timeout: 60000 });
        report.runtime = await app.evaluate(({ app }) => ({ app: app.getVersion(), electron: process.versions.electron, os: process.getSystemVersion() }));
        const mainHandle = await app.browserWindow(main);
        const mainId = await mainHandle.evaluate(win => win.id);
        const openDock = async suffix => {
            const pending = app.waitForEvent('window');
            const url = pathToFileURL(path.join(socialRoot, 'dock.html')).href + '?session=pin-test-' + path.basename(output) + suffix;
            await main.evaluate(url => { window.open(url, '_blank'); }, url);
            const page = await pending;
            await page.waitForLoadState('domcontentloaded');
            const handle = await app.browserWindow(page);
            const id = await handle.evaluate(win => win.id);
            return { page, handle, id };
        };
        const a = await openDock('a');
        const b = await openDock('b');
        const ids = [mainId, a.id, b.id];
        const focus = async handle => {
            for (let attempt = 0; attempt < 10; attempt++) {
                await handle.evaluate(win => { win.show(); win.focus(); });
                await delay(300);
                if (await handle.evaluate(win => win.isFocused())) return;
            }
            assert.fail('Test window did not receive focus');
        };
        const check = async (label, expected, checked) => {
            const result = await app.evaluate(({ BrowserWindow, Menu }, ids) => {
                const item = Menu.getApplicationMenu().getMenuItemById('window-always-on-top');
                return { pinned: ids.map(id => BrowserWindow.fromId(id).isAlwaysOnTop()), checked: item.checked, enabled: item.enabled };
            }, ids);
            assert.deepEqual(result.pinned, expected, label);
            if (checked !== undefined) assert.equal(result.checked, checked, label + ' checkmark');
            report.cases.push({ label, ...result });
            console.log('PASS', label);
        };
        const toggle = id => app.evaluate(({ BrowserWindow, Menu }, id) => {
            // Electron's installed MenuItem.click wrapper updates the checkbox and
            // invokes the real handler with the window that owns the menu action.
            Menu.getApplicationMenu().getMenuItemById('window-always-on-top').click(undefined, BrowserWindow.fromId(id), {});
        }, id);
        await focus(mainHandle);
        await toggle(mainId);
        await check('main window still pins independently', [true, false, false], true);
        await toggle(mainId);
        await focus(a.handle);
        await toggle(a.id);
        await check('dashboard menu pins its own window', [false, true, false], true);

        otherApp = await _electron.launch({ executablePath: require('electron'), cwd: output,
            args: [otherBootstrap, '--renderer-process-limit=1', '--user-data-dir=' + path.join(output, 'other-profile')],
            env: { ...process.env, UV_THREADPOOL_SIZE: '2' } });
        const otherPage = await otherApp.firstWindow();
        const otherHandle = await otherApp.browserWindow(otherPage);
        const bounds = await app.evaluate(({ screen }) => {
            const area = screen.getPrimaryDisplay().workArea;
            return { x: area.x + 50, y: area.y + 50, width: Math.min(900, area.width - 100), height: Math.min(700, area.height - 100) };
        });
        await a.handle.evaluate((win, bounds) => win.setBounds(bounds), bounds);
        await otherHandle.evaluate((win, bounds) => win.setBounds(bounds), bounds);
        const nativeHandle = handle => handle.evaluate(win => {
            const buffer = win.getNativeWindowHandle();
            return buffer.length >= 8 ? buffer.readBigUInt64LE().toString() : String(buffer.readUInt32LE());
        });
        const targetHwnd = await nativeHandle(a.handle);
        const otherHwnd = await nativeHandle(otherHandle);
        const checkOrder = async pinned => {
            let native;
            for (let attempt = 0; attempt < 5; attempt++) {
                await focus(otherHandle);
                await delay(2200); // Include the app's delayed focus/blur handlers.
                native = await readNativeOrder(targetHwnd, otherHwnd);
                if (native.otherFocused) break;
                console.log('Retry: desktop focus changed during native observation');
            }
            assert.equal(native.otherFocused, true, 'The separate application must have focus');
            assert.equal(native.targetTopmost, pinned);
            assert.equal(native.targetAboveOther, pinned);
            report.cases.push({ label: pinned ? 'pinned dashboard stays above another application' : 'unpinned dashboard goes behind another application', ...native });
            console.log('PASS native window ordering', JSON.stringify(native));
        };
        await checkOrder(true);
        await focus(a.handle);
        await toggle(a.id);
        await checkOrder(false);
        await focus(a.handle);
        await toggle(a.id);
        await focus(b.handle);
        await toggle(b.id);
        await check('two dashboards can both be pinned', [false, true, true], true);
        await focus(a.handle);
        await toggle(a.id);
        for (let cycle = 0; cycle < 3; cycle++) {
            await focus(b.handle);
            await check('focus pinned dashboard ' + cycle, [false, false, true], true);
            await focus(a.handle);
            await check('focus unpinned dashboard ' + cycle, [false, false, true], false);
        }
        await b.handle.evaluate(win => win.minimize());
        await delay(500);
        await b.handle.evaluate(win => win.restore());
        await focus(b.handle);
        await check('pin survives minimize and restore', [false, false, true], true);
        const extra = await openDock('menu-rebuild');
        await focus(b.handle);
        await check('menu rebuild keeps the focused window checkmark', [false, false, true], true);
        await app.evaluate(({ BrowserWindow }, id) => { global.__closedPinTarget = BrowserWindow.fromId(id); }, extra.id);
        await extra.page.close();
        await focus(b.handle);
        await app.evaluate(({ Menu }) => {
            Menu.getApplicationMenu().getMenuItemById('window-always-on-top').click(undefined, global.__closedPinTarget, {});
            delete global.__closedPinTarget;
        });
        await check('closed target does not pin another window', [false, false, true], true);
        await toggle(b.id);

        const contextItem = async (label, click = true) => {
            await focus(a.handle);
            await app.evaluate(() => { global.__contextMenu = null; });
            await a.page.mouse.click(100, 150, { button: 'right' });
            await delay(300);
            return app.evaluate(({ BrowserWindow }, { id, label, click }) => {
                const menu = global.__contextMenu;
                const item = menu?.items.find(item => item.label.includes(label));
                if (!item) throw new Error('Context menu item missing: ' + label);
                const checked = item.checked;
                menu.closePopup();
                if (click) item.click(undefined, BrowserWindow.fromId(id), {});
                return checked;
            }, { id: a.id, label, click });
        };
        await contextItem('Always on top');
        await check('right-click pin updates the Window menu', [false, true, false], true);
        await toggle(a.id);
        assert.equal(await contextItem('Always on top', false), false);
        await check('Window menu unpin updates right-click checkmark', [false, false, false], false);
        // Clear the context menu's existing explicit pin flag through its own UI.
        await contextItem('Always on top');
        await contextItem('Always on top');
        await contextItem('Make UnClickable');
        await focus(mainHandle);
        await focus(a.handle);
        await delay(1100);
        assert.equal(await app.evaluate((_, id) => global.__mouseCalls.filter(call => call.id === id).at(-1)?.ignore, a.id), false);
        await check('per-window click-through ends when refocused', [false, true, false], true);
        await toggle(a.id);

        for (const enabled of [true, false]) {
            await app.evaluate(({ Menu }) => {
                const item = Menu.getApplicationMenu().items.find(item => item.label === 'Window').submenu.items
                    .find(item => item.label === 'Lock popups unclickable (global)');
                item.click(undefined, undefined, {});
            });
            await focus(a.handle);
            await delay(1100);
            const calls = await app.evaluate((_, ids) => ids.map(id => global.__mouseCalls.filter(call => call.id === id).at(-1)?.ignore), [a.id, b.id]);
            assert.deepEqual(calls, [enabled, enabled]);
            await check('global popup click-through ' + enabled, [false, false, false], false);
        }
        for (const enabled of [true, false]) {
            await app.evaluate(() => {
                if (!global.__pinShortcut) throw new Error('Pin shortcut was not registered');
                global.__pinShortcut();
            });
            await check('existing global shortcut ' + enabled, [enabled, enabled, enabled], enabled);
        }
        await focus(otherHandle);
        await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('window-always-on-top').click(undefined, undefined, {}));
        await check('missing target does not pin another window', [false, false, false], false);
        await focus(a.handle);
        await a.page.close();
        await focus(mainHandle);
        assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('window-always-on-top').checked), false);
        report.cases.push({ label: 'closing the dashboard restores main-window menu state' });
        report.success = true;
    } catch (error) {
        report.error = error.stack;
        throw error;
    } finally {
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
        console.log('Report:', path.join(output, 'report.json'));
        try {
            if (otherApp) await otherApp.close();
        } finally {
            try { if (app) await app.close(); }
            finally { if (nativeObserver) nativeObserver.stdin.end(); }
        }
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
