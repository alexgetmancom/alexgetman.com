---
обновлено: 2026-06-24
---

# Экосистема бренда

## Контракт бренда

- Главный бренд: `alexgetmancom`.
- Главный домен: `alexgetman.com`.
- Текущий публичный сайт: `https://alexgetman.com`.
- Старый домен `ialexey.ru` должен вести на `alexgetman.com`.
- Основной язык роста: английский.
- Русский язык: активная текущая аудитория и поддерживающее комьюнити.
- `alexgetman.com/` является English-first root; русский раздел живет на `/ru/`.
- Email/newsletter: отложено до завершения базовой настройки соцсетей.

## Текущие публичные ссылки

| Площадка | Ссылка | Роль | Статус |
|---|---|---|---|
| Website | `https://alexgetman.com` | собственный hub | active |
| Threads RU | `https://www.threads.com/@alexgetmancom` | короткие RU-посты / репостинг | active |
| YouTube RU | `https://www.youtube.com/@alexgetmancom` | RU-видео | active |
| Twitch | `https://www.twitch.tv/alexgetmancom` | стримы, сначала RU | active |
| Facebook page | `https://www.facebook.com/profile.php?id=61590942205426` | дополнительная дистрибуция | active, vanity URL pending |
| GitHub | `https://github.com/alexgetmancom` | доверие разработчиков / open-source | active |
| LinkedIn | `https://www.linkedin.com/in/alexgetmancom` | профессиональный профиль | active |
| Instagram RU | `https://www.instagram.com/alexgetmancom/` | RU Reels / визуальная дистрибуция | active |
| Telegram channel | `https://t.me/alexgetmancom` | RU-анонсы / текущая аудитория | active |
| Telegram forum | `https://t.me/+GenGOblinMw3MGVi` | RU-комьюнити и обсуждения | active |
| Discord | `https://discord.gg/Z7sSm56rcb` | комьюнити, будущий EN/RU split | active |

## Решения по площадкам

- По возможности держать один публичный handle: `alexgetmancom`.
- Facebook page URL пока нельзя изменить; целевой vanity URL: `facebook.com/alexgetmancom`, когда станет доступно.
- LinkedIn `alexgetmancom` подтвержден владельцем как рабочий.
- Email/newsletter сейчас не приоритет; вернуться после очистки соцссылок и community-поверхностей.
- Discourse/forum остается будущим планом и не блокирует текущую фазу.

## Content flow contract

### Посты через Telegram controller bot

Source input:

```text
Telegram bot @alexgetman_bot
```

RU flow:

```text
RU content
    -> optional Telegram @alexgetmancom
    -> alexgetman.com /ru/<post_id>/<russian-slug>
    -> Threads RU
```

EN flow:

```text
EN content
    -> English translation
    -> alexgetman.com /<post_id>/<english-slug>
    -> Threads EN
    -> Twitter/X
    -> Facebook
    -> LinkedIn
```

Правила:

- Пост через `@alexgetman_bot` является canonical source; Telegram channel не обязателен.
- Бот делает EN-перевод, показывает RU/EN preview и публикует только после approval владельца.
- Выбор площадок делается пресетами `Full`, `RU only`, `EN only`, `TG only` и галочками доступных targets.
- Текущие доступные targets в bot flow: Telegram, Site RU, Threads RU, Site EN, LinkedIn.
- Capability router показывает format support в preview и предупреждает о partial fallback для video album / mixed media.
- Facebook, X и Threads EN остаются в плане до готовых токенов/подключений и не выбираются в bot flow.
- Прямой пост в Telegram channel больше не является social crosspost trigger; публикация в соцсети идет через bot-approved `publish_queue`.
- Все bot-approved посты идут через единый publishing flow: текст, картинки, видео, captions и media groups.
- RU и EN являются независимыми локалями одного `post_id`; отсутствие одной локали допустимо.
- Site RU и Site EN публикуются только при явно включенном target.
- EN-дистрибуция включает English-first root, Threads EN, Twitter/X, Facebook и LinkedIn.
- Canonical URL: EN `/<post_id>/<english-slug>`, RU `/ru/<post_id>/<russian-slug>`.
- Старые `/posts/*`, `/ru/posts/*` и `/en/*` удалены и возвращают `410 Gone` с `noindex`.
- В bot flow EN-текст проходит human approval.
- EN tone пока не адаптируется: нужен точный перевод без смысловых замен.
- Если в media есть RU-текст на изображении, позже нужна EN-версия media с заменой текста.

