FROM node:20-slim

RUN apt-get update && apt-get install -y ca-certificates curl git && rm -rf /var/lib/apt/lists/*

# Survive transient npm-registry blips (observed ECONNRESET on fetch) instead
# of failing the whole image build on a single dropped connection.
RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000

# Use the latest opencode-ai for access to the most current model catalog.
RUN npm install -g opencode-ai@latest

# Devin CLI is available for the optional devin provider path. Credentials are
# written at runtime only when that provider is selected.
RUN curl -fsSL https://cli.devin.ai/install.sh \
  | sed '/"\$VERSION_DIR\/bin\/\$COMPILED_BIN_NAME" setup/d' \
  | bash \
  && test -x /root/.local/bin/devin
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY dist/ ./dist/

EXPOSE 3000

ENTRYPOINT ["node", "/app/dist/app/server.js"]
