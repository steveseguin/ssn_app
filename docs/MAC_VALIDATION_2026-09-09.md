# macOS v0.4.28 validation

Trial installation and relevant functional checks passed. Release signing and publication are pending.

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
No credentials were committed. The Intel candidate is being rebuilt before publication.

The Mac packaging hook now rejects missing or mismatched native binding/libvips packages
before signing. It rejected the original Intel candidate and accepted the ARM candidate.
Regression cases cover a stale binding, stale libvips, and a missing runtime dependency.
The GitHub alert that prompted this check is recorded against sso-worker's development
lockfile; desktop runtime versions were checked separately rather than inferred from it.
