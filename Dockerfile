FROM node:20-slim

RUN apt-get update && apt-get install -y ca-certificates curl git && rm -rf /var/lib/apt/lists/*

# Survive transient npm-registry blips (observed ECONNRESET on fetch) instead
# of failing the whole image build on a single dropped connection.
RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000

# Use the latest opencode-ai for access to the most current model catalog.
# CommandCode is available for the optional commandcode provider path.
RUN npm install -g opencode-ai@latest command-code@latest

# Devin CLI is available for the optional devin provider path. Credentials are
# written at runtime only when that provider is selected.
RUN curl -fsSL https://cli.devin.ai/install.sh -o /tmp/devin-install.sh \
  && grep -q '"\$VERSION_DIR/bin/\$COMPILED_BIN_NAME" setup' /tmp/devin-install.sh \
  && sed '/"\$VERSION_DIR\/bin\/\$COMPILED_BIN_NAME" setup/d' /tmp/devin-install.sh > /tmp/devin-install-no-setup.sh \
  && ! grep -q '"\$VERSION_DIR/bin/\$COMPILED_BIN_NAME" setup' /tmp/devin-install-no-setup.sh \
  && bash /tmp/devin-install-no-setup.sh \
  && test -x /root/.local/bin/devin \
  && rm -f /tmp/devin-install.sh /tmp/devin-install-no-setup.sh

# Cursor CLI is available for the optional cursor provider path. Download the
# installer to disk first (redirect-safe -fsSL, no curl|bash pipeline) so a
# fetch failure surfaces clearly and the script is auditable; it installs the
# cursor-agent binary into ~/.local/bin. Auth is read at runtime from
# CURSOR_API_KEY, so no credential file is written.
RUN curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh \
  && bash /tmp/cursor-install.sh \
  && test -x /root/.local/bin/cursor-agent \
  && rm -f /tmp/cursor-install.sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY dist/ ./dist/

EXPOSE 3000

ENTRYPOINT ["node", "/app/dist/app/server.js"]
