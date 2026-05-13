const { BrowserWindow, session, dialog } = require('electron');
const path = require('path');

const AUTH_PARTITION = 'persist:tiktok-auth';
const LOGIN_URL = 'https://www.tiktok.com/login';
const SUCCESS_URL_REGEX = /tiktok\.com\/(?:foryou|@)/i;

const CHROME_UA_VERSION = '148.0.0.0';
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_VERSION} Safari/537.36`;

let partitionConfigured = false;

function configureAuthPartition() {
    if (partitionConfigured) return;
    const authSession = session.fromPartition(AUTH_PARTITION);
    authSession.setUserAgent(CHROME_UA);

    authSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = details.requestHeaders;

        headers['User-Agent'] = CHROME_UA;

        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'sec-ch-ua') {
                headers[key] = '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"';
            }
        }

        headers['Accept'] = headers['Accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
        headers['Accept-Encoding'] = 'gzip, deflate, br, zstd';
        headers['Cache-Control'] = headers['Cache-Control'] || 'max-age=0';

        delete headers['X-DevTools-Request-Id'];
        delete headers['X-DevTools-Emulate-Network-Conditions-Client-Id'];

        callback({ requestHeaders: headers });
    });

    authSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = details.responseHeaders || {};
        const keysToDelete = [];
        for (const key of Object.keys(headers)) {
            const lower = key.toLowerCase();
            if (lower === 'accept-ch' || lower === 'cross-origin-opener-policy' || lower === 'cross-origin-embedder-policy' || lower === 'cross-origin-resource-policy') {
                console.log('[TikTokAuth] Stripping response header:', key, '=', headers[key]);
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(k => delete headers[k]);
        callback({ responseHeaders: headers });
    });

    partitionConfigured = true;
}

class TikTokAuth {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.authWindow = null;
  }

  async authenticate() {
    configureAuthPartition();
    const authSession = session.fromPartition(AUTH_PARTITION);

    try {
      await authSession.clearStorageData({
        storages: ['cookies', 'localstorage', 'sessionstorage']
      });
    } catch (error) {
      console.warn('Failed to clear previous TikTok auth session:', error);
    }

    return new Promise((resolve, reject) => {
      let resolved = false;

      this.authWindow = new BrowserWindow({
        width: 1100,
        height: 800,
        parent: this.mainWindow,
        modal: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: false,
          sandbox: false,
          partition: AUTH_PARTITION,
          preload: path.join(__dirname, 'preload-mock.js'),
        }
      });

      this.authWindow.loadURL(LOGIN_URL);

      this.authWindow.on('closed', () => {
        this.authWindow = null;
        if (!resolved) {
          reject(new Error('Authentication window closed'));
        }
      });

      const checkCookies = async () => {
        try {
          const cookies = await authSession.cookies.get({
            domain: '.tiktok.com'
          });
          const rawSessionId = cookies.find(c => c.name === 'sessionid')?.value;
          const rawTtTargetIdc = cookies.find(c => c.name === 'tt-target-idc')?.value;
          const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
          const ttTargetIdc = typeof rawTtTargetIdc === 'string' ? rawTtTargetIdc.trim() : '';
          if (sessionId) {
            resolved = true;
            resolve({ sessionId, ttTargetIdc: ttTargetIdc || null });
            try {
              if (this.authWindow && !this.authWindow.isDestroyed()) {
                this.authWindow.close();
              }
            } catch (_) {}
          }
        } catch (_) {}
      };

      this.authWindow.webContents.on('did-navigate', async (event, url) => {
        if (SUCCESS_URL_REGEX.test(url)) {
          await checkCookies();
        }
      });

      this.authWindow.webContents.on('did-navigate-in-page', async (event, url) => {
        if (SUCCESS_URL_REGEX.test(url)) {
          await checkCookies();
        }
      });

      // Google OAuth in Electron requires:
      // 1. contextIsolation: false — preload patches (navigator.webdriver, userAgentData, etc.)
      //    only affect the page when preload shares the same JS context as the page.
      //    With contextIsolation: true the patches run in an isolated world the page never sees.
      // 2. preload: preload-mock.js — patches navigator.webdriver=false, adds "Google Chrome"
      //    to navigator.userAgentData.brands/fullVersionList, fakes navigator.plugins,
      //    window.chrome, eval.toString(), etc. Google detects raw Chromium (no "Google Chrome"
      //    brand) and blocks sign-in with "This browser or app may not be secure."
      // 3. sec-ch-ua header override in onBeforeSendHeaders — Chromium in Electron sends
      //    sec-ch-ua without "Google Chrome" brand. Must replace value in-place (matching
      //    the lowercase key) to include "Google Chrome";v="148".
      // 4. User-Agent header override — service workers bypass session.setUserAgent() and
      //    expose "Electron/42.0.1" in the UA string. Force UA in onBeforeSendHeaders.
      // 5. onHeadersReceived strips accept-ch, COOP, COEP, CORP — prevents servers from
      //    requesting additional client hints and prevents Cross-Origin-Opener-Policy from
      //    blocking window.opener.postMessage between the Google popup and TikTok's page.
      //    COOP must be stripped case-insensitively (servers use varying header name casing).
      // 6. action: 'allow' — Google's GIS client validates window.open() return value.
      //    action:'deny' returns null, causing "Failed to open popup window" and GIS gives up.
      //    action:'allow' creates a proper popup where window.opener is set and GIS can
      //    communicate with it via postMessage to deliver the OAuth token.
      this.authWindow.webContents.setWindowOpenHandler(({ url }) => {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: false,
              sandbox: false,
              preload: path.join(__dirname, 'preload-mock.js'),
            }
          }
        };
      });

      // When Electron creates the Google OAuth popup, listen for the token relay
      this.authWindow.webContents.on('did-create-window', (popupWindow) => {
        console.log('[TikTokAuth] Popup window created');
        popupWindow.webContents.on('ipc-message', (event, channel, ...args) => {
          if (channel === 'google-oauth-relay') {
            try {
              const { data, targetOrigin } = JSON.parse(args[0]);
              console.log('[TikTokAuth] Relaying Google OAuth token to TikTok page');
              this.authWindow.webContents.executeJavaScript(
                `window.postMessage(${JSON.stringify(data)}, '${targetOrigin}');`
              ).catch(() => {});
            } catch (_) {}
          }
        });
      });
    });
  }

  // Alternative method: Extract cookies from existing session
  async getCookiesFromSession() {
    try {
      const cookies = await session.defaultSession.cookies.get({
        domain: '.tiktok.com'
      });

      const rawSessionId = cookies.find(c => c.name === 'sessionid')?.value;
      const rawTtTargetIdc = cookies.find(c => c.name === 'tt-target-idc')?.value;
      const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
      const ttTargetIdc = typeof rawTtTargetIdc === 'string' ? rawTtTargetIdc.trim() : '';

      return { sessionId: sessionId || null, ttTargetIdc: ttTargetIdc || null };
    } catch (error) {
      console.error('Error getting cookies from session:', error);
      return { sessionId: null, ttTargetIdc: null };
    }
  }

  // Manual cookie input dialog
  async promptForCookies() {
    const { dialog } = require('electron');
    
    const result = await dialog.showMessageBox(this.mainWindow, {
      type: 'info',
      title: 'TikTok Authentication',
      message: 'To use authenticated features, you need to provide your TikTok session cookies.',
      detail: 'Instructions:\n1. Open TikTok in your browser and log in\n2. Open DevTools (F12)\n3. Go to Application → Cookies → tiktok.com\n4. Copy the value of the "sessionid" cookie (required)\n5. Optionally copy "tt-target-idc" if it is present',
      buttons: ['Enter Cookies', 'Cancel'],
      defaultId: 0
    });

    if (result.response === 0) {
      const prompt = require('electron-prompt');
      
      const sessionId = await prompt({
        title: 'Enter Session ID',
        label: 'Session ID:',
        value: '',
        inputAttrs: {
          type: 'text'
        },
        type: 'input'
      }, this.mainWindow);

      const sanitizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!sanitizedSessionId) return null;

      const ttTargetIdc = await prompt({
        title: 'Enter Target IDC',
        label: 'tt-target-idc:',
        value: '',
        inputAttrs: {
          type: 'text'
        },
        type: 'input'
      }, this.mainWindow);

      const sanitizedTtTargetIdc = typeof ttTargetIdc === 'string' ? ttTargetIdc.trim() : '';

      return { sessionId: sanitizedSessionId, ttTargetIdc: sanitizedTtTargetIdc || null };
    }

    return null;
  }
}

module.exports = TikTokAuth;
module.exports.AUTH_PARTITION = AUTH_PARTITION;
