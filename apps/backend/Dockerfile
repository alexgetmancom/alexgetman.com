FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg git rsync tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json astro.config.ts ./
COPY packages/shared ./packages/shared
COPY apps/backend ./apps/backend
COPY apps/web ./apps/web
COPY scripts ./scripts

RUN corepack enable \
  && corepack prepare pnpm@10.13.1 --activate \
  && pnpm install --frozen-lockfile
RUN pnpm --filter @alexgetman/shared typecheck \
  && pnpm --filter @alexgetman/backend typecheck \
  && pnpm --filter @alexgetman/backend build

RUN chown -R node:node /app

USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "/app/apps/backend/dist/src/index.js"]
