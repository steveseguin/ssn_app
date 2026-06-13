# AGENTS.md - Social Stream Ninja Standalone (ssapp)

## Project Overview

Electron desktop application for aggregating social media live stream chat. CommonJS JavaScript codebase (no TypeScript).

## Communication

- When replying to Steve, prefer plain, everyday language over jargon.
- Keep explanations direct and practical; explain technical terms briefly when they matter.

## Source Of Truth

- Social Stream source edits must be made in `C:\Users\steve\Code\social_stream`.
- `ssapp` loads Social Stream source files remotely from `C:\Users\steve\Code\social_stream` at app startup; treat that repo as the primary runtime source.
- Do not treat `C:\Users\steve\Code\ssapp\resources\social_stream_fallback\main` as the source repo; it is a fallback mirror/bundle target.
- The `resources/social_stream_fallback/main` folder is replaced at build/update time and should be treated only as a backup, not the primary source.
- **Do not read, browse, edit, or add changes in `resources/social_stream_fallback` during normal app work.**  
  This folder is disposable/rebuilt on every build/update (`npm run update:fallback`), so spending time on it is not productive.

## Build/Run Commands

| Command | Description |
|---------|-------------|
| `npm run start` | Start Electron app |
| `npm run start2` | Development mode (`--running-from-source`) |
| `npm run build` | Build for current OS |
| `npm run build:win32` | Build for Windows (NSIS + portable) |
| `npm run build:darwin` | Build for macOS (x64 + arm64) |
| `npm run build:linux` | Build for Linux (AppImage) |
| `npm run clean` | Remove dist folder |
| `npm run update:fallback` | Update Social Stream fallback bundle |

## Testing

No formal test framework (Jest/Mocha). Manual integration tests only.

### TikTok Connection Tests

```bash
cd tests/tiktok
npm install
npm start                    # Run default tests
npm run ws                   # WebSocket mode only
npm run legacy               # Legacy/polling mode only
npm run both                 # Both modes sequentially
node run.js --mode=websocket --user=username --duration=30000
```

## Code Style Guidelines

### Formatting (Prettier)

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "es5",
  "printWidth": 120,
  "tabWidth": 2,
  "useTabs": true
}
```

### Module System

CommonJS only. Use `require()` and `module.exports`:

```javascript
const { ipcMain, shell } = require("electron");
const path = require("path");
module.exports = { setupKickOAuthHandler };
```

### Strict Mode

Use `'use strict';` at the top of standalone modules:

```javascript
'use strict';

const fs = require('fs');
// ...
```

### Naming Conventions

- **Variables/functions**: camelCase (`normalizeSlug`, `getMainWindow`)
- **Classes**: PascalCase (`CircularBuffer`, `StateManager`, `KickWsClient`)
- **Constants**: SCREAMING_SNAKE_CASE (`DEFAULT_TIMEOUT_MS`, `LOOPBACK_HOST`)

### Import Organization

1. Node built-ins first (`fs`, `path`, `os`, `crypto`)
2. Electron modules (`electron`, `electron-store`)
3. External packages (`ws`, `undici`)
4. Local modules (relative paths)

```javascript
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");
const Store = require("electron-store");
const WebSocket = require("ws");
const { setupKickOAuthHandler } = require("./resources/electron-kick-handler");
```

### Error Handling

**Silent failures for non-critical operations:**
```javascript
try {
    wc.removeListener("did-finish-load", onFinish);
} catch (_) { }
```

**Error normalization for consistent error objects:**
```javascript
function normalizeGrpcError(error) {
    return {
        message: error.message || "Unknown error",
        code: typeof error.code === "number" ? error.code : null,
        details: error.details || null
    };
}
```

**Custom error codes:**
```javascript
error.code = "SSAPP_TIKTOK_STOPPED";
```

### Async/Await

Prefer async/await over callbacks:

```javascript
async function fetchKickChannel(slug, options = {}) {
    const result = await fetchFn(url, { headers });
    return result;
}
```

### Guard Clauses

Use early returns for validation:

```javascript
if (!value || typeof value !== "string") return "";
if (!connector || typeof connector !== "object") return;
```

### Null Coalescing

```javascript
const userAgent = options.userAgent || DEFAULT_USER_AGENT;
const accessToken = options.accessToken || options.token || null;
```

### Logging

Use bracketed prefixes for context:

```javascript
console.log("[KickWs] Token channel lookup failed", error?.message || error);
console.warn("[TikTok] Sign server fallback patch installed");
console.error("[Preload] Failed to retrieve SSAPP environment:", error);
```

### JSDoc Comments

Document complex functions:

```javascript
/**
 * Install additional fallback logic into the provided TikTok Live connector module.
 * @param {object} connector - The tiktok-live-connector module instance.
 */
function installTikTokSignServerFallback(connector) { ... }
```

### Class Structure

ES6 classes with constructor initialization:

```javascript
class CircularBuffer {
    constructor(capacity) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
    }
    push(item) { ... }
}
```

## Project Structure

```
ssapp/
├── main.js                    # Main Electron process entry
├── preload.js                 # Preload script for renderer
├── renderer.js                # Renderer process
├── index.html                 # Main UI
├── state.js                   # StateManager class
├── tiktok/
│   └── connection-manager.js  # TikTok connection management
├── tiktok-signing/
│   └── electron-signer.js     # TikTok signing helper
├── resources/
│   ├── electron-*-handler.js  # Platform OAuth handlers
│   ├── kick-ws-client.js      # Kick WebSocket client
│   └── social_stream_fallback/# Bundled Social Stream assets
├── tests/tiktok/              # TikTok integration tests
└── scripts/                   # Build scripts
```

## Key Dependencies

- **Electron**: ^40.0.0-beta.7
- **tiktok-live-connector**: ^2.1.0
- **@eulerstream/euler-websocket-sdk**: ^0.0.6
- **ws**: ^8.18.1
- **electron-store**: 8.2.0
- **undici**: ^7.5.0

## Development Notes

- Node.js >= 18.0.0 required
- No TypeScript - pure JavaScript
- All contributions require CLA signing
- Test on your platform before submitting PRs
- Prefer editing existing files over creating new ones

---

## Suggested TODOs

- [ ] Keep TikTok debug logging on for dev builds but move heavy lifting off the hot path
- [ ] Replace the 30k entry `MessageCache` Map with a fixed-size ring buffer
- [ ] Audit reconnect/polling flows to prevent "long pause → duplicate flood" issues
- [ ] Implement "3-strike" Websocket fallback rule
- [ ] Redesign source setup page for clearer Polling vs Websocket choices