### Расписание публикаций (RU + EN)

RU и EN используют независимые хронологические очереди ближайших свободных слотов. Все значения фиксированы по московскому времени (MSK, UTC+3) без сезонного сдвига.

| Направление | Ежедневные слоты (MSK) |
| :---: | :--- |
| RU | `10:37`, `13:37`, `17:37`, `20:37`, `23:37` |
| EN social | `00:37`, `03:37`, `06:37`, `17:37`, `20:37` |

Принципы:
- **Ближайший слот**: Каждый новый draft получает ближайший свободный будущий слот отдельно в RU- и EN-очереди; EN может выйти раньше RU.
- **Лимит**: Не более пяти публикаций каждого направления в календарные сутки MSK.
- **Срочная публикация**: `Publish now` занимает текущую позицию и сдвигает оставшуюся RU- и EN-очередь на один слот вперед.
- **Перенос**: Когда дневные слоты закончились, очередь автоматически продолжается на следующий день.
- **Единый часовой пояс**: Все времена задаются и хранятся как MSK (UTC+3); сезонного сдвига нет.
- **Снайперская минута `:37`**: Все посты выходят строго на `:37` минуте часа.

## Текущая реализация

- `tw-nl` хостит `alexgetman.com` через Nginx и статический output Astro.
- Единый posting stack живет на `tw-nl` в `/opt/alexgetman-posting` и синхронизируется с GitHub repo `alexgetmancom/alexgetman-posting`. Инструкции по управлению стеком, схемы БД, CLI-скрипты диагностики/перезапуска и SQL-запросы описаны в Workspace Skill [ops-guide](file:///Users/alex/projects/infra-agent/.agents/skills/ops-guide/SKILL.md).
- Docker service `alexgetman-site-feed` принимает Telegram webhook traffic через FastAPI/uvicorn и пересобирает/синхронизирует Astro site.
- Docker service `alexgetman-posting-app` запускает social bridge, Telegram controller bot, metrics scheduler и observability loop в одном Python process через `posting/app.py`.
- Local Telegram Bot API работает отдельным sidecar в том же compose.
- Social bridge публикует независимые targets асинхронно, чтобы одна медленная площадка не блокировала остальные.
- Production social targets в `telegram-to-threads`: Threads RU, Facebook Page и LinkedIn включены.
- Сайт публикует страницы постов, `feed.json`, `feed.xml`, sitemap, `llms.txt`, contacts, FAQ, stats, pipeline status и базовый likes API.
- Pipeline history и cached metrics хранятся в SQLite на `tw-nl`: `/opt/alexgetman-posting/data/pipeline.db`.
- SQLite DB также хранит lifecycle, events, media assets, platform rules, credential checks, content memory и analytics rollups.
- Private Command Center доступен на `https://alexgetman.com/command-center` и закрыт private auth.
- Command Center объединяет owner-facing Pipeline tab с repair/queue/credentials/diagnostics tabs; `/pipeline-status` остается read-only shortcut.
- Command Center умеет смотреть drafts/queue/errors/credentials/capabilities и запускать retry/republish, EN edit, EN media JSON replacement и RU-media fallback через общий repair service.
- Telegram controller bot живет внутри Docker service `alexgetman-posting-app`.
- Bot approval пишет canonical publication, locale records, routing plan и очередь в SQLite first (`publications`, `post_locales`, `publication_plans`, `publication_sources`, `publish_jobs`, `site_jobs`).
- Bot preview предлагает `Publish now` и `Schedule`; отложка независимо занимает ближайшие RU- и EN-слоты с лимитом пять публикаций каждого направления в день.
- Команда `/schedule` показывает будущие посты; до публикации их можно открыть и изменить content, media и targets, после чего очередь пересчитывается.
- RU и EN targets могут публиковаться независимо по своим слотам; Telegram message ID не является идентификатором поста и не нужен для EN-only.
- Telegram formatting сохраняется через entities; сайт получает эквивалентный безопасный HTML.
- Сайт строит RU/EN posts напрямую из canonical bot-approved source без Telegram channel scrape.
- Metrics loop внутри `alexgetman-posting-app` обновляет SQLite cache для pipeline status; страница `/pipeline-status` не ходит во внешние API при открытии.
- Observability loop внутри `alexgetman-posting-app` читает control-plane events и отправляет owner alerts по fresh warn/error.
- AI-facing exports публикуются как `content-index.json` и `content-memory.md`.
- Главная страница работает как hub `alexgetmancom`: hero, новости/статьи, проекты, ecosystem links и Telegram feed.
- Страница `/projects/` публикует публичные проекты и ссылки на GitHub.
- Раздел `/ru/` реализован как публичная RU-структура с RU feed и страницами постов.
- English content живет в root; отдельного `/en/` больше нет.
- Root `feed.xml`, `feed.json`, `llms.txt` и `index.md` являются English-first; RU feeds остаются на `/ru/feed.xml` и `/ru/feed.json`.
- Sitemap, canonical и hreflang публикуют только реально существующие локали по новым URL.
- `vm106` больше не запускает active posting/media automation.
- Текущая автоматическая дистрибуция подтверждена: Telegram source post попадает на website и в Threads.
- Posting bridge уже умеет текст/caption, photo, video, media groups, нормализацию видео и временный staging на VPS.
- SQLite schema заложена под историческую базу контента: `posts`, `post_targets`, `post_metrics`, `metric_samples`, `metric_schedule`.
- Durable ops schema используется для queue/state migration: `publish_jobs`, `publish_plans`, `site_source_items`, `site_jobs`, `worker_state`, `ops_actions`; JSON runtime files пока сохраняются как compatibility mirrors.
- Capability matrix по форматам постов и площадкам хранится в SQLite `/opt/alexgetman-posting/data/pipeline.db`: `media_test_cases`, `media_test_results`, `platform_capabilities`.

## Известные пробелы

- Сайт уже English-first, но нужна следующая итерация storytelling/design как полноценного ecosystem hub `alexgetmancom`.
- Разделение `/en` и `/ru` реализовано; нужна следующая итерация site EN media replacement, чтобы EN site мог использовать отдельные EN visuals.
- Нет отдельного Threads EN / Twitter/X automation для EN-постов.
- Threads EN еще не создан.
- Twitter/X API-доступ есть у владельца; значения доступа не фиксируются в repo.
- Facebook Page automation в daemon есть, но текущий Page access протух; нужен устойчивый system-user access.
- LinkedIn automation включена в production daemon.
- LinkedIn analytics permission пока не выдан; publishing работает, post-level views не подтягиваются.
- EN media replacement используется для EN social crosspost и доступен через bot / Command Center JSON; site EN пока использует media исходного channel post.
- Pipeline status page читает SQLite cache и показывает Telegram/site/Threads views; нужна следующая итерация external metrics для Facebook/LinkedIn/X по сохраненным post IDs.
- Posting/media automation перенесена с `vm106` на `tw-nl` / `5.129.238.194`.
- Для Facebook позже нужно настроить vanity URL.
- Newsletter/email capture намеренно отложен.

## Ближайший план

1. Проверить первый реальный post через `@alexgetman_bot`: draft -> EN preview -> approval -> channel -> site -> Threads RU -> LinkedIn -> pipeline status.
2. Подключить отдельные EN media к site EN, чтобы owner мог вручную заменить картинку/видео и на сайте.
3. Получить новый устойчивый Facebook Page access и вернуть Facebook target в bot flow.
4. Подключить X и Threads EN после готовых credentials/accounts.
5. Улучшить media groups на site side, если Telegram webhook порядок даст неполное объединение альбомов.
6. Позже вернуться к email/newsletter и Discourse после стабилизации social surfaces.

## Лог работ

### 2026-06-25 - Canonical post IDs, независимые локали и новые URL

- Изменено: Telegram message ID отвязан от identity поста; добавлены `publications`, `post_locales`, `publication_plans`, `publication_sources`, а первый новый production post получит `post_id=1`.
- Изменено: Добавлены `EN only`, optional Telegram, strict Site RU/Site EN routing, список и редактирование отложенных постов, сохранение Telegram entities и site HTML.
- Изменено: EN URL переведен на `/<post_id>/<english-slug>`, RU на `/ru/<post_id>/<russian-slug>`; старые `/posts/*`, `/ru/posts/*`, `/en/*` возвращают `410 Gone`.
- Проверка: migration `20260625_0004`, `49` tests, Astro build, production smoke, Nginx reload и HTTP checks прошли; canonical feed очищен от legacy history.

### 2026-06-25 - Независимые RU/EN очереди и Facebook video metrics fallback

- Изменено: Отложка использует независимые ближайшие RU- и EN-слоты; EN social может выйти раньше Telegram RU.
- Изменено: `Publish now` сдвигает обе оставшиеся очереди на один слот; отмена compact-ит ещё не опубликованные jobs.
- Изменено: Для Facebook video/Reels metrics добавлен fallback через `video_insights.fb_reels_total_plays`, а likes/comments читаются через video edges.
- Проверка: migration `20260625_0003`, `41 pytest`, production smoke и `ssh tw-nl s` прошли; для поста `430` получены Facebook views `15` EN и `3` RU.

### 2026-06-24 - Внедрена отложенная публикация по MSK-сетке

- Изменено: В controller bot добавлен выбор `Publish now` / `Schedule`.
- Изменено: Scheduled drafts автоматически распределяются по фиксированной RU + EN таблице до пяти постов в день; все значения задаются в MSK без сезонного сдвига.
- Изменено: Telegram/RU surfaces публикуются в RU-слот, Site EN и EN social targets становятся due в парный EN-слот.
- Изменено: В SQLite добавлены `drafts.scheduled_at`, `drafts.scheduled_en_at` и `publish_jobs.publish_at`; retry продолжает использовать отдельный `next_attempt_at`.
- Проверка: migration `20260624_0002`, `39 pytest`, production smoke, stack health-check, bot keyboard, MSK slot calculation и Astro rebuild прошли успешно.

### 2026-06-22 - FastAPI entrypoint, unified ops dashboard и app lifecycle

- Изменено: Posting runtime сокращен до трех Docker services: `alexgetman-telegram-bot-api`, `alexgetman-posting-app`, `alexgetman-site-feed`.
- Изменено: `alexgetman-posting-app` объединяет bridge, controller bot, metrics scheduler и observability loop в одном Python process через `posting/app.py`; subprocess supervisor удален из production path.
- Изменено: `alexgetman-site-feed` переведен с ручного `BaseHTTPRequestHandler` на FastAPI/uvicorn без смены service name, port и Nginx entrypoints.
- Изменено: `/command-center` объединяет Pipeline, Repair, Queue, Credentials и Diagnostics; `/pipeline-status` сохранен как read-only shortcut.
- Изменено: Добавлен общий repair service для retry/republish, EN edit и EN media replacement; `postingctl` использует тот же слой.
- Изменено: В SQLite добавлены durable ops/queue tables `publish_jobs`, `publish_plans`, `site_source_items`, `site_jobs`, `worker_state`, `ops_actions`; JSON compatibility mirrors сохранены.
- Изменено: `scripts/post-tool` стал deprecated wrapper над `postingctl`; legacy edit-логика перенесена в общий repair service.
- Проверка: production deploy прошел; `ssh tw-nl s`, stack health-check, `/pipeline-status`, `/api/pipeline-status`, private `/api/ops-dashboard`, `post-tool status`, `postingctl status` и app health snapshot проверены.

### 2026-06-21 - Внедрен content/control plane

- Изменено: В production добавлен private Command Center для управления draft/queue/lifecycle/errors/credentials/capabilities.
- Изменено: В SQLite добавлены lifecycle, post events, media assets, platform rules, credential checks, content memory и analytics rollups.
- Изменено: Social bridge переведен на async target fan-out, добавлена cleanup политика для staged media.
- Изменено: Controller bot получил capability routing preview для форматов постов.
- Изменено: Публичные AI-facing exports `content-index.json` и `content-memory.md` строятся из content memory.
- Проверка: production smoke прошел; Command Center auth и JSON API проверены; observability worker запущен.

### 2026-06-20 - Posting stack перенесен в alexgetman-posting repo

- Изменено: Production runtime объединен в `/opt/alexgetman-posting` и GitHub repo `alexgetmancom/alexgetman-posting`.
- Изменено: В одном Docker compose работают Bot API, social bridge, controller bot, metrics worker и site feed.
- Изменено: Старый systemd `ialexey-feed` отключен; старые `/opt/telegram-to-threads` и `/opt/telegram-bot-api` больше не являются production entrypoint.
- Проверка: `https://alexgetman.com/pipeline-status` и `/api/pipeline-status` возвращают `200`; `ssh tw-nl s` показывает новые `alexgetman-*` service names.

### 2026-06-20 - Исправлен LinkedIn image crosspost

- Исправлено: LinkedIn image upload теперь поддерживает direct `uploadUrl` из `initializeUpload`.
- Исправлено: LinkedIn multi-image post использует `content.multiImage` и загружает несколько изображений вместо публикации только первого.
- Изменено: Старый direct Telegram flow в `telegram-to-threads` выключен по умолчанию; bridge только сдвигает Telegram offset, а social publishing делает `publish_queue` от `@alexgetman_bot`.
- Результат: Post 414 допубликован в LinkedIn; T03 retest post 419 прошел через LinkedIn multiImage.

### 2026-06-20 - Сайт подключен к bot-approved source

- Изменено: `@alexgetman_bot` сохраняет approved RU/EN content и media в `site_source.json`.
- Изменено: `ialexey-feed` автоматически watches `site_source.json`, синхронизирует его в site `feed.json`, скачивает media через credential controller bot и пересобирает RU/EN post pages.
- Проверка: временные posts 44/45 появились на сайте в RU и EN, затем были удалены; после очистки тестовые URL возвращают `404`.

### 2026-06-20 - Bot flow подготовлен к проверке media matrix

- Изменено: `@alexgetman_bot` принимает albums/media groups и хранит media по новому списочному контракту.
- Изменено: Добавлена команда `/testplan` с форматом тестов: text, single media, multiple media и mixed media.
- Изменено: Добавлена SQLite capability matrix; `T02 Text + picture` отмечен как `pass` по post 414 для Telegram, Site RU, Site EN, Threads RU и LinkedIn.
- Проверено: `T01 Text only`, `T02 Text + picture` и `T03 Text + 2 pictures` прошли через новый bot flow; для LinkedIn multi-image нужен `content.multiImage`.

### 2026-06-20 - Сайт переведен в English-first SEO mode

- Изменено: `https://alexgetman.com/` стал английской главной страницей бренда.
- Изменено: `/ru/` оставлен русской главной, старые `/posts/<id>/` продолжают редиректить на `/ru/posts/<id>/`.
- Изменено: EN/RU post pages получили корректные `lang`, canonical и `hreflang`.
- Изменено: Root feeds и AI-facing файлы `llms.txt` / `index.md` переведены на English-first.
- Изменено: Добавлен рабочий `/sitemap.xml`; sitemap больше не публикует legacy `/posts/<id>/`.
- Изменено: `ialexey.ru` и HTTP redirects сохраняют path и ведут на `alexgetman.com`.

### 2026-06-20 - Внедрен Telegram controller bot для approval flow

- Изменено: На `tw-nl` добавлен Docker service `controller-bot` для `@alexgetman_bot`.
- Изменено: Бот ограничен whitelist владельца, принимает draft text/photo/video, делает EN-перевод, показывает preview и публикует после approval.
- Изменено: Добавлены пресеты `Full`, `RU only`, `TG only` и target toggles для Telegram, Site RU, Threads RU, Site EN и LinkedIn.
- Изменено: Bot flow пишет `publish_plan.json`; `ialexey-feed` и `telegram-to-threads` используют его для approved EN-текста и выборочной публикации targets.
- Ограничение: Отдельная EN media replacement используется для EN social crosspost, но еще не используется для site EN.

### 2026-06-20 - Production history baseline установлен на post 414

- Изменено: Тестовая история bot-flow удалена из pipeline DB, feed/site output и runtime routing files.
- Изменено: `/pipeline-status` и metrics worker используют baseline `414`.
- Результат: Production tracking начинается с Telegram post 414.

### 2026-06-19 - Добавлена историческая SQLite база и metrics worker

- Изменено: На `tw-nl` добавлен `/opt/telegram-to-threads/pipeline_metrics.py` и Docker service `metrics-worker`.
- Изменено: Создана SQLite база `/opt/telegram-to-threads/data/pipeline.db` с таблицами для posts, targets, current metrics, metric samples и future schedule.
- Изменено: `/pipeline-status` и `/api/pipeline-status` читают готовый SQLite cache, добавлена колонка Telegram и отображение views под площадками.
- Результат: Site RU/EN views берутся из локального `metrics.json`; Telegram views обновляются фоново из публичного `t.me/s/alexgetmancom`; страница открывается без live API calls.

### 2026-06-19 - Facebook и LinkedIn переведены на EN-only crosspost

- Изменено: `telegram-to-threads` для Facebook и LinkedIn берет только `text_en` из feed data.
- Изменено: Если английский перевод не найден за короткое ожидание, Facebook/LinkedIn не публикуются, чтобы русский текст не уходил в EN-площадки.
- Результат: LinkedIn post 408 обновлен на английский через LinkedIn Posts API partial update.

### 2026-06-19 - Подключены Threads metrics в pipeline DB

- Изменено: `metrics-worker` читает Threads Insights API по сохраненному `threads_ru.external_id`.
- Изменено: В SQLite сохраняются `views`, `likes`, `replies`, `reposts` и `quotes`; pipeline status показывает `views`.
- Результат: Post 408 начал показывать Threads RU views в `/pipeline-status`.

### 2026-06-20 - Включен decay scheduler для metrics refresh

- Изменено: `metrics-worker` использует `metric_schedule` и опрашивает только due targets, а не все посты за каждый цикл.
- Правило: до 12 часов - 15 минут; старше 12 часов - 1 час; старше 24 часов - 2 часа; старше 7 дней - 12 часов; старше 30 дней - 1 день; старше 3 месяцев - freeze.
- Ограничение: за один цикл обрабатывается не больше `MAX_METRIC_TASKS_PER_CYCLE`.

### 2026-06-20 - Pipeline history baseline перенесен на post 408

- Изменено: SQLite history очищена от постов ниже 408; backup оставлен рядом с DB на сервере.
- Изменено: `metrics-worker` и `/pipeline-status` используют baseline `PIPELINE_BASELINE_MESSAGE_ID=408`.
- Результат: `/pipeline-status` показывает production history начиная с post 408.

### 2026-06-20 - Улучшен pipeline status UI

- Изменено: В `/pipeline-status` добавлены отдельные колонки `Text RU` и `Text EN`.
- Изменено: Метрики площадок стали ссылками на конкретный пост там, где доступен URL или external ID.

### 2026-06-19 - Интеграция LinkedIn Chunked Video и улучшение правил разметки

- Изменено: Добавлена поддержка поблочной загрузки (chunked upload) видео в LinkedIn для файлов крупного размера (>10MB) с опрашиванием статуса `AVAILABLE` перед выходом поста.
- Изменено: Настроено автоматическое удаление первого эмоджи для Facebook и LinkedIn в `telegram_to_threads.py`.
- Изменено: Добавлено правило в системные промпты DeepSeek в `collector.py` для запрета двойных дефисов (`--`) и длинных тире (`—`) с принудительным использованием только одинарных дефисов (`-`).
- Результат: Успешно опубликованы тестовые видео-посты в LinkedIn и Facebook с чистым текстом без первого смайлика и проверочных суффиксов. Обновлен токен Facebook Page на сервере.

### 2026-06-19 - Facebook и LinkedIn включены в production daemon

- Изменено: В `/opt/telegram-to-threads/secrets.env` на `tw-nl` включены `ENABLE_FACEBOOK=true` и `ENABLE_LINKEDIN=true`.
- Изменено: Из Docker mount bridge удален SSH key, так как media staging теперь работает через локальный `/media/threads`.
- Проверка: `telegram-to-threads` пересоздан и запущен; runtime flags показывают `ENABLE_THREADS=true`, `ENABLE_FACEBOOK=true`, `ENABLE_LINKEDIN=true`, `REMOTE_MEDIA_PATH` local.

### 2026-06-19 - Настроена и протестирована интеграция с LinkedIn API

- Изменено: Успешно получена авторизация LinkedIn и Member URN (`urn:li:person:m1q4dRUYGd`).
- Проверка: Тестовый пост опубликован на профиле LinkedIn через REST API (возвращен HTTP 201).
- Состояние: Ключи сохранены в `secrets.env` на сервере и локально в `ops-secrets`, функция оставлена отключенной (`ENABLE_LINKEDIN=false`) до решения владельца.

### 2026-06-19 - Запущен перевод постов на английский язык (DeepSeek API)

- Изменено: В коллектор `ialexey-feed` интегрирован API-клиент DeepSeek для автоматического перевода входящих постов.
- Изменено: Добавлен фоновый перевод отсутствующих постов на старте службы и ручная команда `translate`.
- Изменено: В Astro-проекте созданы шаблон страницы `/en/posts/[id].astro` и генератор `/en/feed.json.js`.
- Результат: Вся база постов переведена на английский язык, `/en/feed.json` и страницы `/en/posts/<id>/` доступны в веб-интерфейсе.

### 2026-06-19 - Обновлен публичный слой alexgetmancom

- На `alexgetman.com` обновлены публичные social/community links с `iAlexeyRu` на `alexgetmancom`.
- Добавлен блок `Экосистема alexgetmancom` на главную страницу.
- Обновлена страница контактов: Telegram channel, Telegram forum, Threads, YouTube, Discord, Twitch, GitHub, LinkedIn, Instagram, Facebook и email.
- Оставлено: source feed и Habr parsing продолжают использовать старые source identifiers, чтобы не ломать текущий content pipeline.

### 2026-06-19 - Главная стала hub и добавлены Projects

- Главная страница получила hero `alexgetmancom` с позиционированием `AI, development, automation и self-hosted проекты`.
- Добавлен блок `Проекты` на главную страницу.
- Добавлена страница `/projects/` с публичными проектами GitHub: `miband-bot`, `ialexey.ru`, `Codex-dictation-fix`, `openclaw-alex`, `infra`, `nexus_bot`.
- В навигацию добавлен пункт `Проекты`.

### 2026-06-19 - Зафиксирован Telegram publishing contract

- Source input для постов: Telegram `@alexgetmancom`.
- RU flow: Telegram `@alexgetmancom` -> site `/ru` -> Threads RU.
- EN flow: RU post -> English translation -> site `/en` -> Threads EN -> Twitter/X -> Facebook -> LinkedIn.
- Все Telegram-посты должны идти через единый flow: текст, картинки, видео, captions и media groups.
- Все из `@alexgetmancom` публикуется автоматически.
- Сначала добивается RU flow; EN social targets отложены.

### 2026-06-19 - Добавлены языковые разделы сайта

- На `alexgetman.com` добавлены `/ru/`, `/ru/feed.json`, `/ru/feed.xml` и страницы `/ru/posts/<id>/`.
- На `alexgetman.com` добавлены `/en/` и `/en/feed.json` как стартовая структура для переводного flow.
- Старые URL постов сохранены для совместимости.

### 2026-06-19 - Уточнены решения по автоматизации

- Старый Telegram URL переименован в `@alexgetmancom`; новые посты должны считаться официальным source.
- Старые `/posts/<id>/` нужно перевести на `/ru/posts/<id>/`.
- Перевод EN должен быть автоматическим, без ручного approval; тон пока простой, без адаптации.
- Facebook публикуется именно в Page, уже настроенную в сервисе.
- LinkedIn и EN social targets пока не являются ближайшей задачей.
- Нужна pipeline status page.
- Posting/media automation нужно перенести с `vm106` на `tw-nl` / `5.129.238.194`.

### 2026-06-19 - Выполнен перенос RU flow на tw-nl

- `telegram-to-threads` и local Telegram Bot API перенесены на `tw-nl` / `5.129.238.194`.
- Active posting containers на `vm106` остановлены.
- `ialexey-feed` переключен на `alexgetmancom`.
- `/posts/<id>/` теперь перенаправляется на `/ru/posts/<id>/`.
- Добавлены `/pipeline-status` и `/api/pipeline-status`.
- Post pages умеют отображать `media[]` с image/video.
