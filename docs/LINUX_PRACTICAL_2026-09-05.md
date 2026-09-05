# Practical Linux validation — 2026-09-05

This pass emphasized running the application instead of reviewing code. All profiles were
isolated. The final AppImage is SSApp 0.4.23 / Electron 43.2.0. The actual published AUR recipe
was also checked: commit `8e6fa13`, package 0.4.18-2, matched the original checked-in recipe.

## Failures found through practical testing

**Clean Arch installation did not launch.** `makepkg` verified the published AppImage checksum
and built the package; `pacman -U` installed it. Running the installed executable failed on
`libnspr4.so`. `ldd` found 21 unresolved libraries, including GTK, NSS, audio and graphics
libraries. The revised recipe declares `gtk3`, `nss`, `alsa-lib`, `libcups`, and `mesa` as required
dependencies and removes FUSE (the installed package is already extracted). In a second clean
Arch container, installing only the revised package and its declared dependencies resolved all
libraries and returned a real MCP initialization response. GUI test tooling was installed only
after that check. The release stays at 0.4.18 and pkgrel advances to 3; no unreleased download URL
or placeholder checksum is committed. The public AUR recipe has NOT been updated by this work.

**Compact window controls were clipped.** Screenshots at 800 pixels showed the version panel
behind the source sidebar and connection mode buttons underneath the settings pane. Small flex
wrapping changes keep the version panel and mode controls inside their available width. Before
and after screenshots were inspected; the final packaged app also passed the overflow check.

Minimal Arch screenshots also exposed missing emoji glyphs. Installing `noto-fonts` and
`noto-fonts-emoji` restored normal text and icon rendering in the inspected screenshot. They are
now optional package recommendations, along with CJK fonts; the CJK font package was not tested.

## Real application results

| Environment / workflow | Completed result |
| --- | --- |
| Ubuntu AppImage baseline | 5 launch/quit cycles, 15 source start/stop cycles |
| Ubuntu X11 with Xfwm window manager | 3 additional launches, 9 source cycles; minimize/restore, hide/show and public HTTPS page |
| Updated source build | 1 launch, 3 source cycles; corrected compact screenshot |
| Corrected Arch 0.4.18 package | 3 launches, 9 source cycles; screenshots, window controls and public HTTPS page |
| Arch upgrade baseline | 1 launch, 3 source cycles with a retained profile |
| Arch local test upgrade to 0.4.23 | 2 launches, 6 source cycles; saved source retained |
| Arch after optional font installation | 1 additional launch and 3 source cycles; emoji screenshot corrected |
| Arch uninstall and reinstall | Application files removed, profile retained; reinstall passed 1 launch and 3 source cycles |
| Final Ubuntu AppImage | 2 launches, 6 source cycles, then another launch / 3 cycles including mouse activation and stopping |
| Native Wayland / headless Weston | 2 launches, 6 source cycles, hide/show and continued source timers; screenshots remain inconclusive |
| Arch headless launcher | Visible setup, settings save, hidden restart, and display-loss shutdown passed |
| Arch MCP on installed 0.4.23 | Interrupted-response recovery and complete multi-megabyte screenshot output passed |
| Final Ubuntu extracted-package gate | Headless setup/persistence, MCP discovery/control/transport, navigation, dialogs, backup/recovery and real speech passed |
| Hidden headless capture soak | 10 minutes, 10/10 productive samples, 600 destination messages while hidden, no errors or stalls |
| Arch package integrity | 1,526 files checked, zero altered files; desktop file validated with a non-fatal multiple-category hint |

Source start/stop tests use the actual source controls and IPC-created Electron windows, assert
that source timers advance, and verify that stopped source windows disappear. Each completed
app quit is checked for process exit. The HTTPS browser check loads `https://example.com/` inside
a real SSApp source window with its normal session/preload/configuration path, verifies rendered
content, and captures that window. It does not establish authenticated chat-platform compatibility.

The Arch 0.4.23 upgrade package was generated from the local AppImage in an isolated copy of the
recipe. It was installed with pacman, not published. The older AUR asset and latest local asset
were deliberately tested separately.

## Screenshots and reproducibility

Artifacts, screenshots, memory snapshots, logs, Arch packages, and SHA-256 checksums are saved in
`/home/ubuntu/code/ssapp-linux-practical-20260905/`. Screenshots include the dashboard, local live
source window, public HTTPS page, and before/after compact layout.

`npm run test:linux-practical:e2e` runs five launches and three source cycles per launch. Set
`SSAPP_TEST_APP` to an AppImage or installed executable, `SSAPP_TEST_OUTPUT` to a result directory,
and `SSAPP_TEST_LAUNCHES` to change the repeat count. Run under Xvfb and an actual window manager;
set `SSAPP_TEST_WM=1` for minimize/restore and the public HTTPS check. The retained-profile options
are for controlled upgrade tests only. The default is a temporary profile; retained-profile testing must point to a dedicated test profile.

The AUR checks followed the real [makepkg workflow](https://man.archlinux.org/man/makepkg.8.en)
and used [PKGBUILD dependency declarations](https://man.archlinux.org/man/PKGBUILD.5.en.html).

## Practical limits and follow-up

Arch was a container using the host kernel, Xvfb and Xfwm with a session bus. Chromium sandboxing
was disabled only in test commands because of container restrictions; the installed launcher and
recipe do not add `--no-sandbox`. This is not a substitute for native Arch sandbox verification.

Wayland launch/stop and source timers passed, but both Playwright and Electron screenshot paths
stalled under headless Weston when capturing the dashboard. Retrying with dashboard focus did
not resolve it. The screenshots are inconclusive in that compositor setup; no production capture
change was made without evidence from a physical Wayland desktop. X11 screenshots succeeded.

Physical GPU drivers, GNOME/KDE integration, system tray behavior, real screen readers, physical
audio output, ARM, and authenticated platform sessions still need real desktop/account testing.
Memory samples are provided but do not establish leak-free behavior over hours or days. The
corrected AUR recipe is ready for publication; public users still receive 0.4.18-2 until it is deployed.
