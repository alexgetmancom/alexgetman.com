# Указываем дефолтный источник сборки (in-docker для локальной сборки на Mac)
ARG BUILD_SOURCE=in-docker

# --- СТАДИЯ СЖАТИЯ FFMPEG (полностью изолированная и кэшируемая) ---
FROM oven/bun:1.3.14-debian AS ffmpeg-bin
USER root
COPY --from=mwader/static-ffmpeg:6.1.1 /ffmpeg /tmp/ffmpeg
COPY --from=mwader/static-ffmpeg:6.1.1 /ffprobe /tmp/ffprobe
RUN apt-get update && apt-get install -y --no-install-recommends upx-ucl \
  && upx -1 /tmp/ffmpeg /tmp/ffprobe \
  && rm -rf /var/lib/apt/lists/*

# --- СТАДИЯ СБОРКИ ВНУТРИ ДОКЕРА (для локальной сборки на Mac) ---
FROM oven/bun:1.3.14-debian AS build-in-docker
WORKDIR /app
# Сначала копируем только конфигурации и файлы package.json для кэширования
COPY --chown=bun:bun package.json bun.lock tsconfig.json tsconfig.base.json astro.config.ts biome.json knip.json ./
COPY --chown=bun:bun apps/backend/package.json ./apps/backend/package.json
COPY --chown=bun:bun tools/knip/package.json ./tools/knip/package.json

RUN chown bun:bun /app
USER bun
RUN --mount=type=cache,target=/home/bun/.bun,uid=1000,gid=1000 bun install --frozen-lockfile --ignore-scripts

# Теперь копируем исходный код
COPY --chown=bun:bun apps/backend ./apps/backend
COPY --chown=bun:bun apps/web ./apps/web
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun tools/knip ./tools/knip

RUN bun run --filter @alexgetman/backend typecheck
RUN DATA_DIR=/data bun run build
RUN bun build apps/web/server.ts --outdir runtime --target bun --splitting --minify --sourcemap=external
RUN bun build apps/backend/src/cli.ts --outdir ops --target bun --minify --sourcemap=external

# --- СТАДИЯ КОПИРОВАНИЯ ГОТОВОГО БИЛДА С ХОСТА (для сборки в GitHub Actions) ---
FROM scratch AS build-on-host
COPY dist /app/dist
COPY runtime /app/runtime
COPY ops /app/ops
COPY apps/backend/drizzle /app/apps/backend/drizzle

# --- ДИНАМИЧЕСКИЙ ВЫБОР СТАДИИ СБОРКИ НА ОСНОВЕ ПЕРЕМЕННОЙ ---
FROM build-${BUILD_SOURCE} AS build

# --- СТАДИЯ ПРОД-ЗАВИСИМОСТЕЙ ---
FROM oven/bun:1.3.14-debian AS prod-deps
WORKDIR /app
COPY --chown=bun:bun package.json bun.lock tsconfig.json tsconfig.base.json astro.config.ts biome.json knip.json ./
COPY --chown=bun:bun apps/backend/package.json ./apps/backend/package.json
COPY --chown=bun:bun tools/knip/package.json ./tools/knip/package.json

RUN chown bun:bun /app
USER bun
RUN --mount=type=cache,target=/home/bun/.bun,uid=1000,gid=1000 bun install --production --ignore-scripts \
  && rm -rf node_modules/esbuild node_modules/rollup node_modules/postcss node_modules/typescript

# --- ФИНАЛЬНЫЙ МИНИМАЛЬНЫЙ ОБРАЗ ---
FROM oven/bun:1.3.14-alpine AS app

ARG GIT_REVISION=unknown
ENV GIT_REVISION=${GIT_REVISION}
ENV DRIZZLE_MIGRATIONS_DIR=/app/apps/backend/drizzle

RUN apk add --no-cache ca-certificates tini

# Копируем сжатые бинарники из изолированной стадии ffmpeg-bin
COPY --from=ffmpeg-bin /tmp/ffmpeg /usr/local/bin/
COPY --from=ffmpeg-bin /tmp/ffprobe /usr/local/bin/

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/runtime ./runtime
COPY --from=build /app/ops ./ops
# Bun emits mtcute's dynamically loaded WASM files beside the server bundle,
# while mtcute resolves them relative to the process working directory.
COPY --from=build /app/runtime/*.wasm ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/backend/drizzle ./apps/backend/drizzle

USER bun
ENTRYPOINT ["tini", "--"]
CMD ["bun", "--smol", "/app/runtime/server.js"]
