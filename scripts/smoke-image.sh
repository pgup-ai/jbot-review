#!/bin/sh
set -eu
variant="$1"
test "$JBOT_IMAGE_VARIANT" = "$variant"
test "$(git --version)" = 'git version 2.56.0'
timeout 30s git ls-remote --exit-code https://github.com/git/git.git refs/tags/v2.56.0 >/dev/null
(
  repo=$(mktemp -d)
  trap 'rm -rf "$repo"' EXIT
  git init -q "$repo/source"
  cd "$repo/source"
  printf 'git smoke\n' > tracked.txt
  git add tracked.txt
  git -c user.name=smoke -c user.email=smoke@example.invalid commit -qm initial
  git grep -P 'git\s+smoke'
  git clone -q --depth=1 "file://$repo/source" "$repo/clone"
  git -C "$repo/clone" fetch -q origin
  test "$(git -C "$repo/clone" rev-parse HEAD)" = "$(git rev-parse HEAD)"
  git worktree add -q --detach "$repo/worktree" HEAD
  printf 'changed\n' >> "$repo/worktree/tracked.txt"
  git -C "$repo/worktree" diff --no-ext-diff HEAD -- tracked.txt | grep -q '^+changed$'
)
for entry in workflow/index.js app/server.js worker/index.js local/index.js review-retrieval.js; do
  test -s "/app/dist/$entry"
  node --check "/app/dist/$entry"
done
if output=$(timeout 30s env -u GITHUB_APP_ID MODEL=opencode/smoke PROVIDER=opencode OPENCODE_API_KEY=smoke node /app/dist/app/server.js 2>&1); then
  echo "App unexpectedly started without GITHUB_APP_ID" >&2
  exit 1
fi
printf '%s\n' "$output" | grep -q 'Error: Missing required env var: GITHUB_APP_ID'
opencode --version
if [ "$variant" = opencode ]; then
  node --input-type=module -e '
    import { createRequire } from "node:module";
    const require = createRequire("/app/package.json");
    for (const name of ["@qoder-ai/qoder-agent-sdk", "@cline/sdk", "@symma/client", "@symma/protocol"]) {
      try { require.resolve(name); } catch (error) {
        if (error.code === "MODULE_NOT_FOUND") continue;
        throw error;
      }
      throw new Error(`Unexpected SDK in opencode image: ${name}`);
    }
  '
  timeout 30s opencode serve --hostname 127.0.0.1 --port 0 > /tmp/opencode-smoke.log 2>&1 &
  server_pid=$!
  trap 'kill "$server_pid" 2>/dev/null || true' EXIT
  for attempt in $(seq 1 30); do
    if grep -q 'server listening on ' /tmp/opencode-smoke.log; then
      break
    fi
    sleep 1
  done
  if ! grep -q 'server listening on ' /tmp/opencode-smoke.log; then
    sed -E 's/server password .*/server password [redacted]/' /tmp/opencode-smoke.log >&2
    exit 1
  fi
fi
if [ "$variant" != opencode ]; then
  command-code --no-auto-update --version
  env PATH=/usr/local/bin:/usr/bin:/bin devin --version
fi
for cli in command-code devin cline grok kilo codex-acp qodercli dim cursor-agent; do
  if [ "$variant" = slim ] && { [ "$cli" = command-code ] || [ "$cli" = devin ]; }; then
    continue
  fi
  if [ "$variant" != full ]; then
    if command -v "$cli" >/dev/null 2>&1; then
      echo "Unexpected CLI in $variant image: $cli" >&2
      exit 1
    fi
  else
    command -v "$cli"
  fi
done
