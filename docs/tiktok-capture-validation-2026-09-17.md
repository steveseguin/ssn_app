# TikTok capture validation — September 17, 2026

Two failure mechanisms were reproduced in running SSApp, and their local fixes
passed the same scenarios. A third connector compatibility problem was reproduced
in a controlled library diagnostic and remains unresolved.

These results establish app defects, not the exact cause of Karla's or Lucky
Looter's live-session failures. Their app versions, logs and Mac runtime were not
available. No actual TikTok account was used or messaged.

## Environment and scope

- Windows x64; checkout app version 0.4.29; installed Electron 43.2.0;
  `tiktok-live-connector` 2.4.3. This was not a packaged release/M1 test.
- Real Electron app, renderer controls, IPC and Social Stream background/relay.
  Each app run used an isolated temporary profile and loopback fixtures.
- Standard capture loaded the real `social_stream/sources/tiktok.js` script through
  SSApp's source-window injection path. The original version came from that repo's
  HEAD into a separate temporary file; production files were not reverted.
- WebSocket validation used the installed connector and real protobuf frames.
  Only remote TikTok room/signing bootstrap was replaced in the isolated process.
  The original disconnect event subscription was reconstructed on that fixture
  connection; the second phase used the current handler without modification.
- No app-wide flags, session/security settings or unrelated source behavior were
  changed by this validation work. CPU affinity was capped at eight logical CPUs
  on a 32-logical-CPU machine, with Node's worker pool capped at two.

## Standard capture: page updates continue but SSN misses them

The fixture reused an existing chat row and updated its text 90 times over at least
135 seconds: 45 replacements using `textContent` and 45 in-place `nodeValue`
updates. Each step verified that the source page contained the new text, counted
source-script messages and counted deliveries through the app's local relay.

| Script | Page updates | Source messages | Destination messages |
| --- | ---: | ---: | ---: |
| Original HEAD | 90 | 0 | 0 |
| Locally patched | 90 | 90 | 90 |

A subsequently appended new row was delivered in both runs. This separates missed
DOM changes from an unavailable downstream connection. The existing reconnect
replay/batch checks also passed. Existing identical-text filtering was unchanged.

The fix recognizes added text nodes and observes in-place text mutations inside
the TikTok chat subtree. This matches the reported symptom as a failure mechanism;
we have not established that these particular users' TikTok pages used that update
pattern. The fixture is not evidence about TikTok's current live DOM layout.

Reproduction:

```powershell
# Export the pre-fix sources/tiktok.js to a separate temporary file first.
node tests/electron/tiktok-dom-replay-e2e.js --source-file=C:\path\to\original\tiktok.js --expect-text-loss --text-updates=45
node tests/electron/tiktok-dom-replay-e2e.js --text-updates=45
```

## WebSocket capture: dropped socket remains shown as active

`tests/electron/tiktok-disconnect-validation-e2e.js` starts capture through the real
renderer activation flow and confirms a protobuf chat reaches the destination.

- Original subscription: after the fixture server closes the socket, no retry is
  scheduled; after 12 seconds the underlying connector is disconnected while the
  UI still reports `active`. The test does not claim that it never recovers after
  every possible timeout.
- Manual Stop/Start restores delivery, matching the reported temporary recovery.
- Patched subscription: two repeated server disconnects automatically reconnect
  using the app's normal retry timing; chat reaches the destination after each.
- Manual Stop then remains stopped through an additional six-second observation.

The installed connector emits `disconnected`, whereas SSApp previously subscribed
to `disconnect`. SSApp's separate Euler proxy adapter does emit `disconnect`; the
fix keeps that adapter's event unchanged. The existing auto-mode regression suite
also checked proxy recovery.

```powershell
node tests/electron/tiktok-disconnect-validation-e2e.js
```

## Extended A/B soak: 30 minutes

`tests/electron/tiktok-capture-soak-e2e.js --minutes=30` completed with exit code 0
and outcome `PASS`. One isolated SSApp instance ran four real sources together:
original/patched Standard scripts and original/patched connector subscriptions.
The timed stream lasted 1,800 seconds, followed by a three-second final drain.
Setup began September 17 at 23:34:31 UTC; results finished September 18 at
00:04:51 UTC (still September 17 locally).

Full evidence: [JSON report](../test-results/tiktok-soak-1789688071945.json) and
[30-second samples](../test-results/tiktok-soak-1789688071945.jsonl). These runtime
artifacts are retained locally under the git-ignored `test-results` directory.

### Standard capture

Each source generated five messages per second. The first 300 appended rows;
the remaining 8,700 reused those rows, alternating `textContent` replacement and
in-place `nodeValue` changes. Selected same-content rerenders checked duplicates.
Six additional newly appended control rows checked downstream connectivity.

| Script | Generated messages | Captured/delivered | Missed updates | Controls delivered |
| --- | ---: | ---: | ---: | ---: |
| Original HEAD | 9,000 | 300 | 8,700 | 6/6 |
| Patched | 9,000 | 9,000 | 0 | 6/6 |

There were zero duplicate Standard messages. All six controls reaching the
destination on the original source show that its downstream path still worked
while reused-row updates were missed. The separately named event companion rows
described below are excluded from these counters.

The number 300 is where this fixture switches update patterns. It is not evidence
of a universal TikTok message limit: the earlier replay test already delivered
620 newly appended rows with the original script.

Script SHA-256 values used in this run:

- Original: `626852036b62f1f8e353147efa6b6fa623805492ad610804a2894282d27ab796`
- Patched: `6ba6776c31e5da06136291f0e9141c8712ef563f870ecd02e5bc919e9031f77e`

### Socket disconnects

