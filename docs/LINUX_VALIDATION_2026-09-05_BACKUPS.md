# Linux backup and recovery review — SSApp 0.4.23

This pass pulled Social Stream beta through `5bbc03d3` and pushed the synced branch at
`3475f2a9`. SSApp was already current at `ce91755` before this fix.

## Confirmed backup omission

The settings backup allowlist omitted `customSessions` and `customUserAgents`, even though
source settings and other app preferences were included. A real app profile containing both
libraries was exported through the application menu to a real file. The resulting JSON omitted
both keys. Moving that backup to a fresh profile could not restore those reusable definitions.

The allowlist now includes both keys. Import validates that each library is a JSON array of
objects with a nonempty session name or user-agent value before changing the current profile.
Existing optional metadata is preserved. Older files remain supported; absent keys do not erase
a current library. Session definitions do not include authenticated browser cookies.

## Functional checks

`test:review-recovery:e2e` now covers the real export/import pipeline and disk files, restoring
both libraries after clearing them, reloading, and finding the restored definitions in the
actual source settings dialogs. It rejects malformed JSON, null, objects, null entries, and
entries missing their required name/value while preserving existing sources.

The same running-app test checks origin-scoped cookie/storage clearing, two renderer crashes
followed by successful reload and continued timer activity, rejected malformed source imports,
a valid source import, and restoration from the automatically written rollback backup.
File picker responses are supplied by the test; the importer/exporter, disk operations, reloads,
source windows, and state persistence are real.

The source run passed after reproducing the export failure before the fix. Hidden capture with
a source created hidden in headless mode passed 20 checks against the synced Social Stream
source, delivering 315 messages including 180 while hidden and 45 without compositor frames.

The recovery test now accepts `SSAPP_TEST_APP` and is included in the Linux package gate. The
gate extracts the AppImage into a temporary installation and exercises offline MCP discovery,
headless setup/restart/persistence/display loss, MCP control and transport recovery, keyboard
navigation and source settings, backup/recovery, and real speech generation. No release or tag
is created by these checks.

The final AppImage build, direct AppImage recovery workflow, and full extracted-package gate
all passed. The restored-list UI check uses a standard capture source; a WebSocket source does
not expose the user-agent settings menu. The test waits for the restored row before opening it.

Final logs, artifact, source revisions, and SHA-256 are saved under
`/home/ubuntu/code/ssapp-linux-validation-20260905-pass5/`.

## Remaining limitations

Physical GPU/desktop tray, screen readers, authenticated live services, ARM, and Windows/macOS
remain outside this host's validated coverage. Some dialog text is still untranslated. The
clearest remaining build improvement is a deliberate lockfile policy for reproducible installs;
this review does not change that policy or claim universal application compatibility.
