# Linux functional validation follow-up — September 5, 2026

This extends [the practical Linux report](LINUX_PRACTICAL_2026-09-05.md). Tests launched real
Electron processes with isolated profiles, local source pages, IPC, and real MCP/HTTP/WebSocket
connections. Ubuntu used Xvfb; Arch used a fresh `archlinux:base-devel` container with Xvfb,
Xfwm and a session bus. These are functional tests, but do not establish compatibility with
every desktop, GPU or streaming account.

## Completed matrix

| Workflow | Result |
| --- | --- |
| Current 0.4.23 AppImage extraction and packaged-app gate | Passed |
| Packaged MCP startup without a display or network | Passed |
| Headless visible setup, saved settings, hidden restart and display-loss recovery | Passed on Ubuntu package and Arch 0.4.18-3 |
| Control API opt-in, active-source guards, stop progress and persistence | Passed |
| MCP interrupted HTTP response recovery and full screenshot delivery after stdin EOF | Passed on Ubuntu package and upgraded Arch package |
| Navigation and source-dialog keyboard/focus workflows, 14 language choices and reload persistence | Passed in package |
| Crash/reload recovery, scoped storage, import rejection, export/restore and rollback backup | Passed in package |
| Local TTS synthesis twice, with worker/model reuse | Passed; real WAV output, no physical speaker check |
| Session isolation, import, deletion and partition cleanup | Passed from source |
| Source deletion, pending activation cleanup and replacement-source safety | Passed from source |
| Group mute/unmute, unrelated-source isolation and reload/reactivation | Passed from source |
| Bulk deletion of 40 sources, empty groups and legacy migration | Passed from source |
| Local WebSocket delivery, loopback-only and explicit LAN configurations | Passed from source |
| MCP app-window screenshots, semantic controls, JavaScript prompts and Electron dialogs | Passed from source |
| Arch clean install of corrected AUR 0.4.18-3 | Passed; no missing shared libraries before adding test tools |
| Arch upgrade to locally staged 0.4.23-3 | Passed; existing profile retained |
| Arch uninstall and reinstall of 0.4.23-3 | Passed; executable removed, profile retained and usable after reinstall |
| Arch GUI before upgrade, after upgrade and after reinstall | Six launch/quit cycles and 18 source start/stop cycles passed, including minimize/restore and HTTPS in a real source window |

Arch screenshots cover the dashboard, compact layout, active source and public HTTPS page.
The current AppImage is the same binary validated in the practical report; a follow-up 0.4.24 build will validate the inspection fix described below.

## MCP page-control findings

The broad MCP page-control test initially stopped at two stale test assumptions:

- Electron `app.getAppMetrics().memory.privateBytes` is Windows-only. Linux legitimately returns
  `privateKb: null`; PID, process type and working-set memory are still checked. See Electron's
  [MemoryInfo documentation](https://www.electronjs.org/docs/latest/api/structures/memory-info).
- A `connected` status clears the preceding source error. The fixture now sends a subsequent
  warning to test redaction in source/list/status responses while retaining a recovered, active source.

After correcting those assertions, two runs timed out in `ssapp_inspect_source_page` at 30 seconds,
while two diagnostic repeats passed. Inspection awaited every frame without a deadline. SSApp
0.4.24 now allows two seconds per frame and ten seconds overall, skipping unresponsive subframes.
An unavailable main page returns `SOURCE_PAGE_UNAVAILABLE` rather than an empty success. The
existing real fixture continuously navigates an iframe; the test now also bounds inspection time.
Two complete runs passed after bounding the waits. The checked-in control skill documents the
minimum version and retry behavior. This fixes an unbounded wait; it does not prove that every
cause of delayed renderer execution has been eliminated.

## Evidence and remaining work

Local logs and screenshots: `/home/ubuntu/code/ssapp-linux-comprehensive-20260905/`.
Earlier build, makepkg, soak and Wayland evidence remains under
`/home/ubuntu/code/ssapp-linux-practical-20260905/`.

The public AUR recipe remains 0.4.18-2 until the corrected recipe is published separately.
The clean-container dependency fix and locally staged upgrade were tested; this is not a claim
that the public package has already been repaired. Container test commands disable Chromium's
sandbox; the installed launcher does not. Native Arch sandbox verification, physical Wayland
screenshots, GPU/desktop/tray integration, audio hardware, screen readers, ARM and authenticated
live-platform testing remain outstanding as described in the practical report. Continue native desktop verification, especially Wayland screenshot behavior.
