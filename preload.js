var { ipcRenderer, contextBridge } = require('electron');
/**
 * @typedef {Object} WsMessagePayload
 * @property {'open' | 'close' | 'message' | 'send'} [type]
 * @property {string} [requestId]
 * @property {any} [data]
 * @property {number} [timestamp]
 */

/**
 * @typedef {Object} WrappedWsEvent
 * @property {number} seq
 * @property {WsMessagePayload} payload
 */

/**
 * @typedef {Object} WsConnectionBuffer
 * @property {string} requestId
 * @property {string} url
 * @property {boolean} active
 * @property {boolean} closed
 * @property {WrappedWsEvent?} openEvent
 * @property {WrappedWsEvent?} closeEvent
 * @property {WrappedWsEvent[]} events - Array of wrapped message and send events for this connection
 */

/** @type {WsConnectionBuffer[]} */
const wsConnectionBuffers = [];
/** @type {Map<string, WsConnectionBuffer>} */
const connectionLookup = new Map();

const wsMessageCallbacks = new Set();
const MAX_ACTIVE_WS_CONNECTIONS = 100;
const MAX_WS_BUFFER_SIZE = 1000;
const PRUNE_WS_TARGET_SIZE = 800;

/**
 * Adds a WebSocket connection buffer to both the ordered array and lookup map.
 * @param {WsConnectionBuffer} conn - The WebSocket connection object to add
 * @returns {WsConnectionBuffer} The added connection object
 */
function addWsConnection(conn) {
  wsConnectionBuffers.push(conn);
  if (conn.requestId) {
    connectionLookup.set(conn.requestId, conn);
  }
  return conn;
}

/**
 * Removes a WebSocket connection buffer at the specified index from both the array and lookup map.
 * @param {number} index - The index of the connection to remove
 * @returns {WsConnectionBuffer | null} The removed connection object, or null if index is invalid
 */
function removeWsConnectionAt(index) {
  if (index < 0 || index >= wsConnectionBuffers.length) return null;
  const [removed] = wsConnectionBuffers.splice(index, 1);
  if (removed?.requestId) {
    connectionLookup.delete(removed.requestId);
  }
  return removed;
}

/**
 * Retrieves an existing WebSocket connection buffer by requestId or creates a new one.
 * @param {string} [requestId] - The unique connection request ID
 * @param {string} [url] - The WebSocket URL
 * @param {boolean} [isActive=true] - Whether the connection is active
 * @returns {WsConnectionBuffer} The existing or newly created connection object
 */
function getOrCreateWsConnection(requestId, url, isActive = true) {
  let conn = requestId ? connectionLookup.get(requestId) : null;
  if (!conn) {
    conn = {
      requestId: requestId || '',
      url: url || '',
      active: isActive,
      closed: !isActive,
      openEvent: null,
      closeEvent: null,
      events: []
    };
    addWsConnection(conn);
  }
  return conn;
}

/**
 * Shifts and removes the oldest WebSocket connection buffer from the front of the array and lookup map.
 * @returns {WsConnectionBuffer | null} The shifted connection object, or null if buffer is empty
 */
function shiftWsConnection() {
  return removeWsConnectionAt(0);
}

/**
 * Calculates the total event count of a connection object (open + messages + close).
 * @param {WsConnectionBuffer|null} [conn] - The connection object
 * @returns {number} The event count for this connection
 */
function getConnectionEventCount(conn) {
  if (!conn) return 0;

  let count = conn.events.length;
  if (conn.openEvent) count++;
  if (conn.closeEvent) count++;

  return count;
}

/**
 * Calculates the total number of buffered events across all connections (open + messages + close).
 * @returns {number} The total event count
 */
function getTotalBufferedEventsCount() {
  let total = 0;
  for (const conn of wsConnectionBuffers) {
    total += getConnectionEventCount(conn);
  }
  return total;
}

