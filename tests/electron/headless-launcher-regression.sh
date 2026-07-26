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
test -f "$SSAPP_TEST_XVFB_READY"
SCRIPT

cat >"$FAKE_BIN/fake-ssapp" <<'SCRIPT'
#!/usr/bin/env bash
printf 'DISPLAY=%s\n' "${DISPLAY:-}" >"$SSAPP_TEST_APP_REPORT"
printf '%s\n' "$@" >>"$SSAPP_TEST_APP_REPORT"
exit 23
SCRIPT

chmod +x "$FAKE_BIN/Xvfb" "$FAKE_BIN/xdpyinfo" "$FAKE_BIN/fake-ssapp"

export SSAPP_TEST_XVFB_PID="$TEST_ROOT/xvfb.pid"
export SSAPP_TEST_XVFB_READY="$TEST_ROOT/xvfb.ready"
export SSAPP_TEST_XVFB_STOPPED="$TEST_ROOT/xvfb.stopped"
export SSAPP_TEST_APP_REPORT="$TEST_ROOT/app-report.txt"

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

echo "headless-launcher-regression: all checks passed"
