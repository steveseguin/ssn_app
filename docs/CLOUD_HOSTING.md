# Running Social Stream Ninja on a server

This walks through running the desktop app on a machine you do not sit in front of — a VPS,
a home server, a spare box — and controlling it from somewhere else. It is useful if you
want chat capture to keep running when your PC is off, or you want to keep the capture load
off your streaming machine.

Everything below was tested on Ubuntu with app version 0.4.7 (Electron 43).

**What works:** the app runs with every window hidden, connects sources, captures chat, and
takes commands over an HTTP API on localhost.

**What to know before you start:**

- It is still a desktop app. It needs a virtual display (a few MB of extra software), it is
  not a small daemon, and it uses a few hundred MB of RAM plus a browser window per source.
- The control API listens on `127.0.0.1` only, by design. You reach it over an SSH tunnel.
  There is no built-in way to expose it safely to the internet, and you should not try.
- Signing in to platforms that need an account is the awkward part. See
  [Signing in](#6-signing-in-to-platforms) — it is solvable, just not one command.

## 1. What you need

- Linux with systemd (Ubuntu 22.04+ or Debian 12+ are the easy choices)
- 2 GB RAM for a couple of platforms, 4 GB if you plan on several
- 1 vCPU is enough; 2 gives you headroom
- `xvfb` (the virtual display) — a normal package, no GPU required

Measured here with everything hidden and chat flowing, using this launcher: **about 600 MB
and 12 processes with one live YouTube source**, and roughly **120 MB per additional
platform** after that. Extra sources on a platform you already run are close to free — a few
MB each, and no extra processes, because same-origin windows share a renderer. Idle CPU with
a hidden source window is under 1% of one core.

Note that `--no-hwa` does not remove the GPU process; it still runs (about 100 MB) doing
software compositing. What it buys you on a GPU-less server is avoiding repeated driver
probing and the GL errors that come with it, not memory.

```bash
sudo apt-get update
sudo apt-get install -y xvfb
```

## 2. Get the app onto the server

Either run from source:

```bash
git clone https://github.com/steveseguin/ssn_app.git
cd ssn_app
npm install
```

or download the Linux AppImage from the
[releases page](https://github.com/steveseguin/social_stream/releases) and make it
executable. If the AppImage will not start on a minimal server, either install `libfuse2`
or extract it instead:

```bash
./socialstreamninja.AppImage --appimage-extract   # gives you ./squashfs-root/socialstreamninja
```

## 3. Start it

There is a launcher that sets up the display, hides every window, turns on the control API
and generates a token for you:

```bash
npm run start:headless          # or: ./scripts/start-headless.sh
```

It prints where your data and token live, and the exact SSH command to reach it:

```
[start-headless] data directory : /home/you/.local/share/ssapp-headless
[start-headless] control API    : http://127.0.0.1:17777  (localhost only, token required)
[start-headless] token file     : /home/you/.local/share/ssapp-headless/control-api-token
```

Settings it respects, all optional:

| Variable | Default | What it does |
|---|---|---|
| `SSAPP_DATA_DIR` | `~/.local/share/ssapp-headless` | Settings, sessions and logins live here |
| `SSAPP_CONTROL_PORT` | `17777` | Control API port on localhost |
| `SSAPP_DISPLAY_NUM` | `99` | Which virtual display to use |
| `SSAPP_SCREEN_SIZE` | `1920x1080x24` | Virtual screen size |
| `SSAPP_BINARY` | local Electron | Point this at your AppImage or extracted binary |
| `SSAPP_ENABLE_GPU` | off | Keep hardware acceleration on (only if the host has a real GPU) |

If you would rather not use the launcher, this is all it does:

```bash
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
export DISPLAY=:99
export SSAPP_USER_DATA_DIR="$HOME/.local/share/ssapp-headless"
./node_modules/electron/dist/electron . \
  --ssapp-headless-control \
  --ssapp-control-api \
  --ssapp-control-port=17777 \
  --ssapp-control-token-file="$SSAPP_USER_DATA_DIR/control-api-token" \
  --no-hwa
```

Two details worth knowing:

- Use **`SSAPP_USER_DATA_DIR`**, not Chromium's `--user-data-dir`. The app calls
  `app.setPath('userData', ...)` during startup, so `--user-data-dir` only ends up applying
  to part of the app's state and you get settings in one place and logins in another.
- `--ozone-platform=headless` looks like it should remove the need for Xvfb. It does not
  work — the app segfaults during startup, with or without hardware acceleration, on both
  Electron 38 and 43. Use Xvfb.

## 4. Reach it from your own machine

Forward the port over SSH, then talk to it as if it were local:

```bash
# on your own machine
ssh -N -L 17777:127.0.0.1:17777 you@your-server
```

```bash
# in another terminal, still on your own machine
TOKEN=$(ssh you@your-server cat .local/share/ssapp-headless/control-api-token)
curl -H "x-ssapp-token: $TOKEN" http://127.0.0.1:17777/api/v1/status
```

The token can also go in a query string (`?token=...`) if a client cannot set headers.
Requests without it get a `403`.

## 5. Drive it

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/status` | GET | App state and every source with its status |
| `/api/v1/capabilities` | GET | Every command with its schema and risk level |
| `/api/v1/command` | POST | Run a command |
| `/api/v1/events` | GET | Event stream |
| `/api/v1/operations/<id>` | GET | Result of an earlier command |

Adding a YouTube live chat and starting it:

```bash
API=http://127.0.0.1:17777/api/v1
AUTH="x-ssapp-token: $TOKEN"

curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d '{
  "action": "addSource",
  "value": { "target": "youtube", "url": "https://www.youtube.com/live_chat?is_popout=1&v=VIDEO_ID" }
}' $API/command

curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"action":"startSource","value":{"sourceId":"youtube-url-xxxxxx"}}' $API/command

