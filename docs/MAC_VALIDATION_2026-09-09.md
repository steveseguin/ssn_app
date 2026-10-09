# macOS v0.4.28 validation

Final signed installations and relevant functional checks passed on Apple Silicon and
Intel through Rosetta. Published and verified on the existing Social Stream v0.4.28
pre-release.

## Source and review

- Pulled SSApp main from `89326cc` to `24aa70e` and reviewed the six incoming commits.
- Reviewed background script/MIME recovery, diagnostics, per-source sign-in Origin rules,
  TikTok image normalization, receipt layout, UI guidance, and Windows installer changes.
- Pulled Social Stream beta to `9a28715b`. The bundled source is the existing v0.4.28 tag,
  `94ef100299bce215b82e59c45fd3fd834a4bfec3`, matching the Windows/Linux release.
- Electron remains pinned to 43.4.1, including the explicit packaged-runtime setting.
- No source-specific fix changed global Electron flags, sessions, or security defaults.

## Installation and functional checks

A trial Apple Silicon DMG was mounted read-only. Its app was copied with `ditto` into
`~/Applications/SSApp QA 0.4.28/`, and the image was detached before testing.
The installed app was launched through macOS Launch Services (`open`), with a separate
`SSAPP_USER_DATA_DIR`. It displayed the source UI, retained a changed language through
three reloads, quit cleanly, and retained the setting after a complete relaunch.

Passed against this installed trial app:

- Offline features: wishlist QR, donation hearts, compressed Bilibili chat, ZIP widget import,
  and map, each on initial load and reload with requests blocked.
- Six source mirror/cache/outage cases using real captured messages.
- Rich chat/emote rendering with normal, blocked-library, and reload cases.
- Two native local TTS requests generated valid WAV audio with one worker/model load.

Passed in source or supporting checks:

- All sixteen background script-recovery scenarios, including malformed responses, delays,
  partial loads, runtime errors, retry, report opt-in, and saved Event Flow preservation.
- Real HTTPS background-page and loader MIME recovery through Electron request hooks.
- Fresh offline, online, partial-outage, and stalled-script startup, including persistence.
- VK phone sign-in form twice, expected Origin header, stable page, and shared parent/popup session.
  No credentials were submitted.
- Group mute controls, source isolation, reactivation, and reload persistence.
- Sign-in Origin-rule validation and scope; TikTok image/emote regression checks.
- Fallback dependency guard and real TikTok signing submodule check.
- Real Electron receipt layout/PDF rendering with 58 mm stock and changed margins.
  A temporary Mac adapter used a longer receipt to ensure wrapping changed; no physical
  print job was sent, and Windows-only driver width assertions were excluded.

## Test correction

Two recovery suites initially timed out after switching back to the editor. Diagnostics
showed a ready loader, open Event Flow database, and both saved flows present. Playwright's
default animation-frame polling had stopped in the hidden frame on macOS. The checked-in
recovery tests now poll readiness by timer. The HTTPS test also waits for browser-frame
attachment, and the VK test waits for DOM readiness rather than every third-party resource.
The navigation suite also waits for deferred initial page restoration before clicking
through the menu; its earlier clicks could race the startup Sources-page restore.
All original functional assertions remain; production behavior is unchanged.

## Limits and evidence

- VK reached the sign-in form; completed account authentication was not tested.
- The Stream Deck integration test could not start because its separately compiled plugin
  bundle is absent from this Mac checkout. No physical Stream Deck or printer was tested.
- Intel validation uses Rosetta, not physical Intel hardware.
- The rapid language-switch stress crash documented for v0.4.26 has not been claimed fixed.
- Windows installer changes were reviewed, not executed on this Mac.

Logs, screenshots, install-test scripts, and isolated-profile references are in
`/tmp/ssapp-mac-0428`. Generated fallback files were updated only by the build updater.

## Native dependency correction

The first signed Intel candidate reported Sharp 0.35.4 but loaded libheif 1.23.1 from
older cross-architecture native packages. The ARM candidate loaded patched libheif 1.23.2.
Updated the four local Mac native packages to Sharp 0.35.4/libvips package 1.3.3, matching
Sharp's declared requirements, and updated the ignored local mac.sh installer pins.
No credentials were committed. Both subsequent candidates reported Sharp 0.35.4,
libheif 1.23.2, libvips 8.18.6, and Electron 43.4.1.

