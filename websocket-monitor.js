const { session } = require('electron');

/**
 * Sets up WebSocket monitoring for a webContents instance
 * @param {Electron.WebContents} webContents - The webContents to monitor
 * @param {Object} [options] - Configuration options
 * @param {(url: string) => boolean} [options.filter] - Optional filter function to limit which WebSockets to monitor
 * @param {Function} [options.onMessage] - Callback for WebSocket messages
 * @param {Function} [options.onOpen] - Callback for WebSocket open events
 * @param {Function} [options.onClose] - Callback for WebSocket close events
 * @param {Function} [options.onSend] - Callback for WebSocket send events
 * @returns {Promise<Function>} Cleanup function to stop monitoring
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
                        onOpen({ url, requestId });
                    }
        } break;

                case 'Network.webSocketWillSendHandshakeRequest': {
                    const conn = webSocketConnections.get(params.requestId);
                    if (conn && params.wallTime && params.timestamp) {
                        // The exact difference between MonotonicTime and Unix epoch clock time
                        conn.timestampDelta = params.wallTime - params.timestamp;
                    }
        } break;

        case 'Network.webSocketClosed': {
                    const connection = webSocketConnections.get(params.requestId);
                    if (connection) {
                        let { timestampDelta } = connection;
                        if (timestampDelta === null) {
                            console.warn("Timestamp Delta missing in WS Connection data", connection.url, connection.requestId);
                            timestampDelta = Date.now() - params.timestamp;
                        }
                        onClose({
                            url: connection.url,
                            requestId: params.requestId,
                            timestamp: params.timestamp + timestampDelta,
                        });
                        webSocketConnections.delete(params.requestId);
                    }
        } break;

                case 'Network.webSocketFrameReceived':
                    const receivedConn = webSocketConnections.get(params.requestId);
                    if (receivedConn && params.response) {
                        let { timestampDelta } = receivedConn;
                        if (timestampDelta === null) {
                            console.warn("Timestamp Delta missing in WS Connection data", receivedConn.url, receivedConn.requestId);
                            timestampDelta = Date.now() - params.timestamp;
                        }
                        onMessage({
                            url: receivedConn.url,
                            data: params.response.payloadData,
                            opcode: params.response.opcode,
                            timestamp: params.timestamp + timestampDelta,
                            requestId: params.requestId
                        });
          } break;

        case 'Network.webSocketFrameSent': {
                    const sentConn = webSocketConnections.get(params.requestId);
                    if (sentConn && params.response) {
                        let { timestampDelta } = sentConn;
                        if (timestampDelta === null) {
                            console.warn("Timestamp Delta missing in WS Connection data", sentConn.url, sentConn.requestId);
                            timestampDelta = Date.now() - params.timestamp;
                        }
                        onSend({
                            url: sentConn.url,
                            data: params.response.payloadData,
                            timestamp: params.timestamp + timestampDelta,
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

    function cleanup() {
        try {
            webContents.debugger.off('message', messageHandler);
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
        await Promise.all([
            webContents.debugger.sendCommand('Network.enable'),
            // Enable runtime for WebSocket frame events
            webContents.debugger.sendCommand('Runtime.enable'),
        ]);
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