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
DATA_DIR="${SSAPP_USER_DATA_DIR:-${SSAPP_DATA_DIR:-$HOME/.local/share/ssapp-headless}}"

die() { echo "error: $*" >&2; exit 1; }

# Setup uses the same profile and display, but leaves windows visible for VNC sign-in.
MODE_ARGS=(--ssapp-headless-control)
if [ "${1:-}" = "--setup" ]; then
	shift
	MODE_ARGS=()
	export SSAPP_HEADLESS_CONTROL=0
fi
[[ "$DISPLAY_NUM" =~ ^[0-9]+$ ]] || die "SSAPP_DISPLAY_NUM must be a display number, such as 99"
[[ "$SCREEN_SIZE" =~ ^[1-9][0-9]*x[1-9][0-9]*x(16|24|32)$ ]] || die "SSAPP_SCREEN_SIZE must look like 1920x1080x24"

command -v Xvfb >/dev/null || die "Xvfb is not installed. Debian/Ubuntu: sudo apt-get install -y xvfb x11-utils"
command -v xdpyinfo >/dev/null || die "xdpyinfo is not installed. Debian/Ubuntu: sudo apt-get install -y x11-utils"

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

# Install traps before starting Xvfb, including during its readiness wait.
APP_PID=""
XVFB_PID=""
stop_child() {
	local child_pid="$1"
	local attempt
	if kill -0 "$child_pid" 2>/dev/null; then
		kill "$child_pid" 2>/dev/null || true
		# A wedged app/display must not hold service shutdown open forever.
		for ((attempt = 0; attempt < 40; attempt++)); do
			kill -0 "$child_pid" 2>/dev/null || break
			sleep 0.25
		done
		if kill -0 "$child_pid" 2>/dev/null; then
			echo "[start-headless] process $child_pid did not stop; forcing shutdown" >&2
			kill -KILL "$child_pid" 2>/dev/null || true
		fi
	fi
	wait "$child_pid" 2>/dev/null || true
}
cleanup() {
	if [ -n "$APP_PID" ]; then
		stop_child "$APP_PID"
	fi
	if [ -n "$XVFB_PID" ]; then
		stop_child "$XVFB_PID"
	fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_xvfb() {
	Xvfb ":$DISPLAY_NUM" -screen 0 "$SCREEN_SIZE" -nolisten tcp "$@" &
	XVFB_PID=$!
	for _ in $(seq 1 40); do
		if kill -0 "$XVFB_PID" 2>/dev/null && xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1; then
			return 0
		fi
		# Xvfb can die during startup rather than just being slow.
		kill -0 "$XVFB_PID" 2>/dev/null || break
		sleep 0.25
	done
	stop_child "$XVFB_PID"
	XVFB_PID=""
	return 1
}

# Reuse an existing virtual display if one is already up on this number, otherwise start one.
XVFB_PID=""
if xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1; then
	echo "[start-headless] reusing existing display :$DISPLAY_NUM"
else
	echo "[start-headless] starting Xvfb on :$DISPLAY_NUM ($SCREEN_SIZE)"
	if ! start_xvfb; then
		# Some hosts ship GPU drivers that advertise EGL/GLX but cannot serve it, and Xvfb
		# crashes on startup while initialising the GLX extension. Retry without it.
		echo "[start-headless] Xvfb failed to start; retrying with GLX disabled"
		start_xvfb -extension GLX || die "Xvfb did not come up on :$DISPLAY_NUM"
	fi
fi

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

"$APP_BINARY" "${APP_PATH_ARG[@]+"${APP_PATH_ARG[@]}"}" \
	--ozone-platform=x11 \
	"${MODE_ARGS[@]}" \
	"${GPU_ARGS[@]}" \
	"$@" &
APP_PID=$!

# If our display dies, fail the service even if Electron stays alive or exits cleanly.
# systemd can then restart the whole capture stack instead of leaving a dead display.
if [ -n "$XVFB_PID" ]; then
	while kill -0 "$APP_PID" 2>/dev/null; do
		kill -0 "$XVFB_PID" 2>/dev/null || die "Xvfb exited while SSApp was running"
		sleep 0.5
	done
	kill -0 "$XVFB_PID" 2>/dev/null || die "Xvfb exited while SSApp was running"
fi

if wait "$APP_PID"; then
	APP_EXIT_CODE=0
else
	APP_EXIT_CODE=$?
fi
APP_PID=""
exit "$APP_EXIT_CODE"
