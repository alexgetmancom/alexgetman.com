# План Production Parity и эксплуатации

## ⚠️ Контекст ручного деплоя и доработок (Июль 2026)

### 📝 Как мы вручную запускали SSR и боролись с сервером (История деплоя)
После того как предыдущий агент завершил переписывание архитектуры на SSR монолит, автоматического деплоя на сервере еще не было. Мы начали накатывать всё руками и прошли через настоящую полосу препятствий:

1. **Развал верстки:** Сразу после запуска контейнера сайт открылся с гигантскими SVG-иконками и без стилей. Выяснилось, что Astro в режиме Node middleware по умолчанию вообще не раздает скомпилированную статику из `dist/client`. Мы дописали кастомный стриминг файлов в `server.ts`.
2. **Падение сборки в GitHub Actions:** Когда мы попытались запушить фикс статики, сборка на гитхабе упала на этапе `bun install`. Причина — prepare-скрипт Lefthook требовал `git`, которого нет в базовом Debian-образе. Мы добавили флаг `--ignore-scripts` в Dockerfile, и билд позеленел.
3. **Забитый диск на сервере:** При попытке стянуть образ сервер ответил ошибкой `no space left on device`. Раздел `/` был забит на 93%. Мы провели принудительную чистку старых докер-образов и навсегда удалили контейнер старого `site-builder`'а, освободив **3.7 ГБ** места, после чего стянули образ.
4. **Пустая лента постов:** Контейнеры перезапустились, но сайт выдал заглушку «Русские/английские посты появятся после публикации». Оказалось, фронтенд Astro до сих пор читает старый статический файл `feed.json` с диска (задача перехода на чистый Drizzle SQLite запланирована в планах ниже). Поскольку папка релиза была чистой, файла там не было. Мы вручную скопировали актуальные файлы `feed.json` и `metrics.json` из старой директории бэкапов в активный контейнер, и посты появились.
5. **Пропавшие картинки постов:** Лента постов загрузилась, но все изображения и плееры видео были размытыми заглушками. Оказалось, пути к файлам ведут в `/media/posts/`, к которому у нового контейнера не было доступа. Мы добавили в `compose.yaml` маунт `/home/deploy/ialexey-web/media:/data/site/media:ro`, перезапустили контейнеры, и картинки успешно прогрузились.

**Исполнителю на проверку и автоматизацию (ВЫСШИЙ ПРИОРИТЕТ):**
1. **Dockerfile:** Добавлен `--ignore-scripts` в `bun install`, иначе сборка в чистом окружении CI/CD падала без `git` на prepare-скрипте Lefthook.
2. **Раздача статики:** В `apps/web/server.ts` встроен стриминг файлов из `/app/dist/client` с MIME-типами, так как Astro Node-middleware по умолчанию не отдает статику.
3. **Nginx:** В основном конфиге `/etc/nginx/sites-enabled/ialexey.ru` добавлен именованный `@backend`. В `ialexey-cache.conf` все `try_files $uri =404;` заменены на `try_files $uri @backend;` (если файла нет на хосте, запрос проксируется в контейнер).
4. **Медиа-файлы:** В `compose.yaml` добавлен bind mount `- /home/deploy/ialexey-web/media:/data/site/media:ro` для стриминга картинок/видео постов.
5. **Состояние на сервере:** Контейнеры перезапущены из `/home/deploy/releases/alexgetman-2e06600/apps/backend`. Старый `site-builder` убит вручную (освободили 700 МБ памяти, на сервере свободно 3.7 ГБ).
6. **Задача автоматизации:** Полностью настроить автоматический деплой (CD по GHCR-пушу), Healthcheck `/readyz` с авто-откатом и Telegram-кнопку «Откатить». Избавить фронтенд от костылей с чтением `feed.json`/`metrics.json` с диска — читать посты напрямую из Drizzle SQLite.
7. **Задача очистки устаревших файлов:** Удалить все следы до-монолитной архитектуры (скрипты `buildSite.ts`, старые HTML-генераторы, неиспользуемые Nginx-конфиги раздачи статики с диска, и очистить папку `/home/deploy/ialexey-web` на сервере от старых HTML, оставив только `/media/`, так как мы окончательно переехали на чистый SSR).
8. **Кэширование GitHub Actions Docker Cache (type=gha):** Настроить в GitHub Workflow `.github/workflows/docker.yml` кэширование слоев `cache-from: type=gha` и `cache-to: type=gha,mode=max`. Это позволит повторно использовать прогретый докер-кэш (включая `bun install`) и собирать образ на гитхабе за 15 секунд вместо 5 минут.

- Оставшиеся оптимизации Bun

