# План надёжности, упрощения и развития production-системы

Дата актуализации: 2026-07-13. Это единственный source of truth для очереди работ, discovery и целевой структуры. План отражает состояние `main`, а не старый parity-backlog.

## Принципы исполнения

1. Сначала устраняются риски потери данных, доступа и повторной публикации; затем — поставка и тесты; затем — архитектура и продукт.
2. Задача готова только с кодом, релевантными тестами и проверкой в подходящей среде.
3. Production DB не передаётся в обычный CI. Миграции проверяются на sanitised fixture или защищённой копии вне публичных артефактов.
4. VPS получает только готовые immutable Docker-образы; сборка и тесты происходят в CI.
5. Рефакторинг не объединяется с изменением поведения, миграцией или ротацией секретов.
6. Код, таблицы и deploy-контуры удаляются только после доказательства отсутствия runtime- и внешнего consumer-а в течение согласованного retention-периода.

## Известные факты и границы

### Уже исправлено или не требует отдельного проекта

- `isAdmin` больше не fail-open; malformed URL возвращает 400; Astro origin check включён.
- Ссылки бота валидируются, story JSON экранируется, HTTP-клиенты имеют timeout/redaction.
- Dashboard уже подключён в модульной форме — рефакторинг ради рефакторинга не нужен.
- `knip` сейчас проходит, но это baseline, а не доказательство отсутствия legacy: конфиг исключает `helpers.ts`, `home-posts.ts`, `fsUtils.ts`, dashboard и `brand.ts`.

### Карта состояния и ключевые риски

| Класс | Где хранится | Главный риск | Нужное решение |
| --- | --- | --- | --- |
| Authoritative state | SQLite: drafts, posts, публикации, jobs, schedules, audit, likes | Только ручная локальная копия БД; terminal records растут бесконечно. | P1.1, P1.6. |
| Irreplaceable media | site media, story media, `VIDEO_MEDIA_DIR`, часть Telegram media | Не входят в DB backup; story/site/video cleanup неполный. | P1.1, P1.7. |
| Derived/rebuildable state | feed, статический site index, часть media cache | Можно пересобрать, но сейчас часть файлов растёт без cleanup. | P1.6, P1.7. |
| Deploy state | deploy-agent state и rollback digest | Не включён в backend backup; утрата ухудшает rollback. | P1.1, P2.3. |
| Публичные/внешние эффекты | Telegram webhook, publisher API, likes/pageviews | Дубликаты после timeout, rate-limit/доверие proxy, персональные данные в audit. | P0.3, P1.2, P1.4, P1.6. |

Особые находки, которые должны быть закрыты планом:

- `SITE_METRICS_JSON` имеет двух writer-ов (`recordPageview()` и `renderFeedFiles()`), поэтому один может затереть поля другого.
- `arrayBuffer()` используется при обработке media/video до ограничений размера; при лимите контейнера 768 MiB это риск OOM.
- У terminal publish/site/video jobs, events/audit, comments, likes и analytics snapshots нет общей retention-политики.
- `story-media` не очищается; abandoned/rejected video drafts могут сохранять файлы бессрочно.
- Таблицы `media_assets` и `content_memory` статически не имеют production writer/reader; это кандидаты на проверку, не на немедленное удаление.

## P0 — целостность и доступ

| ID | Задача | Критерий готовности |
| --- | --- | --- |
| P0.1 | Восстановить Drizzle migration chain | Parity-индексы из `0002_restore_python_parity_indexes.sql` входят в применяемую историю; snapshots существуют для всех миграций; миграции проходят на чистой БД и защищённой копии существующей БД без destructive `push`. |
| P0.2 | Разделить секреты Command Center и Telegram webhook | Нет fallback `COMMAND_CENTER_TOKEN <- TELEGRAM_WEBHOOK_SECRET`; оба контура имеют отдельные обязательные секреты; после деплоя секреты ротированы и проверены. |
| P0.3 | Сделать Telegram webhook быстрым и идемпотентным | HTTP-ответ Telegram не ждёт перевод или LLM; update обрабатывается durable job/outbox; повтор одного `update_id` не создаёт второй draft, публикацию или ответ. |
| P0.4 | Исправить финализацию Telegram-альбомов | Ошибка перевода не записывает пустой EN-текст; создание/изменение draft не повторяется при ошибке отправки preview; есть regression-тесты. |

## P1 — надёжная эксплуатация и внешние эффекты

