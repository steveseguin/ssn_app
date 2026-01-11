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
    - [x] Wire `tiktok-signing/electron-signer.js` into `tiktok/connection-manager.js`.
    - [x] Create a `signedWebSocketProvider` adapter that uses the local Electron window to sign requests.
    - [x] Verify `msToken` and `userAgent` are correctly passed from the signing window.
    - [x] **FIXED**: Implemented in-window fetch to bypass 403 errors and deserialized the protobuf response using `tiktok-live-connector`'s internal utilities.

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

## TikTok Chat Send (Local Signer, Non-Euler) — Current Behavior

- We open the local signer window at `https://livecenter.tiktok.com/realtime`, scrape msToken/cookies/X-Bogus/etc., and use that payload to establish the tiktok-live-connector WebSocket via the local signer adapter (no Euler services involved).
- On `sendChatMessage` we first try the direct `/webcast/room/chat/` POST signed by the local signer; headers include live cookies, CSRF, Referer/Origin pointing at the live page, and the content is part of the signed URL.
- If the HTTP send fails or returns an empty body, we allow fallback to the live WebSocket’s `connection.sendMessage` (again using the locally signed session), never calling Euler.
- **Status:** not working end-to-end. Direct POSTs return HTTP 200 with empty bodies and the subsequent WebSocket fallback is not producing visible chat messages yet. Needs further investigation before this path can be trusted.

## TikTok Chat POST Structure (Reference)

**URL**: `https://webcast.tiktok.com/webcast/room/chat/`
**Method**: `POST`
**Content-Type**: `application/json; charset=utf-8`

**Query Parameters (Signed)**:
- `aid`: `1988`
- `app_language`: `en-GB` (or similar)
- `app_name`: `tiktok_web`
- `browser_language`: `en-GB`
- `browser_name`: `Mozilla`
- `browser_online`: `true`
- `browser_platform`: `Win32`
- `browser_version`: (User Agent version)
- `channel`: `tiktok_web`
- `client_start_timestamp_millisecond`: (Current timestamp)
- `content`: (The message content)
- `cookie_enabled`: `true`
- `data_collection_enabled`: `true`
- `device_id`: (Numeric ID)
- `device_platform`: `web_pc`
- `focus_state`: `true`
- `history_len`: `3`
- `input_type`: `0`
- `is_fullscreen`: `false`
- `is_page_visible`: `true`
- `os`: `windows`
- `priority_region`: (Region code, e.g., `CA`)
- `referer`: (Live room URL)
- `region`: (Region code)
- `room_id`: (Numeric Room ID)
- `root_referer`: (Live room URL)
- `screen_height`: `1080` (or similar)
- `screen_width`: `1920` (or similar)
- `tz_name`: (Timezone, e.g., `America/Toronto`)
- `user_is_login`: `true`
- `verifyFp`: (Verify Fingerprint from cookie)
- `webcast_language`: `en-GB`
- `msToken`: (Signed Token)
- `X-Bogus`: (Signature)
- `X-Gnarly`: (Signature)

**JSON Body**:
```json
{
  "room_id": "7575903733403110165",
  "content": "hi",
  "emotes_with_index": "",
  "input_type": 0,
  "client_start_timestamp_millisecond": 1763905763322
}
```

**Important Headers**:
- `Cookie`: Must include `sessionid`, `msToken`, `tt_target_idc`, etc.
- `Referer`: `https://www.tiktok.com/@username/live`
- `Origin`: `https://www.tiktok.com`
- `User-Agent`: Must match the one used for signing.

## Kick Websocket Mode Plan (Electron + Worker)

References:
- https://dev.kick.com/ (Kick Dev Docs, also mirrored at https://github.com/KickEngineering/KickDevDocs)
- https://api.kick.com/swagger/v1/doc.json (Public API schema; includes /events/subscriptions and /chat)
- https://api.kick.com/public/v1/public-key (Webhook signature verification)
- Unofficial realtime chat uses Pusher at wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false with channels chatrooms.<chatroom_id>.v2 and channel.<channel_id> (observed in open-source clients).

Planned tasks:
- [x] Add a Node WS client (Electron main process) that connects to Pusher, subscribes to chatrooms.<id>.v2 and channel.<id>, and maps App\\Events\\ChatMessageEvent and related events into the existing Kick message shape.
- [x] Resolve chatroom_id + channel_id via https://kick.com/api/v2/channels/<slug> with caching and a manual override if the API is blocked.
- [x] Pipe Node WS messages into the websocket UI via IPC/ninjafy, reusing the same normalizer as the current bridge path; keep the DOM mode unchanged as the fallback.
- [x] Keep the Cloudflare worker for webhook events (subs/follows/tips + optional chat), driven by OAuth loopback in Electron and /events/subscriptions; continue signature verification using the Kick public key.
- [x] Restore window.parent.postMessage fallback in resources/social_stream_fallback/main/sources/websocket/kick.js for non-extension hosts.
- [x] Gate websocket mode to Electron and surface socket status (no auto-fallback to DOM mode).
