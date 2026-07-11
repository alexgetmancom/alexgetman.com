# План Production Parity и эксплуатации

| Задача | Зачем и критерий готовности | Состояние |
| --- | --- | --- |
| 48. Intelligent Registry-based deploy (ВЫСШИЙ ПРИОРИТЕТ) | GitHub Actions пушит образ в GHCR и триггерит деплой. Скрипт на сервере проверяет здоровье `/readyz` нового контейнера. В случае сбоя — авто-откат на стабильный хэш. Бот шлет статус в Telegram с инлайн-кнопкой «Откатить» для ручного отката в 1 клик. | Частично: CI публикует immutable digest с BuildKit GHA cache; deploy-agent, readiness и rollback protocol реализованы и покрыты test. Нужна установка агента и проверка на VPS. |
| 1. Legacy parity matrix | Сверить каждый крупный Python-модуль из git history с TS-модулями, тестами и production-путями; незакрытые функции имеют отдельные строки ниже. | В работе |
| 2. schema.py -> DB schema | Сверить все legacy tables, columns, indexes и constraints с `schema.ts` на fixture и production-readonly базе. | Частично |
| 3. meta.py -> Meta clients | Сверить Facebook, Instagram и Threads payloads, auth, media upload и error mapping с legacy реализацией. | Не начато |
| 4. command_center_ui.py -> Dashboard | Сверить все страницы, actions, auth, pipeline fields и UX Command Center. | Частично |
| 5. pipeline.py -> Queue/worker | Сверить locks, retries, scheduling, stale recovery, metrics и site jobs с legacy pipeline. | Частично: queue, retry/stale recovery и site jobs покрыты; pipeline-status переведен с legacy union query на Drizzle reads. Нужна parity-сверка с production fixture. |
| 6. controller/schedule.py -> bot schedule | Сверить расписание, MSK slots, rebalance и ручное изменение времени. | Частично: rebalance теперь читает занятые слоты одним запросом вместо запроса на каждый день; нужна сверка всех legacy edge cases. |
| 7. Legacy test suite coverage | Для каждой перенесённой критической функции добавить TS test либо явно зафиксировать непереносимый integration test. | В работе |
| 10. Shared media cache | Один download/transcode/stage на пост и локаль, без параллельных ffmpeg и дублирующих файлов. | Частично |
| 11. Durable media cache | Кэш media переживает процесс и безопасно очищается только после всех target jobs. | Не начато |
| 12. Media resource limits | ffmpeg и worker имеют CPU/RAM/pids limits, чтобы не положить VPS или сеть. | Частично |
| 15. Retry/backoff policy | Единые bounded retries, retryable errors и observability для всех target clients; legacy payload fallbacks удалены после wire-format audit. | Частично |
| 23. Channel stories | Telegram Stories публикуются только в настроенный channel peer, URL и peer подтверждаются integration test. | Частично |
| 25. Instagram stories | RU/EN credentials, public media URL, status polling и failure mapping покрыты тестами. | Не начато |
| 26. Social repair | Edit/retry published targets обновляет поддерживаемые внешние сети либо явно сообщает unsupported target. | Не начато |
| 28. `/schedule` bot command | Админ видит scheduled drafts и может открыть/изменить их через inline keyboard. | Частично |
| 29. Bot architecture and business updates | `bot.ts` разделён на handlers/albums/drafts; Business Connection updates либо обрабатываются, либо feature полностью отключён и документирован. | Частично: transport, callbacks, albums, drafts и preview разделены; Business Connection audit остаётся. |
| 30. Target visibility verification | Bluesky и другие SPA targets проверяются через platform API, не только HTTP 200. | Не начато |
| 32. Pipeline status API | `/pipeline-status` и `/api/pipeline-status` показывают реальные jobs, loops, errors, metrics и git revision. | Частично |
| 33. Command Center dashboard | Dashboard соответствует данным pipeline API, защищён auth и имеет action/error states. | Частично |
| 34. Dashboard live updates | SSE/MCP feed подключён к Dashboard либо заменён polling с корректными refresh/error states. | Не начато |
| 35. SQLite parity and safety | WAL, busy timeout, fixture compatibility и production-readonly schema audit подтверждены. | Частично |
| 36. Safe DB migrations | Baseline migrations создаются из существующей DB без destructive `push`; apply проверяется на копии production DB. | Не начато |
| 37. Typed DB boundary | Приоритетные raw SQL в publish/site jobs получают typed repositories; `SqliteCompat any` сокращается. | Частично: publish/site jobs, worker, pipeline status, maintenance, MCP и content index переведены на Drizzle. Остались только низкоуровневые SQLite queries для metadata/Drizzle migrations и JSON-boundary в bot/actions/observability. |
| 38. Config and deploy-path audit | Удалить/объяснить `CONTROLLER_DB`, baseline constants и обязательные env; исправить `web-sync` old-brand defaults; Zod fail-fast покрыт тестами. | Не начато |
| 39. Web canonical parity | EN root, RU `/ru`, canonical URLs, feeds, sitemap и JSON-LD не используют Telegram как source. | Не начато |
| 41. AI-ready content | `llms.txt` использует Markdown URLs, добавлен `feed-ai.json`, image alt и AI analytics имеют данные/тесты. | Частично |
| 42. Markdown and Link headers | Markdown negotiation и HTTP Link headers проверяются end-to-end после deploy. | Требует проверки |
| 47. Lean ffmpeg runtime | Выбрать проверенный Debian slim или минимальный codec build; H.264/AAC/MP4 и poster generation проходят media tests. | Не начато |
| 50. Code quality gates | Biome, Knip, staged hook, typecheck, unit/integration tests, Docker smoke test и browser checks обязательны в CI. | Частично: Lefthook, typecheck, Bun tests и SSR build есть; Docker/browser и устранение накопленных Biome ошибок остаются. |
| 57. Zod Env Validator | Валидировать конфигурацию и ключи API в `.env` при старте приложения с помощью схем Zod. Оценка: Не дрочь (9/10, уберет скрытые падения при деплое). | Частично |
| 64. Bun Shell for FFmpeg | Использовать нативный Bun Shell (`await $`ffmpeg ...``) для запуска процессов транскодинга вместо сложного спавна `child_process`/`Bun.spawn`. | Не начато |
| 66. Workspaces production prune | Заменить хрупкий хардкод-клининг `rm -rf` в Dockerfile на bun workspaces production prune для надежной очистки devDependencies из монорепозитория. | Не начато |
| 67. Safe frontend deploy gate | Защитить web-sync.ts от деплоя сломанного кода при падении CI. Добавить запрос к GitHub API на статус проверок коммита перед git pull, либо перевести на push-модель из CI. | Не начато |

## Правила исполнения

1. Пункт становится `Готово` только после кода, релевантного теста и проверки production/fixture там, где это применимо.
2. `Частично` означает, что часть реализации уже есть, но критерий строки ещё не доказан целиком.
4. VPS не собирает Docker images. Сборка и тесты происходят в CI, сервер только получает готовый immutable image.
