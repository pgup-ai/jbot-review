# node 24 matches cursor-agent's bundled Node major, so it shares the system node (see cursor stage).
FROM node:24-slim

# git: review shells out to it. curl: used by the provider installers below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

# Retry npm fetches so a transient registry ECONNRESET doesn't fail the build.
RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000

# Engine + optional commandcode/codex/cline/grok/kilo providers; --version verifies they run
# on Node 24. Pinned exactly: with @latest the buildx layer cache froze whatever version
# the last cache bust happened to grab — bump versions here deliberately instead.
RUN npm install -g opencode-ai@1.18.4 command-code@0.40.17 @openai/codex@0.142.5 cline@3.0.46 @xai-official/grok@0.2.94 @kilocode/cli@7.3.54 @agentclientprotocol/codex-acp@1.1.7 \
  && npm cache clean --force \
  && opencode --version \
  && command-code --version \
  && codex --version \
  && cline --version \
  && grok --version \
  && kilo --version \
  && codex-acp --version

# Keep Qoder in its own layer: its package is large enough to push the combined
# multi-CLI npm install over common Docker Desktop memory limits.
RUN npm install -g @qoder-ai/qodercli@1.0.43 \
  && npm cache clean --force \
  && qodercli --version

# Devin CLI (optional devin provider); strip the installer's interactive setup step.
RUN curl -fsSL https://cli.devin.ai/install.sh -o /tmp/devin-install.sh \
  && grep -q '"\$VERSION_DIR/bin/\$COMPILED_BIN_NAME" setup' /tmp/devin-install.sh \
  && sed '/"\$VERSION_DIR\/bin\/\$COMPILED_BIN_NAME" setup/d' /tmp/devin-install.sh > /tmp/devin-install-no-setup.sh \
  && ! grep -q '"\$VERSION_DIR/bin/\$COMPILED_BIN_NAME" setup' /tmp/devin-install-no-setup.sh \
  && bash /tmp/devin-install-no-setup.sh \
  && test -x /root/.local/bin/devin \
  && rm -f /tmp/devin-install.sh /tmp/devin-install-no-setup.sh

# Cursor CLI (optional cursor provider); installer saved to disk, not piped to bash
# (auditable). Dedup: cursor bundles its own Node — when majors match, symlink it to
# the system node; fail the build if a future cursor bundles a different major.
RUN set -eux; \
  curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh; \
  bash /tmp/cursor-install.sh; \
  test -x /root/.local/bin/cursor-agent; \
  cnode="$(ls -d /root/.local/share/cursor-agent/versions/*/node)"; \
  [ -f "$cnode" ] || { echo "ERROR: expected exactly one cursor node binary, got: $cnode" >&2; exit 1; }; \
  cmaj="$("$cnode" --version | sed 's/^v//; s/\..*//')"; \
  smaj="$(node --version | sed 's/^v//; s/\..*//')"; \
  if [ "$cmaj" != "$smaj" ]; then \
    echo "ERROR: cursor bundles Node $cmaj but the base image is Node $smaj; bump the base to node:$cmaj-slim or drop this dedup" >&2; \
    exit 1; \
  fi; \
  rm -f "$cnode"; \
  ln -s /usr/local/bin/node "$cnode"; \
  /root/.local/bin/cursor-agent --help >/dev/null; \
  rm -f /tmp/cursor-install.sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY dist/ ./dist/

EXPOSE 3000

ENTRYPOINT ["node", "/app/dist/app/server.js"]
