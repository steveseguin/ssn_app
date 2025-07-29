// preload.js - Comprehensive browser fingerprint normalization for Kasada bypass
// Based on research about Kasada detection vectors

// Reduce console noise - only log important info
const PRELOAD_DEBUG = false; // Set to true for debugging
if (PRELOAD_DEBUG) {
  console.log('[Preload] Starting preload script execution at:', new Date().toISOString());
  console.log('[Preload] Initial navigator.userAgent:', navigator.userAgent);
}

// First, ensure webdriver is false to match Chrome behavior
// Check if it's already defined to avoid conflicts
if (!Object.getOwnPropertyDescriptor(navigator, 'webdriver')) {
  delete navigator.__proto__.webdriver;
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    configurable: true
  });
}

// Add persistent monitoring to ensure webdriver stays false
// Some scripts or Electron itself might try to reset it
(function() {
  let checkInterval = setInterval(() => {
    if (navigator.webdriver !== false) {
      delete navigator.webdriver;
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
        configurable: true
      });
    }
  }, 100);
  
  // Stop checking after 10 seconds
  setTimeout(() => clearInterval(checkInterval), 10000);
})();

// Remove ALL Electron-specific properties more aggressively
const electronProps = ['electron', 'process', 'require', 'module', '__dirname', '__filename', 'global', 'exports', 'Buffer'];
electronProps.forEach(prop => {
  if (window[prop]) {
    try {
      delete window[prop];
    } catch(e) {
      Object.defineProperty(window, prop, {
        get: () => undefined,
        configurable: true
      });
    }
  }
});

// Set up a monitor to keep removing electron property
setInterval(() => {
  if (window.electron) {
    delete window.electron;
  }
}, 100);

// Also remove it immediately after a short delay to catch late additions
setTimeout(() => {
  if (window.electron) {
    delete window.electron;
  }
}, 1000);

// Override CDP detection - Chrome DevTools Protocol
// Removed as it causes recursion with toString override

// Remove CDP properties
delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

// Remove automation-related properties
const automationProps = [
  'domAutomation', 'domAutomationController', 'callPhantom', '_phantom',
  '__nightmare', 'callSelenium', '_Selenium_IDE_Recorder', '__webdriver_script_fn',
  '__driver_evaluate', '__webdriver_evaluate', '__selenium_evaluate', 
  '__fxdriver_evaluate', '__driver_unwrapped', '__webdriver_unwrapped',
  '__selenium_unwrapped', '__fxdriver_unwrapped'
];

automationProps.forEach(prop => {
  try { 
    delete window[prop]; 
    delete navigator[prop];
    delete document[prop];
  } catch(e) {}
});

// Spoof navigator properties to match Chrome on Windows
// Determine platform based on actual OS or config
const getPlatform = () => {
  // Check if mockUserAgentData exists in window config
  if (window.__mockUserAgentData && window.__mockUserAgentData.platform) {
    const platform = window.__mockUserAgentData.platform;
    if (platform === 'macOS') return 'MacIntel';
    if (platform === 'Linux') return 'Linux x86_64';
  }
  // Default to Win32 for Windows (still Win32 even on Windows 11 in 2025)
  return 'Win32';
};

Object.defineProperty(navigator, 'platform', { 
  get: getPlatform, 
  configurable: true 
});

Object.defineProperty(navigator, 'vendor', { 
  get: () => 'Google Inc.', 
  configurable: true 
});

// Remove Electron from appVersion
const originalAppVersion = Object.getOwnPropertyDescriptor(Navigator.prototype, 'appVersion').get;
Object.defineProperty(navigator, 'appVersion', {
  get: () => originalAppVersion.call(navigator).replace(/Electron\/[\d.]+\s*/g, ''),
  configurable: true
});

// Fix productSub based on browser type
Object.defineProperty(navigator, 'productSub', {
  get: () => {
    if (navigator.userAgent.includes('Firefox')) {
      return '20100101'; // Firefox productSub
    }
    return '20030107'; // Chrome productSub
  },
  configurable: true
});

