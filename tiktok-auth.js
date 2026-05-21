const { BrowserWindow, session, dialog } = require('electron');
const path = require('path');

const AUTH_PARTITION = 'persist:tiktok-auth';
const LOGIN_URL = 'https://www.tiktok.com/login';
const SUCCESS_URL_REGEX = /tiktok\.com\/(?:foryou|@)/i;

const CHROME_UA_VERSION = '148.0.0.0';
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_VERSION} Safari/537.36`;

let partitionConfigured = false;

function getAuthAcceptLanguage() {
    const value = process.env.SSAPP_ACCEPT_LANGUAGE;
    return typeof value === 'string' && value.trim() ? value.trim() : 'en-US,en;q=0.9';
}

async function readTikTokCredentialsFromSession(authSession) {
    try {
        const cookies = await authSession.cookies.get({
            domain: '.tiktok.com'
        });
        const rawSessionId = cookies.find(c => c.name === 'sessionid')?.value;
        const rawTtTargetIdc = cookies.find(c => c.name === 'tt-target-idc')?.value
            || cookies.find(c => c.name === 'tt_target_idc')?.value;
        const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
        const ttTargetIdc = typeof rawTtTargetIdc === 'string' ? rawTtTargetIdc.trim() : '';
        return { sessionId: sessionId || null, ttTargetIdc: ttTargetIdc || null };
    } catch (_) {
        return { sessionId: null, ttTargetIdc: null };
    }
}

function summarizeAuthUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return `${parsed.origin}${parsed.pathname}`;
    } catch (_) {
        return typeof rawUrl === 'string' ? rawUrl.split('?')[0].split('#')[0] : '';
    }
}

function getWindowOrigin(win, fallback = 'https://accounts.google.com') {
    try {
        if (win && !win.isDestroyed() && win.webContents) {
            return new URL(win.webContents.getURL()).origin;
        }
    } catch (_) {}
    return fallback;
}

function buildGoogleOAuthRelayScript(data, targetOrigin, sourceOrigin) {
    const safeTargetOrigin = typeof targetOrigin === 'string' && targetOrigin ? targetOrigin : '*';
    const safeSourceOrigin = typeof sourceOrigin === 'string' && sourceOrigin ? sourceOrigin : 'https://accounts.google.com';
    return `
      (() => {
        const data = ${JSON.stringify(data)};
        const targetOrigin = ${JSON.stringify(safeTargetOrigin)};
        const sourceOrigin = ${JSON.stringify(safeSourceOrigin)};
        let normalizedTargetOrigin = targetOrigin;
        try { normalizedTargetOrigin = new URL(targetOrigin).origin; } catch (_) {}
        const canDeliver = targetOrigin === '*' || normalizedTargetOrigin === window.location.origin;
        if (!canDeliver) return false;
        const relayKey = JSON.stringify([sourceOrigin, typeof data, data]);
        window.__ssappGoogleOAuthRelaySeen = window.__ssappGoogleOAuthRelaySeen || new Set();
        if (window.__ssappGoogleOAuthRelaySeen.has(relayKey)) return false;
        window.__ssappGoogleOAuthRelaySeen.add(relayKey);
        try {
          window.dispatchEvent(new MessageEvent('message', {
            data,
            origin: sourceOrigin,
            source: window
          }));
        } catch (_) {}
        return true;
      })();
    `;
}

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
        headers['Accept-Language'] = getAuthAcceptLanguage();
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
            if (
                lower === 'accept-ch' ||
                lower === 'cross-origin-opener-policy' ||
                lower === 'cross-origin-opener-policy-report-only' ||
                lower === 'cross-origin-embedder-policy' ||
                lower === 'cross-origin-embedder-policy-report-only' ||
                lower === 'cross-origin-resource-policy' ||
                lower === 'cross-origin-resource-policy-report-only'
            ) {
                if (lower !== 'cross-origin-resource-policy') {
                    console.log('[TikTokAuth] Stripping response header:', key, '=', headers[key]);
                }
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

    if (process.env.SSAPP_TIKTOK_AUTH_CLEAR === '1') {
      try {
        await authSession.clearStorageData({
          storages: ['cookies', 'localstorage', 'sessionstorage']
        });
      } catch (error) {
        console.warn('Failed to clear previous TikTok auth session:', error);
      }
    } else {
      const existingCredentials = await readTikTokCredentialsFromSession(authSession);
      if (existingCredentials.sessionId) {
        return existingCredentials;
      }
    }

    return new Promise((resolve, reject) => {
      let resolved = false;
      let cookiePoll = null;
      const childWindows = new Set();
      const relayedGoogleMessages = new Set();

      const finish = (credentials) => {
        if (resolved) return;
        resolved = true;
        if (cookiePoll) {
          clearInterval(cookiePoll);
          cookiePoll = null;
        }
        resolve(credentials);
        try {
          if (this.authWindow && !this.authWindow.isDestroyed()) {
            this.authWindow.close();
          }
        } catch (_) {}
        for (const childWindow of childWindows) {
          try {
            if (childWindow && !childWindow.isDestroyed()) {
              childWindow.close();
            }
          } catch (_) {}
        }
        childWindows.clear();
      };

      this.authWindow = new BrowserWindow({
        width: 1100,
        height: 800,
        parent: this.mainWindow,
        modal: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: false,
          sandbox: false,
          nativeWindowOpen: true,
          partition: AUTH_PARTITION,
          preload: path.join(__dirname, 'preload-mock.js'),
        }
      });

      this.authWindow.loadURL(LOGIN_URL);

      this.authWindow.on('closed', () => {
        this.authWindow = null;
        if (cookiePoll) {
          clearInterval(cookiePoll);
          cookiePoll = null;
        }
        for (const childWindow of childWindows) {
          try {
            if (childWindow && !childWindow.isDestroyed()) {
              childWindow.close();
            }
          } catch (_) {}
        }
        childWindows.clear();
        if (!resolved) {
          reject(new Error('Authentication window closed'));
        }
      });

      const checkCookies = async () => {
        const credentials = await readTikTokCredentialsFromSession(authSession);
        if (credentials.sessionId) {
          finish(credentials);
        }
      };

      cookiePoll = setInterval(checkCookies, 1000);

      this.authWindow.webContents.on('did-navigate', async (event, url) => {
        console.log('[TikTokAuth] Main window navigated:', summarizeAuthUrl(url));
        if (SUCCESS_URL_REGEX.test(url)) {
          await checkCookies();
        }
      });

      this.authWindow.webContents.on('did-navigate-in-page', async (event, url) => {
        console.log('[TikTokAuth] Main window in-page navigation:', summarizeAuthUrl(url));
        if (SUCCESS_URL_REGEX.test(url)) {
          await checkCookies();
        }
      });

      this.authWindow.webContents.on('dom-ready', () => {
        this.authWindow.webContents.executeJavaScript(`
          (() => {
            if (window.__ssappTikTokAuthMessageProbeInstalled) return;
            window.__ssappTikTokAuthMessageProbeInstalled = true;
            window.addEventListener('message', (event) => {
              try {
                const origin = String(event.origin || '');
                const data = event.data;
                const dataType = data === null ? 'null' : typeof data;
                const keys = data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : [];
                const sourcePresent = Boolean(event.source);
                if (origin.includes('google') || keys.some((key) => String(key).toLowerCase().includes('credential'))) {
                  try {
                    window.__ssappGoogleOAuthRelaySeen = window.__ssappGoogleOAuthRelaySeen || new Set();
                    window.__ssappGoogleOAuthRelaySeen.add(JSON.stringify([origin, dataType, data]));
                  } catch (_) {}
                  window.__ipc?.ipcRenderer?.send('tiktok-auth-message-probe', JSON.stringify({
                    origin,
                    dataType,
                    keys,
                    sourcePresent
                  }));
                }
              } catch (_) {}
            }, true);
          })();
        `).catch(() => {});
      });

      this.authWindow.webContents.on('ipc-message', (event, channel, ...args) => {
        if (channel !== 'tiktok-auth-message-probe') return;
        try {
          const detail = JSON.parse(args[0]);
          console.log(
            '[TikTokAuth] TikTok page received message:',
            'origin=', detail.origin || '',
            'type=', detail.dataType || '',
            'keys=', Array.isArray(detail.keys) ? detail.keys.join(',') : '',
            'source=', Boolean(detail.sourcePresent)
          );
        } catch (_) {}
      });

      // TikTok's Google sign-in lands on Google's gsi/transform page, which
      // calls back to the opener window rather than redirecting in-place. Keep a
      // real native popup so window.opener exists for that callback.
      this.authWindow.webContents.setWindowOpenHandler(({ url }) => {
        console.log('[TikTokAuth] Allowing auth popup:', summarizeAuthUrl(url));
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: this.authWindow,
            modal: false,
            width: 640,
            height: 760,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: false,
              sandbox: false,
              nativeWindowOpen: true,
              partition: AUTH_PARTITION,
              preload: path.join(__dirname, 'preload-mock.js'),
            }
          }
        };
      });

      // When Electron creates the Google OAuth popup, listen for the token relay
      this.authWindow.webContents.on('did-create-window', (popupWindow) => {
        console.log('[TikTokAuth] Popup window created');
        childWindows.add(popupWindow);
        const handlePopupNavigation = async () => {
          await checkCookies();
        };
        popupWindow.webContents.on('dom-ready', () => {
          popupWindow.webContents.executeJavaScript('Boolean(window.opener)', true)
            .then((hasOpener) => {
              console.log('[TikTokAuth] Popup opener available:', Boolean(hasOpener));
            })
            .catch(() => {});
        });
        popupWindow.webContents.on('did-navigate', async (event, url) => {
          console.log('[TikTokAuth] Popup navigated:', summarizeAuthUrl(url));
          await handlePopupNavigation();
        });
        popupWindow.webContents.on('did-navigate-in-page', async (event, url) => {
          console.log('[TikTokAuth] Popup in-page navigation:', summarizeAuthUrl(url));
          await handlePopupNavigation();
        });
        popupWindow.on('closed', async () => {
          childWindows.delete(popupWindow);
          await handlePopupNavigation();
        });
        popupWindow.webContents.on('ipc-message', (event, channel, ...args) => {
          if (channel === 'google-oauth-relay-state') {
            try {
              const detail = JSON.parse(args[0]);
              console.log('[TikTokAuth] Google OAuth relay state:', detail.event, detail.url || '');
            } catch (_) {}
            return;
          }

          if (channel === 'google-oauth-relay') {
            try {
              const { data, targetOrigin, sourceOrigin } = JSON.parse(args[0]);
              const relaySourceOrigin = sourceOrigin || getWindowOrigin(popupWindow);
              const relayKey = JSON.stringify([relaySourceOrigin, targetOrigin || '*', typeof data, data]);
              if (relayedGoogleMessages.has(relayKey)) {
                return;
              }
              relayedGoogleMessages.add(relayKey);
              const dataKeys = data && typeof data === 'object' ? Object.keys(data).slice(0, 12).join(',') : '';
              console.log(
                '[TikTokAuth] Relaying Google OAuth token to TikTok page',
                'target=', targetOrigin || '*',
                'keys=', dataKeys
              );
              if (this.authWindow && !this.authWindow.isDestroyed() && this.authWindow.webContents) {
                setTimeout(() => {
                  if (!this.authWindow || this.authWindow.isDestroyed() || !this.authWindow.webContents) return;
                  this.authWindow.webContents.executeJavaScript(
                    buildGoogleOAuthRelayScript(data, targetOrigin, relaySourceOrigin),
                    true
                  ).catch((error) => {
                    console.warn('[TikTokAuth] Google OAuth relay injection failed:', error?.message || error);
                  });
                }, 150);
              }
              setTimeout(async () => {
                await checkCookies();
                try {
                  if (!resolved && popupWindow && !popupWindow.isDestroyed()) {
                    popupWindow.close();
                  }
                } catch (_) {}
              }, 1000);
            } catch (_) {}
          }
        });
      });
    });
  }

  // Alternative method: Extract cookies from existing session
  async getCookiesFromSession() {
    try {
      configureAuthPartition();
      return await readTikTokCredentialsFromSession(session.fromPartition(AUTH_PARTITION));
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
module.exports.configureAuthPartition = configureAuthPartition;
