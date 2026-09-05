# AGENTS.md - Social Stream Ninja Standalone (ssapp)

## Project Overview

Electron desktop application for aggregating social media live stream chat. CommonJS JavaScript codebase (no TypeScript).

## Git Rules (CRITICAL)

- **Never create git branches, worktrees, or pull requests in this repo unless Steve explicitly asks for one.** All work happens as commits directly on the currently checked-out branch (normally `main`) in the main checkout at `C:\Users\steve\Code\ssapp`.
- This applies to every agent and tool session (Claude, Codex, or anything else). Agent-created branches and worktrees keep getting orphaned and their work lost — e.g. the May 2026 `codex/*` branches and the stale `ssapp-vpzone-fix` worktree that had to be cleaned up in August 2026.
- If a task genuinely seems to require a branch or PR, stop and ask Steve first instead of creating one.

## Communication

- When replying to Steve, prefer plain, everyday language over jargon.
- Keep explanations direct and practical; explain technical terms briefly when they matter.
- When Steve asks for a TLDR, keep it genuinely short: a few lines max, no long explanation.
- Always end a substantial reply with concrete next steps when there is a sensible one to offer: what is blocked on Steve, what is blocked on someone else, the one thing worth doing first, and an offer to start it. Include anything deferred along the way instead of quietly dropping it. Skip this only when the task is genuinely finished or the reply is a one-line factual answer.
- When Steve asks to remember an instruction, save it into the relevant instruction file or memory mechanism when possible; do not merely say it will be kept in mind.
- If Steve says "remember", treat it as a request to persist the instruction. Check for writable instruction targets, especially the repo `AGENTS.md` for project-specific behavior and `C:\Users\steve\.codex\AGENTS.md` for global behavior. Update the most appropriate file, or both when the instruction applies globally and to the current repo. Do not say memory tools are unavailable unless no writable instruction or memory target exists after checking.

## Source Of Truth

- Social Stream source edits must be made in `C:\Users\steve\Code\social_stream`.
- `ssapp` loads Social Stream source files remotely from `C:\Users\steve\Code\social_stream` at app startup; treat that repo as the primary runtime source.
- Do not treat `C:\Users\steve\Code\ssapp\resources\social_stream_fallback\main` as the source repo; it is a fallback mirror/bundle target.
- The `resources/social_stream_fallback/main` folder is replaced at build/update time and should be treated only as a backup, not the primary source.
- **Do not read, browse, edit, or add changes in `resources/social_stream_fallback` during normal app work.**  
  This folder is disposable/rebuilt on every build/update (`npm run update:fallback`), so spending time on it is not productive.

## Social Stream Payload Rules

- Donation-style chat rows should use `hasDonation` and optional `donoValue`; do not set `event: "donation"` just because a chat/tip row has a donation value.
- Use existing payload fields first. Only populate `meta` when there is additional structured data that downstream consumers actually need and no existing field handles it well.

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

## Release Rules

- Read `RELEASE.md` before any release, deploy, tag, or artifact-upload work.
- Critical rule: never create git tags or GitHub releases in `ssapp` / `ssn_app`; app release tags and artifacts belong in `steveseguin/social_stream`.
- Local Windows builds are expected to use a self-signed/untrusted development certificate. Do not report that local trust-chain status as an issue by itself; only flag an actual signing failure or an unexpected signing result on an official release artifact.
- GitHub release notes should follow the existing Social Stream style, including the heading `### What's new in this version:`.
- The `What's new` bullets must summarize every important user-facing change included in the release package, not only the final version bump. For example, if `v0.3.128` is being released after `v0.3.113`, include the important user-facing changes from `v0.3.114` through `v0.3.128`.
- Before writing or updating release notes, check recent `steveseguin/social_stream` releases so the notes match the existing release-note style and include the right range of changes.
- Do not add redundant platform intro text such as "Windows, macOS, and Linux pre-release" or "This pre-release includes Windows, macOS, and Linux builds." The Downloads table already shows platforms.

## Testing

No formal test framework (Jest/Mocha). Manual integration tests only.

### LLM Control Maintenance

- Whenever the SSApp control API, MCP adapter, command endpoints, capabilities, schemas, or version compatibility changes, update the checked-in skill under `C:\Users\steve\Code\social_stream\docs\skills\control-social-stream` in the same work.
- Record each such change in the skill's version log, including the minimum SSApp version required for newly added or changed capabilities.
- Keep the running SSApp version exposed through the control API and MCP responses so agents can select only skill capabilities supported by that app version.
- The explicitly enabled control API is intentionally tokenless and restricted to `127.0.0.1`. Do not report the lack of token authentication or origin checks as a code issue; the loopback binding is the intended trust boundary. Only flag this area if the API becomes reachable beyond loopback or a concrete failure of that boundary is reproduced.

### VERY IMPORTANT: What Counts As Testing

- Testing is not complete if it relies only on unit tests, smoke tests, static checks, syntax checks, or mocked/headless checks.
- Unit tests and smoke tests are **not** considered actual testing for this project. They are only supporting sanity checks.
- Only functional in-app, end-to-end testing of the real user workflow is considered actual testing.
- For Electron/app changes, actual testing means starting the app in an appropriate isolated profile/environment and verifying the behavior inside the running app over time, including side effects such as reloads, persistence, network/server calls, background jobs, and repeated events.
- Do not report a change as tested unless functional in-app/e2e testing was performed, or clearly state that only sanity checks were run and actual testing remains incomplete.
- For website-loading and capture issues, reproduce them in SSApp's real Electron source window using the same session, user agent, preload, request hooks, and injected source configuration. Do not use the OpenAI in-app Browser or an unrelated browser as evidence of SSApp behavior.
- `tests/electron/window-state-diagnostics.js` may use the normal Social Stream profile. Do not report that profile choice as an issue by itself; only flag a concrete unintended settings change, data loss, or corruption reproduced by the diagnostic.

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

### Hidden Window Capture Tests

Capture running in a window that is not on screen is fragile and has broken silently before
(see `hidden-window-keepalive.js`). Both of these build real source windows through the real
IPC path, so they count as functional testing. On a machine with no desktop, start a virtual
display first (`Xvfb :99 -screen 0 1920x1080x24 &` and `export DISPLAY=:99`).

```bash
npm run test:hidden-capture                       # ~3 min, local fixture
npm run test:hidden-capture -- --url="https://www.youtube.com/live_chat?is_popout=1&v=ID"
npm run test:hidden-capture -- --start-hidden     # window created hidden: no frames at all
npm run test:hidden-capture -- --headless         # as a server install runs it

# Does capture survive a long session? One --url per platform.
npm run test:hidden-capture:soak -- --minutes=60 --start-hidden \
  --url="https://www.youtube.com/live_chat?is_popout=1&v=ID" \
  --url="https://www.twitch.tv/popout/CHANNEL/chat?popout="
```

Both use an isolated `SSAPP_USER_DATA_DIR`, so they will not touch the real profile. Windows
that never see a chat message are reported as inconclusive rather than passing, so check that
the channel is actually live before believing a green run.

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

- **Electron**: ^43.2.0
- **tiktok-live-connector**: 2.4.3
- **@eulerstream/euler-websocket-sdk**: ^0.0.6
- **ws**: ^8.21.0
- **electron-store**: 8.2.0
- **undici**: ^7.5.0

## Development Notes

- Node.js >= 20.9.0 required
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
