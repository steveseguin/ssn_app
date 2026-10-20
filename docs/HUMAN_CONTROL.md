# Private sign-in through an SSApp viewer

[Read this guide in HTML](HUMAN_CONTROL.html)

Use the private viewer when an agent needs you to complete a sign-in inside SSApp,
including a browser window running hidden on another computer. The sign-in stays
in that SSApp browser profile. Signing into an unrelated browser on your own
computer does not sign the SSApp browser in.

## On the SSApp computer

Requires SSApp 0.4.40 with control API 1.6.0 or newer.

1. Enable **File > Local AI / Automation > Enable Local Control API** and restart.
2. Open `http://127.0.0.1:17777/api/v1/human/viewer` in a browser on that computer.
3. Select **Take private control**, then choose the SSApp window.
4. Check the site address above the picture. Click and type in the picture, or
   use the private text box and **Send & clear**. Use the window list for popups.
5. Select **Done · return control to AI** when the private step is finished.

**Disconnect · keep AI paused** stops viewing without returning control. Closing
the viewer also leaves automation paused. Reopen the viewer and take control to
continue or finish. An abruptly disconnected session expires after two minutes
without requests; a new viewer can then take control. Sessions last at most
30 minutes before reconnection is required.

The viewer does not show hidden windows on the host's desktop. Very small hidden
windows temporarily get a usable viewport while privately viewed; their size is
restored on disconnect unless someone manually resized the window meanwhile. A hidden window
that has never been shown, as under headless control on Windows, renders no picture and ignores
clicks. While you view it, SSApp keeps it rendering off-screen and transparent, then hides it
again when you disconnect or finish. Headless use still
requires both `--ssapp-headless-control` and `--ssapp-control-api`.

## From another computer

The localhost address belongs to the SSApp host. A remote bridge must authenticate
the person, connect to SSApp locally, and carry the private viewer traffic to that
person. Do not expose the loopback API directly to the network. Ninja MCP's regular
screenshot tools are separate from this private viewer connection.

The bridge must keep human viewing, input, and credentials separate from model
tool calls, observers, transcripts, recordings, and ordinary logs. It must stop
its agent activity before takeover and resume only after explicit human handback.
Only the person or their authorized bridge should create a viewer session.

## What pauses

Private takeover pauses the local control API's automation reads and writes across
SSApp. Existing API frame streams and event streams close. New page observations,
source/settings queries, dialogs, and input through MCP return
`HUMAN_CONTROL_ACTIVE`. Already accepted operations must finish before private
input is enabled; a waiting takeover returns `HUMAN_CONTROL_DRAINING` and can be
retried. The original operation may already have executed; do not replay it.

`ssapp_get_human_control_status` remains available and reports `idle`, `waiting`,
`active`, or `suspended`. It never returns a viewer credential or page content.
Disconnected or expired viewers leave automation paused until a person explicitly
returns control. Other local programs, desktop access, existing Social Stream
chat transports, and the website itself are outside this API pause.

Ordinary SSApp windows, manual sign-in, chat capture, settings, and defaults keep
their existing behavior. This viewer adds no model calls or background capture to
normal use. Capture happens only for requested screenshots or connected streams.

## Bridge API

Read `GET /api/v1/instance` and the `humanControl` capability returned by
`GET /api/v1/capabilities`. Bind every private request to that instance using
`X-SSApp-Instance-Id`. A restart rejects the old instance and invalidates all
viewer credentials. Obtain new user authorization before reconnecting.

| Request | Purpose |
| --- | --- |
| `GET /api/v1/human/viewer` | Standalone browser viewer; sibling `viewer.js` and `viewer.css` are included. |
| `GET /api/v1/human/status` | Non-sensitive state and whether automation is paused. |
| `POST /api/v1/human/start` with `{"confirm":true}` | Pause automation, drain existing operations, and create one viewer session. Returns a private `token`, `expiresAt`, and `deadline`. Never return this result to a model. |
| `POST /api/v1/human/command` | Execute an allowlisted command for the person; body is `{"action":"…","value":{…}}`. |
| `GET /api/v1/human/frames/{targetId}?fps=2&maxWidth=1280` | On-demand multipart JPEG frames. Percent-encode the target ID. |
| `POST /api/v1/human/suspend` with `{"confirm":true}` | Revoke the viewer token, close streams, and keep automation paused. |
| `POST /api/v1/human/finish` with `{"confirm":true}` | Revoke the token and explicitly return control after viewer requests finish. |

Except for start, status, and static assets, private requests require the
`X-SSApp-Human-Token` header. The existing API remains tokenless on loopback;
this short-lived capability distinguishes private viewing from ordinary agent
traffic. It does not replace remote authentication or protect against other
programs trusted on the same host. A bridge must not expose start to agents or
unauthorized callers. A second active viewer is rejected.

Private commands are `listBrowserTargets`, `captureBrowserScreenshot`,
`browserInput`, `navigateBrowserTarget`, `getPendingAppDialogs`, and
`respondToAppDialog`. They use the existing schemas and confirmation fields.
Host-file paths are not accepted through the private dialog endpoint; use the
separate authorized file workflow for uploads. Responses are not stored in the
automation operation ledger or published on its event stream.

The bundled viewer refreshes bounded JPEG screenshots and sends their
`screenshotId` with input. Screenshot metadata includes `page.redactedUrl` and
`page.title`; the address excludes credentials, query parameters, and fragments.
Never combine a picture from one target with coordinates from another. After
navigation or resize, obtain a fresh screenshot if SSApp returns `STALE_SCREENSHOT`.

The stream supports 1–5 fps, at most two connected streams, and no audio. The
reader must handle multipart boundaries split across transport packets, honor
backpressure, and close the host stream when permission or the viewer connection
ends. Streaming alone does not renew the viewer lease: send an authorized private
command periodically, such as `listBrowserTargets`. For input coordinates, use a
fresh screenshot. A remote media adapter may transport these frames through
VDO.Ninja; media publication and audio capture require their own integration.

An authorized bridge can give the bundled viewer a grant through
`/api/v1/human/viewer#token=VIEWER_TOKEN&instance=INSTANCE_ID` on its authenticated
viewer origin. The viewer removes the fragment immediately and keeps the token in
memory only. Never include credentials in query parameters, model messages, or
logs. Proxy the API paths to the bound host and serve the viewer on the same origin.
Serve the viewer as a separate page; its default policy disallows embedding.

On uncertain input delivery, inspect the result before retrying. The host does
not deduplicate human requests; the remote bridge must preserve its request IDs
and retry protection. Suspending cancels remaining private input dispatch where
possible but cannot undo actions already delivered to the browser.