The Mac packaging hook now rejects missing or mismatched native binding/libvips packages
before signing. It rejected the original Intel candidate and accepted the ARM candidate.
Regression cases cover a stale binding, stale libvips, and a missing runtime dependency.
The GitHub alert that prompted this check is recorded against sso-worker's development
lockfile; desktop runtime versions were checked separately rather than inferred from it.

## Bundled-source correction

Steve completed a local build after an overlapping build was interrupted. Its apps and
DMGs passed signing/notarization checks, and its Intel DMG installation passed launch,
three reloads, clean restart, persistence, navigation in 14 locales, offline features,
and two local speech requests under Rosetta. However, targeted package hash checks found
that `mac.sh` had refreshed the bundle from older Social Stream `main`, not v0.4.28.
Those artifacts were withheld from publication and replaced by a tagged rebuild.

The replacement build explicitly sets `SSN_SOCIALSTREAM_BRANCH=v0.4.28` and
`SSN_SOCIALSTREAM_OUTPUT_BRANCH=main`. The local ignored `mac.sh` now defaults to the
package version's tag, with an explicit environment override available. RELEASE.md
records the same tagged-build requirement for adding Mac assets to an existing release.

## Final tagged installers

Both final apps and disk images passed Developer ID signature verification, Apple
notarization and stapling, and Gatekeeper assessment. Both DMGs passed `hdiutil verify`;
both ZIPs passed archive integrity checks and matched their packaged `app.asar` hashes.
Both runtimes report Electron 43.4.1, Sharp 0.35.4, libheif 1.23.2, and libvips 8.18.6.
Targeted background/giveaway package hashes match the existing v0.4.28 source tag.

For each final DMG, mounted read-only, copied its app into Applications with `ditto`,
detached the image, and tested the installed copy in an isolated profile. Both passed:

- Normal macOS Launch Services launch with graphics enabled, three reloads, clean quit,
  full relaunch, saved-language persistence, and a stability interval.
- Keyboard navigation, focus, accessible labels, all 14 locales, and reload persistence.
- Ten offline feature cases covering initial loads and reloads.
- Two local speech requests producing valid WAV audio with one model/worker load.

The final ARM app also passed bundled text-only emote rendering and reload checks.
Earlier tagged-source trial coverage additionally exercised rich emotes, captured source
messages and mirror recovery. The native app remains at `~/Applications/socialstream.app`;
the temporary Intel installation was removed. Personal app profiles were not used.

Final DMG notarization responses (Intel, then Apple Silicon):

```json
{"message":"Processing complete","status":"Accepted","id":"1e59e993-5744-474b-981c-c1765f1ee221"}
{"status":"Accepted","message":"Processing complete","id":"233ad8a7-a73b-4964-89b1-b9c1f5d851c8"}
```

Final download SHA-256 hashes:

```text
b5e568ea9e3942bb6b76682dd92a5cd52dd26645e8877661c4cd40b9b1cfa345  dist/socialstreamninja_mac_v0.4.28_arm64.dmg
899fdcd33fcc17abd6696cc487c4a70746e5c4aeb5923b85a5e388cd1ead50c3  dist/socialstreamninja_mac_v0.4.28_arm64.zip
b853e499765685faf67e8b12fb086353d460a5310561ab21a19ddda4747b4bcb  dist/socialstreamninja_mac_v0.4.28_x64.dmg
10b7b2725f0b34dcb2a907ff419c1631584f72d52aa2fd2d49478adb4f1d369b  dist/socialstreamninja_mac_v0.4.28_x64.zip
```

## Publication

Uploaded the four Mac DMG/ZIP files to the existing public pre-release:
https://github.com/steveseguin/social_stream/releases/tag/v0.4.28

Verified all nine release assets are present, the five Windows/Linux assets are preserved,
and each Mac asset's uploaded state, byte size, and GitHub SHA-256 digest match the local
file. Updated the existing release notes with four Mac download links and retained the
known rapid language-switch stress-crash limitation. No app repository tag or release
was created. Removed redundant generated staging bundles; about 3.5 GiB remained free,
with the four Mac downloads retained in `dist` and the native app installed.
