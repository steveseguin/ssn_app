#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"

cleanup_test() {
	if [ -f "$TEST_ROOT/xvfb.pid" ]; then
		kill "$(cat "$TEST_ROOT/xvfb.pid")" 2>/dev/null || true
	fi
	rm -rf "$TEST_ROOT"
}
trap cleanup_test EXIT

cat >"$FAKE_BIN/Xvfb" <<'SCRIPT'
#!/usr/bin/env bash
echo "$$" >"$SSAPP_TEST_XVFB_PID"
touch "$SSAPP_TEST_XVFB_READY"
trap 'touch "$SSAPP_TEST_XVFB_STOPPED"; exit 0' TERM INT
while true; do sleep 1; done
SCRIPT

cat >"$FAKE_BIN/xdpyinfo" <<'SCRIPT'
#!/usr/bin/env bash
if [ "${SSAPP_TEST_DISPLAY_NOT_READY:-0}" = 1 ]; then exit 1; fi
test -f "$SSAPP_TEST_XVFB_READY"
SCRIPT

cat >"$FAKE_BIN/fake-ssapp" <<'SCRIPT'
#!/usr/bin/env bash
printf 'DISPLAY=%s\n' "${DISPLAY:-}" >"$SSAPP_TEST_APP_REPORT"
printf 'PROFILE=%s\n' "$SSAPP_USER_DATA_DIR" >>"$SSAPP_TEST_APP_REPORT"
printf 'HEADLESS_ENV=%s\n' "${SSAPP_HEADLESS_CONTROL:-}" >>"$SSAPP_TEST_APP_REPORT"
printf '%s\n' "$@" >>"$SSAPP_TEST_APP_REPORT"
if [ "${SSAPP_TEST_APP_STUBBORN:-0}" = 1 ]; then
	trap '' TERM INT
fi
if [ "${SSAPP_TEST_APP_WAIT:-0}" = 1 ]; then
	echo "$$" >"$SSAPP_TEST_APP_PID"
	while true; do sleep 0.1; done
fi
exit 23
SCRIPT

chmod +x "$FAKE_BIN/Xvfb" "$FAKE_BIN/xdpyinfo" "$FAKE_BIN/fake-ssapp"

export SSAPP_TEST_XVFB_PID="$TEST_ROOT/xvfb.pid"
export SSAPP_TEST_XVFB_READY="$TEST_ROOT/xvfb.ready"
export SSAPP_TEST_XVFB_STOPPED="$TEST_ROOT/xvfb.stopped"
export SSAPP_TEST_APP_REPORT="$TEST_ROOT/app-report.txt"
export SSAPP_TEST_APP_PID="$TEST_ROOT/app.pid"
unset SSAPP_USER_DATA_DIR

set +e
PATH="$FAKE_BIN:$PATH" \
	SSAPP_BINARY="$FAKE_BIN/fake-ssapp" \
	SSAPP_DATA_DIR="$TEST_ROOT/data" \
	SSAPP_DISPLAY_NUM=187 \
	"$REPO_ROOT/scripts/start-headless.sh" --fixture-argument
APP_STATUS=$?
set -e

test "$APP_STATUS" -eq 23
test -f "$SSAPP_TEST_XVFB_STOPPED"
grep -Fxq 'DISPLAY=:187' "$SSAPP_TEST_APP_REPORT"
grep -Fxq -- '--ssapp-headless-control' "$SSAPP_TEST_APP_REPORT"
grep -Fxq -- '--no-hwa' "$SSAPP_TEST_APP_REPORT"
grep -Fxq -- '--fixture-argument' "$SSAPP_TEST_APP_REPORT"
grep -Fxq -- '--ozone-platform=x11' "$SSAPP_TEST_APP_REPORT"

# An existing display belongs to its owner, and setup must preserve the selected profile.
rm -f "$SSAPP_TEST_XVFB_STOPPED"
set +e
PATH="$FAKE_BIN:$PATH" \
	SSAPP_BINARY="$FAKE_BIN/fake-ssapp" \
	SSAPP_USER_DATA_DIR="$TEST_ROOT/selected profile" \
	SSAPP_DATA_DIR="$TEST_ROOT/wrong-profile" \
	SSAPP_HEADLESS_CONTROL=1 \
	"$REPO_ROOT/scripts/start-headless.sh" --setup --fixture-argument