curl -s -H "$AUTH" $API/status      # the source should reach "status":"active"
```

`getCapabilities` lists the rest: stopping and restarting sources, muting, changing
connection mode, updating settings, reloading, and shutting down. Destructive commands need
`"confirm": true`.

To shut the app down cleanly:

```bash
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"action":"shutdownApp","value":{"confirm":true}}' $API/command
```

There is also an MCP adapter (`npm run mcp`) if you want an LLM assistant driving the same
commands.

## 6. Signing in to platforms

Public YouTube live chat needs no login, so the simplest setups need nothing here. Anything
that needs an account does, and a server has no screen to click on. Pick one:

**Option A — view the virtual display over VNC.** Attach a VNC server to the display the app
is already using, tunnel it, and use the real UI once to sign in.

```bash
sudo apt-get install -y x11vnc
x11vnc -display :99 -localhost -rfbport 5900 -nopw -forever &
```

```bash
# on your own machine
ssh -N -L 5900:127.0.0.1:5900 you@your-server
# then point any VNC client at localhost:5900
```

Keep `-localhost` on, so it is only reachable through the tunnel. Stop `x11vnc` when you are
finished; it does not need to run while the app does.

**Option B — sign in on your desktop and copy the profile up.** Sign in with the normal
desktop app, stop it, then copy its data directory to the server's `SSAPP_DATA_DIR`:

```bash
rsync -a ~/.config/SocialStream/ you@your-server:.local/share/ssapp-headless/
```

Some saved logins are tied to the OS keyring or machine, so treat this as "usually works,
sometimes needs a re-login".

**Option C — avoid logins.** Public live chat URLs and the API- or websocket-based sources do
not need an account. This is the least fragile option for an unattended server.

## 7. Keep it running (systemd)

```ini
# /etc/systemd/system/ssapp.service
[Unit]
Description=Social Stream Ninja (headless)
After=network-online.target