1. Перевести оставшиеся файловые операции на `Bun.file()` и `Bun.write()` там, где это не меняет потоковую обработку медиа.
2. Убрать оставшиеся `backendDb.sqlite.prepare(...)` в пользу типизированных Drizzle repositories.
3. Ввести Zod-парсинг для всех внешних JSON-пейлоадов и JSON-колонок, которые пока проверяются вручную.
4. Добавить покрытие для `bun test` и определить безопасную политику обновления зависимостей.

| Задача | Зачем и критерий готовности | Состояние |
| --- | --- | --- |
| 48. Intelligent Registry-based deploy (ВЫСШИЙ ПРИОРИТЕТ) | GitHub Actions пушит образ в GHCR и триггерит деплой. Скрипт на сервере проверяет здоровье `/readyz` нового контейнера. В случае сбоя — авто-откат на стабильный хэш. Бот шлет статус в Telegram с инлайн-кнопкой «Откатить» для ручного отката в 1 клик. | Не начато |
| 1. Legacy parity matrix | Сверить каждый крупный Python-модуль из git history с TS-модулями, тестами и production-путями; незакрытые функции имеют отдельные строки ниже. | В работе |
| 2. schema.py -> DB schema | Сверить все legacy tables, columns, indexes и constraints с `schema.ts` на fixture и production-readonly базе. | Частично |
| 3. meta.py -> Meta clients | Сверить Facebook, Instagram и Threads payloads, auth, media upload и error mapping с legacy реализацией. | Не начато |
| 4. command_center_ui.py -> Dashboard | Сверить все страницы, actions, auth, pipeline fields и UX Command Center. | Частично |
| 5. pipeline.py -> Queue/worker | Сверить locks, retries, scheduling, stale recovery, metrics и site jobs с legacy pipeline. | Частично |
| 6. controller/schedule.py -> bot schedule | Сверить расписание, MSK slots, rebalance и ручное изменение времени. | Частично |
| 7. Legacy test suite coverage | Для каждой перенесённой критической функции добавить TS test либо явно зафиксировать непереносимый integration test. | В работе |
| 10. Shared media cache | Один download/transcode/stage на пост и локаль, без параллельных ffmpeg и дублирующих файлов. | Частично |
| 11. Durable media cache | Кэш media переживает процесс и безопасно очищается только после всех target jobs. | Не начато |
| 12. Media resource limits | ffmpeg и worker имеют CPU/RAM/pids limits, чтобы не положить VPS или сеть. | Частично |
| 15. Retry/backoff policy | Единые bounded retries, retryable errors и observability для всех target clients; legacy payload fallbacks удалены после wire-format audit. | Частично |
| 23. Channel stories | Telegram Stories публикуются только в настроенный channel peer, URL и peer подтверждаются integration test. | Частично |
| 25. Instagram stories | RU/EN credentials, public media URL, status polling и failure mapping покрыты тестами. | Не начато |
| 26. Social repair | Edit/retry published targets обновляет поддерживаемые внешние сети либо явно сообщает unsupported target. | Не начато |
| 28. `/schedule` bot command | Админ видит scheduled drafts и может открыть/изменить их через inline keyboard. | Частично |
| 29. Bot architecture and business updates | `bot.ts` разделён на handlers/albums/drafts; Business Connection updates либо обрабатываются, либо feature полностью отключён и документирован. | Не начато |
| 30. Target visibility verification | Bluesky и другие SPA targets проверяются через platform API, не только HTTP 200. | Не начато |
| 32. Pipeline status API | `/pipeline-status` и `/api/pipeline-status` показывают реальные jobs, loops, errors, metrics и git revision. | Частично |
| 33. Command Center dashboard | Dashboard соответствует данным pipeline API, защищён auth и имеет action/error states. | Частично |
| 34. Dashboard live updates | SSE/MCP feed подключён к Dashboard либо заменён polling с корректными refresh/error states. | Не начато |
| 35. SQLite parity and safety | WAL, busy timeout, fixture compatibility и production-readonly schema audit подтверждены. | Частично |
| 36. Safe DB migrations | Baseline migrations создаются из существующей DB без destructive `push`; apply проверяется на копии production DB. | Не начато |
| 37. Typed DB boundary | Приоритетные raw SQL в publish/site jobs получают typed repositories; `SqliteCompat any` сокращается. | Частично: publish/site jobs и worker fallback переведены на Drizzle; bot, actions, operations и оставшиеся boundary ещё требуют миграции. |
| 38. Config and deploy-path audit | Удалить/объяснить `CONTROLLER_DB`, baseline constants и обязательные env; исправить `web-sync` old-brand defaults; Zod fail-fast покрыт тестами. | Не начато |
| 39. Web canonical parity | EN root, RU `/ru`, canonical URLs, feeds, sitemap и JSON-LD не используют Telegram как source. | Не начато |
| 41. AI-ready content | `llms.txt` использует Markdown URLs, добавлен `feed-ai.json`, image alt и AI analytics имеют данные/тесты. | Частично |
| 42. Markdown and Link headers | Markdown negotiation и HTTP Link headers проверяются end-to-end после deploy. | Требует проверки |
| 47. Lean ffmpeg runtime | Выбрать проверенный Debian slim или минимальный codec build; H.264/AAC/MP4 и poster generation проходят media tests. | Не начато |
| 49. Fast CI/CD | Path filters, parallel `bun test`, Bun/BuildKit cache, отсутствие лишнего ffmpeg install, image build only for affected main changes и deploy gate дают измеримый быстрый pipeline. | Готово |
| 50. Code quality gates | Biome, Knip, staged hook, typecheck, unit/integration tests, Docker smoke test и browser checks обязательны в CI. | Частично |
| 57. Zod Env Validator | Валидировать конфигурацию и ключи API в `.env` при старте приложения с помощью схем Zod. Оценка: Не дрочь (9/10, уберет скрытые падения при деплое). | Частично |
| 58. ky HTTP Client | Перевести сетевые клиенты с сырого `fetch` на библиотеку `ky` для авто-ретраев и таймаутов. Оценка: На грани / Дрочь (5/10, требует много переписывания кода). | Не начато |
| 59. fast-safe-stringify | Защитить логирование циклов от падений через `fast-safe-stringify`. Оценка: Чистый дрочь (2/10, оверинжиниринг, в проекте нет сложных объектов). | Не начато |
| 64. Bun Shell for FFmpeg | Использовать нативный Bun Shell (`await $`ffmpeg ...``) для запуска процессов транскодинга вместо сложного спавна `child_process`/`Bun.spawn`. | Не начато |
| 65. Lefthook parallel check | Оптимизация локальных хуков. Настроить pre-push проверки (knip, lint, typecheck) параллельно с помощью concurrently или bash wait, сэкономив 30-40% времени локального ожидания. | Не начато |
| 66. Workspaces production prune | Заменить хрупкий хардкод-клининг `rm -rf` в Dockerfile на bun workspaces production prune для надежной очистки devDependencies из монорепозитория. | Не начато |
| 67. Safe frontend deploy gate | Защитить web-sync.ts от деплоя сломанного кода при падении CI. Добавить запрос к GitHub API на статус проверок коммита перед git pull, либо перевести на push-модель из CI. | Не начато |


