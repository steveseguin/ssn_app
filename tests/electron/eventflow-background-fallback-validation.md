# Background fallback / Event Flow persistence — September 7, 2026

Reproduced the v0.4.25 dependency monitor switching a healthy HTTPS background to the file fallback after about 15 seconds. Both processIncomingMessage and filterXSS existed in the background. The parent file:// window could not read the HTTPS frame's Location because of origin isolation; the monitor caught that security error and incorrectly classified both dependencies as missing.

The monitor now requests the two readiness booleans through a main-process handler restricted to the main app frame and its selected child frame. It does not relax browser security or execute caller-provided JavaScript. Genuine dependency failures still select the complete offline bundle. The offline warning now explains that online Event Flows remain saved separately.

Actual Electron testing used isolated profiles and deterministic HTTPS fixture responses, with no live channels or user settings:

- Healthy online loading remained online beyond the previous 15-second trigger, with an inactive saved Event Flow visible.
- A genuine blocked script selected the offline background. Its separate IndexedDB store was empty; loading the original online origin recovered the original flow unchanged.
- Closing and restarting the app with the same profile preserved the saved flow unchanged, and the online page remained stable beyond 15 seconds.
- Existing startup-outage coverage passed fresh offline, online, partial failure, stalled script, and offline restart cases, including chat capture without duplicate delivery.
- Frame fallback diagnostics and portable data-path supporting checks passed.

Update-path review: the installer sets deleteAppDataOnUninstall=false. Portable profile paths use SocialStreamNinja-data/profile without an app-version component; legacy profile copying includes IndexedDB. Event Flow initialization opens eventFlowDB version 2 and creates missing stores without deleting the database. The separate deleteDatabase migration found in db.js targets chatMessagesDB, not Event Flows. This review and restart test do not constitute an actual NSIS upgrade test or establish the cause of an earlier loss in the reporter's own profile.

Reproduce with node tests/electron/eventflow-background-fallback-e2e.js and node tests/electron/startup-outage-e2e.js. Complete local reports: %TEMP%/ssapp-flow-fallback-IuZqa4/report.json and %TEMP%/ssapp-startup-outage-XgVtxl/report.json. A local packaged fix, version 0.4.25-upgrade-qa.1, was subsequently built for published-release upgrade testing below. Nothing was released or pushed.

## Published Windows release upgrade validation

The official portable release downloads for 0.3.128, 0.4.14, and 0.4.25 were extracted and their unchanged application executables were launched in isolated profiles. Their SHA-256 hashes matched GitHub release asset digests:

| Release | SHA-256 |
| --- | --- |
| 0.3.128 | `5549f6ccde9c6dc9270e5bf47d7e88cbb6d1d56efa21463ac4bd5f7dcb5f2244` |
| 0.4.14 | `f10d6d8ff2f7a8551888a5244be101cd56ef23374fff8e1aa045427a1d087b31` |
| 0.4.25 | `8e2b54ac81766a2f7186667809345c120b7f77dee9f720da1d67aa6e68a70236` |

No published 0.4.13 release was listed, so 0.4.14 was used as the nearby intermediate version. HTTPS fixture responses served the current primary SSN source under the real background origin; these apps normally fetch that web core independently of their desktop version. This preserves Electron origin isolation without depending on a live channel or external script availability. It does not recreate every historical version of the remote web core.

Each release saved a complete active and inactive flow graph in its real IndexedDB. The app was closed, the fixed packaged executable was started with the same profile, then closed and restarted again. All three upgrade/restart cases passed: full flow records and node configurations matched, only the active flow executed, session ID and a saved setting were retained, a localStorage preference survived, and a persistent test cookie survived. Published 0.4.25 reproduced the false switch after 15 seconds; its empty offline store did not erase its HTTPS flow records. The fixed package stayed online beyond that deadline and recovered both records.

Initial reports: `%TEMP%/ssapp-released-upgrade-H4qpms/report.json` (0.4.25) and `%TEMP%/ssapp-released-upgrade-hWJLLf/report.json` (0.3.128 and 0.4.14). Run `node tests/electron/released-upgrade-e2e.js` with the extracted releases under `.codex-tmp/upgrade-qa/vVERSION/unpacked/` and the fixed package under `.codex-tmp/upgrade-qa/fixed/win-unpacked/`. Environment overrides are documented at the top of the test.

Scope: this tests real released executables and persistent profiles, not an NSIS installer running over an existing installation, the portable wrapper's automatic profile discovery, or a real user's existing profile. It cannot establish whether this reporter experienced any separate earlier loss. Genuine offline operation still uses separate storage; the fix deliberately avoids merging or overwriting either store.

Final combined matrix, including editor interaction: `%TEMP%/ssapp-released-upgrade-XSGiEP/report.json`. All six upgrade/restart phases passed. The real Event Flow Editor displayed exactly one active and one inactive saved flow, opened the original graph, and retained its name. Upgrade screenshots for all three starting versions were visually reviewed: saved flow list, selected graph, nodes, connection, and active state were present, with no false fallback warning. Screenshots are in each version subfolder beside the report. This is a manually invoked regression test; it is not added to startup, push hooks, or default popup checks.
