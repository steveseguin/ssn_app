# Named User Session settings migration

The older app saved Social Stream settings in shared `savedSync.json` and global
electron-store backups. Named User Sessions now use separate files and backup
keys. The missing migration can leave an existing session with its correct room
ID but only a source-list compatibility object (`urls`, `groups`, and empty bot
command arrays) in place of its API, AI, TTS, and other Social Stream settings.
If a complete localStorage mirror survives, the old recovery path can sometimes
avoid the loss. The reproduced failure uses an API-only session with no sources.

## Scope and safeguards

- Recovery runs in the local main app page before source-list initialization. It
  cannot be requested by a source window or child frame.
- The Default Session is excluded. Newly created sessions are marked ineligible.
- Any actual setting in the session's saved state or backups blocks recovery,
  including an explicitly false setting. Intentionally empty settings without
  the reproduced source-list placeholder are left alone.
- Recovery uses the session partition's own localStorage settings when available.
  Otherwise, the legacy shared file must match the partition's saved room ID and
  password. Conflicting identities or missing evidence are left untouched.
- Pending imports take precedence. Only the chat settings object is recovered;
  the session's existing identity, app on/off state, and other saved fields win.
- The old shared file is read only. A separate copy of the target's original
  files and backup values is saved before recovery. It is never overwritten.
- The migration is recorded once. Later user changes, including turning the API
  off, are not undone. Interrupted writes can retry using the original backup.
- Deleting a session or clearing its persistence also removes its recovery backup
  and migration marker. No runtime flags, source request hooks, or permissions
  change. Recovery needs no dialog, forced reload, or app restart.

This is deliberately conservative: partial configurations containing real user
preferences and cases without a matching identity need an explicit settings
restore instead of an automatic merge.

## Functional verification

`legacy-user-session-upgrade-e2e.cjs` launches the published v0.3.113 and v0.4.21
app archives using their respective Electron runtimes, then the current checkout
using the locally installed Electron 43.2.0 runtime. Profiles and rooms are
isolated. Static HTTPS assets are supplied from the sibling source checkout while
preserving the app's normal page origins, partitions, and preload configuration.
The repeatable test replaces only the upstream API/Dock endpoint in the served
background script with an isolated loopback WebSocket fixture. The app still
opens its real connection and processes API ingestion; this test does not verify
the public HTTP gateway. External DNS and other production requests are blocked.
No customer room, account, paid AI provider, or live source is used.

The test covers direct upgrades, already-broken upgrades, restarts, user changes
through the actual settings checkbox, mismatched rooms/passwords, existing newer
settings, intentional empty settings, backup/write failures, default and fresh
sessions, profile/cookie/source-state preservation, and recovery-backup deletion.
The separate existing `session-isolation-e2e.js` exercises session switching,
imports, deletion/recreation, and exact partition cleanup in running Electron.

Verified on Windows on 2026-09-09: all 18 upgrade/recovery cases passed, as did
the existing session-isolation/import/deletion test. Full migration evidence is
in `C:/Users/steve/AppData/Local/Temp/ssapp-session-migration-e2e-wdRpzl/report.json`.

Reverified all 18 upgrade/recovery cases on 2026-09-10 with the isolated relay
fixture and external requests blocked. Evidence:
`C:/Users/steve/AppData/Local/Temp/ssapp-session-migration-e2e-Dszl4x/report.json`.

Run with:

```powershell
node tests/electron/legacy-user-session-upgrade-e2e.cjs
node tests/electron/session-isolation-e2e.js
```

The upgrade test expects `.codex-tmp/api-repro/vVERSION/app/resources/app.asar`
and `.codex-tmp/api-repro/vVERSION/runtime/socialstream.exe` for 0.3.113 and
0.4.21. Set `SSAPP_LEGACY_UPGRADE_ARTIFACTS` to use another artifact directory.
The runtime directory needs Electron's default-app launcher for the external
diagnostic bootstrap; the published app archive itself remains unmodified.

This does not test the Windows installer, portable self-extractor, other OS
runtimes, audible TTS, or the customer's actual AI credentials. No release or
deployment is included.
