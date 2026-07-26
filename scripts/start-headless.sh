#!/usr/bin/env bash
#
# Start Social Stream Ninja on a machine with no desktop: creates a virtual display and
# launches the app with every window hidden.
#
# See docs/CLOUD_HOSTING.md for the full walkthrough.
#
#   ./scripts/start-headless.sh                     # run in the foreground
#   SSAPP_DATA_DIR=/var/lib/ssapp ./scripts/start-headless.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DISPLAY_NUM="${SSAPP_DISPLAY_NUM:-99}"
SCREEN_SIZE="${SSAPP_SCREEN_SIZE:-1920x1080x24}"
DATA_DIR="${SSAPP_DATA_DIR:-$HOME/.local/share/ssapp-headless}"

die() { echo "error: $*" >&2; exit 1; }

command -v Xvfb >/dev/null || die "Xvfb is not installed. Debian/Ubuntu: sudo apt-get install -y xvfb"

# Locate the app. A source checkout runs the local Electron and has to be told where the app
# is; a packaged build (AppImage, or the unpacked binary beside it) already contains the app,
# so it must not be handed a path argument.
APP_BINARY="${SSAPP_BINARY:-}"
APP_PATH_ARG=()
if [ -z "$APP_BINARY" ]; then
	if [ -x "node_modules/electron/dist/electron" ]; then
		APP_BINARY="node_modules/electron/dist/electron"
		APP_PATH_ARG=(.)
	else
		die "no electron found. Run npm install, or set SSAPP_BINARY to your AppImage."
	fi
fi

mkdir -p "$DATA_DIR"

start_xvfb() {
	# $1: extra Xvfb arguments
	Xvfb ":$DISPLAY_NUM" -screen 0 "$SCREEN_SIZE" -nolisten tcp $1 >/dev/null 2>&1 &
	XVFB_PID=$!
	for _ in $(seq 1 40); do
		if xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1; then
			return 0
		fi
		# Xvfb can die during startup rather than just being slow.
		kill -0 "$XVFB_PID" 2>/dev/null || break
		sleep 0.25
	done
	kill "$XVFB_PID" 2>/dev/null || true
	XVFB_PID=""
	return 1
}

# Reuse an existing virtual display if one is already up on this number, otherwise start one.
XVFB_PID=""
if xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1; then
	echo "[start-headless] reusing existing display :$DISPLAY_NUM"
else
	echo "[start-headless] starting Xvfb on :$DISPLAY_NUM ($SCREEN_SIZE)"
	if ! start_xvfb ""; then
		# Some hosts ship GPU drivers that advertise EGL/GLX but cannot serve it, and Xvfb
		# crashes on startup while initialising the GLX extension. Retry without it.
		echo "[start-headless] Xvfb failed to start; retrying with GLX disabled"
		start_xvfb "-extension GLX" || die "Xvfb did not come up on :$DISPLAY_NUM"
	fi
fi

cleanup() {
	if [ -n "$XVFB_PID" ]; then
		kill "$XVFB_PID" 2>/dev/null || true
	fi
}
trap cleanup EXIT

cat <<INFO
[start-headless] data directory : $DATA_DIR
[start-headless] virtual display: :$DISPLAY_NUM

INFO

# SSAPP_USER_DATA_DIR (not Chromium's --user-data-dir) is what actually relocates settings,
# sessions and cookies: the app overrides --user-data-dir during startup.
export SSAPP_USER_DATA_DIR="$DATA_DIR"
export DISPLAY=":$DISPLAY_NUM"

# Servers rarely have a usable GPU, and letting Chromium keep probing for one wastes work and
# fills the log with GL errors. Set SSAPP_ENABLE_GPU=1 if the host really does have one.
GPU_ARGS=(--no-hwa)
if [ "${SSAPP_ENABLE_GPU:-0}" = "1" ]; then
	GPU_ARGS=()
fi

exec "$APP_BINARY" "${APP_PATH_ARG[@]+"${APP_PATH_ARG[@]}"}" \
	--ssapp-headless-control \
	"${GPU_ARGS[@]}" \
	"$@"
