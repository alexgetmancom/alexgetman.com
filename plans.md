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

## Ближайший спринт: Critical Correctness

- [x] Удалить/отключить публичные следы `ialexey.ru`, `ialexey`, `iAlexey`, `ialexeyru` там, где они видны пользователям, поисковикам или ИИ-агентам.
- [ ] Убрать 301/302 редиректы `ialexey.ru -> alexgetman.com` в Nginx/Cloudflare, если домен ещё обслуживается.
- [x] Проверить, что старые post routes возвращают корректный `410 Gone` и `noindex`:
  - `/posts/*`
  - `/ru/posts/*`
  - `/en/*`
- [x] Проверить, что `/pipeline-status` и Command Center используют только canonical `post_id`, без Telegram ID как номера поста.
- [x] Проверить, что sitemap, feeds, `llms.txt`, `index.md`, markdown endpoints и JSON-LD используют только новые canonical URL.
- [x] Убрать любые “original Telegram post/source” формулировки из публичного сайта.
- [x] Оставить Telegram-ссылки только как discussion/community links.

## SEO Foundation

- [x] Создать `/about` и `/ru/about`.
  - EN: Alex Getman, Almaty, Kazakhstan, AI mentor, technology consultant, DevOps/self-hosted background.
  - RU: Алексей Гетманец, Алматы, Казахстан, ИИ-ментор, IT-консультант, DevOps/self-hosted background.
  - Без Москвы/России в bio/meta/schema.
- [x] Создать Privacy Policy на EN и RU.
  - Указать Alex Getman и `i@alexgetman.com`.
  - Описать Giscus, likes, hashed IP, analytics без лишних персональных данных.
- [x] Создать кастомную `404.astro`.
- [x] Проверить `robots.txt`: sitemap и agent signals уже отдаются через `src/pages/robots.txt.js`.
  - Sitemap: `https://alexgetman.com/sitemap-index.xml`.
  - Сохранить совместимость с текущим `isitagentready.com` 100/100.
- [x] Добавить/проверить `manifest.json` и `theme-color`.
- [x] Исправить Schema.org `Article`:
  - убрать `isBasedOn`, если ещё есть;
  - добавить обязательное `image`;
  - author/publisher должны быть `Alex Getman` / `alexgetman.com`;
  - canonical URL должен вести на сайт.
- [x] Ограничить meta description постов до 155-160 символов.
- [ ] Проверить OpenGraph/Twitter image для постов.
- [x] Ленивая загрузка Giscus через IntersectionObserver.

## Public Brand Cleanup

- [x] Проверить и вычистить старые домены в:
  - `public/.well-known/*`;
  - MCP/server-card metadata;
  - `auth.md`;
  - `llms.txt`;
  - `index.md`;
  - OpenAPI/API catalog;
  - README и публичных docs;
  - JSON-LD `sameAs`;
  - footer/header/contact pages.
- [x] Исправить Threads links:
  - EN: `https://www.threads.net/@alexgetmanco` или актуальный canonical Threads URL;
  - RU: `https://www.threads.net/@alexgetmanru`.
- [x] Исправить контакты:
  - Telegram Forum должен иметь Telegram icon, не X icon;
  - LinkedIn/Instagram карточки не должны наследовать неправильные CSS-классы.
- [x] Переименовать карточку проекта `ialexey.ru` в `alexgetman.com`.

## Content UX

- [x] Сделать `/archive` и `/ru/archive` с группировкой по годам/месяцам.
- [x] Сделать `/search` и `/ru/search` на базе `search-index.json`.
- [x] Сделать страницы категорий:
  - `/category/[category]`
  - `/ru/category/[category]`
- [x] Сделать бейджи/теги на страницах постов кликабельными.
- [x] Добавить read time.
- [x] Убрать дублирование заголовка в карточках постов: preview должен начинаться после первого заголовочного предложения.
- [x] Добавить блок `Trending Posts` на EN homepage.
- [ ] Добавить emoji reactions под постами, если это не усложнит privacy/антиспам.
- [x] Улучшить code/pre styling для readability.

## Homepage Redesign

