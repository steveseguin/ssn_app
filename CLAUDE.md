# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Social Stream Ninja Standalone (ssapp) is an Electron-based application for capturing social media streams. It's a standalone version that provides better performance and stability than browser-based capture for streaming applications like OBS.

## Project Guidelines

- When testing a change, if that change does not result in the desired outcome, undo the change after
- Do not label a file or line of code as success, complete, final, or working, unless it first been actually tested and validated as so
- If git commit is available, commit working or successful and validated as working code changes with a brief comment to a feature/test/experiment branch
- Test changes when reasonable and possible
- Do not remove or break existing code or functionality when developing out new features and functions
- Leverage MCP connectors as needed for second opinions, search, and code review
- Inline code comments should be made cautiously when making claims of what something does until validated. Incorrect statements can be misleading to future efforts

## Development Commands

```bash
# Install dependencies
npm install

# Start development (from source)
npm run start2

# Start with custom file source
npm run start3  # Uses C:/Users/steve/Code/social_stream/
npm run start4  # Uses specified file source

# Build for platforms
npm run build:win32    # Windows build
npm run build:darwin   # macOS build (x64 and arm64)
npm run build:linux    # Linux build
npm run build:rpi      # Raspberry Pi build

# Clean build directory
npm run clean

# Release (publish)
npm run release
```

## Architecture

### Core Components

1. **Main Process** (`main.js`):
   - Manages Electron app lifecycle
   - Handles window creation and management
   - Implements TLS proxy for TikTok Kasada protection
   - Manages IPC communication between main and renderer
   - Handles command-line arguments and configuration

2. **Preload Script** (`preload.js`):
   - Security bridge between renderer and main process
   - Implements message authentication for injected scripts
   - Manages secure IPC communication

3. **Renderer Process** (`renderer.js`):
   - UI logic and interaction
   - Chat overlay functionality
   - Theme management

4. **TikTok Integration**:
   - `tiktok-auth.js` - Authentication handling
   - `tls-proxy-transparent.js` - TLS proxy for bypassing protections
   - Uses `tiktok-live-connector` for live stream connections

5. **TTS System**:
   - `tts.js` - Text-to-speech implementation
   - `tts-worker.js` - Worker thread for TTS processing
   - Uses Kokoro-82M-ONNX model for voice synthesis

6. **Event Flow System** (`actions/`):
   - `EventFlowSystem.js` - Core event handling
   - `EventFlowEditor.js` - Visual flow editor
   - Enables custom automation workflows

### Key Technologies

- **Electron 37.2.0** - Desktop app framework
- **WebSocket** connections for real-time communication
- **Worker Threads** for TTS processing
- **Electron Store** for persistent configuration
- **ONNX Runtime** for AI model inference

### Security Considerations

- Uses preload script authentication tokens to validate injected scripts
- Implements TLS proxy for secure TikTok connections
- Sandboxing disabled for certain features (flagged in main.js)
- Certificate files in `certs/` folder (`cert.pem`, `key.pem`, `socialstream.pfx`) for HTTPS