// Override userAgentData to include Google Chrome (only if we're using Chrome UA)
if (navigator.userAgentData && navigator.userAgent.includes('Chrome')) {
  // Extract Chrome version from the actual user agent that was set
  const chromeMatch = navigator.userAgent.match(/Chrome\/(\d+)/);
  const chromeVersion = chromeMatch ? chromeMatch[1] : '138'; // Chrome 138 is current stable as of July 2025
  
  if (PRELOAD_DEBUG) console.log('[Preload] Detected Chrome version from UA:', chromeVersion);
  
  const originalGetHighEntropyValues = navigator.userAgentData.getHighEntropyValues;
  navigator.userAgentData.getHighEntropyValues = async function(hints) {
    const result = await originalGetHighEntropyValues.call(this, hints);
    
    // Add Google Chrome to brands
    if (result.brands) {
      result.brands = [
        {"brand": "Google Chrome", "version": chromeVersion},
        {"brand": "Chromium", "version": chromeVersion},
        {"brand": "Not)A;Brand", "version": "99"}
      ];
    }
    
    if (result.fullVersionList) {
      result.fullVersionList = [
        {"brand": "Google Chrome", "version": `${chromeVersion}.0.0.0`},
        {"brand": "Chromium", "version": `${chromeVersion}.0.0.0`},
        {"brand": "Not)A;Brand", "version": "99.0.0.0"}
      ];
    }
    
    // Fix platform version to match Windows 11 (more common in 2025)
    if (hints.includes('platformVersion')) {
      result.platformVersion = "15.0.0"; // Windows 11 version
    }
    
    return result;
  };
  
  // Also override the low entropy values
  Object.defineProperty(navigator.userAgentData, 'brands', {
    get: () => [
      {"brand": "Google Chrome", "version": chromeVersion},
      {"brand": "Chromium", "version": chromeVersion},
      {"brand": "Not)A;Brand", "version": "99"}
    ],
    configurable: true
  });
} else if (navigator.userAgent.includes('Firefox') && navigator.userAgentData) {
  // Firefox doesn't normally have userAgentData, so remove it
  delete navigator.userAgentData;
}

// Don't override deviceMemory and hardwareConcurrency - use actual system values
// These are already provided by the browser and should reflect real hardware
if (PRELOAD_DEBUG) {
  console.log('[Preload Debug] Actual deviceMemory:', navigator.deviceMemory);
  console.log('[Preload Debug] Actual hardwareConcurrency:', navigator.hardwareConcurrency);
}

Object.defineProperty(navigator, 'language', { 
  get: () => {
    // Force 'en' to match Chrome, regardless of system language
    return 'en';
  }, 
  configurable: true 
});

Object.defineProperty(navigator, 'languages', { 
  get: () => {
    // Force ['en'] to match Chrome, regardless of system language
    return ['en'];
  }, 
  configurable: true 
});

Object.defineProperty(navigator, 'doNotTrack', {
  get: () => '1',  // Match Chrome's default behavior
  configurable: true
});

Object.defineProperty(navigator, 'maxTouchPoints', {
  get: () => 0,
  configurable: true
});

Object.defineProperty(navigator, 'connection', {
  get: () => ({
    rtt: 100,
    type: 'ethernet',
    saveData: false,
    effectiveType: '4g',
    downlinkMax: undefined,
    downlink: 10,
    ontypechange: null
  }),
  configurable: true
});

// Mock Chrome's internal plugins
const mockPlugins = [
  {
    name: 'PDF Viewer',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: [{
      type: 'application/pdf',
      suffixes: 'pdf',
      description: 'Portable Document Format'
    }]
  },
  {
    name: 'Chrome PDF Viewer',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: [{
      type: 'application/x-google-chrome-pdf',
      suffixes: 'pdf',
      description: 'Portable Document Format'
    }]
  },
  {
    name: 'Chromium PDF Plugin',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: [{
      type: 'application/x-nacl',
      suffixes: '',
      description: 'Native Client Executable'
    }]
  },
  {
    name: 'Microsoft Edge PDF Viewer',
    filename: 'internal-pdf-viewer', 
    description: 'Portable Document Format',
    mimeTypes: [{
      type: 'application/pdf',
      suffixes: 'pdf',
      description: 'Portable Document Format'
    }]
  },
  {
    name: 'WebKit built-in PDF',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: [{
      type: 'application/pdf',
      suffixes: 'pdf', 
      description: 'Portable Document Format'
    }]
  }
];

