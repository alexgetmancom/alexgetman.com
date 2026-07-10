FROM oven/bun:1.3.14-debian

ARG GIT_REVISION=unknown
ENV GIT_REVISION=${GIT_REVISION}

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg git rsync tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock tsconfig.json tsconfig.base.json astro.config.ts ./
COPY packages/shared ./packages/shared
COPY apps/backend ./apps/backend
COPY apps/web ./apps/web
COPY scripts ./scripts

RUN bun install --frozen-lockfile
RUN bun run --filter @alexgetman/shared typecheck \
  && bun run --filter @alexgetman/backend typecheck \
  && bun run --filter @alexgetman/backend build \
  && DATA_DIR=apps/web/src/data bun run build

RUN chown -R bun:bun /app

USER bun

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "--smol", "/app/apps/backend/dist/index.js"]
