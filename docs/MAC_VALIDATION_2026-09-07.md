# macOS v0.4.26 release preparation

Release work is incomplete. No Mac artifacts were uploaded or notarized.

Source app: `70e8dc8` (v0.4.26), plus the group audio correction recorded with this report.
Review range: last pull, `bd5acf3..70e8dc8`, focusing on source lifecycle/setup,
settings transfer, background recovery, audio, and automation transport changes.
Social Stream beta checkout was fast-forwarded from `a279a3ba` to `f91815c9`.
Both repositories were initially clean. No branches, tags, or releases were created.

## Functional checks completed

All checks below ran real Electron app windows with isolated profiles on Apple Silicon macOS.
External responses were replaced by fixtures where the existing tests specify them.
These results do not establish authenticated live-platform or physical-printer coverage.

- Source setup in UI-only mode: supported-sites navigation, validation, Bilibili selection,
  pasted URL normalization for eleven platforms, Escape and focus restoration.
- eBay setup: discovery fixture, pagination, event selection, source activation/replacement,
  failure/retry, stale replies, and process-restart persistence.
- Source lifecycle: deletion, late activation cleanup, replacement, cache success/failure.
- Recovery: scoped cookies/storage, repeated crash/reload, rejected malformed imports,
  reusable browser definitions, valid import, and rollback backup.
- Settings export/import and full-session transfer round trips.
- Offline assets on updated beta: wishlist QR, animated donation hearts, compressed Bilibili
  chat, ZIP widget import, world map; initial load and reload with network blocked.
- Source mirrors: cache host, invalid response, raw host, disk cache, timeout, corrupt disk cache.
  This run began before the sibling source update and used the earlier capture script.
- Rich emotes: normal, blocked sanitizer request, reload; six messages each.
- Navigation: keyboard/focus/accessibility, fourteen locales, reload persistence.
- MCP transport: interrupted response/recovery and full screenshot delivery after stdin EOF.
- Local TTS: two real synthesis requests produced valid WAV audio, reusing one worker/model.
- Group audio: reproduced failures before correction; passed original test afterward,
  then passed added real capture-page reload coverage and the existing restart/error cases.

## Correction

The mute IPC handler changed the active webContents but retained the initial mute value
in `view.args`. Delayed injection or page reload could restore the old value, undoing
group or individual audio controls. The handler now updates that shared configuration.
This correction is local to SSApp and is not part of the other computer's original build.

## Blockers and remaining work

- Build failed during beta fallback staging with `ENOSPC`. Only about 0.2 GB remained.
  Free at least 10 GB before attempting both architectures and notarization.
- `mac.sh` uses interactive sudo; passwordless sudo was unavailable. An equivalent
  build was attempted under the user account using its existing signing variables,
  `SSN_SOCIALSTREAM_BRANCH=beta`, and `SSN_SOCIALSTREAM_OUTPUT_BRANCH=main`.
- Existing `dist` is root-owned. It was temporarily renamed and restored intact;
  its ownership/cleanup may need attention before retrying the normal prebuild.
- Developer ID signing identity is present. Apple notarization has not been attempted.
- The failed build's temporary clone was removed. Test logs remain at
  `/tmp/ssapp-mac-0426`. No generated fallback files were manually inspected or changed.
- The original offline dependency failure was caused by the stale sibling checkout;
  the updated beta passes the dependency check without an allowlist change.
- Text-only emote and Event Flow fallback runs were interrupted by disk exhaustion.
  Startup-outage and hidden capture tests remain pending, as do voice-command,
  live-platform, Intel/Rosetta, and packaged app checks.
- Re-run relevant tests with adequate space, finish remaining review/coverage, build
  x64 and arm64, verify signatures/notarization/stapling, and test packaged apps.
- `v0.4.26` in `steveseguin/social_stream` was still absent at the last check. Confirm
  the other computer's release/source revision before uploading the Mac assets there.
- Coordinate the group audio fix with the Windows/Linux build before publishing.
