const { BrowserWindow, session } = require('electron');

const AUTH_PARTITION = 'persist:tiktok-auth';
const LOGIN_URL = 'https://www.tiktok.com/login';
const SUCCESS_URL_REGEX = /tiktok\.com\/(?:foryou|@)/i;

class TikTokAuth {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.authWindow = null;
  }

  async authenticate() {
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

      // Create a new window for TikTok login
      this.authWindow = new BrowserWindow({
        width: 500,
        height: 700,
        parent: this.mainWindow,
        modal: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: AUTH_PARTITION // Separate session for auth
        }
      });

      // Load TikTok login page after ensuring session data is cleared
      this.authWindow.loadURL(LOGIN_URL);

      // Handle window closed
      this.authWindow.on('closed', () => {
        this.authWindow = null;
        if (!resolved) {
          reject(new Error('Authentication window closed'));
        }
      });

      // Listen for navigation to detect successful login
      this.authWindow.webContents.on('did-navigate', async (event, url) => {
        // Check if we're on a page that indicates successful login
        if (SUCCESS_URL_REGEX.test(url)) {
          try {
            // Get cookies from the session
            const cookies = await authSession.cookies.get({
              domain: '.tiktok.com'
            });

            // Find the required cookies
            const rawSessionId = cookies.find(c => c.name === 'sessionid')?.value;
            const rawTtTargetIdc = cookies.find(c => c.name === 'tt-target-idc')?.value;
            const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
            const ttTargetIdc = typeof rawTtTargetIdc === 'string' ? rawTtTargetIdc.trim() : '';

            if (sessionId) {
              resolved = true;
              resolve({ sessionId, ttTargetIdc: ttTargetIdc || null });
            }
          } catch (error) {
            console.error('Error getting cookies:', error);
          }
        }
      });

      // Add menu to help users
      this.authWindow.webContents.on('did-finish-load', () => {
        this.authWindow.webContents.executeJavaScript(`
          console.log('Please log in to your TikTok account');
        `);
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
