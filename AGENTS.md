# Workflow

- Work only on `main`; do not create branches or PRs.
- Before every push: typecheck, tests, and production build.
- Push directly to `main`; CI/CD is main prodiction path

## Tatically after 2026-07-15. All other production deployments remain CI/CD-only.

## Локальные данные для сайта и плеера

- Пустая локальная БД — норма: главная отрендерит «English posts will appear here…», плеер не смонтируется. **Не сеять данные вручную и не писать INSERT'ы по месту** — есть фикстура.
- `bun scripts/dev-seed.ts` — 3 опубликованных поста, у первого 2 картинки. Пишет БД и медиа в `.dev-fixture/` (в gitignore) и печатает готовую строку запуска:
  - `PIPELINE_DB=<db> SITE_PUBLIC_DIR=<public-dir> bun run dev`
  - Флаги: `--posts N`, `--gallery N` (картинок у первого поста), `--db`, `--public-dir`, `--reset` (пересоздать).
- Почему по умолчанию именно так: на пустом или односоставном фиде не видны ни лента, ни фильтры режимов, ни сегментированная полоса прогресса — она появляется только при 2+ картинках в посте.
- Источник данных — `apps/web/src/server/site-fixture.ts` (drizzle-схема + реальные байты картинок под продовым именованием из `site-media-naming.ts`). Оттуда же сеется SSR-смоук-тест, поэтому дев и CI смотрят на одну и ту же форму данных. Менять форму — там, а не в вызывающих местах.
- Для логики плеера (таймеры, автоматы, прогресс) писать юнит-тесты рядом с `apps/web/src/scripts/story-player/*.test.ts` на happy-dom — быстро и детерминированно. Учитывать: **happy-dom не считает layout**, `offsetTop`/`clientHeight`/`scrollTop` там всегда 0, поэтому геометрия и прокрутка проверяются только живым браузером.

## Runtime diagnostics

- Production SSH alias: `ssh tw-nl`. Two containers run the same image: `alexgetman-backend` (alex) and `maru-backend` (maru) — pick the one the incident is actually about, or check both if unsure which account is affected.
- Перед анализом worker, очередей, конфигурации, публикаций или ошибок сначала выполнить CLI локально. Это проверяет контракт и доступность команды, но локальная БД/volumes могут отсутствовать:
  - `bun run --filter @alexgetman/backend ops status`
  - `bun run --filter @alexgetman/backend ops doctor`
  - `bun run --filter @alexgetman/backend ops audit`
  - `bun run --filter @alexgetman/backend ops capabilities`
  - `bun run --filter @alexgetman/backend ops verify --ref post:<id>`
  - `bun run --filter @alexgetman/backend ops timeline --ref post:<id>` — полная durable-хронология jobs, targets и событий с фазами и `durationMs`.
  - `bun run --filter @alexgetman/backend ops media-status` — health, очередь, VAAPI, версия и диск удалённого media processor на VM-106.
  - `bun run --filter @alexgetman/backend ops media-diagnose` — health плюс безопасная авторизованная обработка встроенного fixture без публикации.
  - `bun run --filter @alexgetman/backend ops media-job --ref post:<id>` — media-фазы вместе с полной публикационной timeline.
  - `bun run --filter @alexgetman/backend ops media-reprocess --ref post:<id> [--apply]` — без `--apply` только план; с `--apply` повторно создаёт или прогревает Story-варианты на VM-106, но ничего не публикует.
  - `bun run --filter @alexgetman/backend ops republish --ref post:<id> [--target <target>] [--locale ru|en]` (alias: `retry`) — requeues a target's publish job from its durable source; if no job exists yet for that target, creates one. This is a mutation — see the "not without explicit request" rule below.
- Упрощённая prod-обёртка: `bun run ops:prod <command> [args]`; по умолчанию использует `alexgetman-backend`, для Maru добавить `--account maru`. Примеры: `bun run ops:prod timeline --ref post:106`, `bun run ops:prod media-diagnose`.
- Сразу после этого, если нужен фактический production-state, выполнить те же команды на сервере через уже запущенный контейнер: `ssh tw-nl 'docker exec -u bun <alexgetman-backend|maru-backend> bun /app/ops/cli.js <command>'`. Начинать со `status`, `doctor`, `audit`; для конкретного поста — `verify --ref post:<id>`. Не искать состояние по исходникам, пока не получен CLI output. Флаг `-u bun` обязателен: контейнер стартует от root ради entrypoint (чинит владельца смонтированных томов), а `docker exec` без `-u` унаследует root, а не рабочего пользователя приложения.
- **"Не публиковался ролик / пост" — начинать с `audit`.** Он уже возвращает и текстовый, и видео-пайплайн разом: `recentPostEvents`/`failedPublishJobs` (посты) и `recentVideoFailures` (последние 20 failed/cancelled `video_targets` с `lastError`, названием черновика, платформой и временем) — одна команда вместо ручных SQL-запросов по `video_targets`/`video_drafts`. Пример: `ssh tw-nl 'docker exec -u bun maru-backend bun /app/ops/cli.js audit'`.
- Если `lastError` в `audit` не объясняет причину (например, ошибка внешнего API без деталей) — это уже root-cause на уровне кода, не порт диагностики; читать сам код и git-историю затронутого файла (`git log -- <path>`), не гадать по логам.
- Если локальная команда завершается `EROFS`, `ENOENT` или из-за отсутствующих локальных `/data`/secrets, не исправлять это ради диагностики: за production-ответом идти к read-only CLI в контейнере.
- Для авторизованной диагностики конкретного поста использовать JSON endpoint `/api/post-debug?ref=post:<id>`; он показывает post, targets и publish jobs.
- Не запускать `backup`, `restore`, `metrics-backfill --apply`, `media-reprocess --apply`, `capability-record`, retry/republish, ручные `UPDATE` в БД или другие мутации без явного запроса пользователя.
