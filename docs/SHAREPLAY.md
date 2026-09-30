# SharePlay desktop source

Select **SharePlay** in Add source, sign in, choose the saved account, and add it.
Activate the source to capture the signed-in account's own channel. Setup also
lets you sign in again or forget the saved sign-in.

## Current status — September 29, 2026

The production public client `social_stream_ninja_prod_5f96ea` now works and
is SSApp's default. Live system-browser sign-in as evarate completed with no
client secret through `http://127.0.0.1:8181/sources/websocket/shareplay.html`.
The token exchange and
account lookup returned 200, all three EventSub subscriptions returned 201,
and sandbox chat, Blitz and viewer updates reached SSN's background capture.
Secret-free renewal rotated both tokens successfully.

Chrome displayed `ERR_BLOCKED_BY_CLIENT` on the final callback result page
after SSApp completed sign-in. That browser attempt was stopped; the app's
successful API and capture results were verified separately.

The live Test-client integration also works against SharePlay EventSub.
SSApp refreshed the saved evarate login, received `session_welcome`, and
created `chat.message`, `channel.blitz` and `stream.viewers` subscriptions
with HTTP 201. SharePlay's sandbox emitted all three topics over the real
WebSocket and they reached the SSN background as chat with an emote, a Blitz
raid and a viewer update. A further chat event arrived after token renewal
and reconnection. Keepalives were also observed. These were server-generated
synthetic events; ordinary viewer chat has not yet been observed through the API.

MAJ3STIC supplied the deployment update and protocol changes on September 29:

- WebSocket: `wss://events.shareplay.tv/eventsub/ws`.
- Subscription REST service: `https://events.shareplay.tv/eventsub/subscriptions`.
- Every proof accompanying an access token includes
  `ath = base64url(SHA-256(access_token))`; token exchange/refresh proofs omit it.
- Authorization remains `Bearer` plus a fresh DPoP proof.
- Public clients now accept HTTP numeric-loopback callbacks. SSApp uses
  `http://127.0.0.1:8181/sources/websocket/shareplay.html`, falling back to 8080,
  for both the Test client and public clients.

The Electron fixture passed the new proof requirement, separate OAuth/events
services, both callback ports for public and Test clients, and a 503 refresh
failure followed by recovery with the same refresh token and a fresh proof.
The existing reconnect path already preserves credentials for that failure.
The app uses native WebSocket headers, so the new browser ticket endpoint is
not needed for this desktop source.

