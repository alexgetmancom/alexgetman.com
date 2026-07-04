# План развития alexgetman.com

Документ фиксирует актуальный roadmap сайта `alexgetman.com` после перехода на canonical post model, новых URL и результата `isitagentready.com` **100/100 Level 5 Agent-Native**.

## Текущий статус

- Домен: `alexgetman.com`.
- Основной язык роста: EN в корне сайта `/`.
- Русский раздел: `/ru/`.
- Посты имеют собственный canonical `post_id`, независимый от Telegram message ID.
- URL постов:
  - EN: `/<post_id>/<english-slug>/`
  - RU: `/ru/<post_id>/<russian-slug>/`
- Старые Telegram-номера `430/440/...` не должны использоваться как публичная нумерация сайта.
- `isitagentready.com`: **100/100**, Level 5 Agent-Native. Дальше цель не “догнать оценку”, а сохранить её без деградации при развитии сайта.
- `ialexey.ru`: SEO-ценности, трафика и важных статей нет. Стратегия: **полный разрыв со старым брендом без 301/302**.

## Принципы

1. `alexgetman.com` является первоисточником контента.
2. Telegram не является source of truth. Он может появляться только как канал публикации, ссылка на обсуждение или комьюнити.
3. Все публичные страницы, feeds, sitemap, JSON-LD и markdown endpoints должны ссылаться на canonical URL сайта.
4. Внешние платформы получают ссылку на сайт, а не наоборот.
5. EN-first: английский контент в корне, RU только под `/ru/`.
6. Операционный rename путей на сервере делаем только если он даёт реальную пользу, а не ради косметики.
7. EN и RU версии публичного сайта должны использовать один и тот же UI/UX каркас. Отличаться могут только язык интерфейса, локализованные тексты, URL, даты, категории и набор доступных постов. Нельзя развивать `/` и `/ru/` как разные дизайны.

## Почему Telegram ещё может мелькать

Telegram допустим в трёх местах:
- как platform target в pipeline/Command Center;
- как ссылка `Discuss in Telegram` / `Обсудить в Telegram`;
- как Telegram channel/community в контактах.

Telegram не должен мелькать как:
- `original source`;
- `isBasedOn` в Schema.org;
- источник RSS/feed описаний;
- основа публичной нумерации постов;
- обязательный backend для EN-only/RU-only публикаций.

Если где-то в публичном HTML, RSS, JSON-LD, `.well-known`, `llms.txt`, `index.md` или markdown endpoint текст всё ещё говорит “Telegram source/original”, это баг и его надо убирать.

## Активный план: ИИ-оптимизация (AI-SEO / AIO)

### Шаг 1. Перевод ссылок в `llms.txt` на `.md` версии постов
Динамические Markdown-версии страниц уже созданы, но ссылки в фиде для моделей ведут на стандартный HTML.
- **Реализация**: Обновить генератор [llms.txt.js](file:///Users/alex/projects/alexgetman.com/apps/web/src/pages/llms.txt.js) (строка 45), чтобы ссылки вели на эндпоинты с `.md`.

### Шаг 2. Расширенный фид для ИИ-моделей (`/feed-ai.json`)
Стандартный `feed.json` не содержит специфических метаданных для ИИ.
- **Реализация**: Создать эндпоинт `/feed-ai.json`. Добавить для каждого поста:
  - `tldr` или `summary`: краткое резюме поста (1-2 предложения).
  - `key_entities`: список ключевых технологий, нейросетей, брендов.
  - `actions`: ссылки на внешние репозитории или источники.

### Шаг 3. Аналитика и мониторинг активности ИИ на дашборде
Отслеживание запросов от ИИ-агентов для понимания их интересов.
- **Реализация**:
  - Отфильтровать запросы Nginx от ботов: `OAI-SearchBot`, `GPTBot`, `ClaudeBot`, `Perplexibot`.
  - Сохранять количество запросов в базу `pipeline.db` (новая метрика `ai_hits`).
  - Вывести метрику в Command Center отдельной колонкой 🤖 `AI Hits`.

### Шаг 4. Автоматическая генерация тегов `alt` для изображений
Улучшение семантической разметки картинок для поисковых роботов.
- **Реализация**: В компонентах [StoryVisual.astro](file:///Users/alex/projects/alexgetman.com/apps/web/src/components/home-news/StoryVisual.astro) и [StoryRail.astro](file:///Users/alex/projects/alexgetman.com/apps/web/src/components/home-news/StoryRail.astro) заменить пустой атрибут `alt=""` на динамический `alt={activePost.title}`.

### Шаг 5. Поддержка Markdown Negotiation (Accept: text/markdown)
Автоматическая отдача Markdown-версии страницы, если клиент запрашивает её в заголовках.
- **Реализация**: В Nginx-конфигурации (`ialexey-cache.conf`) настроить обработку заголовка `Accept`: если пришёл `Accept: text/markdown`, делать внутреннее перенаправление с `/` на `/index.md`, а с `/{postId}/{slug}/` — на `/{postId}/{slug}.md`.

### Шаг 6. Проверка и настройка HTTP Link Headers
- **Реализация**: Убедиться, что на сервере в глобальном `nginx.conf` настроена переменная `$link_header`, содержащая ссылки на `api-catalog`, `agent-skills` и `llms.txt`.

## Отложено

Эти задачи не делаем в ближайшем спринте, чтобы не тратить время на низкий ROI или высокий операционный риск.

- [ ] Полный rename production paths `/home/deploy/ialexey-web` -> `/home/deploy/alexgetman-web` без отдельной необходимости.
- [ ] Прямое чтение production SQLite из Astro build через `better-sqlite3`/Drizzle.
- [ ] Перевод Astro build на HTTP API как единственный source of truth.
- [ ] Emoji reactions под постами: вернуться отдельно, когда будет понятна privacy/антиспам модель и реальная польза для retention.
- [ ] Логичные `<h2>/<h3>` внутри постов: делать только после надежного правила разметки, не эвристикой ради HTML.
- [ ] Полная поддержка media inside body для Dev.to: пока используем только cover image, чтобы не плодить отдельный upload/hosting слой.
- [ ] Pinterest API automation.
- [ ] Reddit automation до стабильного аккаунта и понятного moderation strategy.
- [ ] TikTok/Reels/Shorts automation.
- [ ] npm package ради backlink.
- [ ] Docker Hub image ради backlink.
- [ ] Boosty/монетизация.
- [ ] Новые языки (`es`, `zh`) до стабилизации EN/RU.
