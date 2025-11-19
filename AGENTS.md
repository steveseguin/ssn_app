# Suggested TODOs

- [ ] Guard the message pump timer in `tiktok/connection-manager.js` (`MessageProcessor.startProcessing`) so only one `setTimeout` is pending at a time; burst traffic currently stacks timers until the first tick runs.
- [ ] Rework the queue trimming branch in `MessageProcessor.addToQueue` to drop entries in bulk (e.g., `splice` with a larger stride) instead of repeated `shift`/`cache.remove` loops that become O(n²) at high volume.
- [ ] Keep TikTok debug logging on for dev builds but move the heavy lifting off the hot path: buffer message summaries or offload `normalizeForLogging`/disk writes to a worker before high-rate payloads start blocking the event loop.
- [ ] Update the batch forwarder so `sendBatchToBackground` and `logTikTokForwardedMessage` operate on the batch as a unit; avoid per-message logging/IPC work when the renderer already accepts arrays.
- [ ] Replace the 30 k entry `MessageCache` Map with a fixed-size ring buffer (or similar) that still protects against duplicate replays during reconnects. Any change must keep dedupe effective through polling reconnects, where TikTok historically resends old messages—verify we resume from the latest cursor instead of page 0 before trimming the cache aggressively.
- [ ] Audit reconnect/polling flows to confirm we are requesting new pages rather than restarting from the beginning; this is the suspected trigger for the “long pause → duplicate flood” reports.

## TikTok Websocket Context Recap

- `tiktok-live-connector@2.1.0` now instantiates EulerStream’s signer by default (`EulerSigner` from `@eulerstream/euler-api-sdk`), so every websocket connection hits `https://tiktok.eulerstream.com` unless we pass a custom signer or API key.
- The connector fetches a signed protobuf via `fetchSignedWebSocketFromEuler` before it can open TikTok’s websocket. TikTok refuses unsigned websocket upgrades—even anonymous read-only consumers—so some signing layer is mandatory.
- Euler still answers limited unsigned traffic, which explains the “sometimes it works” inconsistency. When their free quota or infra hiccups (e.g., repeated `Unexpected sign server status 500`), our connect sequence stalls until the service recovers or fallback succeeds.
- We already have legacy/polling support plus an in-progress built-in signing helper, but the current code keeps defaulting to Euler and races between websocket/polling connections (`Already connecting!`) can leave us stuck on Euler when it fails.

## Current State

1. **Websocket path**
   - Dependent on Euler unless the user supplies `args.signing` (API key or custom service URL) or we inject our own signer via `signedWebSocketProvider`.
   - Lacks guards around concurrent `connect()` attempts, so fallback activation can be interrupted by “Already connecting!” errors.
2. **Legacy/polling path**
   - Serves as the only Euler-free option but still needs the TODOs above (timer guard, queue trims, batch forwarding, reconnect audit) to keep up under load.
3. **Built-in signing work**
   - Renderer already gathers msToken/etc.; we need a path to feed those tokens into a local signer so we don’t require an external URL. The current connector expects a signer object, not necessarily an HTTP endpoint, so we can bridge our local helper straight into `signedWebSocketProvider`.

## Recommended Strategy

1. Treat Euler as optional. Default new sources to legacy mode unless the user explicitly configures a signer/API key, and clearly message when websocket mode is unavailable without it.
2. Harden the reconnect/fallback pipeline so legacy mode can take over automatically when signing fails (guard timers, avoid overlapping `connect()` calls, reset `pollingFallbackActivated` on failure).
3. Finish our internal signing helper so we can inject a local `signedWebSocketProvider` (no third-party URL required). Continue supporting user-supplied API keys/service URLs for those who prefer Euler.
4. Elevate legacy mode performance (queue management, batch logging, dedupe replays) so it remains a first-class experience independent of websocket availability.
5. Improve observability: emit `emitStatus` updates that flag when we are retrying Euler, when fallback activates, or when a signer is required.

## Task List Toward Independence

1. **Connection Guard Rails**
   - Serialize `this.connection.connect()` calls and reconnect timers in `tiktok/connection-manager.js` so “Already connecting!” can’t derail fallback. This directly addresses the conflicting legacy/websocket modes seen in logs.
   - When fallback instantiation fails, reset `pollingFallbackActivated` so future sign errors can trigger it again.
2. **Euler Dependency Controls**
   - Detect when no signing config/API key is provided and default to legacy mode rather than hammering Euler anonymously. Update renderer copy to explain why websocket mode needs a signer.
   - Add a circuit breaker for sign errors (after N consecutive failures, surface an actionable UI error and pause retries instead of looping silently).
3. **Legacy Mode Enhancements**
   - Implement the six TODOs at the top of this file: timer guard, queue trimming, logging offload, batch logging, ring buffer cache, reconnect audit. These keep polling performant even without websocket access.
   - Ensure reconnects resume from the latest cursor/page even after legacy fallback to prevent duplicate floods.
4. **In-House Signing Path**
   - Finish wiring our built-in signing helper: capture msToken/session artifacts locally, wrap them in a signer class that matches `signedWebSocketProvider`’s shape, and skip the need for any URL-based proxy.
   - Document how to configure optional external signers (Euler API key, self-hosted service) versus the built-in/local option.
5. **Documentation & Messaging**
   - Update user docs/settings to clarify the three options (legacy, local signer, Euler API). Reference `tiktok-live-connector` README sections on `signApiKey`, `disableEulerFallbacks`, and `signedWebSocketProvider` for advanced usage.
   - Call out the inconsistency: Euler may occasionally answer unsigned traffic, but that behavior isn’t guaranteed—reinforcing why we need an independent path.

Keeping this list front-and-center should prevent a repeat of the observed failure mode and move Social Stream toward a fully standalone TikTok integration while still letting power users plug in their own signing infrastructure if desired.