// Create proper PluginArray
const pluginArray = Object.create(PluginArray.prototype);
mockPlugins.forEach((plugin, index) => {
  pluginArray[index] = plugin;
  pluginArray[plugin.name] = plugin;
});
pluginArray.length = mockPlugins.length;
pluginArray.item = function(index) { return this[index]; };
pluginArray.namedItem = function(name) { return this[name]; };
pluginArray.refresh = function() {};

Object.defineProperty(navigator, 'plugins', {
  get: () => pluginArray,
  configurable: true
});

// Create proper MimeTypeArray  
const mimeTypes = {};
const mimeTypeArray = Object.create(MimeTypeArray.prototype);
let mimeIndex = 0;

mockPlugins.forEach(plugin => {
  plugin.mimeTypes.forEach(mimeType => {
    mimeType.enabledPlugin = plugin;
    mimeTypes[mimeType.type] = mimeType;
    mimeTypeArray[mimeIndex] = mimeType;
    mimeTypeArray[mimeType.type] = mimeType;
    mimeIndex++;
  });
});

mimeTypeArray.length = mimeIndex;
mimeTypeArray.item = function(index) { return this[index]; };
mimeTypeArray.namedItem = function(name) { return this[name]; };

Object.defineProperty(navigator, 'mimeTypes', {
  get: () => mimeTypeArray,
  configurable: true
});

// Canvas fingerprinting - Allow natural fingerprinting
// Most modern anti-bot systems expect consistent canvas fingerprints
// Modifying them actually makes detection easier
(function() {
  // Just log canvas operations for debugging
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    const context = originalGetContext.apply(this, [type, ...args]);
    
    if (type === '2d' && context) {
      // Log when canvas fingerprinting might be happening
      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      let toDataURLCallCount = 0;
      
      this.toDataURL = function(...args) {
        toDataURLCallCount++;
        if (toDataURLCallCount <= 3) { // Only log first few calls
          console.log('[Preload Debug] Canvas toDataURL called - possible fingerprinting');
        }
        return originalToDataURL.apply(this, args);
      };
    }
    
    return context;
  };
})();

// WebGL - Just ensure the extension is available, don't spoof the actual hardware
(function() {
  // The WEBGL_debug_renderer_info extension might be disabled in some cases
  // We just need to ensure it works properly if it exists
  const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    // For debugging - log what WebGL parameters are being queried
    const result = originalGetParameter.apply(this, [parameter]);
    
    // Only log UNMASKED parameters to see what's being detected
    if (parameter === 0x9245 || parameter === 0x9246) {
      console.log('[Preload Debug] WebGL parameter requested:', parameter, 'Result:', result);
    }
    
    return result;
  };

  if (typeof WebGL2RenderingContext !== 'undefined') {
    const originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(parameter) {
      const result = originalGetParameter2.apply(this, [parameter]);
      
      if (parameter === 0x9245 || parameter === 0x9246) {
        console.log('[Preload Debug] WebGL2 parameter requested:', parameter, 'Result:', result);
      }
      
      return result;
    };
  }
})();

// AudioContext - Allow natural audio fingerprinting
// Modern anti-bot systems expect consistent audio fingerprints
// Let the browser use its natural audio processing
(function() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (AudioContext) {
    console.log('[Preload Debug] AudioContext available - using natural audio fingerprinting');
  }
})();


// Battery API - Use actual battery status if available
// Only override if the API doesn't exist (for consistency)
if (!('getBattery' in navigator)) {
  // If battery API doesn't exist, don't add it
  // Modern browsers are removing this API anyway
  console.log('[Preload Debug] Battery API not available (this is normal)');
} else {
  console.log('[Preload Debug] Battery API available - using actual battery status');
}

// Screen properties - Use actual screen values
// Don't override these as they should match the user's actual display
console.log('[Preload Debug] Actual screen dimensions:', {
  width: screen.width,
  height: screen.height,
  availWidth: screen.availWidth,
  availHeight: screen.availHeight,
  colorDepth: screen.colorDepth,
  pixelDepth: screen.pixelDepth
});

