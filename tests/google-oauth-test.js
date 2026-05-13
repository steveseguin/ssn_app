const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const AUTH_PARTITION = 'persist:google-test';
const CHROME_UA_VERSION = '148.0.0.0';
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_VERSION} Safari/537.36`;

const GOOGLE_URL = process.argv[2] || 'https://accounts.google.com/v3/signin/identifier?flowName=GeneralOAuthFlow';

app.commandLine.appendSwitch('disable-features', 'UserAgentClientHints');

app.whenReady().then(() => {
    const ses = session.fromPartition(AUTH_PARTITION);
    ses.setUserAgent(CHROME_UA);

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = details.requestHeaders;
        headers['User-Agent'] = CHROME_UA;
        delete headers['X-DevTools-Request-Id'];
        delete headers['X-DevTools-Emulate-Network-Conditions-Client-Id'];
        
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'sec-ch-ua') {
                headers[key] = '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"';
            }
        }
        
        callback({ requestHeaders: headers });
    });

    ses.webRequest.onHeadersReceived((details, callback) => {
        const headers = details.responseHeaders || {};
        delete headers['accept-ch'];
        callback({ responseHeaders: headers });
    });

    const win = new BrowserWindow({
        width: 500,
        height: 700,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            partition: AUTH_PARTITION,
            preload: path.join(__dirname, '..', '..', 'preload-mock.js'),
        }
    });

    win.webContents.openDevTools({ mode: 'detach' });

    win.webContents.on('did-navigate', (event, url) => {
        console.log('NAVIGATED to:', url.substring(0, 120));
        if (url.includes('rejected')) {
            console.log('*** GOOGLE REJECTED ***');
        }
        if (url.includes('identifier') || url.includes('password')) {
            console.log('*** GOT SIGNIN PAGE ***');
        }
    });

    win.loadURL(GOOGLE_URL).catch(err => {
        console.error('Failed to load URL:', err.message);
    });

    win.on('closed', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
