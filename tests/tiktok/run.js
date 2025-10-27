const path = require('path');
const process = require('process');
const tiktokConnector = require('tiktok-live-connector');
const {
  createTikTokEnvironment
} = require('../../tiktok/connection-manager');

const args = process.argv.slice(2);
const options = {
  mode: 'both',
  username: 'juanstreams',
  duration: 20000
};

for (const arg of args) {
  if (arg.startsWith('--mode=')) {
    options.mode = arg.split('=')[1] || options.mode;
  } else if (arg.startsWith('--user=')) {
    options.username = arg.split('=')[1] || options.username;
  } else if (arg.startsWith('--duration=')) {
    const parsed = Number(arg.split('=')[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      options.duration = parsed;
    }
  }
}

const websocketConnections = {};
const browserViews = {};
const connectionStates = new Map();

const env = createTikTokEnvironment({
  connector: tiktokConnector,
  shouldEnableTikTokLogging: false,
  resolveLogDirectory: () => path.join(__dirname, 'logs'),
  getMainWindow: () => null,
  browserViews,
  websocketConnections,
  log: (...args) => console.log('[lib]', ...args),
  onStatus: (status) => console.log('[status]', status),
  onEvent: (event) => {
    if (!event || event.type !== 'tiktok') {
      return;
    }
    const summary = {
      event: event.event || (event.hasDonation ? 'gift' : 'chat'),
      user: event.chatname || event.userid || 'unknown',
      donation: event.hasDonation || null
    };
    const body = event.chatmessage ? ` :: ${event.chatmessage}` : '';
    console.log(`[event:${summary.event}] ${summary.user}${summary.donation ? ' [' + summary.donation + ']' : ''}${body}`);
  },
  getCachedSettings: () => ({}),
  isCaptureEventsEnabled: () => true,
  isCaptureJoinedEventEnabled: () => true,
  isViewerUpdateAllowed: () => true,
  isTextOnlyModeEnabled: () => false,
  connectionStates
});

const {
  ConnectionManager,
  cleanupConnection
} = env;

if (!ConnectionManager) {
  console.error('TikTok environment unavailable. Ensure tiktok-live-connector is installed.');
  process.exit(1);
}

let nextWssId = 1;

async function runStrategy(strategy) {
  const wssID = nextWssId++;
  const username = options.username.toLowerCase();
  const manager = new ConnectionManager(
    username,
    wssID,
    null,
    null,
    { forceLegacyConnector: strategy === 'legacy' }
  );

  manager.virtualTabId = 900000 + wssID;
  manager.wssID = wssID;
  websocketConnections[wssID] = manager;
  browserViews[manager.virtualTabId] = {
    isTikTokVirtual: true,
    wssID,
    username,
    args: { url: `https://www.tiktok.com/@${username}/live` },
    webContents: {
      getURL: () => `https://www.tiktok.com/@${username}/live`,
      send: () => {}
    }
  };

  connectionStates.set(wssID, {
    isConnected: false,
    lastAttempt: Date.now(),
    isReconnecting: false,
    attemptInProgress: false
  });

  console.log(`\n[runner] Starting ${strategy} connection for @${username}`);
  try {
    await manager.initialize();
  } catch (error) {
    console.error(`[runner] initialize failed (${strategy}):`, error.message || error);
  }

  await new Promise(resolve => setTimeout(resolve, options.duration));

  try {
    cleanupConnection(wssID);
  } catch (error) {
    console.warn(`[runner] cleanup error (${strategy}):`, error.message || error);
  }
}

async function main() {
  const modes = [];
  if (options.mode === 'both' || options.mode === 'websocket') {
    modes.push('websocket');
  }
  if (options.mode === 'both' || options.mode === 'legacy') {
    modes.push('legacy');
  }

  for (const mode of modes) {
    await runStrategy(mode);
  }

  console.log('\n[runner] Test run complete.');
  process.exit(0);
}

main().catch(error => {
  console.error('[runner] Fatal error:', error);
  process.exit(1);
});
