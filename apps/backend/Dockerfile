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
RUN --mount=type=cache,target=/home/bun/.bun,uid=1000,gid=1000 bun install --frozen-lockfile --ignore-scripts
RUN bun run --filter @alexgetman/backend typecheck
RUN DATA_DIR=/data bun run build
RUN bun build apps/web/server.ts --outdir runtime --target bun --splitting --minify --sourcemap=external

# Копируем и сжимаем ffmpeg и ffprobe с помощью UPX (lzma метод)
USER root
COPY --from=mwader/static-ffmpeg:6.1.1 /ffmpeg /tmp/ffmpeg
COPY --from=mwader/static-ffmpeg:6.1.1 /ffprobe /tmp/ffprobe
RUN apt-get update && apt-get install -y --no-install-recommends upx-ucl \
  && upx --best --lzma /tmp/ffmpeg /tmp/ffprobe \
  && rm -rf /var/lib/apt/lists/*

FROM oven/bun:1.3.14-debian AS prod-deps

WORKDIR /app
COPY --chown=bun:bun package.json bun.lock tsconfig.json tsconfig.base.json astro.config.ts ./
COPY --chown=bun:bun apps/backend ./apps/backend
COPY --chown=bun:bun apps/web ./apps/web
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun tools/knip ./tools/knip
COPY --chown=bun:bun biome.json knip.json ./

RUN chown bun:bun /app
USER bun
# Устанавливаем prod-зависимости и вырезаем тяжелый сборочный Vite/Rollup/Esbuild мусор
RUN --mount=type=cache,target=/home/bun/.bun,uid=1000,gid=1000 bun install --production --ignore-scripts \
  && rm -rf node_modules/esbuild node_modules/rollup node_modules/postcss node_modules/typescript

FROM oven/bun:1.3.14-alpine AS app

ARG GIT_REVISION=unknown
ENV GIT_REVISION=${GIT_REVISION}
ENV DRIZZLE_MIGRATIONS_DIR=/app/apps/backend/drizzle

RUN apk add --no-cache ca-certificates tini

# Копируем ультра-сжатые с помощью UPX бинарники
COPY --from=build /tmp/ffmpeg /usr/local/bin/
COPY --from=build /tmp/ffprobe /usr/local/bin/

WORKDIR /app
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/runtime ./runtime
COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/apps/backend/drizzle ./apps/backend/drizzle

USER bun
ENTRYPOINT ["tini", "--"]
CMD ["bun", "--smol", "/app/runtime/server.js"]