## Сохранённый отложенный backlog

Эти пункты не отменены. Они не входят в первые 50, потому что не должны задерживать production parity. Перед началом любого из них требуется отдельная оценка ROI, безопасности и влияния на текущую систему.

| Задача | Зачем и критерий готовности | Состояние |
| --- | --- | --- |
| Nano Stores | Добавить только при реальной потребности связать несколько Astro islands общим реактивным state. | Отложено |
| Type-safe MCP tools | Декларировать MCP tools через Zod после определения внешнего consumer и модели авторизации. | Отложено |
| Vercel AI SDK Integration | Использовать Vercel AI SDK для продвинутого авто-рерайта постов под лимиты сетей, генерации тегов и перевода. | Отложено |
| MCP Server for AI Agents | Интегрировать Model Context Protocol (MCP) SDK для возможности прямого управления публикациями через внешних ИИ-агентов. | Отложено |
| Emoji reactions | Вернуться после утверждения privacy, anti-spam и retention модели. | Отложено |
| Structured headings in posts | Добавить только при надёжном редакторском правиле, не эвристикой ради HTML. | Отложено |
| Dev.to inline media | Поддержать после отдельного решения о public upload/hosting lifecycle. | Отложено |
| Reddit automation | Возобновить после стабильного аккаунта и утверждённой moderation strategy. | Отложено |
| npm package backlink | Рассматривать только как отдельный продукт, а не как искусственный SEO backlink. | Отложено |
| Docker Hub image backlink | Рассматривать только при реальной ценности публичного образа. | Отложено |
| Boosty/monetization | Требует отдельной продуктовой модели и платёжной/правовой проверки. | Отложено |
| New locales (`es`, `zh`) | Не начинать до стабилизации EN/RU publication и site workflows. | Отложено |

Pinterest и TikTok/Reels/Shorts исключены из плана по текущему решению.

## Правила исполнения

1. Пункт становится `Готово` только после кода, релевантного теста и проверки production/fixture там, где это применимо.
2. `Частично` означает, что часть реализации уже есть, но критерий строки ещё не доказан целиком.
4. VPS не собирает Docker images. Сборка и тесты происходят в CI, сервер только получает готовый immutable image.