// Hide automation indicators
Object.defineProperty(document, 'hidden', {
  get: () => false,
  configurable: true
});

Object.defineProperty(document, 'visibilityState', {
  get: () => 'visible',
  configurable: true
});

// Ensure document has focus - Override the method, not just define a property
const originalHasFocus = document.hasFocus;
document.hasFocus = function() {
  return true;
};

// Also override the hasFocus check on window.top.document if it exists
try {
  if (window.top && window.top.document && window.top.document.hasFocus) {
    window.top.document.hasFocus = function() {
      return true;
    };
  }
} catch(e) {
  // Cross-origin access might fail, that's okay
}

// Fix eval.toString() length (should be 33 for Chrome)
if (eval.toString().length !== 33) {
  window.eval = new Proxy(window.eval, {
    get(target, prop) {
      if (prop === 'toString') {
        return () => 'function eval() { [native code] }';
      }
      return target[prop];
    }
  });
}

// Notification permission (only if Notification exists)
if (typeof Notification !== 'undefined') {
  Object.defineProperty(Notification, 'permission', {
    get: () => 'default',
    configurable: true
  });
}

console.log('[Preload] Browser fingerprint normalization applied');

// Debug: Check what we're actually modifying
console.log('[Preload Debug] navigator.userAgent:', navigator.userAgent);
console.log('[Preload Debug] navigator.webdriver:', navigator.webdriver);
console.log('[Preload Debug] document.hasFocus():', document.hasFocus());
if (navigator.userAgentData) {
  console.log('[Preload Debug] userAgentData.brands:', navigator.userAgentData.brands);
  console.log('[Preload Debug] userAgentData.mobile:', navigator.userAgentData.mobile);
  console.log('[Preload Debug] userAgentData.platform:', navigator.userAgentData.platform);
  
  // Test our override
  navigator.userAgentData.getHighEntropyValues(['brands', 'fullVersionList']).then(hints => {
    console.log('[Preload Debug] High entropy values after override:', hints);
  });
}

// Log when scripts are loaded
console.log('[Preload Debug] Script loading order - preload.js loaded at:', new Date().toISOString());

// Additional anti-detection measures for 2025
// Override permissions API to look more human
if (navigator.permissions && navigator.permissions.query) {
  const originalQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = function(descriptor) {
    // Return realistic permission states
    const permissionStates = {
      'notifications': 'prompt',
      'geolocation': 'prompt',
      'camera': 'prompt',
      'microphone': 'prompt',
      'midi': 'denied',
      'clipboard-read': 'granted',
      'clipboard-write': 'granted'
    };
    
    const state = permissionStates[descriptor.name] || 'prompt';
    
    return Promise.resolve({ 
      state: state,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true
    });
  };
}

// Fix chrome object to look more authentic
if (!window.chrome) {
  window.chrome = {};
}

// Always apply chrome fixes
if (true) {
  // Chrome in a regular tab (not extension context) should NOT have runtime
  // This matches the Chrome fingerprint where runtime doesn't exist
  if (window.chrome.runtime) {
    delete window.chrome.runtime;
  }
  
  // Add chrome.loadTimes (deprecated but still present in Chrome)
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = function() {
      return {
        requestTime: Date.now() / 1000 - 1,
        startLoadTime: Date.now() / 1000 - 0.5,
        commitLoadTime: Date.now() / 1000 - 0.3,
        finishDocumentLoadTime: Date.now() / 1000 - 0.1,
        finishLoadTime: Date.now() / 1000,
        firstPaintTime: Date.now() / 1000 - 0.2,
        firstPaintAfterLoadTime: 0,
        navigationType: "Other",
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: "h2",
        wasAlternateProtocolAvailable: false,
        connectionInfo: "h2"
      };
    };
  }
  
  // Add chrome.csi (present in Chrome)
  if (!window.chrome.csi) {
    window.chrome.csi = function() {
      return {
        onloadT: Date.now(),
        pageT: Date.now() - 1000,
        startE: Date.now() - 2000,
        tran: 1
      };
    };
  }
  
  // Ensure chrome.app exists (empty object in regular tabs)
  if (!window.chrome.app) {
    window.chrome.app = {
      isInstalled: false,
      InstallState: {
        DISABLED: "disabled",
        INSTALLED: "installed",
        NOT_INSTALLED: "not_installed"
      },
      RunningState: {
        CANNOT_RUN: "cannot_run",
        READY_TO_RUN: "ready_to_run",
        RUNNING: "running"
      }
    };
  }
}

