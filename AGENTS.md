# Language

**The repository is English-only. The product is bilingual; the codebase is not.**

- English is required in: code comments, identifiers, commit messages, test names,
  log and error messages, `README.md`, and every other doc or design note.
- Russian belongs only in *product content* — user-facing UI strings, locale
  files, bot copy, post text. Those are data, not code.
- Why: the product ships RU and EN, so Russian in source blurs the line between
  "text the reader sees" and "text explaining the code". A reviewer must be able
  to tell them apart at a glance, and translation tooling must never pick up a
  comment.
- Translated docs get an explicit suffix: `README.md` is the source of truth,
  `README.ru.md` is a translation of it (not yet written).
- When you touch a file that still has Russian comments, convert the lines you
  are already editing. Do not open unrelated files just to translate them.

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

## Running the dashboard locally

- The same `bun scripts/dev-seed.ts` also fills Command Center. It prints both URLs; the dashboard one carries the token:
  - site — `http://localhost:4321/`
  - dashboard — `http://localhost:4321/command-center?token=dev`
- The dashboard needs `COMMAND_CENTER_TOKEN` to be set or every request renders the login screen. Locally any value works as long as the server and the URL agree; `.claude/launch.json` sets `dev`. `?token=` is traded for an HttpOnly cookie on the first GET.
- `--no-dashboard` seeds site rows only. Use it when you are working on the player and do not want ~4k metric sample rows.
- Fixture layering: `apps/web/src/server/site-fixture.ts` writes what the public read model needs, `apps/web/src/server/dashboard-fixture.ts` adds what only Command Center reads (per-target publish state, metric history, queue and worker rows). Change the shape there, not in the seed script.
- The dashboard fixture is deliberately not all-green: one target fails with an error, one job stays queued, and metric samples are spread every two hours across 14 days. A fixture with one sample per day makes the overview chart draw a vertical spike instead of a curve, and an all-published fixture hides every error style.
- **No audience numbers locally.** Audience counts come from live platform APIs, not from the database, so that panel shows `—` against a fixture. That is expected, not a bug to chase.

## Theming

- Two skins, one vocabulary. Site tokens: `apps/web/src/shared/styles/tokens.css`. Dashboard tokens: `apps/backend/src/interfaces/web/dashboard/theme.ts`. The names match, the values deliberately do not — the site is editorial (crimson accent), the dashboard is a dense ops tool (blue accent, higher contrast).
- `apps/backend/tests/themeContract.test.ts` parses both files and fails if a shared token is missing from either, in either theme. Add a token to `SHARED_THEME_TOKENS` and you must add it to both stylesheets.
- The theme is `data-theme` on `<html>`, applied by an inline script before first paint (otherwise the wrong theme flashes). System preference is the default; an explicit click is stored in `localStorage` and wins from then on.
- **Never write a raw colour in CSS** — only `var(--*)`. The dashboard used to hold 143 literal hexes across three files, roughly twenty of which were near-identical greys nobody could tell apart.
- Only the media stage is dark in both themes. The article panel and the rail hold text, so they follow the theme via `--player-surface` / `--player-backdrop`; see "Story player chrome" below.

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

## Story player chrome

- **Only the stage is dark in both themes.** It shows a photo or a video, so it is a viewer, like the black frame inside a light YouTube. Everything else in the player — the article panel, the rail, their controls — is a reading surface and follows the theme through `--player-surface` (panel and card fill) and `--player-backdrop` (what sits behind the rail).
- **Translucency inside the player used to assume something dark behind it.** Several surfaces were `rgba(0, 0, 0, 0.5–0.8)` and inactive rail cards are dimmed with `opacity: 0.38` and `grayscale(1)`. Over a light page the translucent ones composited to grey slabs, so they are opaque themed fills now. The opacity case is different: it fades toward whatever is behind, so `--player-backdrop` has to be a real colour on both themes and has to sit on an ancestor (`.story-rail-container`) — an element cannot opt its own background out of its own opacity.
- The token override in tokens.css is scoped to `.story-visual`, not `.story-player`. Widening it back would drag the panel and the rail into dark-only again.
- **Colours picked against one background do not survive the other.** The article body was `#e2e8f0` and the category badge `#ff5c77` — both chosen for a dark panel, both unreadable on a white one. The same applied to a 4-7% crimson wash on the active rail card: invisible on black, distinctly pink on white. Use tokens, and prefer a border over a tint for state.
- The progress bar is white over media, which fails on a light image — and plenty of posts are screenshots of white pages. A gradient scrim under the top overlay (`.story-visual__top-scrim`) fixes every image at once instead of hunting for a bar colour that works on all of them.
- The bottom actions are one floating blurred bar holding three equal labelled items, not a row of separate chips — the shape a mobile tab bar has. The same bar is reused at the foot of the desktop context panel, so there is one component in two positions. Because the items are equal and labelled, a video-first feed needs no layout variant; only the third label changes meaning, from "read the post" to "read the transcript".
- **No large colour fills over media.** Emphasis on the primary item is a slightly lighter translucent fill, not the brand crimson. Hue works as a small mark (category badge, link) where it reads as brand; spread across a slab on top of a photo it reads as an alarm and outshouts the frame. Same reason the progress bar is white on a translucent track rather than crimson. The overlay palette lives in `--overlay-*` in tokens.css and is deliberately not themed — the surface underneath is media, not the page.
- **Autoplay with sound is impossible on a first visit** — browsers refuse it until the user has interacted with the page. The clip therefore always starts muted, and the prompt to enable sound is the required gesture. `hasMutedPreference()` separates "chose silence" from "never asked"; only the second is prompted, and any answer is persisted.
- No theme switch below 760px: mobile OSes have a reliable system dark mode, so the override only earns its place on desktop.
