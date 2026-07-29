# Указываем дефолтный источник сборки (in-docker для локальной сборки на Mac)
ARG BUILD_SOURCE=in-docker

# --- СТАДИЯ FFMPEG (полностью изолированная и кэшируемая) ---
# Бинарники кладём как есть, без upx. Измерено 2026-07-26: сжатый образ с `upx -1`
# и без него весит одинаково (140 МБ) — gzip слоя делает ту же работу, — но upx
# стоит ~318 мс распаковки на КАЖДЫЙ запуск ffmpeg/ffprobe, а видео-пайплайн
# зовёт их десятки раз за публикацию. `--best --lzma` ещё хуже: ~1230 мс.
# Экономия была только в месте на диске VM, которое и так чистит `docker image
# prune` в конце деплоя.
FROM oven/bun:1.3.14-debian AS ffmpeg-bin
USER root
COPY --from=mwader/static-ffmpeg:6.1.1 /ffmpeg /tmp/ffmpeg
COPY --from=mwader/static-ffmpeg:6.1.1 /ffprobe /tmp/ffprobe

# --- СТАДИЯ СБОРКИ ВНУТРИ ДОКЕРА (для локальной сборки на Mac) ---
FROM oven/bun:1.3.14-debian AS build-in-docker
WORKDIR /app
# Сначала копируем только конфигурации и файлы package.json для кэширования
COPY --chown=bun:bun package.json bun.lock tsconfig.json tsconfig.base.json astro.config.ts svelte.config.ts biome.json knip.json ./
COPY --chown=bun:bun apps/backend/package.json ./apps/backend/package.json
COPY --chown=bun:bun tools/knip/package.json ./tools/knip/package.json
COPY --chown=bun:bun tools/svelte-check/package.json ./tools/svelte-check/package.json
COPY --chown=bun:bun tools/dependency-cruiser/package.json ./tools/dependency-cruiser/package.json

RUN chown bun:bun /app
USER bun
RUN --mount=type=cache,target=/home/bun/.bun,uid=1000,gid=1000 bun install --frozen-lockfile --ignore-scripts

# Теперь копируем исходный код
COPY --chown=bun:bun apps/backend ./apps/backend
COPY --chown=bun:bun apps/web ./apps/web
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun tools/knip ./tools/knip
COPY --chown=bun:bun tools/svelte-check ./tools/svelte-check
# Backend shares the Story encoder with the isolated media-processor service.
# Keep the single source in the in-Docker TypeScript build context as well.
# The whole directory, not just story-encode.ts: the backend's own tests import
# service.ts too, and the typecheck below runs across them.
COPY --chown=bun:bun deploy/media-processor ./deploy/media-processor

RUN bun run --filter @alexgetman/backend typecheck
RUN DATA_DIR=/data bun run build
RUN bun build apps/web/server.ts --outdir runtime --target bun --splitting --minify --sourcemap=external
RUN bun build apps/backend/src/cli.ts --outdir ops --target bun --minify --sourcemap=external
RUN bun build apps/backend/src/runtime/docker-entrypoint.ts --outdir entrypoint --target bun --minify --sourcemap=external
RUN bun build apps/backend/src/story-cards/renderer-process.ts --outdir story-renderer --target bun --minify --sourcemap=external

# --- СТАДИЯ КОПИРОВАНИЯ ГОТОВОГО БИЛДА С ХОСТА (для сборки в GitHub Actions) ---
FROM scratch AS build-on-host
COPY dist /app/dist
COPY runtime /app/runtime
COPY ops /app/ops
COPY entrypoint /app/entrypoint
COPY story-renderer /app/story-renderer
COPY apps/backend/drizzle /app/apps/backend/drizzle
COPY apps/backend/assets /app/apps/backend/assets

# --- ДИНАМИЧЕСКИЙ ВЫБОР СТАДИИ СБОРКИ НА ОСНОВЕ ПЕРЕМЕННОЙ ---
FROM build-${BUILD_SOURCE} AS build

