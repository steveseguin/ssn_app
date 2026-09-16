# macOS v0.4.29 validation

## Build and scope

Pulled SSApp main from `a1ee121` to `bf63778` and reviewed the incoming runtime changes:
legacy named-session recovery, Local Server reply routing/frame updates, eBay validation
and regional sign-in, TikTok gift metadata/injection, and Always on Top window targeting.
Pulled the sibling Social Stream beta checkout to `d45bd184` for source diagnostics.

Built both Mac architectures by running `./mac.sh`. Its updater cloned the existing
Social Stream v0.4.29 tag (`8b72bac5aea0ca8e6cec2b1a297bfcd9a450131f`), matching the
numbered release rather than taking subsequent beta changes. No production code,
shared security flags, preloads, headers, or session defaults were changed for this release.

## Installed app checks

Mounted each generated DMG read-only, copied its app with `ditto` into a separate
Applications test directory, detached the image, and tested the installed copy.
All tests used isolated profiles; normal user settings were not used.

Both Apple Silicon and Intel (through Rosetta) passed:

- Developer ID signature, notarization ticket, and Gatekeeper verification.
- DMG checksum and ZIP integrity; ZIP app.asar hashes matched the packaged app.
- Version 0.4.29 and packaged main.js matching the reviewed checkout.
- Runtime checks: Electron 43.4.1, Sharp 0.35.4, libheif 1.23.2, libvips 8.18.6.
- Normal-graphics Launch Services launch using a copy of the v0.4.28 test profile,
  preserved language on initial upgrade, three reloads, clean restart, and persistence.
- Navigation, keyboard/focus behavior, all 14 locales, and reload persistence.
- Ten offline-feature initial-load/reload cases and two valid local speech WAV requests.

The installed Apple Silicon app additionally passed:

- Actual floating Dock window pin/unpin, repeated toggles, menu state and reload,
  with the main window's Always on Top state unchanged.
- Six source mirror/cache/outage recovery cases using captured messages.
- Rich and text-only emotes under normal, blocked-library, and reload conditions.

Source-app eBay setup tests passed regional sign-in windows, event validation, retry,
cancellation, seller selection, source activation/replacement, and process-restart persistence.
These use deterministic discovery responses; completing account authentication was not tested.

## Additional Local Server finding

The source diagnostic passed captured-message Flow routing without duplicates, poll
controls, receiver disable/re-enable recovery, Credits collection, Hype snapshots,
Timer/Ticker reload recovery, Map settings, and a negotiated controller reply.
It did not pass the full suite: the generated giveaway-manager URL used
`localserver`, the custom port, and `server2`, but omitted `server`. The actual manager
stayed at “Connecting to the host…” and received no WebSocket traffic.

An initial interpretation that the assertion was simply outdated was disproved by
continuing the workflow. The temporary test edit was reverted; no failing assertion
was removed from the repository. The relevant shared giveaway controller/popup files
are unchanged between the v0.4.29 tag and the diagnostic's sibling checkout. This
limitation is included in the release notes alongside the existing poll-restart issue.

## Limits and evidence

Physical Intel hardware, physical printers/Stream Deck, and long authenticated live-stream
sessions were not tested. The older Windows-only legacy-session upgrade harness was not
run on this Mac; the installed tests cover the copied v0.4.28 default test profile, not the
entire older named-session migration matrix. The rapid language-switch stress crash from
previous releases has not been claimed fixed and remains in the release notes.

Logs, screenshots, runtime reports, release metadata and scripts are under
`/tmp/ssapp-mac-0429`. Final hidden-capture and publication results follow below.

## Final capture checks

The installed ARM build passed all 21 assertions for each of Twitch and YouTube using
local chat fixtures through real source-window IPC, bundled capture scripts, and normal
preloads. Hidden-window and zero-compositor-frame capture continued delivering messages
to the background/destinations. This was functional short-session coverage, not an
hour-long authenticated live-channel soak.

The verified ARM app replaced the previous installation at `~/Applications/socialstream.app`.
Redundant staging/test apps were removed; the four DMG/ZIP release files remain in `dist`.

Final file hashes:

```text
beec4589b02437d2508aa9305922ae355c4aff3821806285d36a72b93584cc48  dist/socialstreamninja_mac_v0.4.29_arm64.dmg
2437deae323ceec1f5ecd93221e0f752f0eccf623e0f77314ef6710a8b119635  dist/socialstreamninja_mac_v0.4.29_arm64.zip
0c37d62bae45cd59ec244f9cea5dd12b3ec46cc95f34e23e5042c707081474b7  dist/socialstreamninja_mac_v0.4.29_x64.dmg
a88cd65ea5b0ae85312cb456b0b497b6ebe91ab1a20708a909c93b8f8f280df9  dist/socialstreamninja_mac_v0.4.29_x64.zip
```

## Publication

Added the four signed/notarized DMG and ZIP files to the existing public pre-release:
https://github.com/steveseguin/social_stream/releases/tag/v0.4.29

Verified all nine assets, preserved the five Windows/Linux assets, and matched each
Mac upload's state, byte size and GitHub SHA-256 digest to its local file. Notes retain
the original changes and VirusTotal links, add four Mac download links, and document
the giveaway-manager limitation plus the prior language-switch stress-crash limitation.
No SSApp repository tag or release was created. About 4.5 GiB remained free after cleanup.
