# План Production Parity и эксплуатации

Цель: довести TypeScript monorepo до полной замены legacy Python-системы, устойчивой публикации и быстрого delivery. Публичная модель: EN в `/`, RU в `/ru/`, canonical URL независим от Telegram message ID; Telegram не является source of truth.

## Критический контекст

- Инцидент поста 54 показал, что девять параллельных ffmpeg для одного видео могут заблокировать backend и сеть VPS. Пункты 8-17 и 46-49 имеют приоритет перед новыми продуктами.
- Production SQLite нельзя изменять через destructive schema sync. Любая миграция сначала проверяется на копии живой базы.
- VPS не должен собирать Docker images: CI собирает immutable image, production только скачивает и запускает его.
- Уже реализованные функции не считаются закрытыми до проверки тестом и production/fixture gate.


## Рекомендации по упрощению и оптимизации кода на Bun

После успешного перехода на Bun и миграции планировщика, для максимального упрощения кодовой базы рекомендуется внедрить следующие практики:

1. **Использование нативных API Bun для I/O и процессов:**
   * Заменить `node:fs/promises` на нативный `Bun.file(path).text()` / `Bun.write(path, content)`. Это сократит бойлерплейт и ускорит чтение.
   * Использовать `Bun.spawn` вместо `node:child_process` для еще более лаконичного управления фоновыми задачами (включая FFmpeg).
2. **Переход на Drizzle ORM для работы с БД:**
   * Уйти от сырых SQL-запросов `backendDb.sqlite.prepare(...)` к типизированным запросам Drizzle ORM. Это исключит опечатки в запросах и сделает схемы строго типизированными.
3. **Zod для валидации API и JSON-пейлоадов:**
   * Использовать `zod` схемы для парсинга входных JSON-структур (например, `payload_json`), что уберет громоздкие ручные проверки `typeof` и снизит вероятность runtime-ошибок.
4. **Контроль зависимостей и покрытие тестов:**
   * Добавить сбор покрытия `bun vitest run --coverage` для выявления мертвого/неиспользуемого кода в бэкенде.
   * Использовать утилиту `taze` для быстрого интерактивного обновления пакетов монорепозитория.