| ID | Задача | Критерий готовности |
| --- | --- | --- |
| P1.1 | Offsite backup и restore drill | Утверждена карта authoritative state, regenerable cache, irreplaceable media и deploy state; нужные данные ежедневно хранятся вне VPS с encryption/retention; есть регулярный restore-test, size/free-space report и независимый uptime-monitor `/readyz`. |
| P1.2 | Безопасный retry публикаций | Каждый publisher сохраняет внешний ID сразу после подтверждённого успеха; перед повтором после неясного результата выполняется platform-specific reconciliation; Bluesky не создаёт дубль при неуспешной visibility-проверке. |
| P1.3 | Контрактные тесты publisher-ов | Для Facebook, GitHub, Instagram posts, Bluesky, video/storage/ffmpeg и bot callback UI проверены success, permanent/transient error и «API принял запрос, ответ потерялся». |
| P1.4 | Публичные мутации и trusted proxy | Likes, pageview и webhook ограничены rate limit; `X-Forwarded-For`/`X-Real-IP` принимаются только от trusted proxy; правила покрыты тестами. |
| P1.5 | SSE и фоновые циклы | Pipeline payload кэшируется кратко; SSE clients ограничены и stream закрывается корректно; publishers не пересоздаются на тик; shutdown ждёт in-flight работу; интервалы метрик обоснованы. |
| P1.6 | Metrics, IndexNow и retention | `last_digest` сохраняется после успешного запроса; у `SITE_METRICS_JSON` ровно один writer либо данные в SQLite; утверждены и выполняются сроки хранения jobs, audit/events, likes, comments, snapshots, media test results и файловых метрик; dashboard/MCP не раскрывают secrets из JSON/errors. |
| P1.7 | Потоковая обработка и cleanup медиа | Большие загрузки проверяются и пишутся потоково, без полного буфера RAM; cleanup cache/story/site/video media reference-aware и не удаляет файлы активных jobs; abandoned drafts имеют TTL; ffmpeg concurrency и CPU/RAM/pids проверены нагрузочно. |

## P2 — поставка, тесты и ясные контракты

| ID | Задача | Критерий готовности |
| --- | --- | --- |
| P2.1 | Docker smoke в CI | CI собирает production image, запускает его с безопасной test-конфигурацией и ожидает успешный `/readyz`. |
| P2.2 | Минимальный browser smoke | Проверяются ключевые публичные страницы, canonical/JSON-LD, медиа-карточки и базовый SSR без ошибок; внешние зависимости замоканы. |
| P2.3 | Deploy и rollback E2E | Контролируемый Telegram rollback завершён, откат к immutable digest подтверждён healthcheck; GitHub job permissions минимальны. |
| P2.4 | Типизированные границы | `FeedItem` и media type экспортированы из `feed.ts`; SSR helpers принимают доменные типы; endpoint-ы используют `APIContext`; HTTP/Telegram команды, target metadata и DB JSON валидируются Zod/явным narrowing; `noExplicitAny` проходит путь warning → error. |
| P2.5 | Конфигурация и документация | Исправлена семантика пустых boolean env; мёртвые/переопределяемые env удалены или документированы; README отражает реальную single-process topology. |
| P2.6 | SEO и статический анализ | Sitemap не ставит одинаковый build-time `lastmod`; lint warnings устранены либо обоснованы; Knip использует точные entrypoints/exports вместо широких ignore. |
| P2.7 | Инвентаризация живости и legacy deploy | Для route/cron/CLI/Docker entrypoint, env, DB-таблицы, файла и external consumer-а есть owner и доказательство использования. Проверены `web-sync`, `Dockerfile.patch`, `media_assets`, `content_memory` и таблицы с малым числом ссылок. Кандидаты классифицированы active / external / removable. |

## Целевая структура после стабилизации

Цель — не новый framework и не разнос web/backend на процессы. Сейчас web запускает backend workers, поэтому отдельные процессы добавят сеть, авторизацию и deploy-сложность без пользы для P0/P1.

```text
transport (HTTP / Telegram / CLI)
              ↓
use-cases (publish, repair, video, site, engagement)
              ↓
repositories + platform adapters + filesystem
```

Конечная организация остаётся внутри текущего backend:

```text
core/        config, db, typed JSON, logging, runtime primitives
content/     drafts, posts, publication model, feed projection
delivery/    publish jobs, reconciliation, publisher adapters
video/       video draft lifecycle, video jobs, video publishers/storage
site/        site jobs, materialisation, IndexNow, content index
metrics/     schedules, repository, one adapter per platform
admin/       Command Center queries and typed repair commands
transport/   HTTP routes, Telegram handlers, CLI wiring
```

Это target layout, а не повод для big-bang move: сначала выделяется ответственность, затем отдельным механическим PR меняются пути.

### Что объединить

