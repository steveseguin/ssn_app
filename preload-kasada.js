// Iterative preload - start minimal and add fixes one by one
console.log('[Iterative] Starting with minimal working base...');

(function() {
    'use strict';
    
    // CRITICAL: Fix CSS.supports for CreepJS
    const originalSupports = CSS.supports.bind(CSS);
    CSS.supports = function(prop, value) {
        if (arguments.length === 1 && prop === 'border-end-end-radius: initial') {
            return false;
        }
        if (arguments.length === 2 && prop === 'border-end-end-radius' && value === 'initial') {
            return false;
        }
        return originalSupports.apply(this, arguments);
    };
    
    // Minimal navigator fixes
    const originalNavigator = window.navigator;
    const navigatorProxy = new Proxy(originalNavigator, {
        has(target, prop) {
            if (prop === 'webdriver') return false;
            return prop in target;
        },
        get(target, prop) {
            if (prop === 'webdriver') return undefined;
            if (prop === 'languages') return ['en-US', 'en'];
            if (prop === 'language') return 'en-US';
            return target[prop];
        }
    });
    
    Object.defineProperty(window, 'navigator', {
        get: () => navigatorProxy,
        set: () => {},
        enumerable: true,
        configurable: false
    });
    
    delete Navigator.prototype.webdriver;
    
    // Chrome object - minimal version
    const chromeObj = {
        app: {
            isInstalled: false,
            InstallState: {
                DISABLED: 'disabled',
                INSTALLED: 'installed',
                NOT_INSTALLED: 'not_installed'
            },
            RunningState: {
                CANNOT_RUN: 'cannot_run',
                READY_TO_RUN: 'ready_to_run',
                RUNNING: 'running'
            },
            getDetails: function() { return null; },
            getIsInstalled: function() { return false; },
            installState: function(callback) { 
                if (callback) callback({state: 'not_installed'});
            },
            runningState: function() { return {state: 'cannot_run'}; }
        },
        loadTimes: function() {
            const timing = performance.timing;
            const base = timing.navigationStart / 1000;
            return {
                requestTime: base,
                startLoadTime: base,
                commitLoadTime: base + 0.05,
                finishDocumentLoadTime: base + 0.5,
                finishLoadTime: base + 1,
                firstPaintTime: base + 0.2,
                firstPaintAfterLoadTime: 0,
                navigationType: "Other",
                wasFetchedViaSpdy: false,
                wasNpnNegotiated: true,
                npnNegotiatedProtocol: "h2",
                wasAlternateProtocolAvailable: false,
                connectionInfo: "h2"
            };
        },
        csi: function() {
            return {
                startE: performance.timing.navigationStart,
                onloadT: performance.timing.loadEventEnd || Date.now(),
                pageT: performance.now(),
                tran: 15
            };
        }
    };
    
    Object.defineProperty(chromeObj.loadTimes, 'toString', {
        value: () => 'function loadTimes() { [native code] }'
    });
    
    Object.defineProperty(chromeObj.csi, 'toString', {
        value: () => 'function csi() { [native code] }'
    });
    
    window.chrome = chromeObj;
    
    // ITERATION 1: Just the minimal fixes above
    // No iframe fixes, no plugins, no notifications, no permissions
    
    console.log('[Iterative] Minimal base loaded - ready for testing');
})();

// IPC Bridge
const { ipcRenderer } = require('electron');
window.navigateTo = (url) => ipcRenderer.invoke('navigate-to', url);
window.executeScript = (script) => ipcRenderer.invoke('execute-script', script);