| Задача | Зачем и критерий готовности | Состояние |
| --- | --- | --- |
| 1. Legacy parity matrix | Сверить каждый крупный Python-модуль из git history с TS-модулями, тестами и production-путями; незакрытые функции имеют отдельные строки ниже. | В работе |
| 2. schema.py -> DB schema | Сверить все legacy tables, columns, indexes и constraints с `schema.ts` на fixture и production-readonly базе. | Частично |
| 3. meta.py -> Meta clients | Сверить Facebook, Instagram и Threads payloads, auth, media upload и error mapping с legacy реализацией. | Не начато |
| 4. command_center_ui.py -> Dashboard | Сверить все страницы, actions, auth, pipeline fields и UX Command Center. | Частично |
| 5. pipeline.py -> Queue/worker | Сверить locks, retries, scheduling, stale recovery, metrics и site jobs с legacy pipeline. | Частично |
| 6. controller/schedule.py -> bot schedule | Сверить расписание, MSK slots, rebalance и ручное изменение времени. | Частично |
| 7. Legacy test suite coverage | Для каждой перенесённой критической функции добавить TS test либо явно зафиксировать непереносимый integration test. | В работе |
| 8. Production recovery guard | После рестартов не оставлять jobs в `publishing` и не запускать опасный повтор автоматически. | Готово |
| 9. Async ffmpeg | Запуск ffmpeg не блокирует event loop, healthcheck, Hono или grammY; есть timeout и SIGKILL. | Готово (реализовано в 7a772f1) |
| 10. Shared media cache | Один download/transcode/stage на пост и локаль, без параллельных ffmpeg и дублирующих файлов. | Частично |
| 11. Durable media cache | Кэш media переживает процесс и безопасно очищается только после всех target jobs. | Не начато |
| 12. Media resource limits | ffmpeg и worker имеют CPU/RAM/pids limits, чтобы не положить VPS или сеть. | Частично |
| 13. Publish queue locks | Claim, lock, stale-lock recovery и exactly-once transitions покрыты unit/integration tests. | Готово |
| 14. Duplicate job cleanup | Финализация удаляет лишние queued/failed jobs только в пределах одного post/target. | Готово |
| 15. Retry/backoff policy | Единые bounded retries, retryable errors и observability для всех target clients; legacy payload fallbacks удалены после wire-format audit. | Частично |
| 16. Threads media retry | Ошибка `media is missing` повторяется с задержкой и не создаёт дубль публикации. | Готово |
| 17. Threads partial publication | Уже опубликованные части треда сохраняются; retry продолжает с непубликованной части. | Готово |
| 18. Scheduled publishing | Due drafts автоматически создают и исполняют jobs в заданное время. | Готово |
| 19. Schedule rebalance | Изменение времени пересчитывает MSK slots и связанные jobs без дубликатов. | Готово (реализовано в b650b26 и ca78c2b) |
| 20. RU/EN target localization | Каждый target получает правильные locale text, media, URL и entities; тесты покрывают RU/EN. | Готово |
| 21. Telegram entities | Bold, italic, links и captions сохраняются и передаются в Telegram API. | Готово |
| 22. Post HTML rendering | Telegram entities преобразуются в безопасный HTML для `post_locales`; сайт показывает форматирование. | Готово |
| 23. Channel stories | Telegram Stories публикуются только в настроенный channel peer, URL и peer подтверждаются integration test. | Частично |
| 24. Business stories mode | Решить и реализовать/удалить legacy Bot API Business Connection mode с явной конфигурацией. | Готово |
| 25. Instagram stories | RU/EN credentials, public media URL, status polling и failure mapping покрыты тестами. | Не начато |
| 26. Social repair | Edit/retry published targets обновляет поддерживаемые внешние сети либо явно сообщает unsupported target. | Не начато |
| 27. Cancelled draft cleanup | Отмена неопубликованного draft удаляет связанные jobs, locales, sources и планы без удаления опубликованных данных. | Готово |
| 28. `/schedule` bot command | Админ видит scheduled drafts и может открыть/изменить их через inline keyboard. | Частично |
| 29. Bot architecture and business updates | `bot.ts` разделён на handlers/albums/drafts; Business Connection updates либо обрабатываются, либо feature полностью отключён и документирован. | Не начато |
| 30. Target visibility verification | Bluesky и другие SPA targets проверяются через platform API, не только HTTP 200. | Не начато |
| 31. Observability alerts | Stale jobs, failed targets, credentials и site build failures создают deduplicated alerts. | Готово |
| 32. Pipeline status API | `/pipeline-status` и `/api/pipeline-status` показывают реальные jobs, loops, errors, metrics и git revision. | Частично |
| 33. Command Center dashboard | Dashboard соответствует данным pipeline API, защищён auth и имеет action/error states. | Частично |
| 34. Dashboard live updates | SSE/MCP feed подключён к Dashboard либо заменён polling с корректными refresh/error states. | Не начато |
| 35. SQLite parity and safety | WAL, busy timeout, fixture compatibility и production-readonly schema audit подтверждены. | Частично |
| 36. Safe DB migrations | Baseline migrations создаются из существующей DB без destructive `push`; apply проверяется на копии production DB. | Не начато |
| 37. Typed DB boundary | Приоритетные raw SQL в publish/site jobs получают typed repositories; `SqliteCompat any` сокращается. | Частично: publish/site jobs и worker fallback переведены на Drizzle; bot, actions, operations и оставшиеся boundary ещё требуют миграции. |
| 38. Config and deploy-path audit | Удалить/объяснить `CONTROLLER_DB`, baseline constants и обязательные env; исправить `web-sync` old-brand defaults; Zod fail-fast покрыт тестами. | Не начато |
| 39. Web canonical parity | EN root, RU `/ru`, canonical URLs, feeds, sitemap и JSON-LD не используют Telegram как source. | Не начато |
| 40. Duplicate EN routes | Проверить `/en/posts/[postId]`, удалить duplicate canonical route или оставить явный redirect. | Готово |
| 41. AI-ready content | `llms.txt` использует Markdown URLs, добавлен `feed-ai.json`, image alt и AI analytics имеют данные/тесты. | Частично |
| 42. Markdown and Link headers | Markdown negotiation и HTTP Link headers проверяются end-to-end после deploy. | Требует проверки |
| 43. Site trigger and freshness | Публикация будит site job немедленно; fallback metrics interval равен 10 seconds, а не 300. | Частично |
| 44. Site builder isolation | Astro/Sharp build выполняется отдельным service/container, не в backend process. | Частично |
| 45. Incremental site rendering | Изменение одного поста не требует полного Astro build; fallback full build надёжен. | Не начато |
| 46. Thin backend image | Multi-stage image содержит только runtime deps; без source, dev deps, Astro, Sharp, Git, rsync и `chown -R`. | Частично |
| 47. Lean ffmpeg runtime | Выбрать проверенный Debian slim или минимальный codec build; H.264/AAC/MP4 и poster generation проходят media tests. | Не начато |
| 48. Registry-based deploy | CI публикует immutable image в GHCR; VPS делает pull/up, хранит текущий и rollback image, не собирает Docker. | Не начато |
| 49. Fast CI/CD | Path filters, parallel Vitest, Bun/BuildKit cache, отсутствие лишнего ffmpeg install, image build only for affected main changes и deploy gate дают измеримый быстрый pipeline. | Частично |
| 50. Code quality gates | Biome, Knip, staged hook, typecheck, unit/integration tests, Docker smoke test и browser checks обязательны в CI. | Частично |
| 51. Telegram Auto-like | Автоматически ставить реакцию (❤️) бота на каждый новый пост в канале после публикации, чтобы стимулировать реакции подписчиков. | Не начато |
| 52. Stories Aspect Ratio Fix | Приведение горизонтальных/квадратных картинок к вертикальному разрешению 1080x1920 (letterbox/pillarbox) без растягивания и деформации в TG и IG Stories. | Не начато |
| 53. Dev.to Inline Image | Встраивать обложку поста или медиафайл прямо в markdown-тело статьи на Dev.to в виде `![image](url)`, а не только в `cover_image`. | Не начато |
| 54. Dynamic Timezone Math | Использовать стандартный `Intl.DateTimeFormat` для динамического вычисления смещения MSK вместо хардкода `hour - 3`. | Готово |
| 55. X/Twitter Standard OAuth | Перейти с ручной генерации OAuth 1.0 сигнатур в `social/x.ts` на стабильный пакет `oauth-1.0a` для полной совместимости с кодировками. | Не начато |
| 56. p-limit Concurrency | Использовать пакет `p-limit` для жесткого ограничения параллельно запускаемых задач FFmpeg (макс 2). Оценка: Не дрочь (10/10, мастхэв для спасения от OOM/зависаний). | Готово |
| 57. Zod Env Validator | Валидировать конфигурацию и ключи API в `.env` при старте приложения с помощью схем Zod. Оценка: Не дрочь (9/10, уберет скрытые падения при деплое). | Частично |
| 58. ky HTTP Client | Перевести сетевые клиенты с сырого `fetch` на библиотеку `ky` для авто-ретраев и таймаутов. Оценка: На грани / Дрочь (5/10, требует много переписывания кода). | Не начато |
| 59. fast-safe-stringify | Защитить логирование циклов от падений через `fast-safe-stringify`. Оценка: Чистый дрочь (2/10, оверинжиниринг, в проекте нет сложных объектов). | Не начато |
| 60. Observability Alert Loop Fix | Исправить баг бесконечного спама в `observability.ts`. Метод `scanPublicationFailures` повторно создает алерты для джобов в статусе `failed`, даже если предыдущее событие уже было прочитано (`acked_at IS NOT NULL`). Нужно переводить отработанные упавшие джобы в `failed_archived` или переписать запрос `NOT EXISTS`. | Готово |
| 61. Telegram Stories MTProto Modernization | Заменить тяжелый устаревший пакет `telegram` (GramJS) на современный Bun-нативный `@mtcute/client` для отправки историй. Использовать `@mtcute/sqlite` для хранения сессии авторизации в базе `pipeline.db`. | Не начато |