APP_STATUS=$?
set -e
test "$APP_STATUS" -eq 23
test ! -f "$SSAPP_TEST_XVFB_STOPPED"
grep -Fxq "PROFILE=$TEST_ROOT/selected profile" "$SSAPP_TEST_APP_REPORT"
grep -Fxq 'HEADLESS_ENV=0' "$SSAPP_TEST_APP_REPORT"
! grep -Fxq -- '--ssapp-headless-control' "$SSAPP_TEST_APP_REPORT"
! grep -Fxq -- '--setup' "$SSAPP_TEST_APP_REPORT"
grep -Fxq -- '--fixture-argument' "$SSAPP_TEST_APP_REPORT"

# Losing the launcher-owned display must fail and stop the app, so a service can restart.
rm -f "$SSAPP_TEST_XVFB_READY" "$SSAPP_TEST_XVFB_STOPPED"
PATH="$FAKE_BIN:$PATH" SSAPP_BINARY="$FAKE_BIN/fake-ssapp" \
	SSAPP_DATA_DIR="$TEST_ROOT/data" SSAPP_TEST_APP_WAIT=1 \
	"$REPO_ROOT/scripts/start-headless.sh" &
LAUNCHER_PID=$!
for ((attempt = 0; attempt < 100; attempt++)); do
	[ -f "$SSAPP_TEST_APP_PID" ] && break
	sleep 0.1
done
test -f "$SSAPP_TEST_APP_PID"
kill "$(cat "$SSAPP_TEST_XVFB_PID")"
set +e
wait "$LAUNCHER_PID"
APP_STATUS=$?
set -e
test "$APP_STATUS" -eq 1
! kill -0 "$(cat "$SSAPP_TEST_APP_PID")" 2>/dev/null

# An unresponsive app must not prevent SIGTERM from stopping the launcher and display.
rm -f "$SSAPP_TEST_XVFB_READY" "$SSAPP_TEST_XVFB_STOPPED" "$SSAPP_TEST_APP_PID"
PATH="$FAKE_BIN:$PATH" SSAPP_BINARY="$FAKE_BIN/fake-ssapp" \
	SSAPP_DATA_DIR="$TEST_ROOT/data" SSAPP_TEST_APP_WAIT=1 SSAPP_TEST_APP_STUBBORN=1 \
	"$REPO_ROOT/scripts/start-headless.sh" &
LAUNCHER_PID=$!
for ((attempt = 0; attempt < 100; attempt++)); do
	[ -f "$SSAPP_TEST_APP_PID" ] && break
	sleep 0.1
done
test -f "$SSAPP_TEST_APP_PID"
kill "$LAUNCHER_PID"
set +e
wait "$LAUNCHER_PID"
APP_STATUS=$?
set -e
test "$APP_STATUS" -eq 143
test -f "$SSAPP_TEST_XVFB_STOPPED"
! kill -0 "$(cat "$SSAPP_TEST_APP_PID")" 2>/dev/null

# Interrupting display startup must clean it up before Electron is even launched.
rm -f "$SSAPP_TEST_XVFB_READY" "$SSAPP_TEST_XVFB_STOPPED" "$SSAPP_TEST_APP_PID"
PATH="$FAKE_BIN:$PATH" SSAPP_BINARY="$FAKE_BIN/fake-ssapp" \
	SSAPP_DATA_DIR="$TEST_ROOT/data" SSAPP_TEST_DISPLAY_NOT_READY=1 \
	"$REPO_ROOT/scripts/start-headless.sh" &
LAUNCHER_PID=$!
for ((attempt = 0; attempt < 100; attempt++)); do
	[ -f "$SSAPP_TEST_XVFB_READY" ] && break
	sleep 0.1
done
test -f "$SSAPP_TEST_XVFB_READY"
kill "$LAUNCHER_PID"
set +e
wait "$LAUNCHER_PID"
APP_STATUS=$?
set -e
test "$APP_STATUS" -eq 143
test -f "$SSAPP_TEST_XVFB_STOPPED"
test ! -f "$SSAPP_TEST_APP_PID"

echo "headless-launcher-regression: all checks passed"
