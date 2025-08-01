const { session } = require('electron');

/**
 * Sets up WebSocket debugging for a webContents instance
 * @param {Electron.WebContents} webContents - The webContents to debug
 * @param {Object} options - Configuration options
 * @param {Function} options.filter - Optional filter function to limit which WebSockets to monitor
 * @param {Function} options.onMessage - Callback for WebSocket messages
 * @param {Function} options.onOpen - Callback for WebSocket open events
 * @param {Function} options.onClose - Callback for WebSocket close events
 * @param {Function} options.onSend - Callback for WebSocket send events
 * @returns {Function} Cleanup function to stop debugging
 */
function setupWebSocketDebugger(webContents, options = {}) {
    const {
        filter = null,
        onMessage = () => {},
        onOpen = () => {},
        onClose = () => {},
        onSend = () => {}
    } = options;

    let debuggerAttached = false;
    const webSocketConnections = new Map();

    // Attach debugger
    try {
        webContents.debugger.attach('1.3');
        debuggerAttached = true;
    } catch (err) {
        console.error('Failed to attach debugger:', err);
        return () => {};
    }

    // Enable network domain
    webContents.debugger.sendCommand('Network.enable');
    
    // Enable runtime for WebSocket frame events
    webContents.debugger.sendCommand('Runtime.enable');

    // Handle debugger events
    const messageHandler = (event, method, params) => {
        if (!debuggerAttached) return;

        try {
            switch (method) {
                case 'Network.webSocketCreated':
                    const { requestId, url } = params;
                    console.log('[WebSocket Debugger] WebSocket created:', url);
                    if (!filter || filter(url)) {
                        webSocketConnections.set(requestId, { url, requestId });
                        onOpen({ url, requestId });
                    }
                    break;

                case 'Network.webSocketClosed':
                    const connection = webSocketConnections.get(params.requestId);
                    if (connection) {
                        onClose({ url: connection.url, requestId: params.requestId });
                        webSocketConnections.delete(params.requestId);
                    }
                    break;

                case 'Network.webSocketFrameReceived':
                    const receivedConn = webSocketConnections.get(params.requestId);
                    if (receivedConn && params.response) {
                        if (receivedConn.url.includes('streamelements')) {
                            console.log('[WebSocket Debugger] StreamElements message:', params.response.payloadData);
                        }
                        onMessage({
                            url: receivedConn.url,
                            data: params.response.payloadData,
                            timestamp: params.timestamp,
                            requestId: params.requestId
                        });
                    }
                    break;

                case 'Network.webSocketFrameSent':
                    const sentConn = webSocketConnections.get(params.requestId);
                    if (sentConn && params.response) {
                        onSend({
                            url: sentConn.url,
                            data: params.response.payloadData,
                            timestamp: params.timestamp,
                            requestId: params.requestId
                        });
                    }
                    break;
            }
        } catch (error) {
            console.error('Error handling debugger event:', error);
        }
    };

    webContents.debugger.on('message', messageHandler);

    // Cleanup function
    return () => {
        if (debuggerAttached) {
            try {
                webContents.debugger.off('message', messageHandler);
                webContents.debugger.detach();
                debuggerAttached = false;
                webSocketConnections.clear();
            } catch (err) {
                console.error('Error detaching debugger:', err);
            }
        }
    };
}

module.exports = {
    setupWebSocketDebugger
};