// Add more navigator properties that real browsers have
if (!navigator.scheduling) {
  navigator.scheduling = {
    isInputPending: function() { return false; }
  };
}

if (!navigator.ink) {
  navigator.ink = {
    requestPresenter: function() { 
      return Promise.reject(new DOMException('Ink is not supported', 'NotSupportedError')); 
    }
  };
}

if (!navigator.mediaCapabilities) {
  navigator.mediaCapabilities = {
    decodingInfo: function() { 
      return Promise.resolve({
        supported: true,
        smooth: true,
        powerEfficient: true
      }); 
    },
    encodingInfo: function() { 
      return Promise.resolve({
        supported: true,
        smooth: true,
        powerEfficient: true
      }); 
    }
  };
}

// Override toString methods to prevent detection
const nativeToStringFunction = Function.prototype.toString;
Function.prototype.toString = function() {
  // Prevent infinite recursion by checking if we're already in a toString call
  if (this === Function.prototype.toString) {
    return nativeToStringFunction.call(this);
  }
  
  if (this === navigator.permissions?.query ||
      this === window.chrome?.loadTimes ||
      this === navigator.scheduling?.isInputPending) {
    return 'function ' + this.name + '() { [native code] }';
  }
  return nativeToStringFunction.call(this);
};

// Handle IPC exposure based on context isolation setting
const { contextBridge, ipcRenderer } = require('electron');

// Check if contextIsolation is enabled
const contextIsolated = process.contextIsolated;
console.log('[Preload] Context isolation:', contextIsolated);

if (contextIsolated) {
  // When contextIsolation is true, use contextBridge
  console.log('[Preload] Using contextBridge to expose IPC');
  // Use a different name to avoid detection
  contextBridge.exposeInMainWorld('__ipc', {
    ipcRenderer: {
      send: (channel, ...args) => {
        // Whitelist channels that are allowed
        const validChannels = ['signIn', 'createWindow', 'window-closed', 'toggleSourceVisibility'];
        if (validChannels.includes(channel)) {
          ipcRenderer.send(channel, ...args);
        }
      },
      on: (channel, func) => {
        const validChannels = ['window-closed', 'window-hidden', 'fromMain'];
        if (validChannels.includes(channel) || channel.startsWith('window-closed-')) {
          // Strip event from the callback
          ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
      },
      once: (channel, func) => {
        const validChannels = ['window-closed'];
        if (validChannels.includes(channel) || channel.startsWith('window-closed-')) {
          // Strip event from the callback
          ipcRenderer.once(channel, (event, ...args) => func(...args));
        }
      },
      invoke: async (channel, ...args) => {
        const validChannels = ['toggleSourceVisibility', 'show-save-dialog'];
        if (validChannels.includes(channel)) {
          return await ipcRenderer.invoke(channel, ...args);
        }
      },
      sendSync: (channel, ...args) => {
        const validChannels = ['signIn', 'createWindow', 'storageSave', 'prompt', 'alert'];
        if (validChannels.includes(channel)) {
          return ipcRenderer.sendSync(channel, ...args);
        }
      }
    }
  });
} else {
  // When contextIsolation is false, expose directly to window
  console.log('[Preload] Exposing IPC directly to window (contextIsolation disabled)');
  // Use a different name to avoid detection
  window.__ipc = {
    ipcRenderer: {
      send: (channel, ...args) => ipcRenderer.send(channel, ...args),
      on: (channel, func) => ipcRenderer.on(channel, func),
      once: (channel, func) => ipcRenderer.once(channel, func),
      invoke: async (channel, ...args) => await ipcRenderer.invoke(channel, ...args),
      sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args)
    }
  };
}