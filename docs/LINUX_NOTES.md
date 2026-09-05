# Linux notes

What behaves differently on Linux, what is not available at all, and what to check first when
a Linux user reports something odd. The original findings were verified on Ubuntu with app
version 0.4.7 (Electron 43, Chromium 150), on X11 (Xvfb with xfwm4) and Wayland (headless Weston).
See the [0.4.22 Linux review](LINUX_VALIDATION_2026-09-05.md) for the latest packaging fixes,
functional test results, and remaining coverage gaps.

The [0.4.23 follow-up](LINUX_VALIDATION_2026-09-05_FOLLOWUP.md) covers MCP transport fixes
and the new packaged-app checks in Linux CI.

## Capture in windows you cannot see

This is the big one, and it is fixed rather than merely documented — see
`hidden-window-keepalive.js`.

A source window that is not on screen may get no compositor frames at all, and
requestAnimationFrame is driven by frames. Chat pages append messages from frame-scheduled
work, so capture stops even though timers keep running and `backgroundThrottling: false` is
set. Measured with a source window created hidden, which is what you get whenever a source's
window is switched off and what every window gets under `--ssapp-headless-control`:

| state | compositor frames |
|---|---|
| created hidden, X11 desktop | 0–1 per second |
| created hidden, headless control mode | 0 |
| on screen, Wayland, real chat page | ~1 per second |
| hidden after having been shown, X11 | 60 per second |

A frame pump injected into capture pages runs queued frame callbacks from a timer when real
frames stop, and stays dormant when they do not. Verified over 45- and 35-minute soaks with
real YouTube and Twitch chat, including with compositor frames forced to zero.
`SSAPP_DISABLE_FRAME_PUMP=1` turns it off.

Hiding a source window on Linux uses a real `hide()`. Off-screen parking, which is what
Windows and macOS do, cannot work here: window managers clamp far-off-screen coordinates back
towards the desktop (a request for -30000 came back at -676, leaving a visible sliver) and
Wayland forbids programmatic positioning outright.

## Not available on Linux

**Portable mode.** Windows-only by design: `resolveEarlyDataPaths()` returns null on every
other platform. The AppImage is the Linux equivalent and runs from any directory. For
portable *data*, set `SSAPP_USER_DATA_DIR` to a folder beside the AppImage — that relocates
settings, sessions, logins, logs and cache. Note that Chromium's own `--user-data-dir` is
**not** enough: the app calls `app.setPath('userData', ...)` during startup, which overrides
it for sessions and recovered settings.

**System TTS voices.** Electron on Linux reports no speech-synthesis voices at all:
`speechSynthesis.getVoices()` stays empty even with speech-dispatcher installed and working
(`spd-say -L` lists voices) and with `--enable-speech-dispatcher` passed. Use the bundled TTS
engine, which works. The system-voice test skips on non-Windows for this reason.

**`setOpacity()`.** A no-op on Linux — Electron documents it as Windows and macOS only, and it
was confirmed to silently return 1 after setting 0.5, on both X11 and Wayland. Anything that
tries to hide a window by making it transparent will appear to succeed and do nothing.

## Needs something from the desktop environment

**Desktop notifications need a notification daemon.** Without one, `Notification.show()` used
to block the whole main process for two minutes while D-Bus timed out, with
`Notification.isSupported()` reporting true the entire time. The app now probes for
`org.freedesktop.Notifications` once, gives up permanently after a failure, and never tries
under `--ssapp-headless-control`. If notifications do not appear on a minimal desktop, that is
why; look for `[Notifications] No desktop notification service on this session`.

**The tray icon needs a tray host.** GNOME has none by default and many minimal window
managers never had one, so close-to-tray can hide the window with no icon to click. Relaunching
the app now restores the running window, which is the way back when there is no tray. Headless
control mode is exempt, since keeping windows hidden is the point of it.

**Transparent windows need a compositing window manager.** Without a compositor, transparency
does not work. This is why the AppImage can give a transparent chat overlay on KWin but not on
a bare window manager.

**Global shortcuts** register and fire on X11 — verified by delivering real key events. On
Wayland, delivery is up to the compositor: `globalShortcut.register()` returns true either way,
so a shortcut that never fires is not something the app can detect.

## GPU and stability

The app forces `--ignore-gpu-blocklist` and `--enable-gpu-rasterization`, which is exactly what
tends to crash on a blocklisted or flaky Linux driver. The crash-recovery ladder now actually
applies on Linux: L1 drops WebGPU, L2 respects the GPU blocklist, L3 disables GPU rasterization.
Boot was verified at every level from 0 to 4. The L4 rung, which relaxes the GPU sandbox, stays
Windows-only on purpose — that is a security trade-off, not a stability knob.

