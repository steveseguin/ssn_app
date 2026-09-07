# macOS v0.4.26 release validation

Both final Mac builds passed signing, Apple notarization, Gatekeeper assessment, and package checks.
Published to https://github.com/steveseguin/social_stream/releases/tag/v0.4.26.
Verified all nine assets are uploaded, the release remains a public prerelease, and the
four Mac asset sizes and GitHub SHA-256 digests match the final local artifacts.

## Source and scope

- SSApp: `70e8dc8` plus `f303eb6` (mute persistence) and `d65561e` (Mac hiding and native runtime packaging), plus runtime pin `c28e68d`.
- Reviewed the last pull, `bd5acf3..70e8dc8`, with particular attention to source setup/lifecycle,
  settings transfer, background recovery, audio, history, and automation transport changes.
- Pulled SSApp main: already current. Fast-forwarded the sibling Social Stream beta checkout
  to `bbfb7fa9`; reviewed its additional TTS feedback changes.
- Packaged Social Stream from **v0.4.26**, `f91815c93f6a06d58d4d8f6a1372dd29ddac6767`,
  matching the existing Windows/Linux release. The updater staged that tag into bundled `main`.
- Initialized the real TikTok signing submodule at the pinned `e7f3eec3ebe6b71ec70f32992c5f4cdbb72fc28e`.
- Aligned installed dependencies with package settings and installed Sharp runtimes for both Mac architectures.
  Final packaging pins Electron 43.4.1 (`c28e68d`). Initial source checks also used 43.4.1.
  A 43.6.0 signed ARM candidate crashed during navigation; signed 43.4.1 passed the same test.

## Functional checks

These checks ran real Electron app windows with isolated profiles. Existing fixtures replaced
external services where specified by the test. No normal Social Stream profile was used.

Passed in the source app:

- Source setup UI: supported-sites navigation, validation, Bilibili selection, pasted URLs
  for eleven platforms, Escape and focus restoration.
- eBay discovery fixture, pagination, event picker, activation/replacement, failure/retry,
  stale replies, and process-restart persistence.
- Source deletion, late activation cleanup, replacement, and cache success/failure.
- Scoped cookies/storage, repeated crash/reload recovery, malformed import rejection,
  reusable browser definitions, valid imports, and rollback backup.
- Settings export/import and full-session transfer round trips.
- Navigation keyboard/focus/accessibility, fourteen locales, and reload persistence.
- MCP interrupted responses, recovery, and complete screenshot delivery after stdin EOF.
- Rich/text-only emotes in normal, blocked-sanitizer, and reload cases.
- Startup with offline, online, missing-library and stalled-library responses; offline restart.
- Event Flow online stability, genuine offline fallback, reconnect and restart persistence.
- TikTok DOM replay: 620 initial messages, bounded reconnect batches, recycled-row handling.
- Group mute/unmute, unrelated-source isolation, reactivation, error feedback, and added reload coverage.
- Hidden capture diagnostic: **21 passed, 0 failed**, including created-hidden, reveal,
  logical visibility, zero compositor frames, timers, and delivery to destinations.
- Five-minute created-hidden capture soak: all five samples delivered messages, 500 sampled
  rows/destination messages, zero capture errors, minimum 60 rAF/s and 62 timers/s.
- Voice commands with real Whisper, Test/Armed modes, Event Flow actions, forged-chat rejection,
  shared controls, reload, Stop and pairing restrictions.
- Cohost microphone recognition, lifecycle, and sender restrictions; recognized the fixture phrase.

Passed in packaged apps before final signing:

- Intel under Rosetta and Apple Silicon: two local TTS requests each produced valid WAV audio
  using one worker and one model load.
- Both architectures: offline wishlist QR, animated donation hearts, compressed Bilibili chat,
  ZIP widget import, and world map, each on initial load and reload with requests blocked.
- Apple Silicon: six source mirror/cache/outage cases with real captured messages.
- Apple Silicon: rich and text-only emotes, normal/blocked sanitizer/reload (six messages per case).

Supporting checks: fallback dependencies, TikTok dedupe/event regressions, native runtime
pruning regression, dependency alignment, and diff whitespace checks.

## Problems found and resolved

- Signed Apple Silicon packages using Electron 43.6.0 repeatedly crashed during navigation,
  both through Playwright and through the local control interface without a debugger.
  The same packaged navigation test and native TTS passed with signed Electron 43.4.1.
  Pinned that runtime before rebuilding the final release candidates.

