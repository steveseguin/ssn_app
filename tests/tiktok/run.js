const path = require('path');
const process = require('process');
const tiktokConnector = require('tiktok-live-connector');
const {
  createTikTokEnvironment,
  installTikTokSignServerFallback
} = require('../../tiktok/connection-manager');
const {
  createStrategyResult,
  exitCodeForResults
} = require('./runner-result');

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

installTikTokSignServerFallback(tiktokConnector);

const websocketConnections = {};
const browserViews = {};
const connectionStates = new Map();
const latestStatuses = new Map();
const connectedConnectionIds = new Set();

const env = createTikTokEnvironment({
  connector: tiktokConnector,
  shouldEnableTikTokLogging: false,
  resolveLogDirectory: () => path.join(__dirname, 'logs'),
  getMainWindow: () => null,
  browserViews,
  websocketConnections,
  log: (...args) => console.log('[lib]', ...args),
  onStatus: (status) => {
    console.log('[status]', status);
    if (!status || status.wssID == null) return;
    latestStatuses.set(status.wssID, status);
    if (status.status === 'connected') connectedConnectionIds.add(status.wssID);
  },
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
  let initializeError = null;
  try {
    await manager.initialize();
  } catch (error) {
    initializeError = error;
    console.error(`[runner] initialize failed (${strategy}):`, error.message || error);
  }

  await new Promise(resolve => setTimeout(resolve, options.duration));

  try {
    cleanupConnection(wssID);
  } catch (error) {
    console.warn(`[runner] cleanup error (${strategy}):`, error.message || error);
  }

  return createStrategyResult(
    strategy,
    connectedConnectionIds.has(wssID),
    latestStatuses.get(wssID),
    initializeError
  );
}

async function main() {
  const modes = [];
  if (options.mode === 'both' || options.mode === 'websocket') {
    modes.push('websocket');
  }
  if (options.mode === 'both' || options.mode === 'legacy') {
    modes.push('legacy');
  }

  if (!modes.length) {
    throw new Error(`Unsupported TikTok test mode: ${options.mode}`);
  }

  const results = [];
  for (const mode of modes) {
    results.push(await runStrategy(mode));
  }

  const failed = results.filter(result => !result.connected);
  if (failed.length) {
    console.error('\n[runner] Test run failed:', failed);
  } else {
    console.log('\n[runner] Test run complete.');
  }
  return exitCodeForResults(results);
}

main().then(code => {
  process.exit(code);
}).catch(error => {
  console.error('[runner] Fatal error:', error);
  process.exit(1);
});
