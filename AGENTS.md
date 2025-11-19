# Suggested TODOs

- [x] Guard the message pump timer in `tiktok/connection-manager.js` (`MessageProcessor.startProcessing`) so only one `setTimeout` is pending at a time.
- [x] Rework the queue trimming branch in `MessageProcessor.addToQueue` to drop entries in bulk (e.g., `splice` with a larger stride).
- [ ] Keep TikTok debug logging on for dev builds but move the heavy lifting off the hot path: buffer message summaries or offload `normalizeForLogging`/disk writes to a worker before high-rate payloads start blocking the event loop.
- [ ] Replace the 30 k entry `MessageCache` Map with a fixed-size ring buffer (or similar) that still protects against duplicate replays during reconnects.
- [ ] Audit reconnect/polling flows to confirm we are requesting new pages rather than restarting from the beginning; this is the suspected trigger for the “long pause → duplicate flood” reports.
- [ ] (Low Priority) Update the batch forwarder so `sendBatchToBackground` and `logTikTokForwardedMessage` operate on the batch as a unit.

## TikTok Websocket Context Recap

- `tiktok-live-connector@2.1.0` defaults to EulerStream’s signer.
- We have a "Legacy" (Polling) mode which is now the default for new sources.
- We are building an in-house signing helper to allow Websocket connections without external dependencies.

## Current State

1.  **Websocket path**
    - Users can supply an API Key or custom signing URL.
    - If no key is provided, we attempt EulerStream (anonymous).
    - **Goal**: Wire up the local in-house signer as a third, robust option.
2.  **Legacy/polling path**
    - The default for new sources.
    - Performance hardened (timers and queue trimming fixed).
3.  **Built-in signing work**
    - `tiktok-signing/electron-signer.js` helper exists but is not yet wired to `signedWebSocketProvider`.

## Recommended Strategy

1.  **Default to Legacy (Polling)**: New sources start here.
2.  **Websocket Fallback Logic**:
    - If a user selects Websocket mode (with or without a key/signer):
    - Try to connect (using Key, Local Signer, or Euler).
    - **Circuit Breaker**: If it fails to sign/connect after **3 attempts**, automatically fall back to Polling mode.
    - Show a warning to the user: "Websocket mode failed, switched to Polling."
    - If the user manually retries, reset the counter and try Websockets again before falling back.
    - If the user *explicitly* selects Polling, do not attempt Websockets.
3.  **Prioritize In-House Signer**: Finish wiring `electron-signer.js` to `tiktok-live-connector` so users have a reliable, free Websocket option.
4.  **UI/UX Cleanup**: Reorganize the setup page to clearly present these options (Polling vs Websocket [Local / API Key / Euler]).

## Task List Toward Independence

1.  **In-House Signing Path (High Priority)**
    - [ ] Wire `tiktok-signing/electron-signer.js` into `tiktok/connection-manager.js`.
    - [ ] Create a `signedWebSocketProvider` adapter that uses the local Electron window to sign requests.
    - [ ] Verify `msToken` and `userAgent` are correctly passed from the signing window.

2.  **Connection Guard Rails & Fallback Logic**
    - [ ] Implement the "3-strike" rule: after 3 failed Websocket connection attempts, switch `usingLegacyTikTokConnector` to `true` for that session.
    - [ ] Ensure `pollingFallbackActivated` logic resets correctly on manual retry.
    - [ ] Display a UI warning when fallback occurs.

3.  **UI/UX Improvements**
    - [ ] Redesign the source setup page to better organize "Polling" vs "Websocket" choices.
    - [ ] Clarify that "Websocket" without a key will try Euler (best effort) or the Local Signer (once ready).

4.  **Legacy Mode Enhancements**
    - [ ] Audit reconnects to ensure we resume from the latest cursor (prevent duplicate floods).
    - [ ] (Low Priority) Batch logging optimizations.