| Сейчас | Целевое упрощение | Не раньше |
| --- | --- | --- |
| publish/site/video job lifecycle | Маленький общий `runClaimedJobs`: concurrency, shutdown, tracing, error boundary. Домены сохраняют отдельные таблицы, payload, статусы и `claim/complete/fail/recoverStale` repository. Перенос: site → video → publish. | P1.2, P1.5; работа P3.2. |
| `bot/video.ts` | Telegram adapter → typed `VideoCommand` → video use-case. UI не читает DB JSON и не содержит scheduling rules. | После P0.3/P0.4. |
| `video/service.ts` | Отдельные lifecycle, queue executor, notification и cleanup. | После P1.7. |
| `services/actions.ts` | transport validation → `AdminCommand` → repair use-case; audit как общий decorator. | После P1.2. |
| `pipeline.ts`, `commandCenter.ts`, `dashboard.ts` | `admin/queries` и разные serializers для HTML/JSON/MCP, без супер-модели. | После P1.5. |
| `helpers.ts` | `post-paths`, `post-media`, `post-html`, date/text с `FeedItem`. | P2.4. |
| `metrics/collectors.ts` | Один platform adapter на файл при общем collector contract/scheduler/repository. | После P1.3. |

### Что не объединять

- Publisher-ы разных соцсетей: протоколы и идемпотентность существенно различаются; общий только результатный контракт.
- Метрики разных платформ: общий scheduler/repository, но collectors отдельные.
- Таблицы jobs в одну универсальную таблицу: payload/status/side effects слишком разные.
- `db/schema.ts` дробить только из-за LOC: схема намеренно централизована.
- Рефакторить dashboard: модульная версия уже используется.

## P3 — упрощение, управляемость и продукт

| ID | Задача | Критерий готовности |
| --- | --- | --- |
| P3.1 | Command Center как центр решений | Для target видны history, внешний ID, попытки, reconciliation и visibility; retry авторизован, безопасен и оставляет audit trail. |
| P3.2 | Общая механика очередей | Вынесен минимальный queue runner; site, затем video и publish используют его без смены таблиц или бизнес-семантики. Конкурентные инварианты и shutdown покрыты тестами. |
| P3.3 | Доменная декомпозиция | Выделены границы из таблицы «Что объединить»: video UI/use-case, repair commands, admin read-model, web utilities, platform metric adapters. Поведение не меняется в том же PR. |
| P3.4 | Нормализовать модель публикаций | Дата публикации имеет один реляционный источник истины; JSON не дублирует расписание; миграция обратима и проверена на копии БД. |
| P3.5 | Удалить подтверждённый legacy | После остановки новых записей и наблюдения за retention-период удалены доказанно неиспользуемые code/tests/env/docs. DB-таблица удаляется отдельной миграцией после backup/restore-проверки. |
| P3.6 | Web architecture и локализация | После P0–P2 оценены i18n routing и формальная web/backend boundary; изменения принимаются только при измеримой выгоде для поддержки. |

## Discovery-проход P2.7

1. Для каждого контура заполнить: `entrypoint → writer → reader → owner → external consumer → retention → backup class`.
2. Проверить repository, CI, systemd/cron и read-only production telemetry за согласованный retention-период.
3. Для DB собрать только агрегаты: rows/min/max по растущим таблицам, размер DB/WAL, size volumes, возраст последнего backup и свободное место. `wal_checkpoint` не запускать без отдельного согласования.
4. Кандидат сначала перестаёт принимать новые записи или выключается feature flag-ом; затем наблюдается; потом удаляется.
5. Для DB: backup → restore-test → migration → отсутствие запросов → отдельный release на drop.

## Очередь релизов

1. **Release A:** P0.1–P0.4 — migrations, secret separation, durable webhook, albums.
2. **Release B:** P1.1–P1.5 — backups, no-duplicate publishing, integration contracts, rate limits, worker/SSE.
3. **Release C:** P1.6–P2.3 — retention/media, Docker/browser smoke, rollback E2E.
4. **Release D:** P2.4–P2.7 — typed boundaries, config, static analysis и карта живости.
5. **Release E:** P3.1–P3.3 — Command Center и упрощение очередей/доменов.
6. **Release F:** P3.4–P3.6 — нормализация, удаление подтверждённого legacy, архитектурные решения только по измеримой пользе.

## Не делать без нового обоснования

- Не мигрировать на Hono: это не закрывает текущие P0/P1-риски.
- Не заменять `Bun.spawn([...])` для ffmpeg на Bun Shell: проблема памяти не исчезнет, а quoting-риски вырастут.
- Не вводить универсальную очередь, общую таблицу jobs или масштабную нормализацию БД до закрытия миграций и идемпотентности.
- Не добавлять GitHub API gate к `web-sync` до подтверждения, что этот deploy-контур вообще используется.
- Не удалять `Dockerfile.patch`, `web-sync`, таблицы или volumes только по статическому поиску.

## Обнаруженные проблемы / что нужно отдельно проверить

- **Nginx-контур приведён к версии в репозитории.** Active topology подтверждена: stream `:443` → TLS `127.0.0.1:4443` → HTTP `127.0.0.1:81` → Alex `:8788`/Maru `:8789`. CI устанавливает эти конфиги, проверяет `nginx -t` и лишь затем reload-ит сервис. Реальный IP передаётся через PROXY protocol и заново записывается в `X-Real-IP` на доверенных переходах.