Both fixture sockets were closed at minutes 6, 15 and 24. At each one-minute
observation, the original connector remained disconnected with no retry timer;
the patched connector was connected again. Only the original source was then
manually stopped/restarted so the next comparison could run.

| Subscription | Automatic recoveries | Chat sent on open sockets | Chat delivered | Missing/duplicates |
| --- | ---: | ---: | ---: | ---: |
| Original | 0/3 within 60 seconds | 7,334 | 7,334 | 0/0 |
| Patched | 3/3 | 8,164 | 8,164 | 0/0 |

The original's smaller total reflects its offline periods. The delivery check
counts frames actually sent on open sockets; it does not claim that messages
occurring while disconnected can be recovered. Both sources ended with four
connections: three manual recoveries for the original versus three automatic
recoveries for the patch. Individual likes also continued to arrive, totaling
1,591 on the original source and 1,757 on the patched source.

### Events continue while socket chat stops

For 126 seconds, the fixture deliberately withheld chat while continuing likes.
Both sources remained connected without reconnecting, and each delivered another
124 like events. Both resumed chat when the fixture sent chat again, without loss
of the frames actually supplied.

This demonstrates the symptom when upstream chat is absent. It does not reproduce
an unexplained selective loss of incoming chat inside SSApp. Raw frames and other
events update the existing health-check activity timestamp, so continued likes
do not trigger its inactivity timeout. Neither patch fixes selective upstream
chat absence. Identifying the affected users' cause requires comparing actual
incoming chat frames with the live page when their failure occurs.

### Limits and unsuccessful attempts

- The successful run used real Windows SSApp source windows and the installed
  connector, with local fixture data. It did not test a signed-in live TikTok
  session, macOS/M1, remote signer renewal or the 90-minute proactive refresh.
- A four-minute pilot first passed the before/after checks with 1,200 Standard
  messages per source (`test-results/tiktok-soak-1789687736296.json`).
- One attempted 30-minute run crashed the main Electron renderer during setup,
  before the timed stream. Its report is
  `test-results/tiktok-soak-1789688008226.json`; the renderer reported
  `render-process-gone:crashed`, exit code `-1073741819`. Cleanup also encountered
  a locked temporary profile. The isolated leftover process was stopped; the
  subsequent full run used the same runtime settings and exited cleanly. The
  startup crash was not diagnosed or fixed by these TikTok changes.
- The final diff was reviewed: production changes are confined to TikTok's
  mutation handling and connector disconnect subscription. Euler's separate
  `disconnect` event remains unchanged. Existing unrelated edits were preserved.

Reproduction (Windows resource cap used for this run):

```powershell
$env:UV_THREADPOOL_SIZE = '2'
[System.Diagnostics.Process]::GetCurrentProcess().ProcessorAffinity = [IntPtr]255
node tests/electron/tiktok-capture-soak-e2e.js --minutes=30
```

After committing the fix, the harness defaults to the pre-fix Social Stream
revision `1267e184` instead of the moving `HEAD`. Use `--baseline-ref=REVISION`
to select a different original script; that revision must exist in the local
Social Stream checkout. The source hashes above identify the scripts used for
the completed run.

## Standard mode: likes and follows

The follow-up clarification was that TikTok likes were missing; YouTube capture
was working. No YouTube behavior was changed or diagnosed.

The optional `tests/electron/tiktok-standard-events-validation.js` companion
attached to the isolated running soak and added separately identified event rows
to its two Standard source windows. Each original/patched script delivered:

- 10 of 10 rendered like events, classified as `liked`.
- 10 of 10 rendered follow events, classified as `followed`.
- 10 of 10 ordinary comments containing the word "like", with no event category.
- No duplicates in these 60 deliveries.

Artifact: `test-results/standard-event-probe-1789688325333.json`.

The isolated profile had `capturelikeevent` enabled. The current UI label is
"Show individual likes in main chat/events." `background.js` sends like events
to the Reactions Overlay independently, but suppresses their normal chat output
when this setting is off (and suppresses events when `hideevents` is on). An early
soak pilot omitted the like setting and received zero likes at its chat-output
collector; that pilot was corrected, not treated as a product defect.

This confirms support for the tested rendered markup. It does not establish
that a live TikTok page renders every like, follow or gift, or that all current
TikTok layouts match the fixture. Gifts, total-like counters and live-event
completeness were not validated in this companion test.

```powershell
# Use the profile/relay port belonging to an active isolated capture soak.
node tests/electron/tiktok-standard-events-validation.js --profile=C:\path\to\Temp\ssapp-tiktok-soak-ID --relay-port=PORT
```

## Unresolved: Local Signer and saved-session configuration

`tests/tiktok/connector-compatibility-diagnostics.js` exercises the installed
connector's unmodified `connect`/`_connect` path, intercepting the default provider
route before any network request. It uses dummy credentials only.

- SSApp's manager contains session credentials, but the connector's cookie session
  bundle is empty after construction and after the signer-credential update.
- A positive control using the connector's current `session.cookie` shape accepts
  the same dummy credentials.
- With Local Signer selected, the local signer is called zero times and the
  default provider route is called once. The older `signedWebSocketProvider`
  option supplied by SSApp is not used by this installed version.

This is a reproducible compatibility defect, not a validated live-login failure
or proof that authentication would deliver every missing message. The diagnostic
is intentionally an assertion of the current defect and must be updated when the
compatibility repair is implemented. It is not a passing functional app test.

```powershell
node tests/tiktok/connector-compatibility-diagnostics.js
```

Next work: repair the connector integration, then verify a signed-in live session
on the affected Mac/build. No changes were published as part of validation.
