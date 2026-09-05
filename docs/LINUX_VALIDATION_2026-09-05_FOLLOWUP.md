# Linux review follow-up — SSApp 0.4.23

This follows the [0.4.22 review](LINUX_VALIDATION_2026-09-05.md). It targets MCP transport
failures and gaps between source testing and the Linux artifact users install. Validation
ran on Ubuntu 24.04.3 x86-64 with Electron 43.2.0 and isolated temporary profiles.

## Confirmed issues

### Interrupted MCP replies never settled

The adapter handled HTTP request errors but did not handle errors from the HTTP response
stream. A connection lost after headers and part of the response body left the tool call
unanswered while the client kept stdin open.

Reproduced by forwarding a real running SSApp status response through a loopback proxy and
interrupting its body. The fix handles response errors through the existing error normalizer.
The same adapter now returns `SSAPP_UNREACHABLE` and successfully handles a subsequent status
request after the connection recovers. A failed mutation response still does not establish
whether the operation took effect; clients must inspect state before retrying.

### Screenshot replies were truncated when stdin closed

The adapter called `process.exit(0)` immediately when its last request finished after stdin
EOF. Pipe output is asynchronous, so a large screenshot could be cut off while the process
still reported success.

Reproduced with a real SSApp window displaying a local high-detail canvas, the real screenshot
command, and a client that delayed reading stdout after closing stdin. The old adapter
returned incomplete JSON. It now drains stdout before exiting; the complete multi-megabyte
PNG response parses correctly and the adapter exits successfully.

Both fixes are MCP 1.2.2 / minimum SSApp 0.4.23. API 1.3.1 and the tool schemas are unchanged.
The primary Social Stream control skill and its version log were updated in the same work.

### Linux artifacts could be uploaded without running them

Neither Linux build workflow had a packaged-app functional gate. This is the gap that let
the speech-packaging issue in the first review escape source-only checks.

Both workflows now run `npm run test:linux-package -- /path/to/app.AppImage` before artifact
upload. The script extracts the artifact into a temporary installation, exercises its real
executable and MCP adapter, and removes the installation afterward. It does not require FUSE
or a neighboring Social Stream checkout. Tests cover:

- offline/display-free MCP discovery;
- visible setup, settings persistence, headless restart and display-loss shutdown;
- MCP source control, API opt-in and restart persistence;
- interrupted response recovery and complete screenshot output after stdin EOF;
- keyboard navigation, accessibility labels, 14 language options and reload persistence;
- packaged local speech generation and reuse of the loaded model.

### Publish workflow targeted the wrong repository

The publish job used `GH_REPO: ${{ github.repository }}` and allowed tag/developer lanes to
create releases in this repository, contrary to `RELEASE.md`. Its job condition now permits
publishing only in `steveseguin/social_stream`. Other jobs use read-only contents permissions;
write permission is confined to that guarded publish job. `ssn_app` can still produce
downloadable workflow artifacts. No tags or releases were created to validate this guard.

## Results

| Check | Result |
| --- | --- |
| New transport regression against source Electron | Passed |
| New transport regression against actual AppImage executable and adapter | Passed |
| Full extracted-package gate with ordinary local sandbox settings | Passed |
| Full gate with the CI-only sandbox override | Passed |
| MCP control using both the packaged app and packaged adapter | Passed |
| MCP window capture, semantic interaction, JavaScript prompts and Electron dialogs | Passed in the running app |
| Linux AppImage build after updating the local Social Stream bundle | Passed |
| Full npm audit and runtime-only audit | Zero findings |
| Translation coverage and workflow structure checks | Passed as supporting sanity checks |

The exact package-gate command was executed locally. The updated GitHub-hosted workflows have
not yet run, so this report does not claim a remote CI pass. Workflow parsing and guard checks
are supporting checks, not substitutes for the functional app tests above.

## Remaining work

- Adopt a cross-platform dependency lockfile policy to make installations reproducible.
  The ignored lockfile policy was not changed in this review.
- Validate the workflows on GitHub after these changes are pushed. The publishing guard
  intentionally disables repository-local developer releases as required by `RELEASE.md`.
- The physical-desktop, ARM/AUR, authenticated-platform and live TikTok-signer limitations
  from the first review remain. This pass does not expand those coverage claims.
- The new transport fixes were functionally tested on Linux; Windows/macOS validation remains.

The local review AppImage and logs are saved in
`/home/ubuntu/code/ssapp-linux-validation-20260905-pass2/`. This is an unpublished review build.
