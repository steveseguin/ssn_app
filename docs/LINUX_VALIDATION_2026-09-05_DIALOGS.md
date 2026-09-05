# Linux source settings review — SSApp 0.4.23

This third pass follows the [MCP and package review](LINUX_VALIDATION_2026-09-05_FOLLOWUP.md).
It focuses on source settings that were still difficult or impossible to operate with a keyboard.
Tests use the real Electron app, isolated temporary profiles, and inactive fixture sources on
Ubuntu 24.04.3 x86-64. No authenticated platform accounts are required for these workflows.

## Validated bugs and fixes

Opening User Agent Settings or Browser Session Settings left focus behind the visible dialog.
Neither dialog had dialog semantics, contained Tab navigation, nor responded to Escape.
These failures were reproduced by opening each dialog through its source settings menu in
the running app before changing the code.

Both now reuse the existing modal behavior: focus enters the dialog, the background becomes
inert, Tab and Shift+Tab remain inside, and Escape/Cancel restores focus to the source settings
button. Closing removes event listeners and restores the background's previous accessibility
state, so repeated use does not accumulate handlers. IME composition keys are ignored.

A second reproduction created a custom browser session, selected the platform default,
then pressed Enter on the custom session. The selected value stayed `default-youtube`.
Custom session rows now contain a native selection button with `aria-pressed`; their remove
button remains separate and has a translated name identifying the session it removes.
Mouse selection remains available.

The custom inputs now have associated labels. Dialog titles and these labels are translated
through the existing language dictionaries, covering all 14 language choices. Other text in
these dialogs still has English strings; this is not a complete localization overhaul.

## Functional validation

The new `npm run test:source-dialog-accessibility:e2e` opens settings through the real menu,
checks three repeated open/close cycles, forward/backward Tab containment, Escape during IME
composition, focus restoration, and cleared background inert state. It creates a custom session
and user agent, selects and saves them, reloads the app, and checks the persisted source values.
It also opens the existing Rumble sign-in method dialog to exercise the shared dynamic-modal
path, and checks dialog names/input labels across the 14 language choices.

An initial additional test mistakenly expected YouTube to open that method chooser; YouTube
correctly opened its sign-in window. The test now uses Rumble, which supports the chooser.
The separate prompt test exposed a test-only race: clicking Cancel can close its Electron window
before Playwright acknowledges the click. The two remaining unguarded Cancel actions now use
that test's existing window-close helper and still check the real IPC result.

| Check | Result |
| --- | --- |
| Source dialogs on X11 | Passed |
| Source dialogs on native Wayland / headless Weston | Passed |
| Direct AppImage source-dialog workflow | Passed |
| Final extracted AppImage package gate, including speech | Passed |
| MCP app-window capture, interaction, and native dialogs | Passed |
| Prompt keyboard, IME, scrolling, and IPC result checks | Passed after fixing the test race |
| Final Linux x86-64 AppImage build | Passed |

Logs and the final artifact hash are recorded beside the saved build in
`/home/ubuntu/code/ssapp-linux-validation-20260905-pass3/`.

## Package gate and remaining work

The new dialog workflow is part of `npm run test:linux-package -- /path/to/app.AppImage`.
The gate extracts an installation into a temporary directory and runs the real packaged app:
display-free MCP discovery, headless setup/restart/persistence/display-loss shutdown, MCP
source control, interrupted-response recovery, complete screenshot output, navigation,
source dialogs, and local speech generation. The installation is removed afterward.

The largest remaining build-process improvement is a deliberate reproducible-install policy:
`package-lock.json` is ignored and Linux CI currently discards it. This pass does not change that
repository policy. Pinning the complete dependency tree would make local and CI results easier
to reproduce.

Native Wayland testing uses headless Weston with the Pixman renderer; X11 uses Xvfb with GLX
disabled. These are real Electron workflows, but do not establish physical GPU, desktop tray,
GNOME/KDE, screen-reader, ARM, authenticated live-platform, or Windows/macOS compatibility.
Those coverage gaps from the earlier reports remain. No release, tag, or upload was performed.