- [x] Перенести удачный портальный layout RU-версии на EN root.
- [x] Сделать lead story с крупной картинкой 16:9.
- [x] Добавить thumbnails в списках постов.
- [x] Добавить компактный sidebar для latest/trending/social links.
- [x] Использовать относительное время в списках (`3h ago`, `вчера`) с `<time datetime="...">`.
- [x] Разделить главную по темам/рубрикам, когда появится достаточно постов.

## Media & Performance

- [x] Добавить минимальную build-time генерацию WebP variants для локальных public images.
- [ ] Сохранять локальные optimized media, не зависеть от Telegram CDN.
- [ ] Проверить LCP на мобильных для главной и страниц постов.
- [x] Добавить responsive image sizes для post thumbnails/hero.
- [x] Не ломать media fallback для EN/RU локалей.

## Content Semantics

- [x] Улучшить базовый HTML постов:
  - двойные переносы -> `<p>`;
  - списки -> `<ul>/<ol>`, если структура очевидна;
  - inline code/pre сохранять безопасно.
- [ ] Добавить логичные подзаголовки -> `<h2>/<h3>`, когда появится надежное правило, а не эвристика ради эвристики.
- [ ] Сохранять Telegram entities только как входной formatting source, а не как публичную зависимость.
- [ ] Для соцсетей, которые не поддерживают HTML, продолжать отдавать plain text.

## AIO / Agent-Native Maintenance

- [x] Достигнуть `isitagentready.com` 100/100 Level 5 Agent-Native.
- [ ] После каждого изменения `.well-known`, markdown negotiation, MCP, auth metadata или robots проверять, что оценка не просела.
- [ ] Не добавлять новые AIO-фичи только ради баллов, если уже 100/100.
- [ ] Поддерживать актуальными:
  - `llms.txt`;
  - `index.md`;
  - markdown endpoints;
  - `.well-known` metadata;
  - MCP/server-card;
  - API catalog.

## Distribution

- [ ] Считать уже подключённые каналы базовой дистрибуцией:
  - Threads RU/EN;
  - X;
  - Facebook RU/EN;
  - LinkedIn;
  - Bluesky;
  - Mastodon;
  - dev.to;
  - GitHub Discussions/Giscus.
- [ ] Для каждой внешней площадки хранить canonical URL сайта.
- [ ] Следить, чтобы внешние публикации не создавали дубликаты без canonical ссылки.
- [ ] Добавить метрики внешних площадок только там, где API стабилен и не создаёт лишний maintenance.

## Operational Cleanup

- [ ] В Nginx/Cloudflare убрать обслуживание `ialexey.ru`, если домен больше не нужен.
- [ ] Внутренние server paths с `ialexey-*` переименовывать только отдельным maintenance окном с backup и rollback.
- [ ] Не делать большой rename вместе с функциональными изменениями сайта.
- [ ] В deployment docs явно различать:
  - public brand cleanup;
  - internal path cleanup;
  - domain retirement.

## Отложено

Эти задачи не делаем в ближайшем спринте, чтобы не тратить время на низкий ROI или высокий операционный риск.

- [ ] Монорепозиторий `website/backend`.
- [ ] Полный rename production paths `/home/deploy/ialexey-web` -> `/home/deploy/alexgetman-web` без отдельной необходимости.
- [ ] Прямое чтение production SQLite из Astro build через `better-sqlite3`/Drizzle.
- [ ] Перевод Astro build на HTTP API как единственный source of truth.
- [ ] Pinterest API automation.
- [ ] Reddit automation до стабильного аккаунта и понятного moderation strategy.
- [ ] TikTok/Reels/Shorts automation.
- [ ] npm package ради backlink.
- [ ] Docker Hub image ради backlink.
- [ ] Boosty/монетизация.
- [ ] Новые языки (`es`, `zh`) до стабилизации EN/RU.
- [ ] Cloudflare/DNS-AID доработки, если текущий `isitagentready.com` остаётся 100/100.
- [ ] Тяжелая конвертация всех post media в WebP/AVIF и хранение optimized variants. В этом прогоне сделан только безопасный минимум: existing build-time avatar/social image generation плюс `loading`, `decoding` и `sizes` на post images.
