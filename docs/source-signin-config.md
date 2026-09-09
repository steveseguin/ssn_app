# Per-source sign-in Origin rules

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