## Сохранённый отложенный backlog

Эти пункты не отменены. Они не входят в первые 50, потому что не должны задерживать production parity. Перед началом любого из них требуется отдельная оценка ROI, безопасности и влияния на текущую систему.

| Задача | Зачем и критерий готовности | Состояние |
| --- | --- | --- |
| Hono RPC client | Типы Hono API экспортируются во frontend; ручные API-вызовы заменяются там, где это снижает риск рассинхронизации. | Отложено |
| Nano Stores | Добавить только при реальной потребности связать несколько Astro islands общим реактивным state. | Отложено |
| Type-safe MCP tools | Декларировать MCP tools через Zod после определения внешнего consumer и модели авторизации. | Отложено |
| Direct SQLite from Astro | Оценить только если изоляция site-builder не решает нужную скорость и консистентность. | Отложено |
| Astro through HTTP API only | Рассматривать после стабилизации canonical feed contract и site-builder. | Отложено |
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
3. Изменения production SQLite сначала проверяются на копии базы; destructive schema sync запрещён.
4. VPS не собирает Docker images. Сборка и тесты происходят в CI, сервер только получает готовый immutable image.
5. Новые социальные цели и отложенные платформы не добавляются, пока пункты 8-37 не подтверждены.

## Рекомендованные оптимизации (Оценка: НЕ ДРОЧЬ / High ROI)

