# Social Stream Ninja Standalone (ssapp)

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Build Status](https://github.com/steveseguin/ssn_app/workflows/Build%20SS%20App%20for%20Linux/badge.svg)](https://github.com/steveseguin/ssn_app/actions)

An Electron-based standalone application for [Social Stream Ninja](https://github.com/steveseguin/social_stream).

## Features

- 🔌 **No requirement to keep visible** - Capture social media chats without keeping popups visible and open
- 💬 **Multi-Platform Support** - Websocket support for YouTube, Twitch, TikTok, and more
- 🔊 **Text-to-Speech** - Built-in TTS with Kokoro-82M model

## Download

Download the latest release for your platform from the [Releases](https://github.com/steveseguin/social_stream/releases) page.

### Arch Linux

Social Stream Ninja is available in the AUR (Arch User Repository):

```bash
# Using yay
yay -S socialstreamninja

# Using paru
paru -S socialstreamninja

# Manual installation
git clone https://aur.archlinux.org/socialstreamninja.git
cd socialstreamninja
makepkg -si
```

## Building from Source

### Prerequisites

- Node.js 20.9 or higher
- npm 8 or higher
- Python (for native module compilation)

### Development

```bash
# Clone the repository
git clone https://github.com/steveseguin/ssn_app.git
cd ssn_app

# Install dependencies
npm install

# Run in development mode
npm run start2
```

### Building

```bash
# Windows
npm run build:win32

# macOS (x64 and arm64)
npm run build:darwin

# Linux
npm run build:linux

# Raspberry Pi
npm run build:rpi
```

## Usage

1. Launch the application
2. Load Social Stream Ninja or your custom social stream ninja URL
3. Configure your chat sources
4. Add the window capture to OBS

For detailed usage instructions, visit the [Social Stream Ninja documentation](https://socialstream.ninja/manual).

## Running on a Server

The app can run on a machine with no monitor — a VPS or a home server — with every window
hidden. Remote control continues to use Social Stream's existing WebRTC or WebSocket
connection; headless mode does not open a new HTTP control service:

```bash
sudo apt-get install -y xvfb x11-utils
./scripts/start-headless.sh
```

See [docs/CLOUD_HOSTING.md](docs/CLOUD_HOSTING.md) for the full walkthrough: preparing a
Social Stream session, running under systemd, and checking that hidden chat capture stays
healthy.

[docs/LINUX_NOTES.md](docs/LINUX_NOTES.md) covers what differs on Linux: portable mode,
notifications, system TTS voices, the tray, transparency, GPU fallback and expected footprint.

## YouTube OAuth (SSAPP) Troubleshooting

If YouTube sign-in loops or quota still appears to hit the default project in SSAPP, check the following:

1. In SSAPP, use `External browser` sign-in for YouTube.
2. In the YouTube websocket page, open `Use your own YouTube API quota` and add your own Google API key.
3. After saving credentials, sign out/in again in the YouTube source so requests use your key's quota project.
4. In Google Cloud, ensure `YouTube Data API v3` is enabled in the same project as that API key.
5. For SSAPP/Electron, do not lock the API key to HTTP referrer restrictions.
6. If Google asks for authorized domains on consent setup, add `socialstream.ninja` (you do not need to add `youtube.com`).

## Configuration

The app stores configuration in:
- Windows: `%APPDATA%/SocialStream/`
- macOS: `~/Library/Application Support/SocialStream/`
- Linux: `~/.config/SocialStream/`

The directory comes from Electron's `app.name`, so the capitalisation matters on Linux, where
the filesystem is case-sensitive. Set `SSAPP_USER_DATA_DIR` to put it somewhere else.

### Local WebSocket server port

The optional local WebSocket server uses port `3003` by default on new installs, which
keeps it clear of other tools that commonly claim `3000`. Installs that already had the
local server enabled keep port `3000`, so existing overlay links and OBS browser sources
continue to connect without being edited; that choice is saved on first launch after
upgrading and does not change again.

Change the port from **File → Set Local Server Port…**; the app persists the choice and
adds the matching `localserverport` parameter to Social Stream pages while the server is
enabled. Pages opened without that parameter still assume port `3000`, so if you hand-write
an overlay URL on a new install, include `localserverport=3003`.

For managed or development launches, `--ssapp-local-server-port=3003` (alias:
`--ssapp-ws-port=3003`) overrides the saved value. The `SSAPP_LOCAL_SERVER_PORT` and
`SSAPP_WS_PORT` environment variables are also accepted. Ports must be whole numbers from
1024 through 65535. Command-line, environment, saved, and default values are considered in
that order.

The server binds to `127.0.0.1` by default. **File → Allow Local Server Connections from
the LAN** changes the binding to `0.0.0.0` after a security warning. Managed launches can
use `--ssapp-local-server-host=0.0.0.0` (alias `--ssapp-ws-host`) or the
`SSAPP_LOCAL_SERVER_HOST` / `SSAPP_WS_HOST` environment variables. `loopback` and `lan`
are accepted as readable aliases. Bind hosts are intentionally limited to loopback
(`127.0.0.1`) or all interfaces (`0.0.0.0`), since Social Stream pages connect through
the loopback address on the SSApp machine.

LAN mode has no authentication or encryption and should only be enabled on a trusted
network. Prefer Social Stream's WebRTC mode when the sender and receiver are on different
computers.

To package a local Social Stream checkout (including uncommitted integration work) instead
of downloading the release branch, set `SSN_SOCIALSTREAM_SOURCE`. The standard allowlist is
still applied, so `.git`, development-only files, and large optional TTS assets are not copied:

```bash
SSN_SOCIALSTREAM_SOURCE=/path/to/social_stream npm run build:linux
```

## Code Signing

Official releases are signed. You can verify the authenticity using the included `code-signing-cert.pem` file. See [CODE_SIGNING.md](CODE_SIGNING.md) for details.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## Related Projects

- [Social Stream Ninja](https://github.com/steveseguin/social_stream) - The web application and Chrome extension
- [VDO.Ninja](https://github.com/steveseguin/vdo.ninja) - WebRTC live streaming tool

## Support

- 📖 [Project Homepage](https://socialstream.ninja)
- 💬 [Discord Community](https://discord.socialstream.ninja)
- 🐛 [Report Issues](https://github.com/steveseguin/ssn_app/issues)

## Acknowledgments

- Built with [Electron](https://www.electronjs.org/)
- TTS powered by [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
- Part of the [VDO.Ninja](https://vdo.ninja) ecosystem
