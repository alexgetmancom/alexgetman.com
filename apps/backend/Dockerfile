FROM oven/bun:1.3.14-debian AS build

WORKDIR /app
COPY --chown=bun:bun package.json bun.lock tsconfig.json tsconfig.base.json astro.config.ts ./
COPY --chown=bun:bun apps/backend ./apps/backend
COPY --chown=bun:bun apps/web ./apps/web
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun tools/knip ./tools/knip
COPY --chown=bun:bun biome.json knip.json ./

RUN chown bun:bun /app
USER bun
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run --filter @alexgetman/backend typecheck
RUN DATA_DIR=/data bun run build
RUN bun build apps/web/server.ts --outdir runtime --target bun --splitting --minify --sourcemap=external
RUN bun install --production --frozen-lockfile --ignore-scripts

FROM oven/bun:1.3.14-debian AS app

ARG GIT_REVISION=unknown
ENV GIT_REVISION=${GIT_REVISION}
ENV DRIZZLE_MIGRATIONS_DIR=/app/apps/backend/drizzle

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/runtime ./runtime
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/apps/backend/drizzle ./apps/backend/drizzle

USER bun
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "--smol", "/app/runtime/server.js"]