The updated [EventSub guide](https://www.shareplay.tv/developers/oauth/guides/eventsub)
and [public-client guide](https://www.shareplay.tv/developers/oauth/guides/public-clients)
were reopened in signed-in Chrome. They now document the events REST host,
`ath`, Bearer plus DPoP, and HTTP numeric-loopback callbacks on any port with
the registered path. The portal shows the production client Active and
Verified, with `http://127.0.0.1/sources/websocket/shareplay.html` registered.
Ordinary viewer chat and authorization by a non-developer account remain
unverified. Earlier failures below are retained as investigation history.

## Current local Test setup

For Test-client verification, select `social_stream_ninja_test_bf18ab` under
**Developer setup**, enter its **Test client secret**, then sign in. The secret
is sent only in the token exchange and
refresh requests, saved using Electron safeStorage, and omitted from source
configuration and the account metadata returned to the renderer. The input
clears when sign-in starts or the dialog closes.

This Test client returns directly from the system browser to
`http://127.0.0.1:8181/sources/websocket/shareplay.html`, falling back to port
8080 if 8181 is busy. Both explicit URLs are registered. No hosted return page
or local HTTPS certificate is used for this client. The supplied secret is
local account configuration, not bundled application code.

The real Electron fixture has passed both HTTP callback ports, encrypted secret
storage, token renewal before and after app restart, and the capture checks
below.

## Live Test results — September 27, 2026

Live verification with evarate and the Test client's secret succeeded through
the HTTP 8181 callback, code exchange (`POST /oauth/token`, 200), and account
lookup (`GET /api/v1/me`, 200). Both access and refresh tokens rotated
successfully. After closing and restarting the real app, the account was
restored and token renewal plus account lookup succeeded again without a new
browser sign-in. The saved secret and tokens were checked to be encrypted.

Chrome displayed `ERR_BLOCKED_BY_CLIENT` on the final callback result page
after the local server had returned 200 and SSApp had completed sign-in. That
browser attempt was stopped. This did not prevent the saved account or the
subsequent main-process API checks.

Live capture is still blocked. The real source and a focused handshake check
both received HTTP 404 with an empty body from
`wss://events.shareplay.tv/eventsub/ws`. The EventSub guide still documents that
exact URL and `Authorization: Bearer` plus a DPoP proof. No welcome message or
subscription was obtained. The documented relative subscription-list path
returned 405 (`Method Not Allowed`) on `https://api.shareplay.tv/eventsub/subscriptions`;
the guide does not explicitly specify the REST host. Checking the events host
at `https://events.shareplay.tv/eventsub/subscriptions` returned an empty 404.

These results were current at 11:35 PM Eastern. SharePlay needs to confirm the
working EventSub WebSocket and REST addresses and whether these are available
to this Test client. Live chat, Blitz, viewer events and synthetic event
delivery remain unverified; their local fixture checks passed.

## Live transport investigation — September 28, 2026

Observed the live Smaw_D channel in signed-in Chrome around 9:35 AM Eastern.
The website opened `wss://events.shareplay.tv/main` and
`wss://chat.shareplay.tv/`, both with HTTP 101 upgrades. Chat received room
configuration and repeated viewer, like and interaction updates. Its history
response was an empty array, and no viewer chat message appeared during the
observation. These site protocols differ from the documented EventSub
`session_welcome` / notification protocol. Their OAuth-client compatibility is
not established by the website's successful connection.

Using the saved Test account in the running SSApp, token renewal and
`GET /api/v1/me` succeeded. The granted scopes remain
`openid profile chat:read events:read`. One documented
`POST /api/v1/me/eventsub/test` request for `chat.message` returned HTTP 200
with `is_synthetic: true` and the documented chat fields. This confirms the
test-event REST route and this client's chat scope work; it does not establish
WebSocket delivery. The route creates no public chat message or on-stream
alert, per the EventSub guide.

Fresh authenticated upgrades to `wss://events.shareplay.tv/eventsub/ws` still
returned empty HTTP 404 responses with either documented DPoP `htu` scheme
(`wss` or `https`). A connection to the website's observed `/main` URL from
the same Electron process returned 101 and was immediately closed, without
authenticating or subscribing. This narrows the failure to the developer
EventSub route rather than general access to the events host. A route or
deployment mismatch is an inference; SharePlay has not confirmed its cause.

The EventSub, Public Clients and Partner API guides were rechecked. They still
give the same EventSub address, Bearer plus DPoP headers and own-channel-only
subscriptions. No alternative OAuth chat-reading transport was found in these
guides. The working first-party website sockets are not documented there as
OAuth endpoints. The outstanding requirement is a working EventSub upgrade
and a confirmed subscription REST host; SSApp cannot yet receive live API chat.

### Direct tests of the observed website endpoints

At Steve's request, tested both observed sockets from the running SSApp with
the saved Test client's valid OAuth token and a fresh DPoP proof. `/api/v1/me`
confirmed the token still belongs to evarate before the tests.

- `wss://events.shareplay.tv/main` upgraded with 101 but sent only a connection
  identifier, not an EventSub welcome. Sending the website's observed `auth`
  message format with the OAuth token returned
  `{"type":"auth_failed","body":"invalid_token"}`. The connection was closed;
  no subscriptions were attempted after that refusal.
- `wss://chat.shareplay.tv/` returned 426 with plain-text `Upgrade Required`
  before authentication or any frames. Chrome still upgraded this same URL
  with 101. Its observed handshake uses WebSocket version 13, a SharePlay
  Origin header and no subprotocol. The native handshake failure's exact
  cause remains unknown, and this test did not establish OAuth compatibility.

These observations do not support replacing the EventSub URL with the
website's `/main` endpoint. The native tests used SSApp's OAuth token; browser
session credentials were not copied into the app.

### Full documentation recheck and final connection check

On September 28, reread all 16 pages exposed by evarate's documentation index:
the overview, Getting Started, Authorization Code Flow, PKCE, Refresh Token
Rotation, Scopes, Scope Grant Policy, DPoP, Public Clients, Partner API,
EventSub, Alerts & Overlays, Endpoints, Error Codes, JWT Claims and Rate Limits.
The guides still specify Bearer plus DPoP, the same EventSub WebSocket URL,
and own-channel subscriptions. No additional EventSub provisioning flag,
Test-client exclusion, alternative OAuth chat-reading transport or explicit
subscription REST base URL was found. Their omission does not prove that no
server-side access requirement exists.

At 13:56 UTC, `POST /oauth/introspect` returned `active: true`, the matching
Test client/account, and `openid profile chat:read events:read`. It did not
expose a `cnf` binding; that omission does not establish whether the token is
DPoP-bound. Current OIDC discovery still advertises only `client_secret_post`
and `client_secret_basic`, whereas the Endpoints reference's example also
lists `none`. No EventSub endpoint is advertised in discovery.

The final check at 13:58 UTC again received an empty 404 on the documented
WebSocket, with no `WWW-Authenticate` header. The API-host subscription GET
returned 405, `{"error":"Method Not Allowed"}`, and `Allow: OPTIONS`; the
events-host subscription GET returned an empty 404. No documented correction
to the connection request was identified. SharePlay needs to confirm the
working EventSub WebSocket and subscription REST base, and whether this Test
client needs additional server-side enablement.

## Production callback

SharePlay authorization opens in the system browser and returns directly to
SSApp's HTTP listener on 127.0.0.1, using port 8181 or 8080. The app checks the
returned state and exchanges the code with its original PKCE verifier and
DPoP key. A public client omits the client secret. The production registration
and live sign-in on port 8181 were verified on September 29. Port 8080 also
passed the real-app local fixture; it has not been used in live production consent.

## Earlier hosted callback workaround

SharePlay offers Google and Discord sign-in. Authorization therefore opens in
the system browser. The previous implementation used an HTTPS page on the SSN
site to pass the code and state to SSApp's HTTP listener on 127.0.0.1. The
current implementation uses the direct loopback callback described above.

The `social_stream/shareplay-callback.html` page is published from `beta` and
was verified in Chrome at `https://socialstream.ninja/beta/shareplay-callback.html`
on September 27, 2026. These exact URLs
were saved successfully on Production client `social_stream_ninja_prod_5f96ea`
at 10:24:20 PM on September 27, 2026; it remains Active and Verified:

- `https://socialstream.ninja/beta/shareplay-callback.html?port=8181`
- `https://socialstream.ninja/beta/shareplay-callback.html?port=8080`

The page accepts only those two return ports and the fixed numeric-loopback
path `/sources/websocket/shareplay.html`. It removes the OAuth query from its
address and sends no referrer. Tokens, the PKCE verifier and the DPoP key stay
in the app; the page only forwards the authorization response. It needs no
local certificate or embedded provider sign-in.

## Earlier production authorization blocker

At 10:46:55 PM on September 27, 2026, the real SSApp production sign-in opened
Chrome with client `social_stream_ninja_prod_5f96ea` and redirect URI
`https://socialstream.ninja/beta/shareplay-callback.html?port=8181`.
SharePlay rejected authorization with `invalid_request` and
`redirect_uri not registered for this client`. No consent screen, loopback
request or token exchange occurred. The pending local listener was canceled.

A fresh portal read still showed that exact URL registered on the Active,
Verified production client. Its audit log records `authorize / rejected` and
`redirect_uri_manipulation / detection` at the same time; it also records the
successful redirect update at 10:24:20 PM. The portal and authorization
endpoint disagree. The public-client guide explicitly allows HTTPS redirects.
SharePlay needs to explain or reconcile the registration used by authorization.
The client's public authentication and live EventSub capture remain unverified.

A subsequent retry tested whether the redirect's query parameter caused this
rejection. The portal now also lists
`https://socialstream.ninja/beta/shareplay-callback.html` without a query
(last updated 10:53:54 PM). Authorization rejected both the original
`?port=8181` URI and that exact query-free URI with the same
`redirect_uri not registered for this client` error. Removing the query did
not resolve the rejection. No callback or token exchange occurred.

The callback deployment passed both the repository publication workflow and
GitHub Pages deployment. The event-reference additions also passed translation
generation and validation for all 16 published languages.

## Additional production registration

At Steve's request, a new production registration was created at 11:05:56 PM
on September 27, 2026: **Social Stream Ninja Desktop**, client ID
`social_stream_ninja_desktop_prod_8323f6`, with redirect
`https://127.0.0.1/sources/websocket/shareplay.html` and the four requested scopes.
The creation form rejected the HTTP version with `Must be HTTPS`, but accepted
HTTPS. The new client is Active and Domain unverified. Its authorization
endpoint returns `unauthorized_client` / `domain_not_verified`, before consent
or any callback. The portal requests DNS verification of the redirect domain.
This does not establish whether redirect matching or public-client token
authentication would succeed after verification.

## Client registration and earlier verification

SharePlay staff provisioned **Social Stream Ninja** as a **public desktop
OAuth client**; the live verification above confirms it works. The developer
portal creates confidential clients and cannot create this client type.
Developer access alone does not supply a client ID.
See SharePlay's [public-client guide](https://www.shareplay.tv/developers/oauth/guides/public-clients).

The fulfilled registration request was:

- A public client ID with S256 PKCE and ES256 DPoP enabled.
- The public-client registration
  `http://127.0.0.1/sources/websocket/shareplay.html`, permitting any loopback
  port. SSApp uses 8181, falling back to 8080 when 8181 is busy.
- Explicit grants for `openid profile chat:read events:read`. These are Standard
  scopes but still require provisioning on the developer account and client;
  see the [scope grant policy](https://www.shareplay.tv/developers/oauth/guides/scope-grant-policy).

**Developer setup** can select the Production client
`social_stream_ninja_prod_5f96ea` or another public client; those use the direct
HTTP loopback callback and omit client authentication secrets. Development deployments
can set `SSAPP_SHAREPLAY_CLIENT_ID`. The client ID is public configuration.

The active Test registration under evarate has client ID
`social_stream_ninja_test_bf18ab`. The portal offered no public-client selector
and issued a client secret. Steve subsequently registered explicit HTTP and
HTTPS callbacks on ports 8080 and 8181, alongside the portless HTTP callback,
and supplied a wider scope allowlist. SSApp requests only the four scopes above.

Live verification on September 27, 2026 used the real SSApp sign-in flow and
Chrome's existing evarate session. With only the portless redirect registered,
authorization rejected the 8181 callback as `redirect_uri not registered for
this client`. After the explicit HTTP 8181 callback was added, authorization
reached consent and the callback reached SSApp. The secret-free token exchange
then failed with `client authentication failed`; no account or tokens were
saved. SharePlay staff need to confirm or enable public-client authentication
for this exact ID. Live capture remains unverified.

The test client's own portal audit log corroborates this attempt: at 9:47:14 PM
it records `authorize / code_issued` as successful, followed by `token / rejected`
and `oauth_token_client_auth_failure` as errors. This establishes a token-endpoint
client-authentication rejection independently of the browser result page. It
does not expose the client's public/confidential setting or the precise reason
authentication failed.

Chrome also displayed `ERR_BLOCKED_BY_CLIENT` on the callback result page,
after SSApp had received the authorization code and attempted token exchange.
That browser attempt was stopped. The public-client guide documents HTTP
numeric-loopback redirects as an exception to production HTTPS requirements;
the production exception has not been tested with this Test registration.

A subsequent portal review found a separate Production registration:
`social_stream_ninja_prod_5f96ea`, Active and Verified. Its audit log records
`client / partner_admin_provisioned` at 9:30:29 PM, whereas the Test client's
creation is `developer_client_created / create` at 9:31:12 PM. The production
client initially registered only:

- `https://127.0.0.1:8181/sources/websocket/shareplay.html`
- `https://127.0.0.1:8080/sources/websocket/shareplay.html`

These HTTPS registrations do not match SSApp's HTTP listener. Both clients allow
the four requested scopes. The detail and edit pages expose environment and
redirects, but no public/confidential selector or DPoP policy. Administrator
provisioning alone did not establish public-client authentication at that
time. The secret-free production exchange later succeeded on September 29.

With Steve's authorization, an attempt was made to add the matching HTTP
callbacks on 8181 and 8080 to the Production client. The portal rejected each
with `Invalid redirect URI: "http://127.0.0.1:{port}/sources/websocket/shareplay.html".
Must be HTTPS.` The edit was canceled. The hosted HTTPS callbacks were added
later as described above.

An app-window redirect capture was explored, but Steve ruled out relying on
embedded sign-in because external identity providers can reject Electron.
SharePlay's Connections page explicitly offers Google and Discord for sign-in.
The earlier implementation used the HTTPS hosted return page described above,
followed by an HTTP loopback navigation in the user's browser. The September 29
update uses direct HTTP loopback for public clients.

The Public Clients, DPoP, Endpoints, Getting Started, Authorization Code Flow,
PKCE, Error Codes, Scope Grant Policy and EventSub pages were rechecked against
the implementation. No discrepancy was found in the documented public-client
token request fields, form encoding, PKCE calculation or DPoP proof structure.
The public-client and getting-started guides explicitly permit HTTP numeric
loopback redirects in production; the portal's generic production form says
HTTPS is required. The error reference distinguishes client authentication
errors from PKCE and DPoP errors. None of these pages explains Chrome's
`ERR_BLOCKED_BY_CLIENT` result.

MAJ3STIC confirmed that ordinary users can authorize SSN without their own
developer provisioning. This has not yet been tested with a non-developer
account. His earlier instruction to send `Authorization: DPoP` was superseded
by the September 29 deployment message and current guides: use
`Authorization: Bearer` plus a separate `DPoP` proof header. This combination
passed live checks with the production public client.

## Capture and connection behavior

The main process connects directly to SharePlay's
[EventSub WebSocket](https://www.shareplay.tv/developers/oauth/guides/eventsub)
and subscribes to `chat.message`, `channel.blitz`, and `stream.viewers`. It sends
messages through SSApp's existing native-source/background path.

- Chat includes names, emotes, and shoutouts. Replies include parent context
  when that parent was received during this app session (a 200-message cache).
  The documented chat event does not supply avatars or badges.
- Completed Blitz events become `raid`; initiated Blitz events are ignored.
- Viewer updates require Show viewer count or hype mode. SharePlay documents
  these as updates once a minute when the count changes.
- Without granted `events:read`, capture subscribes only to chat.
- Reconnect creates fresh subscriptions. SharePlay does not replay missed
  messages. Duplicate delivery IDs are suppressed within a 1,000-event cache.
- Tokens rotate before expiry, are persisted before reuse, and the socket
  reconnects with the new token. Authorization withdrawal requires another sign-in.
- Tokens and the persistent per-install DPoP private key are encrypted using
  Electron safeStorage. Source configuration stores an account reference.
  **Forget sign-in** removes local credentials; SharePlay connection settings
  control server-side revocation.

SharePlay documents three sockets per client/user and 300 subscriptions per
socket. This integration shares one socket per saved account, with at most
three subscriptions. It captures events; sending messages and moderation are
not implemented.

## Verification

Run from `ssn_app` with local Electron and Playwright installed:

```sh
node tests/electron/shareplay-native-e2e.js
```

The test starts the real app in an isolated profile against separate local
OAuth and EventSub services. A real browser window returns directly over HTTP
for both public and Test clients. It covers both callback ports, encrypted
client-secret storage, PKCE and DPoP signature/token-hash verification,
recovery from a 503 refresh response, token rotation before and after restart, message delivery into
the Social Stream background, rich and plain text, duplicates, reconnect,
UI reload, app restart, stop, and forgetting
credentials. It leaves logs and setup screenshots in the printed temporary
directory. Ports 8181 and 8080 must be available when the test starts.

Local fixture success is separate from live SharePlay validation. Live Test
sign-in, account lookup, token rotation and saved authentication after restart
passed. On September 29, live synthetic chat, Blitz and viewer events also
reached SSApp through EventSub, including chat after renewal and reconnect.
Production public-client consent, token rotation, subscriptions and all three
sandbox topics also passed on September 29. Ordinary viewer-chat capture and
non-developer account authorization remain unverified.
