#!/usr/bin/env bash
# Exercise the built artifact, including extraction, without requiring FUSE.
set -euo pipefail

if [ "$#" -ne 1 ]; then
	echo "usage: npm run test:linux-package -- /path/to/app.AppImage" >&2
	exit 2
fi
APPIMAGE_PATH="$(realpath -- "$1")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/ssapp-package-test.XXXXXX)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

for command in xvfb-run Xvfb xdpyinfo; do
	command -v "$command" >/dev/null || { echo "error: $command is required; install xvfb xauth x11-utils" >&2; exit 1; }
done

cd "$TEST_ROOT"
"$APPIMAGE_PATH" --appimage-extract > extract.log
export SSAPP_TEST_APP="$TEST_ROOT/squashfs-root/socialstreamninja"
export SSAPP_MCP_BINARY="$SSAPP_TEST_APP"
export SSAPP_TEST_EXECUTABLE="$SSAPP_TEST_APP"
export SSAPP_TEST_BUNDLED=1
test -x "$SSAPP_TEST_APP"
cd "$REPO_ROOT"

npm run test:mcp-launch:e2e
npm run test:headless-launcher:e2e
npm run test:fallback-dependencies
for test_script in test:emotes:e2e test:offline-assets:e2e test:source-mirrors:e2e test:mcp-control:e2e test:mcp-transport:e2e test:navigation-accessibility:e2e test:source-dialog-accessibility:e2e test:review-recovery:e2e test:tts; do
	xvfb-run -a -s '-screen 0 1920x1080x24 -extension GLX -nolisten tcp' npm run "$test_script"
done
echo "Linux packaged-app validation passed."
