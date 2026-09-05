# Linux review — 5 September 2026

Reviewed SSApp 0.4.22 on Ubuntu 24.04.3 x86-64, Node 22.21.0, Electron 43.2.0.
Starting revisions: `ssn_app/main` at `85f9374`; Social Stream `beta` at `31dbd400`,
merged with the existing local instruction commit as `e506a073`. All app runs used
temporary profiles. The existing user profile was not used.

## Confirmed problems and changes

- **Packaged local speech failed on Linux.** Source speech generation passed, but the actual
  AppImage failed with `libvips-cpp.so.8.18.6: cannot open shared object file`. Sharp's binding
  was unpacked while its companion library remained inside `app.asar`. Explicitly unpacking
  Sharp and `@img` fixes the native library lookup. The rebuilt AppImage generated two valid
  WAV samples, using one worker and one model load. This follows
  [Sharp's Electron packaging guidance](https://sharp.pixelplumbing.com/install/#electron).
- **Linux development launched the wrong source.** `start-linux` contained a hardcoded
  Ubuntu path into the disposable fallback bundle. It now resolves the neighboring
  `social_stream` checkout, quotes the path, and fails clearly if the checkout is absent.
  A real `npm run start-linux` session loaded its settings popup from that checkout.
- **Compact navigation lacked accessible state and keyboard dismissal.** The running app
  exposed only the `☰` glyph, no expanded state, and left the menu open on Escape. The menu
  now has translated accessible labels, expanded/current-page state, Escape dismissal,
  and focus restoration when a focused link is hidden.
- **Translations had gaps.** Six newly added settings/error messages fell back to English
  in every non-English locale. Those translations and the new accessibility labels now
  cover every supported language. Thai Twitch and Kick labels retain the platform names.
- **Affected runtime dependencies were installed.** Updated `ws`, `fast-uri`, `fflate`, and
  `protobufjs` within compatible version families. The old protobuf override covered only
  TikTok, leaving ONNX's dependency unaffected; the override now covers both. Installed
  versions are ws 8.21.3, fast-uri 3.1.6, fflate 0.8.3, and protobufjs 7.6.6.
  `npm audit --omit=dev` reports zero vulnerabilities. Advisory applicability was verified
  against installed versions; no exploit against the app was claimed. See the upstream
  [WebSocket advisory](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p),
  [protobuf advisory](https://github.com/protobufjs/protobuf.js/security/advisories/GHSA-j3f2-48v5-ccww),
  and [URI advisory](https://github.com/fastify/fast-uri/security/advisories/GHSA-f65p-4m7j-42xc).

## Functional validation

These checks ran the actual Electron application; syntax checks and npm audit are separate
supporting checks. X11 used a private Xvfb display. Wayland used a private headless Weston
13 compositor with the software renderer.

| Workflow | Result |
| --- | --- |
| Build Linux AppImage with the local Social Stream checkout | Passed; native libraries included |
| Install/run AppImage from a path containing spaces | Passed |
| Extract AppImage and run the extracted executable | Passed |
| Visible setup, saved settings, hidden restart, display-loss shutdown | Passed from source and packaged app |
| MCP initialization/discovery with no display or main app | Passed from source and AppImage |
| Control API opt-in, source lifecycle, stop progress, settings persistence | Passed from source and AppImage |
| Hidden source capture and real message delivery on X11 | 20 checks passed |
| Hidden source capture and real message delivery on Wayland | 20 checks passed |
| Ten-minute X11 capture soak, source created hidden, headless control enabled | Messages in all 10 sampled minutes, 600 destination messages, no errors |
| Local speech generation before/after dependency updates | Passed from source; packaged failure reproduced and fixed |
| Local WebSocket server loopback workflow after dependency updates | Passed |
| Source crash/reload recovery, cache isolation, invalid import rejection and rollback | Passed |
| User Session isolation, import, deletion, partition cleanup | Passed |
| Group mute/unmute, unrelated source isolation, reactivation after reload | Passed |
| Prompt keyboard/IME behavior and long-dialog scrolling | Passed |
| Compact navigation, repeated keyboard use, translated labels, reload persistence | Passed on X11 source/AppImage and Wayland source |
| Translation layout in 14 locales | Passed in Electron |

Capture used the local chat fixture through SSApp's real source-window and injection paths.
It verifies sustained delivery without a live platform account. It does not establish that
every external platform currently permits sign-in or capture.

The navigation test initially waited on animation frames that Weston did not consistently
provide. Readiness checks now poll on a timer; keyboard and pointer actions still run in
the real Electron UI. Stale pre-existing X sockets also prevented initial test launches;
tests subsequently used a fresh private display. These environment/harness failures were
not reported as product bugs.

## Remaining limits and useful follow-up

- The private TikTok signer is a stub in this checkout. Live TikTok signing and authenticated
  platform workflows were not validated. No credentials were supplied or changed.
- Native GNOME/KDE desktop behavior, physical multi-monitor placement, tray appearance,
  hardware GPU drivers, screen-reader speech, and audible playback need real desktop checks.
  Speech validation verified generated WAV data, not speakers. ARM and Arch/AUR installation
  were not tested on this Ubuntu x86-64 host.
- Refreshing stale local versions of `@xmldom/xmldom`, `js-yaml`, `lodash`, `minimatch`, and
  `tmp` within the existing version constraints cleared the five build-tool advisories.
  Both `npm audit` and `npm audit --omit=dev` now report zero findings. These local dependency
  resolutions are not checked in because the project ignores its lockfile.
- **Reproducible builds and a packaged-app CI gate are the largest process improvements.**
  The repo ignores `package-lock.json`, and Linux CI deletes it before installing. Builds can
  therefore resolve different dependency versions. The Linux build workflows do not run the
  packaged speech/control tests before uploading artifacts. Agree on a cross-platform lockfile
  strategy and add those tests; the speech regression demonstrates why a successful build and
  passing source tests are insufficient. No workflow or lockfile policy was changed here.

## Repeating the packaged checks

The existing headless, control, and speech tests now accept `SSAPP_TEST_APP` for an AppImage
or extracted executable. Adapter discovery uses `SSAPP_MCP_BINARY`. See
[Linux notes](LINUX_NOTES.md#developing-and-testing-on-linux) for commands.

The final local review AppImage is saved outside the repo at
`/home/ubuntu/code/ssapp-linux-validation-20260905/socialstreamninja_linux_v0.4.22_x86_64.AppImage`.
It is a local review build, not a published release.

SHA-256: `95fb4aff8b876a2b0d623dbbfdb77b048147efc485bc67f636102baed6cc157b`

Logs and diagnostic reports are saved alongside that AppImage. No tags, releases, uploads,
or pushes were performed.
