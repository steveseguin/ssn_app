#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ ! -f ../social_stream/background.html ]; then
	echo "error: npm run start-linux requires a neighboring social_stream checkout. See docs/LINUX_NOTES.md." >&2
	exit 1
fi
SOURCE_ROOT="$(cd ../social_stream && pwd)"
exec node_modules/electron/dist/electron . --running-from-source --filesource "$SOURCE_ROOT/" "$@"