Ниже перечислены архитектурные улучшения кода и зависимостей, которые дают максимальный результат при минимальных затратах времени (без оверинжиниринга):

1. **Bun Test (вместо Vitest):**
   * *Что делать:* Перейти на встроенный `bun test`. Удалить из `devDependencies` тяжелые пакеты `vitest` и `@vitest/coverage-v8`.
   * *Результат:* Тесты выполняются мгновенно (за миллисекунды), уходит лишний вес из `node_modules`.

2. **Drizzle-Zod (автогенерация валидаторов):**
   * *Что делать:* Использовать `drizzle-zod` для автоматического создания Zod-схем на основе описанных таблиц Drizzle.
   * *Результат:* Устраняет дублирование кода (не нужно описывать схемы дважды в TS и БД).

3. **Bun Shell (`$`) для FFmpeg:**
   * *Что делать:* Переписать асинхронный спавн процессов FFmpeg в `runtime/ffmpeg.ts` на встроенный `await $`ffmpeg ...``.
   * *Результат:* Выкидываем сложный бойлерплейт-код управления процессами.

4. **Очистка от Node-зависимостей (`dotenv`, `@hono/node-server`, `sanitize-html`):**
   * *Что делать:* Выполнить `bun remove dotenv @hono/node-server sanitize-html` и вырезать их импорты из кода (заменить на нативные фичи Bun и `hono/bun`).
   * *Результат:* Полное очищение от наследия Node.js, ускорение старта и уменьшение Docker-образа.

5. **Bun.file (вместо fs.readFileSync):**
   * *Что делать:* Заменить блокирующее чтение файлов `fs.readFileSync` в хелперах и скриптах на нативный `await Bun.file().text() / .json()`.
   * *Результат:* Чистый асинхронный I/O Bun.

6. **Telegram Stories на `@mtcute` (вместо GramJS):**
   * *Что делать:* Заменить тяжелую библиотеку `telegram` на легкий Bun-нативный `@mtcute/client` с сохранением сессий в `pipeline.db` через `@mtcute/sqlite`.
   * *Результат:* Надежный асинхронный MTProto-клиент без эмуляции Node-полифиллов.
