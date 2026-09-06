#!/bin/sh
set -eu
variant="$1"
test "$JBOT_IMAGE_VARIANT" = "$variant"
for entry in workflow/index.js app/server.js worker/index.js local/index.js; do
  test -s "/app/dist/$entry"
  node --check "/app/dist/$entry"
done
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