# --- СТАДИЯ ПРОД-ЗАВИСИМОСТЕЙ ---
# Keep dependency installation and runtime on the same glibc base. Bun's musl
# runtime does not currently expose every N-API symbol Sharp needs, so an
# Alpine image can contain the correct native package and still fail on import.
FROM oven/bun:1.3.14-debian AS prod-deps
WORKDIR /app
COPY --chown=bun:bun package.json bun.lock tsconfig.json tsconfig.base.json astro.config.ts svelte.config.ts biome.json knip.json ./
COPY --chown=bun:bun apps/backend/package.json ./apps/backend/package.json
COPY --chown=bun:bun tools/knip/package.json ./tools/knip/package.json
COPY --chown=bun:bun tools/svelte-check/package.json ./tools/svelte-check/package.json
COPY --chown=bun:bun tools/dependency-cruiser/package.json ./tools/dependency-cruiser/package.json

RUN chown bun:bun /app
USER bun
# Прод-зависимости здесь ставятся от КОРНЯ, а корневой package.json держит
# `astro` в dependencies, поэтому вместе с ним приезжает весь его build-тулчейн.
# Рантайму он не нужен: сайт уже собран в dist, а SSR-чанки Astro тянут из
# node_modules только drizzle-orm, svelte, hono, @astrojs/rss, @mtcute/bun, yaml
# и мелочь вокруг них. Всё остальное ниже — build-time.
#
# Удалять надо именно из `node_modules/.bun/`: там лежат сами пакеты, а
# `node_modules/<name>` — лишь симлинки на них. Прежний
# `rm -rf node_modules/esbuild ...` не удалял ничего, таких путей не существует.
#
# Список держит честным `Image smoke test` в .github/workflows/deploy.yml: он
# поднимает собранный образ и ходит по SSR-роутам. Если новый импорт в
# apps/web попадёт в один из удалённых пакетов, смоук упадёт до деплоя.
RUN --mount=type=cache,target=/home/bun/.bun,uid=1000,gid=1000 bun install --production --frozen-lockfile --ignore-scripts --linker hoisted \
  && rm -rf \
    node_modules/.bun/@typescript+typescript-* \
    node_modules/.bun/@rolldown+binding-* \
    node_modules/.bun/@esbuild+* \
    node_modules/.bun/lightningcss-linux-* \
    node_modules/.bun/@astrojs+compiler-binding-* \
    node_modules/.bun/@shikijs+langs@*

# --- ФИНАЛЬНЫЙ МИНИМАЛЬНЫЙ ОБРАЗ ---
FROM oven/bun:1.3.14-debian AS app

ARG GIT_REVISION=unknown
ENV GIT_REVISION=${GIT_REVISION}
ENV DRIZZLE_MIGRATIONS_DIR=/app/apps/backend/drizzle

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

# Копируем сжатые бинарники из изолированной стадии ffmpeg-bin
COPY --from=ffmpeg-bin /tmp/ffmpeg /usr/local/bin/
COPY --from=ffmpeg-bin /tmp/ffprobe /usr/local/bin/

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/runtime ./runtime
COPY --from=build /app/ops ./ops
COPY --from=build /app/entrypoint ./entrypoint
COPY --from=build /app/story-renderer ./story-renderer
# Bun emits mtcute's dynamically loaded WASM files beside the server bundle,
# while mtcute resolves them relative to the process working directory.
COPY --from=build /app/runtime/*.wasm ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/backend/drizzle ./apps/backend/drizzle
COPY --from=build /app/apps/backend/assets ./apps/backend/assets

# Stays root by default: the entrypoint fixes bind-mount ownership on a fresh
# volume, then drops privileges in-process before loading the server (see
# apps/backend/src/runtime/docker-entrypoint.ts). The app itself never runs as
# root — `docker exec` bypasses this entrypoint though, so pass `-u bun` there.
# `--smol` belongs here, not in a compose `command:`: the entrypoint loads the
# server into this same process, so anything after the script path would be
# passed to it as an ignored argument instead of taking effect as a Bun flag.
ENTRYPOINT ["tini", "--", "bun", "--smol", "/app/entrypoint/docker-entrypoint.js"]
