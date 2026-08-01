# SSApp Control Architecture Plan

Status: agreed implementation plan, 2026-07-26

## Implementation progress (2026-07-26)

Completed:

- Existing WebRTC/iframe and WebSocket server traffic now share the same SSApp command
  dispatcher and correlated response path.
- The remote allow-list is limited to individual public-source discovery, configuration,
  start/stop/restart, visibility, mute, and connection-mode operations. Settings, app
  lifecycle, bulk source operations, credentials, sign-in, files, and arbitrary code are
  not advertised or accepted remotely.
- A clean profile can add, start, stop, and remove a public source through the real
  iframe/message entry point; the WebSocket relay path can also start and stop an individual
  source.
- Headless launch mode no longer enables `/api/v1`. The local API is an independent,
  explicit loopback-only option, and MCP uses it without token setup.
- Headless, local-control, cloud-hosting, checked-in skill, capability, and version docs now
  describe the same product boundary.
- Downloaded Windows, macOS, and Linux builds expose the MCP adapter through the app
  executable's `--ssapp-mcp` mode. The app copies its exact installed-path configuration, so
  users do not need Node, Python, or a source checkout.
- The public website provides download-to-MCP instructions, a machine-readable `llms.txt`,
  the optional skill, API reference, and compatibility log. MCP initialization also gives a
  connected agent the core workflow automatically.
- Real Electron validation passed for the iframe command bridge, WebSocket command bridge,
  local API/MCP opt-in, and API-disabled headless launch.
- Hidden capture passed end to end with live YouTube and Twitch chat. The provided Kick
  `blame` source also passed through SSApp's default anonymous WebSocket path, including
  hidden and zero-native-frame phases. TikTok and Kick platform fixtures passed through
  their real injectors, and live TikTok WebSocket events were received separately.

Still external or inconclusive:

- A real remote peer should confirm the unchanged WebRTC transport on the intended network;
  the in-app test covers its actual iframe/message entry and response routing, not public
  signaling or firewall traversal.
- TikTok's optional classic-DOM path did not expose usable anonymous chat on this machine;
  its normal live WebSocket path and hidden injector fixture passed. This is retained as a
  test limitation, not an implementation blocker.
- KDE/GNOME Wayland occlusion, dual-monitor placement, tray appearance, Windows artifacts,
  and macOS signing/notarization still require those real platforms.

## Product boundary

Headless mode is only a way to launch SSApp without visible windows. It is not a separate
remote-control product and must not automatically enable a control API.

SSApp has two intentionally different control paths:

1. Local AI and automation may use an opt-in localhost interface and MCP adapter on the same
   machine as SSApp.
2. Remote operators, including Stream Deck, must use Social Stream's existing WebRTC or
   WebSocket transports. Social Stream receives the command and forwards approved SSApp
   operations through the existing postMessage/Electron IPC bridge.

No new remote listener or transport is required.

## Existing systems that remain unchanged

- The optional built-in WebSocket relay/server mode (port 3000 by default, configurable in the File menu or at launch).
- Social Stream's existing VDO.Ninja WebRTC transport and its reliable-send behavior.
- Temporary localhost HTTP callback listeners used while completing OAuth sign-in.
- Existing Social Stream remote actions and transport switching.
- The legacy Electron E2E automation harness, which remains test tooling rather than a
  product-facing remote API.
- `ninja-p2p` is not an SSApp dependency or part of this implementation. App-specific
  `ninja-p2p` skills may be considered separately in the future.

## Remote SSApp control

WebRTC and WebSocket requests must enter the same Social Stream dispatcher and reach the
same SSApp command implementation:

```text
remote controller
    -> existing WebRTC or WebSocket transport
    -> Social Stream background command dispatcher
    -> postMessage / Electron IPC
    -> SSApp command engine
    -> result returned over the originating transport
```

The first supported remote scope is:

- Discover capabilities and app/source status.
- List and inspect configured sources.
- Add, edit, and remove public sources that do not require authentication.
- Start, stop, and restart sources.
- Show, hide, mute, and unmute source windows.
- Select a supported capture/connection mode when no sign-in is required.

Remote SSApp control will not add OAuth initiation, credential or cookie access, arbitrary
JavaScript, filesystem access, or account-management commands. "Read-only" refers to the
platform interaction: public DOM capture can read messages without signing in or replying.
It does not prohibit ordinary local SSApp configuration such as adding or starting a source.

## Local AI and MCP control

The `/api/v1` interface may remain as an opt-in same-machine adapter for local LLMs and
automation. It must:

- Listen only on `127.0.0.1`.
- Stay disabled unless the user explicitly enables it.
- Not be enabled implicitly by headless mode.
- Avoid token generation, token files, rotation UI, authentication setup, and remote-tunnel
  documentation.
- Be described as local AI/automation, not as a cloud-server remote-control interface.

MCP remains a local stdio adapter to that localhost interface. The downloaded app itself
launches that adapter with `--ssapp-mcp`, and the File menu copies the client configuration.
Local tools may expose a broader approved command set than remote WebRTC/WebSocket clients.

## Headless mode

`--ssapp-headless-control` controls window visibility and unattended Electron behavior only.
It must not enable `/api/v1`, generate local API credentials, or print instructions for
tunnelling the API.

A headless instance is remotely operated through its normal Social Stream session using
WebRTC or WebSocket server mode. Cold start must work with an empty profile by allowing the
remote controller to create and start public, unauthenticated sources. Sign-in-dependent
sources are deferred.

## Implementation order

1. Route SSApp capability and source commands through `processIncomingRequest()` so both
   existing WebRTC implementations and WebSocket server mode use one dispatcher.
2. Return correlated command results through the originating transport.
3. Validate and advertise the remote command allow-list, including public-source cold start,
   while excluding sign-in and credential operations.
4. Decouple headless mode from the localhost control API.
5. Simplify `/api/v1` and MCP for explicit localhost-only use and remove token-related UX.
6. Update the headless launcher, cloud-hosting guide, public AI guide, checked-in agent skill,
   capability documentation, and version log.
7. Remove tests that mistake direct handler invocation for WebRTC coverage and add functional
   coverage through the real iframe/SDK message entry point.

## Validation gates

- With a clean profile, add and start a public source through WebRTC and observe its status.
- Repeat the same workflow through existing WebSocket server mode.
- Confirm both transports return equivalent command results and preserve existing Social
  Stream actions.
- Confirm headless mode starts and captures while `/api/v1` remains disabled.
- Confirm `/api/v1` listens only on loopback when explicitly enabled and MCP works locally
  without credential setup.
- Confirm remote capability discovery does not advertise sign-in, credential, filesystem,
  or arbitrary-code commands.
- Functionally exercise hidden/background capture with YouTube, TikTok, Twitch, and Kick,
  including reconnect behavior where a live public source is available.
- Treat static checks and mocked tests as supporting evidence only; final validation requires
  the real Electron app and real Social Stream message path.
