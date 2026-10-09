#!/bin/sh
cd "$(dirname "$0")/.." || exit 1
export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
if ! command -v node >/dev/null 2>&1; then
  echo "Pulse needs Node.js 20 or newer on PATH." >&2
  sleep 30
  exit 1
fi
exec node "$@"
