# SSApp documentation

These guides cover the Social Stream Ninja desktop application itself. They focus on the Electron runtime, operating-system integration, local services, automation, backups, and server operation. Overlay design and the broader Social Stream feature set remain in the [Social Stream manual](https://socialstream.ninja/manual).

## Start here

- [Native Discord Sources](DISCORD_NATIVE.md) — create a Discord bot, grant minimal permissions, select channels, and troubleshoot direct Discord capture.
- [Desktop App Guide](DESKTOP_APP.md) — the human guide to installing, operating, backing up, and troubleshooting SSApp.
- [Automation, MCP, and Local APIs](AUTOMATION.md) — setup and reference material for people building automation and for AI agents controlling SSApp.
- [Cloud and Headless Hosting](CLOUD_HOSTING.md) — running real capture windows on a Linux server with Xvfb and systemd.
- [Linux Notes](LINUX_NOTES.md) — platform-specific behavior for portable data, notifications, TTS, tray support, transparency, and GPU fallback.

## Developer material

- [Control architecture plan](CONTROL_ARCHITECTURE_PLAN.md) — historical design context for the local control surface. Runtime capabilities and [AUTOMATION.md](AUTOMATION.md) are authoritative for current behavior.
- [Release process](../RELEASE.md) — packaging, artifact, and release rules.
- [Contributing](../CONTRIBUTING.md) — repository workflow and contribution requirements.
- [Code signing](../CODE_SIGNING.md) — signing configuration and verification.

## Repository boundary

SSApp is the desktop shell and native integration layer. The source of truth for Social Stream pages, overlays, and platform capture scripts is the separate [social_stream repository](https://github.com/steveseguin/social_stream).

The generated `resources/social_stream_fallback` directory is only a packaged fallback bundle. It is rebuilt during update and build tasks and should not be edited as source.
