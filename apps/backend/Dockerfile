FROM oven/bun:1.3.14-debian AS build

WORKDIR /app
COPY --chown=bun:bun package.json bun.lock tsconfig.json tsconfig.base.json astro.config.ts ./
COPY --chown=bun:bun packages/shared ./packages/shared
COPY --chown=bun:bun apps/backend ./apps/backend
COPY --chown=bun:bun apps/web ./apps/web
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun tools/knip ./tools/knip
COPY --chown=bun:bun biome.json knip.json ./

USER bun
RUN bun install --frozen-lockfile --ignore-scripts \
  && bun run --filter @alexgetman/shared typecheck \
  && bun run --filter @alexgetman/backend typecheck \
  && bun run --filter @alexgetman/backend build \
  && DATA_DIR=apps/web/src/data bun run build

FROM oven/bun:1.3.14-debian AS backend

ARG GIT_REVISION=unknown
ENV GIT_REVISION=${GIT_REVISION}

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=bun:bun /app/apps/backend/dist ./apps/backend/dist

USER bun
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "--smol", "/app/apps/backend/dist/index.js"]

FROM build AS site-builder

ARG GIT_REVISION=unknown
ENV GIT_REVISION=${GIT_REVISION}

USER bun
ENTRYPOINT ["bun", "--smol", "/app/apps/backend/dist/site/builder.js"]