[Service]
Type=simple
User=ssapp
WorkingDirectory=/opt/ssn_app
Environment=SSAPP_DATA_DIR=/var/lib/ssapp
ExecStart=/opt/ssn_app/scripts/start-headless.sh
Restart=on-failure
RestartSec=10
# Give the app time to close sources and save settings.
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

The app handles `SIGTERM` and `SIGINT` as a clean shutdown, which is why the unit above uses
`SIGTERM` and allows time for it. Avoid `SIGKILL`: the app treats an abrupt exit as a crash,
and repeated crashes make it fall back to progressively more conservative graphics settings.

## 8. Check it is healthy

The repo ships a diagnostic that creates a real source window, hides it, and confirms chat
capture keeps running — the exact thing that tends to break on a machine with no screen:

```bash
DISPLAY=:99 npm run test:hidden-capture -- --headless \
  --url="https://www.youtube.com/live_chat?is_popout=1&v=VIDEO_ID"
```

Every check should pass. A healthy run reports chat rows arriving while the window is hidden,
for example `chat rows captured: onScreen=9 hidden=17 withZeroFrames=7`. If chat rows stay at
zero, check the video is actually live and has chat enabled — the diagnostic reports
`rows.target_produces_chat` when the page never produced a single message.

That check takes a couple of minutes. To confirm nothing degrades over a long session —
which is the failure people actually notice, since chat can run fine for ten minutes and then
stop — run the soak instead, with one `--url` per platform you care about:

```bash
DISPLAY=:99 npm run test:hidden-capture:soak -- --minutes=60 \
  --url="https://www.youtube.com/live_chat?is_popout=1&v=VIDEO_ID" \
  --url="https://www.twitch.tv/popout/CHANNEL/chat?popout=" \
  --url="https://kick.com/popout/CHANNEL/chat"
```

It hides every window, then reports rAF rate, timer rate and chat rows arriving per minute,
streaming to a `.jsonl` file you can watch while it runs. Windows that never produce a chat
row are reported as `NO DATA` with a snapshot of what the page actually was, rather than
counting as a pass — usually that means the channel is offline, chat is followers-only, or
the platform wants a login.

## 9. Where your data lives

Everything is under `SSAPP_DATA_DIR` (`~/.local/share/ssapp-headless` by default): settings,
browser sessions and logins, logs, and the control API token. Back up that directory; it is
the only state that matters. Stop the app first so nothing is written mid-copy.

## 10. Troubleshooting

**`Missing X server or $DISPLAY` / the platform failed to initialize.** No virtual display.
Start Xvfb and export `DISPLAY`, or use the launcher.

**Xvfb dies immediately on startup.** Some hosts ship GPU drivers that advertise GLX but
cannot serve it, and Xvfb crashes initialising the extension. Start it with
`-extension GLX`. The launcher detects this and retries automatically.

**The app exits immediately as root, or in a container.** Add `--no-sandbox`. Prefer running
as an ordinary user instead where you can.

**Log full of GL / EGL / WebGL errors.** Expected on a server with no GPU, and harmless.
`--no-hwa` (which the launcher passes) keeps it quiet.

**`403` from the API.** Wrong or missing token. Read it from the token file; it is
regenerated only if you delete it.

**Cannot reach the API from another machine.** It binds `127.0.0.1` deliberately. Use the SSH
tunnel in [step 4](#4-reach-it-from-your-own-machine). Do not put it on a public interface.

**Chat connects but no messages arrive.** Run the health check in step 8. Capture in a
window nobody can see depends on machinery described in `hidden-window-keepalive.js`; if the
check fails there, include its output in a bug report.

**Sources you did not add keep appearing.** Something is sharing a data directory. Each
instance needs its own `SSAPP_DATA_DIR`, and each its own `SSAPP_CONTROL_PORT` and
`SSAPP_DISPLAY_NUM`.
