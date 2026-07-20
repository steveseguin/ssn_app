# YouTube Owner Discovery Plan

Status: kickoff plan. No runtime behavior is implemented by this document.

## Problem

Public YouTube discovery is ambiguous because users usually enter a handle or display name, while YouTube has several identity types. It also cannot find unlisted broadcasts. The better path for a user's own streams is an owner-authenticated discovery mode that uses the signed-in YouTube channel instead of public search.

## UX Direction

When adding YouTube, show a choice before asking for any channel text.

### Find a Public Channel

- Use for public streams from any channel.
- Ask for the public YouTube handle, username, or channel name.
- Explain that it only finds public live or upcoming streams.
- Keep the existing public discovery path for this mode.

### Use My YouTube Account

- Use for the creator's own broadcasts.
- Start with a `Sign in with YouTube` button.
- Request read-only YouTube access by default.
- Do not ask for a username.
- Resolve the signed-in channel from YouTube and show a confirmation screen:

```text
Signed in as:
Louis T. Hunter
Channel ID: UC...

[Use this channel] [Switch account / channel]
```

This makes Brand Channel selection visible and avoids tying the source to ambiguous typed text.

## Main UI

An owner-backed YouTube group should look like a normal YouTube group, with an account indicator.

```text
YouTube - Louis T. Hunter
Signed in
Auto-activate group
[Select Live Sources] [Auto-find & Activate] [Manage Sign-In]
```

The existing buttons can stay. The discovery implementation changes based on group metadata.

## Stream Picker

Reuse the existing YouTube stream picker, but owner-backed results should show broadcast state clearly:

```text
Upcoming   Unlisted   Starts 7:30 PM   Chat not ready yet
Live       Public     Chat ready
Upcoming   Private    Starts when stream starts
```

Actions:

- `Add selected`
- `Auto-find & activate this account`

Do not show normal uploaded videos as selectable live sources.

## Stored State

Do not store OAuth access tokens, refresh tokens, or raw Google account identifiers in exported source/group state.

Group fields:

```js
youtubeDiscoveryMode: "public" | "owner"
channelId: "UC..."
channelTitle: "Louis T. Hunter"
youtubeAuthRef: "opaque-local-auth-reference"
```

Source fields:

```js
videoId: "..."
broadcastId: "..."
liveChatId: "..." // when available
privacyStatus: "public" | "unlisted" | "private"
scheduledStartTime: "..."
youtubeChatStatus: "ready" | "waiting" | "ended" | "disabled"
```

`youtubeAuthRef` should point to app-local auth storage. It should not be enough by itself to recover tokens from an exported session file.

## Discovery Behavior

For public groups:

- Continue using public discovery.
- Keep later cleanup separate from this owner-authenticated work.

For owner-backed groups:

- Do not use the typed username, `channelsonly`, `usernameonly`, or public scrape polling.
- Query the signed-in channel's broadcasts through YouTube Data API.
- Check active and upcoming broadcasts.
- Include unlisted/private results because the owner is signed in.
- If a broadcast exists but chat is not ready, add or keep the source in a waiting state instead of reporting failure.
- Once `liveChatId` is available, activate the normal YouTube chat source.

## Implementation Areas

- `index.html`: add the YouTube add-source choice, owner-backed group labels, and `Manage Sign-In`.
- `youtube.js`: add owner-discovery mapping and picker metadata, without changing public discovery yet.
- `state.js`: persist owner discovery metadata and source chat status.
- `resources/electron-youtube-handler.js`: extend the YouTube OAuth bridge for app-level owner discovery.
- `preload.js`: expose narrow IPC methods for owner discovery, not raw token access.
- `social_stream/sources/websocket/youtube.html`: keep using the existing chat connection flow, but support waiting/upcoming owner-backed streams cleanly.

## Documentation References

- YouTube `liveBroadcasts.list` documents owner filters such as `mine=true` and broadcast status filters such as `active` and `upcoming`: https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list
- YouTube `liveBroadcast` resource documents broadcast fields including channel identity, scheduled timing, live chat ID, and privacy status: https://developers.google.com/youtube/v3/live/docs/liveBroadcasts
- YouTube quota docs show why broad public search should be treated carefully, especially compared with direct list-style calls: https://developers.google.com/youtube/v3/determine_quota_cost

## Open Questions

- Whether Google returns one channel or multiple channels after Brand Channel selection in the current OAuth flow. The UI should handle either one result or a small selection list.
- Whether owner-backed sources should open the chat page immediately in a waiting state, or stay dormant until chat is ready. Prefer waiting state if it is reliable.
- Exact polling cadence. Start conservative, poll slower when the stream is far from scheduled time, and poll faster near start time.
