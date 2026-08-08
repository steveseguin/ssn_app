# Running Social Stream Ninja headlessly

SSApp can run on a VPS, home server, or other Linux machine without a monitor. Headless
mode keeps its Electron windows hidden; it does not turn SSApp into a new HTTP remote-control
service.

Remote commands use the same Social Stream connection that already powers Stream Deck and
other remote controls:

```text
remote controller
    -> Social Stream WebRTC or WebSocket transport
    -> Social Stream command dispatcher
    -> SSApp source controls
```

The optional localhost `/api/v1` and MCP adapter are only for an AI tool running on the same
machine as SSApp. They are not the cloud-control path.

## What you need

- Ubuntu 22.04+, Debian 12+, or a similar Linux system
- 2 GB RAM for a small setup; more for several source windows
- Xvfb, because Electron still needs a display even when every window is hidden
- A persistent data directory for the Social Stream session and source configuration

```bash
sudo apt-get update
sudo apt-get install -y xvfb x11-utils
```

SSApp remains a browser application internally. Expect a few hundred MB of memory plus
additional renderer processes as sources are added.

## Install SSApp

Download the Linux AppImage from the
[Social Stream releases](https://github.com/steveseguin/social_stream/releases), put it in a
stable location, and make it executable. No source checkout or Node installation is required.

```bash
sudo mkdir -p /opt/socialstream
sudo mv socialstreamninja_linux_*.AppImage /opt/socialstream/socialstreamninja.AppImage
sudo chmod 755 /opt/socialstream/socialstreamninja.AppImage
```

If a minimal server cannot mount the AppImage, install `libfuse2` or extract it:

```bash
cd /opt/socialstream
./socialstreamninja.AppImage --appimage-extract
```

## Prepare the normal Social Stream connection

Use the same Social Stream session ID and optional password on SSApp and the remote client.
WebRTC is the normal transport. If WebRTC is unsuitable for the environment, enable Social
Stream's existing WebSocket server mode instead; both reach the same command dispatcher.

The simplest setup is to open SSApp once on a desktop, choose the session ID/password and
transport you want, then move that profile to the server. You can also attach VNC to the
server's virtual display for this one-time setup. Keep the same `SSAPP_USER_DATA_DIR` on later
starts so the session remains stable.

Once the remote connection is established, an empty source list is supported: the remote
controller can add, start, stop, restart, mute, and hide public sources such as a YouTube
pop-out chat that does not require sign-in. Remote OAuth, cookies, credentials, replies, and
account setup are intentionally outside this first headless scope.

## Start headlessly

Start a virtual display, select a persistent data directory, and launch the downloaded app
with every window hidden:

```bash
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -extension GLX &
export DISPLAY=:99
export SSAPP_USER_DATA_DIR="$HOME/.local/share/ssapp-headless"
/opt/socialstream/socialstreamninja.AppImage --ssapp-headless-control --no-hwa
```

Useful settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SSAPP_USER_DATA_DIR` | Electron's normal profile | Settings, session, sources, and browser data |
| `DISPLAY` | none | X display used by Electron source windows |
| `SSAPP_CONTROL_API` | off | Set to `1` only for a local AI process on this server |

If you are developing from a source checkout, `npm run start:headless` remains a convenience
wrapper around the same setup. Downloaded-app users do not need that script.

Use `SSAPP_USER_DATA_DIR`, not Chromium's `--user-data-dir`; SSApp sets its application data
path during startup.

`--ozone-platform=headless` is not a replacement for Xvfb for the main application. Electron
capture windows still need a working display backend.

If FUSE is unavailable, use the extracted executable instead:

```bash
/opt/socialstream/squashfs-root/socialstreamninja --ssapp-headless-control --no-hwa
```

## Optional one-time VNC access

VNC is useful for choosing the Social Stream session or completing a platform sign-in. It
is not required after setup for public read-only chat sources.

```bash
sudo apt-get install -y x11vnc
x11vnc -display :99 -localhost -rfbport 5900 -nopw -forever &
```

From your own machine:

```bash
ssh -N -L 5900:127.0.0.1:5900 you@your-server
```

Connect a VNC client to `localhost:5900`, then stop `x11vnc` when finished.

## Keep it running with systemd

```ini
# /etc/systemd/system/ssapp.service
[Unit]
Description=Social Stream Ninja (headless)
After=network-online.target

[Service]
Type=simple
User=ssapp
WorkingDirectory=/opt/socialstream
Environment=SSAPP_USER_DATA_DIR=/var/lib/ssapp
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1920x1080x24 -nolisten tcp -extension GLX" /opt/socialstream/socialstreamninja.AppImage --ssapp-headless-control --no-hwa
Restart=on-failure
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ssapp
journalctl -u ssapp -f
```

SSApp handles `SIGTERM` and `SIGINT` as clean shutdowns. Avoid `SIGKILL` when possible.

## Developer capture diagnostic

The hidden-capture diagnostic creates real Electron source windows through the normal IPC
path and verifies that work continues while those windows are off screen. It is a repository
test for developers and is not required for a downloaded installation:

```bash
DISPLAY=:99 npm run test:hidden-capture -- --headless \
  --url="https://www.youtube.com/live_chat?is_popout=1&v=VIDEO_ID"
```

For a longer check across platforms:

```bash
DISPLAY=:99 npm run test:hidden-capture:soak -- --minutes=60 --start-hidden \
  --url="https://www.youtube.com/live_chat?is_popout=1&v=VIDEO_ID" \
  --url="https://www.twitch.tv/popout/CHANNEL/chat?popout=" \
  --url="https://kick.com/popout/CHANNEL/chat"
```

A source that never produces a chat message is reported as inconclusive. Confirm the stream
is live and chat is public before treating that as an app failure.

## Local AI on the server itself

If an LLM or automation process runs on the same server, you may explicitly enable SSApp's
loopback API as a separate local adapter:

```bash
xvfb-run -a -s "-screen 0 1920x1080x24 -nolisten tcp -extension GLX" \
  /opt/socialstream/socialstreamninja.AppImage \
  --ssapp-headless-control --ssapp-control-api --no-hwa
```

It listens on `127.0.0.1` only. Do not forward or publish that port for remote users; use the
normal Social Stream WebRTC/WebSocket path instead.

An agent does not find SSApp by scanning the server. Register the downloaded AppImage itself
once in that agent's MCP configuration. SSApp 0.4.7 and newer provide `--ssapp-mcp`; no source
checkout, separate adapter download, or Node installation is required:

```json
{
  "mcpServers": {
    "social-stream": {
      "command": "/opt/socialstream/socialstreamninja.AppImage",
      "args": ["--ssapp-mcp", "--ozone-platform=headless"],
      "env": {
        "SSAPP_CONTROL_URL": "http://127.0.0.1:17777"
      }
    }
  }
}
```

The exact configuration filename depends on the AI client. During MCP setup the client launches
a second lightweight instance of the downloaded executable in adapter mode and asks it for tools.
SSApp 0.4.11 and newer expose the adapter's stable tool set even when the main app starts later;
each tool call still checks `GET /api/v1/capabilities` on loopback before sending a version-gated
command. Older versions should start the main SSApp process before the client. No port scanning,
cloud registration, or separate remote API is involved.

The optional
[`control-social-stream` skill](https://github.com/steveseguin/social_stream/tree/main/docs/skills/control-social-stream)
adds operating guidance for agents that support installable skills. Install that whole folder
in the agent's normal skill directory. The skill is not required for MCP connectivity; MCP
tool discovery and runtime capabilities remain the source of truth.

## Troubleshooting

**`Missing X server or $DISPLAY`.** Start Xvfb and export `DISPLAY`, or use the `xvfb-run`
command shown above.

**Xvfb exits immediately.** Some installed GPU drivers break Xvfb's GLX startup. Start it with
`-extension GLX`, as shown above.

**The app exits as root or in a container.** Add `--no-sandbox`. Running as a normal user is
preferred.

**Chat connects but no messages arrive while hidden.** Run the hidden-capture diagnostic and
include its output in a bug report. Check first that the channel is live and readable without
sign-in.

**Remote commands do not arrive.** Confirm SSApp and the controller use the same Social Stream
session ID/password and that either WebRTC is connected or WebSocket server mode is enabled.

**Sources or settings unexpectedly carry across instances.** Give every instance a different
`SSAPP_USER_DATA_DIR` and display number.
