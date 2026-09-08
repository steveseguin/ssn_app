# Background fallback / Event Flow persistence — September 7, 2026

## Background failure reporting

The background dependency check now sends `background_load_failed` through the
existing opt-in, rate-limited reporter when the loader reports failure. It includes
the failed script, loader error, readiness flags, and custom-script presence/enabled
flags. Background diagnostic URLs omit query strings and fragments; these new
fields do not include custom script code or selected local file paths. Enabling
reporting after a failure and manually reporting an issue also collect the current
background state. The primary Social Stream loader preserves synchronous script
execution error messages instead of only reporting a generic execution failure.

Functional Electron checks passed with isolated profiles and HTTP 503 / runtime
execution failures, followed by Retry loading. Uploads were intercepted locally;
no synthetic reports were sent to Cloudflare. Verified opt-out, failure payload,
rate limiting, enable-after-failure snapshot, flow persistence, and execution of
only the active saved flow. Evidence: `%TEMP%/ssapp-script-recovery-S1ZsPD`
and `%TEMP%/ssapp-script-recovery-l35YMS`. These changes are not published.

## Live mirror and stale-file investigation

Checked 258 resource requests through SSApp's Electron session, covering the local
editor asset inventory on main/beta across cache.socialstream.ninja, the matching
hosted site, and raw.githubusercontent.com. Cross-checked against each published
branch's actual HTML/loader dependencies: all 213 required-resource requests
returned HTTP 200 and all required JavaScript parsed. Hosted/cache JavaScript had
JavaScript MIME types; GitHub Raw used text/plain. Optional settings.json,
badwords.txt, and goodwords.txt returned 404, as did beta-only features probed on
main; none is evidence of a missing required resource on its published branch.
Required script hashes matched across mirrors within each branch. Hosted HTML
adds a robots noindex tag. Main still published its older script-tag loader;
beta published the recovery loader. Both live editor pages opened in SSApp with
no banner after 20 seconds. Evidence: `%TEMP%/ssapp-asset-audit-F2CC6V/report.json`
and the main/beta editor screenshots beside it.

An isolated in-app flow retained a dead remote-image URL, a nonexistent local
media asset, and custom JS that throws. The profile also retained a missing
custom.js path, missing saved text-file paths, an uploaded bad-word list, and
invalid uploaded JavaScript. After two reloads and repeated flow execution, the
loader remained ready, the saved flow remained available, and no banner appeared.
The media properties correctly showed File missing / Relink. Bad-word and JS
uploads are stored as contents; the File-menu custom.js path applies only to
dock/featured/bot. Evidence: `%TEMP%/ssapp-stale-audit-4RHFRf/report.json` and
`repeat-reload.png`. These cases do not establish the affected user's exact cause.

Wrong script MIME cases passed (`mime`, `mime-html`, `loader-mime`). A page MIME
case in the protocol fixture timed out because it bypasses onHeadersReceived;
the appropriate real HTTPS test subsequently passed both page and loader MIME
correction. Evidence: `%TEMP%/ssapp-background-mime-W5MC2Y`. Diagnostic scripts
are `.codex-tmp/eventflow-asset-audit.cjs` and `.codex-tmp/eventflow-stale-audit.cjs`.

## Follow-up: slow downloads, MIME errors, and mirror recovery

The earlier 0.4.26 fix corrected the cross-origin readiness check, but retained a
15-second deadline that could still replace a slow online background with a
different offline IndexedDB store. A local Electron reproduction delayed a
successful script response for 20 seconds: the monitored frame changed to file://
at 16 seconds, while an otherwise identical unmonitored frame completed online.
This reproduces a remaining cause; it does not identify the reporter's exact
network failure.

The new behavior preserves the selected background address on dependency failures.
SSApp downloads complete scripts through its own session, tries cache, hosted,
then GitHub mirrors, and parses the JavaScript before executing it once. MIME
labels and redirected filename extensions do not decide whether a script is
valid. Empty responses, HTML/JSON error bodies, syntax errors, HTTP failures,
and stalled headers/bodies do not get executed. Each attempt is bounded to 12
seconds, including body download. After all mirrors fail the editor displays
Retry loading, without switching databases. A runtime execution failure stops
initialization and is not automatically re-executed. Initial offline startup
still supports the existing packaged background.

The background HTML/loader MIME correction is narrowly limited to those two
bootstrap resources in the main app window. A rejected/missing loader also has
a validated recovery path. Settings initialization runs once after asynchronous
script loading, including compatibility with an older cached background script.

Functional verification in isolated real Electron sessions:

- `npm run test:background-recovery:e2e`: 16 scenarios covering wrong MIME,
  failed bootstrap, invalid bodies, GitHub-only recovery, redirected extension,
  slow responses, stalled bodies, complete outages, and execution failures.
  Full active/inactive flow graphs and the session ID survive; only the active
  flow executes, once. Late responses do not execute twice. Retry restores the
  same editor URL and saved graphs.
- `npm run test:background-mime:e2e`: actual local TLS/HTTP proxy responses,
  exercising Electron's real response-header hook with binary MIME labels on
  background.html and loader.js. Requires OpenSSL for the disposable test
  certificate; certificate bypass is restricted to this isolated test launch.
- `node tests/electron/startup-outage-e2e.js`: fresh offline, online, partial
  failure/retry, stalled failure/retry, and offline restart; real source-window
  capture delivers each message once.
- `node tests/electron/eventflow-background-fallback-e2e.js`: online stability,
  true offline startup, reconnect, and saved-flow restart persistence.
- `node tests/electron/emote-sanitizer-e2e.js`: current local source initialization,
  rich chat rendering, blocked sanitizer dependency, and reload (18 messages).
- Explicit live-asset run (`SSAPP_TEST_LIVE_ASSETS=1`,
  `SSAPP_RECOVERY_PHASES=live-assets`) passed against the public cache server in
  SSApp, preserving both flows and remaining online beyond 20 seconds. Other
  services/channels were blocked. Public HTML/JS response headers were correct
  when checked; this does not establish historical server behavior.

Evidence under `%TEMP%`: `ssapp-script-recovery-4WFR11` (full graph matrix),
`ssapp-script-recovery-BbssOS` (additional MIME/bootstrap outage cases),
`ssapp-background-mime-ZaICLX` (TLS/header checks),
`ssapp-startup-outage-KIB6nc`, `ssapp-flow-fallback-YNqsbE`,
`ssapp-emote-sanitizer-TqUYSF`, and `ssapp-script-recovery-mtf0ws` (live assets).
Recovered graph screenshot: `ssapp-script-recovery-znwOmQ/recovered-editor.png`.

These are local changes in ssapp and the primary social_stream checkout; no
release or remote deployment was performed. The earlier validation below is
historical and describes the superseded partial-outage fallback behavior.

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
