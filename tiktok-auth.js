const { BrowserWindow, session } = require('electron');

class TikTokAuth {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.authWindow = null;
  }

  async authenticate() {
    return new Promise((resolve, reject) => {
      // Create a new window for TikTok login
      this.authWindow = new BrowserWindow({
        width: 500,
        height: 700,
        parent: this.mainWindow,
        modal: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: 'persist:tiktok-auth' // Separate session for auth
        }
      });

      // Load TikTok login page
      this.authWindow.loadURL('https://www.tiktok.com/login');

      // Handle window closed
      this.authWindow.on('closed', () => {
        this.authWindow = null;
        reject(new Error('Authentication window closed'));
      });

      // Listen for navigation to detect successful login
      this.authWindow.webContents.on('did-navigate', async (event, url) => {
        // Check if we're on a page that indicates successful login
        if (url.includes('tiktok.com/foryou') || url.includes('tiktok.com/@')) {
          try {
            // Get cookies from the session
            const cookies = await this.authWindow.webContents.session.cookies.get({
              domain: '.tiktok.com'
            });

            // Find the required cookies
            const sessionId = cookies.find(c => c.name === 'sessionid')?.value;
            const ttTargetIdc = cookies.find(c => c.name === 'tt-target-idc')?.value;

            if (sessionId) {
              this.authWindow.close();
              resolve({ sessionId, ttTargetIdc });
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

      const sessionId = cookies.find(c => c.name === 'sessionid')?.value;
      const ttTargetIdc = cookies.find(c => c.name === 'tt-target-idc')?.value;

      return { sessionId, ttTargetIdc };
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
      detail: 'Instructions:\n1. Open TikTok in your browser and log in\n2. Open DevTools (F12)\n3. Go to Application → Cookies → tiktok.com\n4. Find "sessionid" and "tt-target-idc" cookies\n5. Copy their values',
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

      if (!sessionId) return null;

      const ttTargetIdc = await prompt({
        title: 'Enter Target IDC',
        label: 'tt-target-idc:',
        value: 'useast1a',
        inputAttrs: {
          type: 'text'
        },
        type: 'input'
      }, this.mainWindow);

      return { sessionId, ttTargetIdc };
    }

    return null;
  }
}

module.exports = TikTokAuth;