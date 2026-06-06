FROM node:20-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai@latest

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY tsconfig.json ./

EXPOSE 3000

CMD ["npx", "tsx", "src/app/server.ts"]
