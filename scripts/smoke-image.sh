#!/bin/sh
set -eu
variant="$1"
test "$JBOT_IMAGE_VARIANT" = "$variant"
for entry in workflow/index.js app/server.js worker/index.js local/index.js; do
  test -s "/app/dist/$entry"
  node --check "/app/dist/$entry"
done
if output=$(timeout 30s env -u GITHUB_APP_ID MODEL=opencode/smoke PROVIDER=opencode OPENCODE_API_KEY=smoke node /app/dist/app/server.js 2>&1); then
  echo "App unexpectedly started without GITHUB_APP_ID" >&2
  exit 1
fi
printf '%s\n' "$output" | grep -q 'Error: Missing required env var: GITHUB_APP_ID'
opencode --version
command-code --no-auto-update --version
env PATH=/usr/local/bin:/usr/bin:/bin devin --version
for cli in cline grok kilo codex-acp qodercli dim cursor-agent; do
  if [ "$variant" = slim ]; then
    if command -v "$cli" >/dev/null 2>&1; then
      echo "Unexpected CLI in slim image: $cli" >&2
      exit 1
    fi
  else
    command -v "$cli"
  fi
done
