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

## Активный план

Остались только проверки, которые зависят от production-деплоя или внешних сервисов. Пока `tw-nl` недоступен из-за технических работ, их не закрываем.

1. Проверить OpenGraph/Twitter image для постов после финального деплоя текущих media-правок.
   - Проверить EN и RU post pages.
   - Проверить, что `og:image`, `twitter:image`, `og:image:width`, `og:image:height` ведут на рабочие картинки.
   - Проверить шаринг в Telegram/соцсетях на 1-2 свежих постах.
2. Проверить LCP на мобильных для главной и страниц постов после финального production deploy vertical-first layout.
   - Главная EN `/`.
   - Главная RU `/ru/`.
   - EN post page.
   - RU post page.
3. После изменений `.well-known`, markdown negotiation, MCP, auth metadata или robots проверять, что `isitagentready.com` не просел ниже текущего baseline **100/100 Level 5**.
4. Когда сервер снова доступен, повторить smoke:
   - `https://alexgetman.com` должен отдавать `200`.
   - `https://ialexey.ru` должен отдавать `410 Gone` + `X-Robots-Tag: noindex, nofollow`, без редиректа на `alexgetman.com`.
   - `/pipeline-status`, sitemap, feeds, `llms.txt`, `index.md`, `.well-known/*` должны открываться.

## Закрыто

- Canonical model: посты используют собственный `post_id`, не Telegram message ID.
- URL policy: EN `/<post_id>/<english-slug>/`, RU `/ru/<post_id>/<russian-slug>/`.
- EN-first: английский контент живёт в корне сайта, русский под `/ru/`.
- EN/RU UI policy: обе версии используют один news layout и отличаются только языком, URL, датами, категориями и доступным набором постов.
- Telegram больше не source of truth; допустим только как target, discussion/community link или технический входной канал.
- Legacy routes `/posts/*`, `/ru/posts/*`, `/en/*` возвращают `410 Gone`/`noindex`.
- `ialexey.ru` retired: без 301/302 на `alexgetman.com`; на VPS оставлен явный `410 Gone`, чтобы домен не попадал в default virtual host.
- SEO foundation: `/about`, `/ru/about`, Privacy Policy EN/RU, кастомный `404`, robots/sitemap, manifest/theme-color, JSON-LD Article, meta description.
- Public brand cleanup: старые публичные `ialexey` references вычищены; контакты и Threads links приведены в порядок.
- Content UX: archive, search, category pages, clickable tags, read time, code/pre styling, trending/sidebar, relative time.
- Homepage redesign: единый vertical-first news layout для EN/RU; горизонтальная версия сохранена в branch `codex/home-horizontal-backup` на commit `4e9140e`.
- Media policy: основной article image format **9:16, 1080x1920**; сайт кропает под конкретные слоты; build-time WebP variants и responsive image sizes включены.
- Distribution: Threads RU/EN, X, Facebook RU/EN, LinkedIn, Bluesky, Mastodon, dev.to, GitHub Discussions/Giscus считаются базовой дистрибуцией.
- External canonical: внешние площадки должны ссылаться на canonical URL сайта.
- Metrics policy: собираем только стабильные API; недоступные metrics показываем как `—`, не `n/a`; thread metrics суммируются по частям, где API это позволяет.
- Dev.to: публикуем cover image через `main_image`; body images/video пока не усложняем.
- Operational cleanup: внутренние server paths с `ialexey-*` не переименовываем без отдельного maintenance window.

## Отложено

Эти задачи не делаем в ближайшем спринте, чтобы не тратить время на низкий ROI или высокий операционный риск.

- [ ] Монорепозиторий `website/backend`.
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
- [ ] Cloudflare/DNS-AID доработки, если текущий `isitagentready.com` остаётся 100/100.
- [ ] Тяжелая конвертация всех post media в WebP/AVIF и хранение optimized variants. В этом прогоне сделан только безопасный минимум: existing build-time avatar/social image generation плюс `loading`, `decoding` и `sizes` на post images.
