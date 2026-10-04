# node 24 matches cursor-agent's bundled Node major, so it shares the system node (see cursor stage).
FROM node:24-bookworm-slim AS node-base

FROM node-base AS git-build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl xz-utils build-essential libcurl4-openssl-dev libssl-dev libexpat1-dev libpcre2-dev zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/git
RUN curl -fsSL https://www.kernel.org/pub/software/scm/git/git-2.56.0.tar.xz -o git.tar.xz \
  && echo "26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3  git.tar.xz" | sha256sum -c - \
  && tar -xJf git.tar.xz --strip-components=1 \
  && make -j"$(nproc)" prefix=/usr/local USE_LIBPCRE2=YesPlease NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_RUST=YesPlease \
  && make prefix=/usr/local USE_LIBPCRE2=YesPlease NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_RUST=YesPlease INSTALL_STRIP=-s INSTALL_SYMLINKS=YesPlease DESTDIR=/opt/git install

FROM node-base AS base
# Keep Git's compiler and source out of every runtime variant.
COPY --from=git-build /opt/git/usr/local/ /usr/local/
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libexpat1 libpcre2-8-0 perl liberror-perl \
  && rm -rf /var/lib/apt/lists/* \
  && test "$(git --version)" = 'git version 2.56.0'

# Retry npm fetches so a transient registry ECONNRESET doesn't fail the build.
RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000

WORKDIR /app
EXPOSE 3000
ENTRYPOINT ["node", "/app/dist/app/server.js"]

FROM base AS runtime

# opencode's npm package installs both the glibc and musl binaries (~190MB each);
# this Debian image only runs the glibc one.
RUN npm install -g @opencode/cli@2.0.22 command-code@1.74.1 \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode/cli-linux-*-musl \
  && opencode --version \
  && command-code --no-auto-update --version

# Devin CLI (optional devin provider); strip the installer's interactive setup step.
ARG DEVIN_CLI_VERSION=3000.10.21
RUN curl -fsSL "https://static.devin.ai/cli/${DEVIN_CLI_VERSION}/setup.sh" -o /tmp/devin-install.sh \
  && echo "dac95d1301198bd3ab80c39a6634b38f6ed180e3db438074225351e8f2efd01d  /tmp/devin-install.sh" | sha256sum -c - \
  && grep -q '"\$VERSION_DIR/bin/\$COMPILED_BIN_NAME" setup' /tmp/devin-install.sh \
  && sed '/"\$VERSION_DIR\/bin\/\$COMPILED_BIN_NAME" setup/d' /tmp/devin-install.sh > /tmp/devin-install-no-setup.sh \
  && ! grep -q '"\$VERSION_DIR/bin/\$COMPILED_BIN_NAME" setup' /tmp/devin-install-no-setup.sh \
  && bash /tmp/devin-install-no-setup.sh \
  && test -x /root/.local/bin/devin \
  && /root/.local/bin/devin --version | grep -Fq "devin ${DEVIN_CLI_VERSION} " \
  && rm -f /tmp/devin-install.sh /tmp/devin-install-no-setup.sh

ENV PATH="/root/.local/bin:${PATH}"
ENV JBOT_IMAGE_VARIANT=full

# Depot's env-file may replace PATH; keep Devin on the default executable path.
RUN ln -s /root/.local/bin/devin /usr/local/bin/devin \
  && env PATH=/usr/local/bin:/usr/bin:/bin devin --version >/dev/null

FROM runtime AS full-tools

RUN npm install -g cline@3.0.65 @xai-official/grok@0.2.94 @kilocode/cli@7.3.54 @agentclientprotocol/codex-acp@1.1.7 \
  && npm cache clean --force \
  && cline --version \
  && grok --version \
  && kilo --version \
  && codex-acp --version

# Keep Qoder in its own layer: its package is large enough to push the combined
# multi-CLI npm install over common Docker Desktop memory limits.
RUN npm install -g @qoder-ai/qodercli@1.0.43 \
  && npm cache clean --force \
  && qodercli --version

# DimAgent, likewise in its own layer. Its linux-x64 binary unpacks to ~305MB —
# the largest single CLI here, ahead of kilo (203MB) and opencode (170MB), and
# roughly a third of the image's CLI payload. Smoke-tested with `dim version`:
# `dim --help` is not a help flag and falls through to reading stdin.
RUN npm install -g dimcode@0.3.15 \
  && npm cache clean --force \
  && DIMCODE_DISABLE_AUTOUPDATE=1 dim version

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
RUN ln -s /root/.local/bin/cursor-agent /usr/local/bin/cursor-agent \
  && env PATH=/usr/local/bin:/usr/bin:/bin cursor-agent --help >/dev/null

FROM base AS opencode-tools
# Use the amd64 baseline binary so runners without AVX2 work too.
RUN npm install -g @opencode/cli-linux-x64-baseline@2.0.22 \
  && ln -s /usr/local/lib/node_modules/@opencode/cli-linux-x64-baseline/bin/opencode /usr/local/bin/opencode \
  && npm cache clean --force \
  && opencode --version

FROM base AS app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY dist/ ./dist/
RUN test -s /app/dist/local/index.js

FROM runtime AS slim
COPY --from=app /app /app
ENV JBOT_IMAGE_VARIANT=slim

FROM app AS opencode-app
RUN npm uninstall --omit=dev --ignore-scripts @qoder-ai/qoder-agent-sdk @symma/client @symma/protocol \
  && npm cache clean --force

FROM opencode-tools AS opencode
COPY --from=opencode-app /app /app
ENV JBOT_IMAGE_VARIANT=opencode

# Keep the default target full for existing docker build callers and dogfooding.
FROM full-tools AS full
COPY --from=app /app /app
# The opt-in Cline SDK verifier (JBOT_CLINE_SDK_VERIFIER) runs where Cline does, so slim
# skips it. Same pin as package.json; the linked scope resolves its deps from the prefix.
RUN npm install --prefix /opt/cline-sdk --omit=dev --ignore-scripts @cline/sdk@0.0.86 \
  && ln -s /opt/cline-sdk/node_modules/@cline /app/node_modules/@cline \
  && npm cache clean --force
