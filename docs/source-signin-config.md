# Per-source sign-in configuration

## Self-hosted servers and HTTP Basic Authentication

Owncast uses these settings in all three Social Stream `settings/config*.json` files:

```json
{
  "owncast": {
    "httpBasicAuth": true,
    "signin": { "useSourceUrl": true }
  }
}
```

`signin.useSourceUrl` makes the existing Sign-in button open the source's full HTTP(S)
URL, preserving its subdomain, port, path, and query. An explicit `signin.url` still
takes precedence. URLs containing embedded usernames/passwords are rejected by this
sign-in path; enter credentials in the server sign-in dialog instead.

`httpBasicAuth` handles HTTP Basic challenges in that source's Standard capture and
Sign-in windows. It is read only from the explicit platform configuration, not global
defaults. It is currently enabled only for Owncast. The dialog shows the server and
realm, supports retry and cancellation, and remains accessible when capture is hidden.
Stopping the source or navigating away cancels its pending authentication request.

The handler accepts challenges only from the original source origin (protocol, host,
and port); it does not handle proxy authentication, other schemes, other origins, or
WebSocket connector windows. No Authorization request hook or session mapping changes
are made. Chromium reuses successful HTTP authentication within the existing browser
session; credentials are not saved in source settings or passed through the general
chat/control IPC. Expect to sign in again after restarting the app. Unattended headless
mode cancels challenges and logs that interactive sign-in is required.

This requires the updated SSApp runtime as well as the source configuration; a beta
source update alone cannot add the authentication dialog to an older desktop build.

Run `node tests/electron/owncast-auth-e2e.js` for real SSApp workflow checks against
loopback HTTP challenges and Owncast-shaped chat fixtures. Set `OWNCAST_TEST_URL` to
the URL of a local Owncast 0.3 server to also check its actual production chat page
behind a temporary Basic Auth reverse proxy. This optional server must use HTTP on
localhost/127.0.0.1; the test never uses public channels. Windows verification does
not establish Fedora/Wayland behavior.

Set `OWNCAST_TEST_REPLY=1` as well when the local server has an active stream and
allows chat. That also checks a reply through SSApp's normal outgoing-message path.

Verified on Windows with SSApp 0.4.29 / Electron 43 and the official Owncast 0.3.0
Linux release running locally in WSL: full-address sign-in, rejected-password retry,
session reuse/isolation, distinct server ports, cancellation, source-stop cleanup,
excluded platforms/redirects, capture starting hidden, visible/hidden capture, hidden
reload, and outgoing replies. No capture-script or shared keepalive changes were
needed for those checks. Fedora/Wayland and macOS remain unverified.

## Per-source sign-in Origin rules

Set `signin.fillMissingOrigin` under **any source key** in Social Stream's
`settings/config_0.json`, `settings/config_linux_0.json`, and `settings/config_mac_0.json`.
The source key must match the source's `target`. VK is the first configured source;
there are no VK-specific platform or domain checks in the implementation.

```json
{
  "vkvideo": {
    "signin": {
      "fillMissingOrigin": {
        "pageOrigins": ["https://id.vk.ru", "https://id.vk.com"],
        "requestOrigins": ["https://login.vk.ru", "https://login.vk.com"],
        "methods": ["POST"],
        "includePopups": true
      }
    }
  }
}
```

To enable another source, add this setting under its `signin` section with its own
origins and methods. Preserve its other settings. Update all three OS configs when
the workaround should apply on all OSes.

- `pageOrigins`: exact HTTPS origins of documents allowed to supply the header value.
- `requestOrigins`: exact HTTPS origins receiving the requests; any path on a listed
  origin matches. This list is independent of the page origins.
- `methods`: explicit uppercase HTTP methods, with no implicit default.
- `includePopups`: `true` extends the rule to child and descendant sign-in popups.
  Omitted or `false` limits it to the parent sign-in window.

The rule adds `Origin` only when absent (case-insensitive), using the actual requesting
frame's origin or the window URL when frame information is unavailable. Both origin
lists and the method must match. Existing headers, including `Origin: null`, are kept.
Existing explicit `origin`/`referrer` overrides retain their precedence; avoid combining
fixed overrides with this rule unless intended.

Origins cannot contain wildcards, credentials, paths other than `/`, queries, or fragments.
Ports are significant. Invalid/incomplete rules are ignored. Removing the setting or
setting it to `false` disables it for newly opened sign-in windows. Rules are not inherited
from `global`; capture windows and unrelated windows sharing the session are unaffected.
Tracking is removed when each window is destroyed.

Requires an SSApp build containing `resources/signin-origin-rule.js` and its window
integration. Older builds ignore the new setting. After that initial app update, future
rules can be changed through config without another app build. Restart SSApp to load
the updated config, then open a new sign-in window. Existing windows retain their original
rule. The app-wide `disable-web-security` flag is unchanged.

## Verification

Run `node tests/electron/vk-signin-e2e.js` for real SSApp/VK testing in an isolated profile.
It checks the global flag, login request Origin/response, phone form, popup session sharing,
and two popup openings. No credentials are submitted.

Set `SIGNIN_ORIGIN_TEST_SOURCE=origin-rule-test` to copy the rule to another source key
in memory and verify the same workflow. Set `SIGNIN_ORIGIN_TEST_DISABLED=1` to remove that
source's rule and verify the original missing-Origin failure remains. Repo config is not
changed by these test modes.

Run `node tests/signin-origin-rule.test.js` for supporting scope/validation checks.
These checks alone do not establish successful account authentication.