function pruneWsConnectionBuffers() {
  let currentCount = getTotalBufferedEventsCount();
  if (currentCount < MAX_WS_BUFFER_SIZE) return;

  let excess = currentCount - PRUNE_WS_TARGET_SIZE;

  // Pass 1: Evict empty inactive connections (0 data messages)
  let i = 0;
  while (i < wsConnectionBuffers.length && excess > 0) {
    const conn = wsConnectionBuffers[i];
    if (!conn.active && conn.events.length === 0) {
      const removed = removeWsConnectionAt(i);
      excess -= getConnectionEventCount(removed);
    } else {
      i++;
    }
  }

  // Pass 2: Trim data messages from inactive connections (oldest to newest) before deleting connection metadata
  i = 0;
  while (i < wsConnectionBuffers.length && excess > 0) {
    const conn = wsConnectionBuffers[i];
    if (!conn.active) {
      // Trim needed excess messages in a single batch operation
      if (conn.events.length > 0) {
        const toRemove = Math.min(conn.events.length, excess);
        conn.events.splice(0, toRemove);
        excess -= toRemove;
      }
      // If the connection is now empty of messages and we still need to prune, remove the connection metadata
      if (conn.events.length === 0 && excess > 0) {
      const removed = removeWsConnectionAt(i);
        excess -= getConnectionEventCount(removed);
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  // Pass 3: Trim oldest data messages from oldest active connections if still over target size
  for (const conn of wsConnectionBuffers) {
    if (excess <= 0) break;
    if (conn.events.length > 0) {
      const toRemove = Math.min(conn.events.length, excess);
      conn.events.splice(0, toRemove);
      excess -= toRemove;
      }
    }
  }

let eventArrivalCounter = 0;

function replayAndDrainWsBuffers(callback) {
  // Collect all valid events across connection buffers
  const allEvents = [];

  for (const conn of wsConnectionBuffers) {
    if (conn.openEvent) {
      allEvents.push(conn.openEvent);
    }

    const closeTimestamp = conn.closeEvent ? (conn.closeEvent.payload.timestamp || Infinity) : Infinity;
    const closeSeq = conn.closeEvent ? conn.closeEvent.seq : Infinity;

    for (const item of conn.events) {
      const evtTimestamp = item.payload.timestamp || 0;
      // Do not emit post-close frames (frames arriving after close)
      if (evtTimestamp <= closeTimestamp && item.seq <= closeSeq) {
        allEvents.push(item);
      }
    }

    if (conn.closeEvent) {
      allEvents.push(conn.closeEvent);
    }
  }

  // Sort all events by arrival sequence / timestamp to guarantee true chronological arrival order
  allEvents.sort((a, b) => {
    return a.seq - b.seq;
  });

  // Replay sorted events
  for (const item of allEvents) {
    try {
      callback(item.payload);
    } catch (e) {
      console.error('[Preload] Error replaying WS event:', e);
    }
  }

  // Drain buffers
  wsConnectionBuffers.length = 0;
  connectionLookup.clear();
}

ipcRenderer.on('websocket-message', (event, data) => {
  if (!data || typeof data !== 'object') return;

  if (wsMessageCallbacks.size > 0) {
    wsMessageCallbacks.forEach((cb) => {
      try {
        cb(data);
      } catch (err) {
        console.error('[Preload] Error delivering WebSocket message:', err);
      }
    });
    return;
  }

  const { type, requestId } = data;
  const wrappedEvent = {
    seq: ++eventArrivalCounter,
    payload: data
  };

  // Buffer events when no callbacks are registered yet
  if (type === 'open') {
    const conn = getOrCreateWsConnection(requestId, data.url, true);
    conn.active = true;
    conn.openEvent = wrappedEvent;

    // Enforce active connection cap
    let activeCount = 0;
    for (const c of wsConnectionBuffers) { if (c.active) activeCount++; }
    if (activeCount > MAX_ACTIVE_WS_CONNECTIONS) {
      const oldestActive = wsConnectionBuffers.find(c => c.active && c !== conn);
      if (oldestActive) oldestActive.active = false;
    }
  } else if (type === 'close') {
    const conn = requestId ? connectionLookup.get(requestId) : null;
    if (conn) {
      conn.active = false;
      conn.closed = true;
      conn.closeEvent = wrappedEvent;
    } else {
      const closedConn = getOrCreateWsConnection(requestId, data.url, false);
      closedConn.closeEvent = wrappedEvent;
    }
  } else { // 'message' or 'send'
    const conn = getOrCreateWsConnection(requestId, data.url, true);
    conn.events.push(wrappedEvent);
  }

  pruneWsConnectionBuffers();
});

/**
 * Registers a listener for WebSocket messages and events.
 * Replays any buffered early events upon registration in true arrival order.
 * @param {(data: WsMessagePayload) => void} callback - Callback receiving WebSocket event payload
 * @returns {() => void} Unsubscribe function to remove the listener
 */
function subscribeToWebSocketMessages(callback) {
  if (typeof callback !== 'function') return () => {};
  wsMessageCallbacks.add(callback);
  replayAndDrainWsBuffers(callback);
  return () => {
    wsMessageCallbacks.delete(callback);
  };
}

let cachedEnvironment = null;
const environmentPromise = (async () => {
	try {
		const env = await ipcRenderer.invoke('ssapp:get-environment');
		cachedEnvironment = env || {};
		return cachedEnvironment;
	} catch (error) {
		console.error('[Preload] Failed to retrieve SSAPP environment:', error);
		cachedEnvironment = {};
		return cachedEnvironment;
	}
})();

async function resolveSocialStreamUrl(relativePath, options = {}) {
	try {
		const result = await ipcRenderer.invoke('socialstream:resolve-file-url', relativePath, options);
		if (result && result.success) {
			return result;
		}
		return null;
	} catch (error) {
		console.error('[Preload] resolveSocialStreamUrl failed:', error);
		return null;
	}
}

async function readSocialStreamFile(relativePath, options = {}) {
	try {
		const result = await ipcRenderer.invoke('socialstream:read-file', relativePath, options);
		if (result && result.success) {
			return result.data;
		}
		return null;
	} catch (error) {
		console.error('[Preload] readSocialStreamFile failed:', error);
		return null;
	}
}

async function readSocialStreamJson(relativePath, options = {}) {
	const text = await readSocialStreamFile(relativePath, options);
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch (error) {
		console.error('[Preload] Failed to parse Social Stream JSON asset:', error);
		return null;
	}
}

const ssappFallbackBridge = {
	resolveUrl: resolveSocialStreamUrl,
	readFile: readSocialStreamFile,
	readJson: readSocialStreamJson,
	isAvailable: async (relativePath, options = {}) => {
		const result = await resolveSocialStreamUrl(relativePath, options);
		return !!(result && result.url);
	}
};

const ssappEnvironmentBridge = {
	get: () => environmentPromise,
	getCached: () => cachedEnvironment,
	isPackaged: () => cachedEnvironment ? !!cachedEnvironment.isPackaged : undefined,
	preferLocalAssets: () => cachedEnvironment ? !!cachedEnvironment.preferLocalAssets : undefined,
	hasFallbackBundle: () => cachedEnvironment ? !!cachedEnvironment.hasFallbackBundle : undefined,
	refresh: async () => {
		try {
			const env = await ipcRenderer.invoke('ssapp:get-environment');
			cachedEnvironment = env || {};
			return cachedEnvironment;
		} catch (error) {
			console.error('[Preload] Failed to refresh SSAPP environment:', error);
			return cachedEnvironment || {};
		}
	}
};

async function setSsappLanguagePreference(language) {
	try {
		return await ipcRenderer.invoke('ssapp:set-language', language);
	} catch (error) {
		console.error('[Preload] Failed to persist SSAPP language:', error);
		return { ok: false, error: error?.message || 'Unable to persist language.' };
	}
}

const ssappCustomJsBridge = {
	getState: async () => {
		try {
			return await ipcRenderer.invoke('ssapp:get-custom-js-file-state');
		} catch (error) {
			console.error('[Preload] Failed to get custom.js state:', error);
			return { enabled: false, error: error?.message || 'Unable to read custom.js state.' };
		}
	},
	selectFile: async () => {
		try {
			return await ipcRenderer.invoke('ssapp:select-custom-js-file');
		} catch (error) {
			console.error('[Preload] Failed to select custom.js file:', error);
			return { canceled: true, error: error?.message || 'Unable to select custom.js file.' };
		}
	},
	clear: async () => {
		try {
			return await ipcRenderer.invoke('ssapp:clear-custom-js-file');
		} catch (error) {
			console.error('[Preload] Failed to clear custom.js file:', error);
			return { success: false, error: error?.message || 'Unable to clear custom.js file.' };
		}
	},
	reload: async () => injectStandaloneCustomJs('manual')
};

function getStandaloneCustomJsPageType() {
	try {
		const pathName = window.location && window.location.pathname ? window.location.pathname.toLowerCase() : '';
		const match = pathName.match(/(?:^|\/)(dock|featured|bot)\.html$/i);
		return match ? match[1].toLowerCase() : '';
	} catch (_) {
		return '';
	}
}

function injectScriptIntoPage(code, sourceName) {
	const target = document.head || document.documentElement || document.body;
	if (!target || !code) return false;
	const existingScript = document.getElementById('ssapp-standalone-custom-js');
	if (existingScript) {
		existingScript.remove();
	}
	const script = document.createElement('script');
	script.id = 'ssapp-standalone-custom-js';
	script.dataset.source = sourceName || 'custom.js';
	script.textContent = `${code}\n//# sourceURL=ssapp-custom-js/${encodeURIComponent(sourceName || 'custom.js')}`;
	target.appendChild(script);
	return true;
}

async function injectStandaloneCustomJs(reason = 'load') {
	const pageType = getStandaloneCustomJsPageType();
	if (!pageType) return { skipped: true, reason: 'unsupported-page' };

	try {
		const result = await ipcRenderer.invoke('ssapp:read-custom-js-file');
		if (!result || !result.success || !result.code) {
			if (result && result.error) {
				console.warn('[Preload] custom.js not loaded:', result.error);
			}
			return result || { success: false };
		}
		const state = result.state || {};
		const injected = injectScriptIntoPage(result.code, state.fileName || 'custom.js');
		if (injected) {
			console.log(`[SSAPP] Loaded custom.js for ${pageType} (${reason}): ${state.filePath || state.fileName || 'selected file'}`);
		}
		return { success: injected, state };
	} catch (error) {
		console.error('[Preload] Failed to inject custom.js:', error);
		return { success: false, error: error?.message || 'Unable to inject custom.js.' };
	}
}

function scheduleStandaloneCustomJsInjection() {
	if (document.readyState === 'loading') {
		window.addEventListener('DOMContentLoaded', () => {
			injectStandaloneCustomJs('page-load');
		}, { once: true });
	} else {
		setTimeout(() => {
			injectStandaloneCustomJs('page-load');
		}, 0);
	}
}

async function getSourceWindowConfig() {
	try {
		const result = await ipcRenderer.invoke('ssapp:get-source-window-config');
		return result || {};
	} catch (error) {
		console.error('[Preload] Failed to retrieve source window config:', error);
		return {};
	}
}

const WARN_FILTER_PATTERNS = [
    /Potential permissions policy violation/i,
    /Unrecognized feature/i,
    /Electron Security Warning/i
];

const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args) => {
    try {
        const message = args.map((part) => {
            if (typeof part === 'string') return part;
            if (part instanceof Error && part.message) return part.message;
            return JSON.stringify(part);
        }).join(' ');

        if (WARN_FILTER_PATTERNS.some((pattern) => pattern.test(message))) {
            return;
        }
    } catch (_) {
        // Fall through to original handler on parsing issues
    }
    return originalConsoleWarn(...args);
};

// Debug flag for troubleshooting
const PRELOAD_DEBUG = false; // Set to true for debugging

// Get the random flag for this session
let INJECTED_SCRIPT_FLAG = null;
(async () => {
    INJECTED_SCRIPT_FLAG = await ipcRenderer.invoke('get-injected-script-flag');
    if (PRELOAD_DEBUG) {
        console.log('[Preload] Got injected script flag:', INJECTED_SCRIPT_FLAG);
    }
})();

window.addEventListener('DOMContentLoaded', () => {
	const replaceText = (selector, text) => {
		const element = document.getElementById(selector)
		if (element) element.innerText = text
	}
	for (const type of ['chrome', 'node', 'electron']) {
		replaceText(`${type}-version`, process.versions[type])
	}
})

// Generate a unique token for this session
const MESSAGE_AUTH_TOKEN = 'ssn_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

// Security: Only accept messages from our injected scripts with proper authentication
window.addEventListener('message', (event) => {
	// The injected scripts run in the same window, so we can't filter by source
	// We rely on authentication tokens and message structure validation instead
	
	// Check if the message has our expected structure
	const { data } = event;
	if (!data || typeof data !== 'object') {
		return;
	}
	
	
	// Debug logging
	if (PRELOAD_DEBUG && (data._authToken || data.message || data.getSettings)) {
		console.log('[Preload] Received postMessage:', { 
			hasAuthToken: !!data._authToken, 
			authTokenPrefix: data._authToken ? data._authToken.substring(0, 20) : 'none',
			hasMessage: !!data.message,
			hasGetSettings: !!data.getSettings,
			keys: Object.keys(data)
		});
	}
	
    // Fast-path: forward lightweight WSS status messages (no token required)
    if (data && data.wssStatus) {
        try { ipcRenderer.send('postMessage', data); } catch(_) {}
        return;
    }

    // Check for authentication token (for new secure messages)
    if (data._authToken === MESSAGE_AUTH_TOKEN) {
		// Remove token before forwarding
		const messageData = { ...data };
		delete messageData._authToken;
		
		// Check if this message needs a response
		const needsResponse = messageData._needsResponse;
		const messageId = messageData._messageId;
		delete messageData._needsResponse;
		delete messageData._messageId;
		
		if (needsResponse && messageId) {
			// Send with callback expectation
			const response = ipcRenderer.sendSync('postMessage', messageData);
			
			// Send response back via postMessage
			window.postMessage({
				_isResponse: true,
				_messageId: messageId,
				response: response
			}, '*');
		} else {
			// Send without expecting response
			ipcRenderer.send('postMessage', messageData);
		}
		return;
	}
	
	// Support for injected scripts that can't access contextBridge
	if (INJECTED_SCRIPT_FLAG && data[INJECTED_SCRIPT_FLAG]) {
		// Remove the flag before forwarding
		delete data[INJECTED_SCRIPT_FLAG];
		
		// Extract tab ID if provided
		const tabID = data.__tabID__;
		delete data.__tabID__;
		
		// Re-add tabID if it was present
		if (tabID !== undefined && tabID !== null) {
			data.__tabID__ = tabID;
		}
		
		// Send the message
		ipcRenderer.send('postMessage', data);
		return;
	}
	
    // Legacy support: Only forward messages that have our expected properties
    // This prevents arbitrary messages from the page being forwarded
    // TODO: Eventually remove this once all scripts are updated to use auth tokens
    if (data.wssStatus || data.message || data.delete || data.getSettings || data.getBTTV || 
        data.getSEVENTV || data.getFFZ || data.cmd || data.type === 'toBackground') {
        ipcRenderer.send('postMessage', data);
    }
});

window.addEventListener('error', (event) => {
  console.error('Script error:', event.error);
});

/* window.alert = alert = function(title, val){
	log("window.alert");
	return ipcRenderer.send('alert', {title, val}); // call if needed in the future
}; */

var actualHandler = null;
var doSomethingInWebApp = function(callback){
	if (callback){
		actualHandler = callback;
	}
};

// Create a wrapper that always delegates to the current handler
var doSomethingInWebAppWrapper = function(message, sender, sendResponse) {
	if (actualHandler) {
		try {
			actualHandler(message, sender, sendResponse);
		} catch (_) {}
	}
};

function extractBackgroundCommandRequest(data) {
	if (!data || typeof data !== 'object') return null;
	if (data.type === 'toBackground' && data.data && typeof data.data === 'object') {
		return data.data;
	}
	return null;
}

function sendBackgroundCommandIfNeeded(data, callback) {
	const request = extractBackgroundCommandRequest(data);
	if (!request || !request.cmd || typeof callback !== 'function') return false;
	ipcRenderer.invoke('ssapp:background-command', request)
		.then((response) => {
			callback(response || { ok: false, error: 'Background command returned no response' });
		})
		.catch((error) => {
			callback({
				ok: false,
				error: error && error.message ? error.message : 'Background command failed'
			});
		});
	return true;
}

let sttStatusSubscriptionCounter = 0;
const sttStatusSubscriptions = new Map();
const STT_MAX_AUDIO_BYTE_LENGTH = 16000 * 20 * Float32Array.BYTES_PER_ELEMENT;

function normalizeSttAudioBuffer(audio) {
	const isArrayBuffer = audio instanceof ArrayBuffer;
	const isView = ArrayBuffer.isView(audio) && audio.buffer instanceof ArrayBuffer;
	const byteLength = isArrayBuffer ? audio.byteLength : isView ? audio.byteLength : 0;
	if (!byteLength || byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
		throw new TypeError('transcribeAudio expects non-empty Float32 PCM bytes.');
	}
	if (byteLength > STT_MAX_AUDIO_BYTE_LENGTH) {
		throw new RangeError('transcribeAudio is limited to 20 seconds of 16 kHz audio.');
	}
	return isArrayBuffer
		? audio.slice(0)
		: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
}

async function transcribeAudio(audio, options = {}) {
	return await ipcRenderer.invoke('stt:transcribe', {
		audio: normalizeSttAudioBuffer(audio),
		sampleRate: Number(options.sampleRate) || 16000,
	});
}

function subscribeToSttStatus(callback) {
	if (typeof callback !== 'function') return '';
	const subscriptionId = `stt-status-${++sttStatusSubscriptionCounter}`;
	const listener = (_event, payload) => {
		try {
			callback(payload);
		} catch (error) {
			console.warn('[Preload] STT status callback failed:', error && error.message ? error.message : error);
		}
	};
	sttStatusSubscriptions.set(subscriptionId, listener);
	ipcRenderer.on('stt:status', listener);
	return subscriptionId;
}

function unsubscribeFromSttStatus(subscriptionId) {
	const id = String(subscriptionId || '');
	const listener = sttStatusSubscriptions.get(id);
	if (!listener) return false;
	ipcRenderer.removeListener('stt:status', listener);
	sttStatusSubscriptions.delete(id);
	return true;
}

const localMediaBridge = {
	select: async (payload = {}) => ipcRenderer.invoke('local-media:select', payload),
	list: async () => ipcRenderer.invoke('local-media:list'),
	get: async (assetId) => ipcRenderer.invoke('local-media:get', { assetId }),
	remove: async (assetId) => ipcRenderer.invoke('local-media:remove', { assetId }),
	status: async () => ipcRenderer.invoke('local-media:status'),
	start: async () => ipcRenderer.invoke('local-media:start'),
	stop: async () => ipcRenderer.invoke('local-media:stop'),
	setPort: async (port) => ipcRenderer.invoke('local-media:set-port', { port }),
	getFlowActionsUrl: async (payload = {}) => ipcRenderer.invoke('local-media:flow-url', payload),
	getMediaUrl: async (assetId) => ipcRenderer.invoke('local-media:media-url', { assetId }),
	reveal: async (assetId) => ipcRenderer.invoke('local-media:reveal', { assetId }),
	rotateToken: async () => ipcRenderer.invoke('local-media:rotate-token'),
};

function configureContextBridge(){
	try {
		console.log('[Preload] Configuring contextBridge with ninjafy (including OAuth methods)');
		const effectiveLocale = process.env.SSAPP_LOCALE_EFFECTIVE || 'en-US';
		const acceptLanguageHeader = process.env.SSAPP_ACCEPT_LANGUAGE || 'en-US,en;q=0.9';
		const localeSource = process.env.SSAPP_LOCALE_SOURCE || 'system';
		// Always expose to main world, regardless of whether it exists in isolated context
		contextBridge.exposeInMainWorld('ninjafy', {
			
		  // Expose the auth token directly as a property
		  _authToken: MESSAGE_AUTH_TOKEN,
		  
		  exposeDoSomethingInWebApp: doSomethingInWebApp,
		  
		  checkUrlMatching: (url) => {
			// checkSupported is not available in preload context
			return false;
		  },
		  
		  sendMessage: function(ignore=null, data=null, callback=false, tabID=false) {
			if (sendBackgroundCommandIfNeeded(data, callback)) {
				return;
			}

			// Add authentication token to messages
			const authenticatedData = { ...data, _authToken: MESSAGE_AUTH_TOKEN };
			
			// Add tabID if provided (maintaining security - only injected scripts have access to valid tabIDs)
			if (tabID !== false && tabID !== null && tabID !== undefined) {
				authenticatedData.__tabID__ = tabID;
			}
			
			if (callback) {
			  const response = ipcRenderer.sendSync('postMessage', authenticatedData);
			  callback(response);
			} else {
			  ipcRenderer.send('postMessage', authenticatedData);
			}
		  },
		  
		  // Expose auth token getter for injected scripts that use window.postMessage directly
		  getAuthToken: () => MESSAGE_AUTH_TOKEN,
		  _authToken: MESSAGE_AUTH_TOKEN,
		  
		  // Expose the injected script flag
		  getInjectedScriptFlag: () => INJECTED_SCRIPT_FLAG,

		  getSourceWindowConfig: getSourceWindowConfig,

		  localMedia: localMediaBridge,

		  getSttCapabilities: async () => {
			return await ipcRenderer.invoke('stt:get-capabilities');
		  },

		  transcribeAudio,

		  getSttDiagnostics: async () => {
			return await ipcRenderer.invoke('stt:get-diagnostics');
		  },

		  onSttStatus: subscribeToSttStatus,

		  offSttStatus: unsubscribeFromSttStatus,
			  
			  closeFileStream: async () => {
				await ipcRenderer.invoke('close-file-stream');
			  },
			  
			  onCloseFileStream: (callback) => {
				  ipcRenderer.on('close-file-stream', async () => {
					callback();
				  });
			  },

			  showSaveDialog: async (opts) => {
				return await ipcRenderer.invoke('show-save-dialog', opts);
			  },

			  appendToFile: (filePath, data) => {
				ipcRenderer.send('append-to-file', { filePath, data });
			  },

			  tts: async (text, settings) => {
				return await ipcRenderer.invoke('tts', {text, settings});
			  },
			  
			  onSendToTab: (callback) => {
				ipcRenderer.on('sendToTab', (event, ...args) => {
				  callback(args[0]);
				});
			  },
			  
			  onPostMessage: (callback) => {
				ipcRenderer.on('postMessage', (event, ...args) => {
				  callback(args[0]);
				});
			  },
			  
      onWebSocketMessage: subscribeToWebSocketMessages,
			  
			  sendDeviceList: (response) => {
				ipcRenderer.send('deviceList', response);
			  },
			  
			 'updateVersion' : function (version) { // window.ninjafy.updateVersion(session.version);
				 console.log("Version: "+version);
			  },
			  
			  'updatePPT' : function (PPTHotkey) {},
			  
			  noCORSFetch: async (args) => {
				return await ipcRenderer.invoke("nodefetch", args || {});
			  },

			  fetchRumbleJson: async (url) => {
				return await ipcRenderer.invoke('rumble-fetch-json', { url });
			  },

			  fetchJoystickJson: async (request) => {
				return await ipcRenderer.invoke('ssapp:background-command', Object.assign({}, request || {}, { cmd: 'joystickFetchJson' }));
			  },
			  
			  readStreamChunk: (streamId) => {},
			  
			  closeStream: (streamId) => {},
			  
			  startYouTubeOAuth: async (payload) => {
				return await ipcRenderer.invoke('youtube-oauth', payload);
			  },

			  exchangeYouTubeOAuthCode: async (payload) => {
				return await ipcRenderer.invoke('youtube-oauth-exchange', payload);
			  },

			  refreshYouTubeOAuthToken: async (payload) => {
				return await ipcRenderer.invoke('youtube-oauth-refresh', payload);
			  },

			  startYouTubeOwnerAuth: async (payload) => {
				return await ipcRenderer.invoke('youtube-owner-auth-start', payload || {});
			  },

			  confirmYouTubeOwnerAuth: async (payload) => {
				return await ipcRenderer.invoke('youtube-owner-auth-confirm', payload || {});
			  },

			  listYouTubeOwnerAuth: async () => {
				return await ipcRenderer.invoke('youtube-owner-auth-list');
			  },

			  clearYouTubeOwnerAuth: async (payload) => {
				return await ipcRenderer.invoke('youtube-owner-auth-clear', payload || {});
			  },

			  fetchYouTubeOwnerBroadcasts: async (payload) => {
				return await ipcRenderer.invoke('youtube-owner-broadcasts', payload || {});
			  },

			  startMediaUpload: async (payload) => {
				return await ipcRenderer.invoke('media-upload', payload || {});
			  },

			  startTwitchOAuth: async (payload) => {
				return await ipcRenderer.invoke('twitch-oauth', payload);
			  },

			  startFacebookOAuth: async (payload) => {
				return await ipcRenderer.invoke('facebook-oauth', payload);
			  },

			  exchangeFacebookOAuthCode: async (payload) => {
				return await ipcRenderer.invoke('facebook-oauth-exchange', payload);
			  },

			  startVeloraOAuth: async (payload) => {
				return await ipcRenderer.invoke('velora-oauth', payload);
			  },

			  startKickOAuth: async (payload) => {
				return await ipcRenderer.invoke('kick-oauth', payload);
			  },

			  startVpzoneOAuth: async (payload) => {
				return await ipcRenderer.invoke('vpzone-oauth', payload);
			  },

			  startKickWebSocket: async (payload) => {
				return await ipcRenderer.invoke('kick-ws-connect', payload);
			  },

			  stopKickWebSocket: async (payload) => {
				return await ipcRenderer.invoke('kick-ws-disconnect', payload);
			  },

			  onKickWsEvent: (() => {
				let registered = false;
				return (callback) => {
					if (registered) return;
					registered = true;
					ipcRenderer.on('kick-ws-event', (event, data) => {
						callback(data);
					});
				};
			  })(),

			  onKickWsStatus: (() => {
				let registered = false;
				return (callback) => {
					if (registered) return;
					registered = true;
					ipcRenderer.on('kick-ws-status', (event, data) => {
						callback(data);
					});
				};
			  })(),

			  // Performance monitoring
			  requestPerformanceData: async () => {
				return await ipcRenderer.invoke('getPerformanceMetrics');
			  },
			  
			  onPerformanceData: (callback) => {
				ipcRenderer.on('performance-data', (event, data) => {
				  callback(data);
				});
			  }
			});
		contextBridge.exposeInMainWorld('ssappLocale', {
			locale: effectiveLocale,
			acceptLanguage: acceptLanguageHeader,
			source: localeSource,
			getLocale: () => effectiveLocale,
			getAcceptLanguage: () => acceptLanguageHeader,
			getSource: () => localeSource,
			setLanguage: setSsappLanguagePreference
		});
		contextBridge.exposeInMainWorld('ssappFallback', ssappFallbackBridge);
		contextBridge.exposeInMainWorld('ssappEnvironment', ssappEnvironmentBridge);
		contextBridge.exposeInMainWorld('ssappCustomJs', ssappCustomJsBridge);
	} catch(e){
		// Silently fail if context isolation is disabled - this is expected
		if (!e.message || !e.message.includes('contextBridge API can only be used when contextIsolation is enabled')) {
			console.error('[Preload] Error configuring context bridge:', e);
		}
		throw e; // Re-throw to be caught by outer try-catch
	}
}
// Only configure context bridge if context isolation is enabled
// When context isolation is disabled, we can access window directly
try {
	// Try to use contextBridge - this will throw if contextIsolation is false
	configureContextBridge();
} catch (e) {
	if (e.message && e.message.includes('contextBridge API can only be used when contextIsolation is enabled')) {
		// Context isolation is disabled - expose ninjafy directly on window
		window.ninjafy = {
			// Expose the auth token directly as a property
			_authToken: MESSAGE_AUTH_TOKEN,
			
			getInjectedScriptFlag: () => INJECTED_SCRIPT_FLAG,

			localMedia: localMediaBridge,
			
			sendMessage: (a, b, c, tabID) => {
				const messageData = b || a;
				if (sendBackgroundCommandIfNeeded(messageData, c)) {
					return;
				}
				
				// When tabID is provided, this is a message that should be routed to the background
				// via postMessage handler, not directly to a tab
				const outgoingData = { ...messageData };
				if (tabID !== undefined && tabID !== null && tabID !== false) {
					outgoingData.__tabID__ = tabID;
				}
				
				// If callback is provided, use synchronous IPC to get response
				if (c) {
					const response = ipcRenderer.sendSync('postMessage', outgoingData);
					c(response);
				} else {
					// No callback, send asynchronously
					ipcRenderer.send('postMessage', outgoingData);
				}
			},
			
      onWebSocketMessage: subscribeToWebSocketMessages,
			
			// Add other necessary methods
			exposeDoSomethingInWebApp: (callback) => {
				window.doSomethingInWebApp = callback;
			},
			
			sendDeviceList: (response) => {
				ipcRenderer.send('deviceList', response);
			},
			
			updateVersion: function (version) {
				console.log("Version: "+version);
			},

			noCORSFetch: async (args) => {
				return await ipcRenderer.invoke("nodefetch", args || {});
			},

			fetchJoystickJson: async (request) => {
				return await ipcRenderer.invoke('ssapp:background-command', Object.assign({}, request || {}, { cmd: 'joystickFetchJson' }));
			},

			startYouTubeOAuth: async (payload) => {
				return await ipcRenderer.invoke('youtube-oauth', payload);
			},

			exchangeYouTubeOAuthCode: async (payload) => {
				return await ipcRenderer.invoke('youtube-oauth-exchange', payload);
			},

			refreshYouTubeOAuthToken: async (payload) => {
				return await ipcRenderer.invoke('youtube-oauth-refresh', payload);
			},

			startYouTubeOwnerAuth: async (payload) => {
				return await ipcRenderer.invoke('youtube-owner-auth-start', payload || {});
			},

			confirmYouTubeOwnerAuth: async (payload) => {
				return await ipcRenderer.invoke('youtube-owner-auth-confirm', payload || {});
			},

			listYouTubeOwnerAuth: async () => {
				return await ipcRenderer.invoke('youtube-owner-auth-list');
			},

			clearYouTubeOwnerAuth: async (payload) => {
				return await ipcRenderer.invoke('youtube-owner-auth-clear', payload || {});
			},

			fetchYouTubeOwnerBroadcasts: async (payload) => {
				return await ipcRenderer.invoke('youtube-owner-broadcasts', payload || {});
			},

			startMediaUpload: async (payload) => {
				return await ipcRenderer.invoke('media-upload', payload || {});
			},

			startTwitchOAuth: async (payload) => {
				return await ipcRenderer.invoke('twitch-oauth', payload);
			},

			startFacebookOAuth: async (payload) => {
				return await ipcRenderer.invoke('facebook-oauth', payload);
			},

			exchangeFacebookOAuthCode: async (payload) => {
				return await ipcRenderer.invoke('facebook-oauth-exchange', payload);
			},

			startVeloraOAuth: async (payload) => {
				return await ipcRenderer.invoke('velora-oauth', payload);
			},

			startKickOAuth: async (payload) => {
				return await ipcRenderer.invoke('kick-oauth', payload);
			},

			startVpzoneOAuth: async (payload) => {
				return await ipcRenderer.invoke('vpzone-oauth', payload);
			},

			startKickWebSocket: async (payload) => {
				return await ipcRenderer.invoke('kick-ws-connect', payload);
			},

			stopKickWebSocket: async (payload) => {
				return await ipcRenderer.invoke('kick-ws-disconnect', payload);
			},

			getSttCapabilities: async () => {
				return await ipcRenderer.invoke('stt:get-capabilities');
			},

			transcribeAudio,

			getSttDiagnostics: async () => {
				return await ipcRenderer.invoke('stt:get-diagnostics');
			},

			onSttStatus: subscribeToSttStatus,

			offSttStatus: unsubscribeFromSttStatus,

			tts: async (text, settings) => {
				return await ipcRenderer.invoke('tts', {text, settings});
			},

			onKickWsEvent: (() => {
				let registered = false;
				return (callback) => {
					if (registered) return;
					registered = true;
					ipcRenderer.on('kick-ws-event', (event, data) => {
						callback(data);
					});
				};
			})(),

			onKickWsStatus: (() => {
				let registered = false;
				return (callback) => {
					if (registered) return;
					registered = true;
					ipcRenderer.on('kick-ws-status', (event, data) => {
						callback(data);
					});
				};
			})(),

		};
		window.ssappLocale = {
			locale: process.env.SSAPP_LOCALE_EFFECTIVE || 'en-US',
			acceptLanguage: process.env.SSAPP_ACCEPT_LANGUAGE || 'en-US,en;q=0.9',
			source: process.env.SSAPP_LOCALE_SOURCE || 'system',
			getLocale() { return this.locale; },
			getAcceptLanguage() { return this.acceptLanguage; },
			getSource() { return this.source; },
			setLanguage: setSsappLanguagePreference
		};
		window.ssappFallback = ssappFallbackBridge;
		window.ssappEnvironment = ssappEnvironmentBridge;
		window.ssappCustomJs = ssappCustomJsBridge;
	} else {
		console.error('[Preload] Unexpected error configuring context bridge:', e);
	}
}

ipcRenderer.on('ssapp:custom-js-updated', () => {
	injectStandaloneCustomJs('updated');
});

scheduleStandaloneCustomJsInjection();

function injectDockBridge() {
	try {
		const href = window.location && typeof window.location.href === 'string' ? window.location.href : '';
		if (!href.includes('/dock.html')) return;

		const scriptContent = `
			(() => {
				const resolveToken = () => {
					try {
						if (window.ninjafy && typeof window.ninjafy.getAuthToken === 'function') {
							return window.ninjafy.getAuthToken();
						}
						if (window.ninjafy && typeof window.ninjafy._authToken === 'string') {
							return window.ninjafy._authToken;
						}
					} catch (_) {}
					return null;
				};

				const postToElectron = (payload) => {
					const token = resolveToken();
					const message = { ...payload };
					if (token) {
						message._authToken = token;
					}
					try {
						window.postMessage(message, '*');
					} catch (_) {}
				};

				const originalSend2Extension = window.send2Extension;
				window.send2Extension = function(data, uid = null) {
					try {
						postToElectron({
							overlayNinja: data,
							__tabID__: uid,
							fromDock: true
						});
					} catch (_) {}
					// Response messages already go through Electron's main-process relay,
					// which forwards them to background.html and separately handles any
					// TikTok virtual tabs. Calling the original path here would duplicate
					// the background.html send.
					if (typeof originalSend2Extension === 'function' && !data?.response) {
						return originalSend2Extension.apply(this, arguments);
					}
				};

				const originalRespondP2P = window.respondP2P;
				window.respondP2P = function(data, tid = false) {
					try {
						// respondP2P calls send2Extension internally; the send2Extension wrapper will forward to Electron.
					} catch (_) {}
					if (typeof originalRespondP2P === 'function') {
						return originalRespondP2P.apply(this, arguments);
					}
				};
			})();`;

		const script = document.createElement('script');
		script.textContent = scriptContent;
		(document.head || document.documentElement).appendChild(script);
		script.remove();
	} catch (_) {
		// Ignore dock bridge errors
	}
}

window.addEventListener('DOMContentLoaded', injectDockBridge);


// Handle sendToTab-request messages that expect a response
ipcRenderer.on('sendToTab-request', (event, data) => {
	//console.log("SEND TO TAB REQUEST", data);
	const { message, requestId } = data;
	
	// Call the handler and send back the response
	doSomethingInWebAppWrapper(message, null, function(response) {
		// Send the response back to main process
		ipcRenderer.send(`sendToTab-response-${requestId}`, response);
	});
});

// Handle regular sendToTab messages (no response expected)
ipcRenderer.on('sendToTab', (event, ...args) => {
	doSomethingInWebAppWrapper(args[0], null, function(response){});
});

ipcRenderer.on('postMessage', (event, ...args) => { // GOT MESSAGE FROM MAIN.JS
	try {
		
		if ("doSomething" in args[0]){
			if (args[0].node){ // run it directly, using NODE mode.
			} else { // run it in the page via Electron API
				var fauxEvent = {};
				fauxEvent.data = {};
				fauxEvent.data.doSomething = true;
				doSomethingInWebAppWrapper(fauxEvent, null, function(){});
			}
			return;
		}
		
		if ("eval" in args[0]){
			if (args[0].node){
				eval(args[0].eval);
			} else {
				var fauxEvent = {};
				fauxEvent.data = {};
				fauxEvent.data.eval = args[0].eval;
				doSomethingInWebAppWrapper(fauxEvent, null, function(){});
			}
			return;
		}
		
		if ("getDeviceList" in args[0]) {
			
			var response = {};
			
			if (typeof enumerateDevices === "function"){
				enumerateDevices().then(function(deviceInfos) {
					response.deviceInfos = deviceInfos;
					response = JSON.parse(JSON.stringify(response));
					ipcRenderer.send('deviceList', response);
				})
			} else {
				requestOutputAudioStream().then(function(deviceInfos) {
					
					response.deviceInfos = deviceInfos;
					response = JSON.parse(JSON.stringify(response));
					ipcRenderer.send('deviceList', response);
					
				})
			}
		}
		
	} catch(e){
		console.error(e);
	}
})


function setSink(ele, id){
	ele.setSinkId(id).then(() => {
		console.log("New Output Device:" + id);
	}).catch(error => {
		console.error(error);
	});
}


var hello  = true;

function changeAudioOutputDeviceByIdThirdParty(deviceID){
	console.log("Output deviceID: "+deviceID);
	
	document.querySelectorAll("audio, video").forEach(ele=>{
		try {
			if (ele.manualSink){
				setSink(ele,ele.manualSink);
			} else {
				setSink(ele,deviceID);
			}
		} catch(e){}
	});
	document.querySelectorAll('iframe').forEach( item =>{
		try{
			item.contentWindow.document.body.querySelectorAll("audio, video").forEach(ele=>{
				try {
					if (ele.manualSink){
						setSink(ele,ele.manualSink);
					} else {
						setSink(ele,deviceID);
					}
				} catch(e){}
			});
		} catch(e){}
	});	
	
}

function enumerateDevicesThirdParty() {
	if (typeof navigator.enumerateDevices === "function") {
		return navigator.enumerateDevices();
	} else if (typeof navigator.mediaDevices === "object" && typeof navigator.mediaDevices.enumerateDevices === "function") {
		return navigator.mediaDevices.enumerateDevices();
	} else {
		return new Promise((resolve, reject) => {
			try {
				if (window.MediaStreamTrack == null || window.MediaStreamTrack.getSources == null) {
					throw new Error();
				}
				window.MediaStreamTrack.getSources((devices) => {
					resolve(devices
						.filter(device => {
							return device.kind.toLowerCase() === "video" || device.kind.toLowerCase() === "videoinput";
						})
						.map(device => {
							return {
								deviceId: device.deviceId != null ? device.deviceId : ""
								, groupId: device.groupId
								, kind: "videoinput"
								, label: device.label
								, toJSON: /*  */ function() {
									return this;
								}
							};
						}));
				});
			} catch (e) {}
		});
	}
}

function requestOutputAudioStream() {
	console.log("requestOutputAudioStream");
	return navigator.mediaDevices.getUserMedia({audio: true, video: false}).then(function(stream) { // Apple needs thi to happen before I can access EnumerateDevices. 
		return enumerateDevicesThirdParty().then(function(deviceInfos) {
			console.log("enumerateDevicesThirdParty");
			stream.getTracks().forEach(function(track) { // We don't want to keep it without audio; so we are going to try to add audio now.
				track.stop(); // I need to do this after the enumeration step, else it breaks firefox's labels
			});
			console.log(deviceInfos);
			return deviceInfos;
		});
	});
}