- Delayed source injection/reload restored the original mute flag. The mute IPC handler now
  updates the window configuration as well as the live audio state (`f303eb6`).
- macOS clamped parked capture windows back onto the screen. Mac capture now uses native hide
  with the existing frame pump; the full hidden-capture diagnostic passes (`d65561e`).
- Native runtime pruning used a Windows/Linux resource path on Mac. It now obtains the correct
  app resource path from electron-builder, preserving the selected Mac runtime (`d65561e`).
- Intel packaged speech initially failed because only ARM Sharp native libraries were installed.
  Installed both architectures and verified packaged synthesis on each.
- Synthetic microphone input initially produced silence because the macOS test sandbox could
  not read the fixture file. Re-ran the tests with `--no-sandbox` only in temporary test adapters;
  production sandbox settings were not changed. Voice recognition and actions then passed.
- Initial disk exhaustion interrupted testing/building. Removed disposable package/browser caches,
  untracked CMake build output, and generated OBS test recordings while retaining test reports.
  Administrator authorization repaired root-owned build/dependency folders; old SSApp dist output
  was then cleaned normally. Free space reached about 11 GB before rebuilding.
- The local ignored `mac.sh` now stops on errors, installs both Sharp Mac runtimes, and builds
  without sudo to avoid recreating root-owned build files. Credentials were not committed.

## Limits and evidence

Intel was exercised through Rosetta on Apple Silicon, not on physical Intel hardware.
Live authenticated accounts, physical microphones/printers, and a real OBS custom dock were
not validated here. External-service tests used deterministic fixtures and local relays.
Final signed-app results are recorded below.

Known prerelease issue: an additional control-interface stress test rapidly changed all fourteen
languages (150 ms apart), switched Sessions/Sources, reloaded, and repeated. Signed ARM
43.4.1 crashed during the second cycle with SIGTRAP in V8. Four full navigation cycles
using ordinary Playwright UI actions passed, as did standard packaged feature tests.
This remaining stress-case crash is not claimed fixed; it is disclosed in the release notes.
The 43.4.1 pin resolved the earlier repeatable standard-navigation failure, not every stress case.

Logs and cleanup inventory: `/tmp/ssapp-mac-0426`. Individual test logs identify isolated
profile directories containing JSON reports and screenshots. Generated fallback files were
updated only by the build script, not manually inspected or edited.

## Final signed artifacts

- Both apps: v0.4.26, Electron 43.4.1, matching main.js SHA-256
  `d84713825277c72f6669d0e7da6116291770e532c3c294122b0b4706e67a4550`.
- Both architectures passed final navigation/localization/reload, two real local TTS requests,
  and all ten offline asset checks. Apple Silicon additionally passed source mirrors and
  rich/text-only emote capture, including blocked libraries and reloads.
- Four consecutive signed ARM navigation/localization/reload cycles passed through UI actions.
- Signed ARM comparison build also passed real Whisper voice commands and shared-control workflows.
- Both apps and DMGs have accepted Apple notarization, validated stapled tickets, and Gatekeeper
  acceptance as Notarized Developer ID. Both DMGs passed hdiutil verification and both ZIPs
  passed archive integrity checks. DMGs were explicitly signed before their final submissions.

Final DMG notarization submissions:

- `38a0a1fc-09d7-452c-b495-aaa0df213fa8`: Accepted.

- `e215c44e-b065-4076-a764-f7b0e502be19`: Accepted.

Final artifact SHA-256 hashes:

```text
4e695cbba491ff5905e3405fdc077fe7a5b3d0635ae303a7aa0eba7a31b9ee64  dist/socialstreamninja_mac_v0.4.26_arm64.dmg
e02768a0a448de7adefa2249749abba7ab323a4d0487f459e6fcddc4ea4b7786  dist/socialstreamninja_mac_v0.4.26_arm64.zip
6a27f6479276a227616cbe2e3c5a69fd8f6f8dca930d2c7daf82735d4d11c325  dist/socialstreamninja_mac_v0.4.26_x64.dmg
d5a1d598d93addb2fa86ddf7ea70d27256363ea544f7f3c21e1c6326b4ae0b3c  dist/socialstreamninja_mac_v0.4.26_x64.zip
```

Publication preserved all five existing Windows/Linux assets and added the four Mac downloads.
Release notes include the Mac capture/mute fixes and the remaining language-switch stress issue.
After rebuilding and clearing disposable download caches, approximately 5.7 GiB remained free.