`--no-hwa` disables hardware acceleration but does **not** remove the GPU process: it still runs
at around 100 MB doing software compositing. What it buys on a GPU-less machine is avoiding
repeated driver probing and the GL error spam that comes with it.

## Footprint

Measured with everything hidden and chat flowing: about 600 MB and 12 processes for one live
YouTube source, and roughly 120 MB for each additional *platform*. Extra sources on a platform
you already run cost a few MB each and no extra processes, because same-origin windows share a
renderer. Idle CPU with a hidden source window is under 1% of one core, and memory was flat
across a 20-minute watch.

## Updates

There is no auto-updater — no `electron-updater`, no `autoUpdater` usage. The app compares its
version against GitHub releases and links to the release page; you download a new AppImage
yourself.

## Developing and testing on Linux

Keep the repositories side by side, for example `~/code/ssn_app` and `~/code/social_stream`.
From `ssn_app`, run `npm install`, then `npm run start-linux`. The launcher resolves the
neighboring source directory, supports spaces in the path, and stops with a clear error if
that checkout is missing. It does not load the disposable build fallback as development
source. Use **File > Load Social Stream From Folder** for a checkout in another location.

For an isolated development profile:

```bash
SSAPP_USER_DATA_DIR="$(mktemp -d /tmp/ssapp-dev.XXXXXX)" npm run start-linux
```

The app needs a display even when every window is hidden. `--ozone-platform=headless` looks
like it should avoid that but segfaults during startup on both Electron 38 and 43 — use Xvfb.
On hosts whose drivers advertise GLX but cannot serve it, Xvfb itself crashes unless started
with `-extension GLX`.

```bash
Xvfb :99 -screen 0 1920x1080x24 -extension GLX -nolisten tcp &
export DISPLAY=:99
npm run test:hidden-capture          # add --headless or --start-hidden
```

See `AGENTS.md` for the full list of hidden-capture test entry points, and
`docs/CLOUD_HOSTING.md` for running on a server.

The compact navigation menu supports Enter/Space to open, Escape to close, and returns
keyboard focus to its button when navigation hides a focused link. The menu name, expanded
state, current page, and language selector are exposed to accessibility tools. Their labels
follow the selected app language.

To check a built AppImage or extracted executable with temporary profiles:

```bash
SSAPP_TEST_APP="/path/to/socialstreamninja.AppImage" npm run test:headless-launcher:e2e
DISPLAY=:99 SSAPP_TEST_APP="/path/to/socialstreamninja.AppImage" npm run test:mcp-control:e2e
DISPLAY=:99 SSAPP_TEST_APP="/path/to/socialstreamninja.AppImage" npm run test:navigation-accessibility:e2e
DISPLAY=:99 SSAPP_TEST_APP="/path/to/socialstreamninja.AppImage" npm run test:tts
SSAPP_MCP_BINARY="/path/to/socialstreamninja.AppImage" npm run test:mcp-launch:e2e
```

The launcher test starts its own display; the control and navigation tests need a working
display. These packaged tests select bundled assets so they do not silently depend on a
developer's neighboring checkout. The adapter-only test intentionally runs without a display.
The navigation test uses `--no-sandbox` in its isolated test process to accommodate Linux CI
hosts; that switch is not added by the development launcher.

To run the full packaged-app gate used by both Linux build workflows:

```bash
npm run test:linux-package -- /absolute/path/to/app.AppImage
```

It extracts the AppImage into a temporary installation (no FUSE required), checks MCP
discovery without a display, tests setup and headless recovery, then runs control,
interrupted-response/large-screenshot, navigation/localization, and speech workflows on
private Xvfb displays. The temporary installation is removed when the script exits.
Install `xvfb`, `xauth`, and `x11-utils` first. CI sets `SSAPP_TEST_NO_SANDBOX=1` only for
isolated testing on runners that prohibit Chromium's sandbox; normal launches are unchanged.

Run the packaged speech test as well as the source test. Sharp's native library and its
`@img` dependencies must be outside `app.asar`; otherwise the Linux loader cannot find
libvips and the speech worker fails even though speech works from source. The explicit
`asarUnpack` entries in `package.json` keep those libraries accessible.

## Known gaps in this testing

- **Multi-monitor placement is unverified.** Xvfb reports a single display to Electron even
  with two screens and Xinerama, and its RandR implementation will not accept virtual monitors,
  so per-display window-state restore was only exercised against one display. This needs a real
  dual-head machine.
- **Fully occluded windows on KWin and Mutter are unverified.** Those compositors cull occluded
  surfaces; headless weston does not, so the exact condition from issue #875 could not be
  reproduced locally. The frame pump is page-agnostic and covers it in principle.
- **Tray icon appearance is unverified.** No tray host was available; only the consequence of
  its absence was tested and mitigated.
