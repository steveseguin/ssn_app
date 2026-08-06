const { session } = require('electron');

/**
 * @typedef {Object} WSOpenEvent
 * @property {string} url - The WebSocket URL
 * @property {string} requestId - The CDP request identifier
 * @property {number} timestamp - Epoch timestamp in milliseconds
 *
 * @typedef {Object} WSCloseEvent
 * @property {string} url - The WebSocket URL
 * @property {string} requestId - The CDP request identifier
 * @property {number} timestamp - Epoch timestamp in milliseconds
 *
 * @typedef {Object} WSFrameEvent
 * @property {string} url - The WebSocket URL
 * @property {string} data - Payload data of the frame
 * @property {number} opcode - Frame opcode
 * @property {number} timestamp - Epoch timestamp in milliseconds
 * @property {string} requestId - The CDP request identifier
 *
 * @param {Electron.WebContents} webContents - The webContents to monitor
 * @param {Object} [options] - Configuration options
 * @param {(url: string) => boolean} [options.filter] - Optional filter function to limit which WebSockets to monitor
 * @param {() => Promise<void>|void} [options.onAttached] - Optional async callback invoked immediately after debugger attaches, before CDP commands resolve
 * @param {(event: WSFrameEvent) => void} [options.onMessage] - Callback for WebSocket messages
 * @param {(event: WSOpenEvent) => void} [options.onOpen] - Callback for WebSocket open events
 * @param {(event: WSCloseEvent) => void} [options.onClose] - Callback for WebSocket close events
 * @param {(event: WSFrameEvent) => void} [options.onSend] - Callback for WebSocket send events
 * @returns {Promise<() => void>} Cleanup function to stop monitoring
 */
async function setupWebSocketMonitor(webContents, options = {}) {
  const {
    filter = null,
    onMessage = () => { },
    onOpen = () => { },
    onClose = () => { },
    onSend = () => { }
  } = options;

  let monitoringActive = false;
  /**
   * @type {Map<string, {url: string, requestId: string, timestampDelta: number?}>}
   */
  const webSocketConnections = new Map();

  /**
   * Calculates epoch timestamp in milliseconds for a WebSocket event payload.
   * @param {number?} [timestampDelta] - Monotonic to wall-clock time delta in milliseconds
   * @param {number} [timestamp] - CDP monotonic timestamp in seconds
   * @returns {number} Epoch timestamp in milliseconds
   */
  function calculateWSTimestamp(timestampDelta, timestamp) {
    if (timestampDelta == null || !timestamp) return Date.now();

    return (timestamp * 1000) + timestampDelta;
  }

  // Handle debugger events
  const messageHandler = (event, method, params) => {
    if (!monitoringActive) return;

    try {
      switch (method) {
        case 'Network.webSocketCreated': {
          const { requestId, url } = params;
          if (!filter || filter(url)) {
            // timestampDelta will be calculated in `Network.webSocketWillSendHandshakeRequest`
            webSocketConnections.set(requestId, { url, requestId, timestampDelta: null });
            onOpen({ url, requestId, timestamp: Date.now() });
          }
        } break;

        case 'Network.webSocketWillSendHandshakeRequest': {
          const conn = webSocketConnections.get(params.requestId);
          if (conn && params.wallTime && params.timestamp) {
            // The exact difference in ms between MonotonicTime (sec) and Unix epoch clock time (sec)
            conn.timestampDelta = (params.wallTime - params.timestamp) * 1000;
          }
        } break;

        case 'Network.webSocketClosed': {
          const connection = webSocketConnections.get(params.requestId);
          if (connection) {
            if (connection.timestampDelta === null) {
              console.warn("Timestamp Delta missing in WS Connection data", connection.url, connection.requestId);
            }
            onClose({
              url: connection.url,
              requestId: params.requestId,
              timestamp: calculateWSTimestamp(connection.timestampDelta, params.timestamp),
            });
            webSocketConnections.delete(params.requestId);
          }
        } break;

        case 'Network.webSocketFrameReceived':
          const receivedConn = webSocketConnections.get(params.requestId);
          if (receivedConn && params.response) {
            if (receivedConn.timestampDelta === null) {
              console.warn("Timestamp Delta missing in WS Connection data", receivedConn.url, receivedConn.requestId);
            }
            onMessage({
              url: receivedConn.url,
              data: params.response.payloadData,
              opcode: params.response.opcode,
              timestamp: calculateWSTimestamp(receivedConn.timestampDelta, params.timestamp),
              requestId: params.requestId
            });
          } break;

        case 'Network.webSocketFrameSent': {
          const sentConn = webSocketConnections.get(params.requestId);
          if (sentConn && params.response) {
            if (sentConn.timestampDelta === null) {
              console.warn("Timestamp Delta missing in WS Connection data", sentConn.url, sentConn.requestId);
            }
            onSend({
              url: sentConn.url,
              data: params.response.payloadData,
              timestamp: calculateWSTimestamp(sentConn.timestampDelta, params.timestamp),
              opcode: params.response.opcode,
              requestId: params.requestId
            });
          }
        } break;
      }
    } catch (error) {
      console.error('Error handling WebSocket event:', error);
    }
  };

  webContents.debugger.on('message', messageHandler);

  // Sockets belong to a document; drop tracking on main-frame navigation so a
  // prior document's late frames are never forwarded into the new document
  const navigationHandler = () => {
    webSocketConnections.clear();
  };
  webContents.on('did-navigate', navigationHandler);

  function cleanup() {
    try {
      webContents.debugger.off('message', messageHandler);
    } catch (_) { }
    try {
      webContents.off('did-navigate', navigationHandler);
    } catch (_) { }

    if (monitoringActive) {
      try {
        webContents.debugger.detach();
      } catch (err) {
        console.error('Error detaching WebSocket monitor:', err);
      }
      monitoringActive = false;
      webSocketConnections.clear();
    }
  }

  try {
    webContents.debugger.attach('1.3');
    monitoringActive = true;

    // Queue CDP enable commands synchronously BEFORE loadURL() so Chromium
    // processes Network.enable immediately when the renderer target spins up
    const networkEnablePromise = webContents.debugger.sendCommand('Network.enable');
    const runtimeEnablePromise = webContents.debugger.sendCommand('Runtime.enable');

    if (typeof options.onAttached === 'function') {
      try {
        await options.onAttached();
      } catch (err) {
        console.error('Error executing onAttached callback:', err);
      }
    }

    // Await the queued CDP enable promises
    await Promise.all([networkEnablePromise, runtimeEnablePromise]);
  } catch (err) {
    console.error('Failed to attach WebSocket monitor:', err);
    cleanup();
    throw err;
  }

  // Cleanup function
  return cleanup;
}

module.exports = {
  setupWebSocketMonitor
};