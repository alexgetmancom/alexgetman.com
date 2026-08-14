[English](destinations.md) · [Русский](destinations.ru.md)

# Подключение площадки

У площадки две половины, и они разделены намеренно: Studio должна знать, что
площадка есть, и держать ключи к ней. Никто не спрашивает ключи к площадке, куда
вы не публикуете.

```bash
# 1. Сказать Studio, что площадка есть
docker compose exec app bun /app/ops/cli.js channel-connect --target threads_en

# 2. Спросить, чего ей не хватает
docker compose exec app bun /app/ops/cli.js doctor
```

`doctor` называет ровно те настройки, которых площадке недостаёт, и никогда не
печатает те, что уже есть. Впишите их в `.env`, выполните `docker compose up -d`,
повторите. Те же два шага доступны из Telegram-бота и из MCP-клиента.

## Что можно подключить

Текстовые площадки подключаются по имени цели, видео-аккаунты — по площадке и
языку.

| Площадка | Чем подключить | Что нужно |
| --- | --- | --- |
| Сайт | `--target site_ru` / `site_en` | ничего, плюс `site_enabled: true` в `studio.yaml` |
| Telegram-канал | `--target telegram` | `CONTROLLER_BOT_TOKEN` |
| Discord | `--target discord` | `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID` |
| Threads | `--target threads_ru` / `threads_en` | `THREADS_RU_ACCESS_TOKEN` / `THREADS_EN_ACCESS_TOKEN` либо `ZERNIO_API_KEY` |
| X | `--target x` | `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` |
| Instagram Stories | `--target instagram_stories_ru` / `instagram_stories` | `INSTAGRAM_*_USER_ID` и `INSTAGRAM_*_ACCESS_TOKEN` либо `ZERNIO_API_KEY` |
| Telegram Stories | `--target telegram_stories` | `TELEGRAM_CHANNEL_STORIES_API_ID`, `_API_HASH`, `_SESSION` |
| YouTube | `--platform youtube --locale ru` | `YOUTUBE_*_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN` |
| Instagram лента и Reels | `--platform instagram --locale ru` | `INSTAGRAM_*_ACCESS_TOKEN` и `_USER_ID` либо `ZERNIO_API_KEY` |
| TikTok | `--platform tiktok --provider zernio` | `ZERNIO_API_KEY` — только аналитика, публикации нет |

## Нативно или через провайдера

Площадки Meta достижимы двумя путями, и канал помнит, каким именно он
пользуется. Публиковать напрямую — это своё приложение Meta, Professional-аккаунт
и привязанная страница Facebook.

```bash
# Та же площадка, но доставка через провайдера
docker compose exec app bun /app/ops/cli.js channel-connect --target threads_en --provider zernio --account-id <id>
```

Такому каналу нужен один `ZERNIO_API_KEY` вместо токенов площадки — и для ленты,
и для Threads, и для Stories, — и `doctor` спросит именно его. В Telegram-боте
Настройки → Каналы показывают аккаунты, которые вернул провайдер, так что id
можно выбрать, а не вводить.

Нативный путь остаётся по умолчанию: площадка, которую не несёт провайдер,
доставляется прямо на платформу, как и раньше.

## YouTube

Единственная площадка с проводником, потому что получение первого токена — это
шаг, на котором люди застревают.

**Приложение создаёте вы, а не мы.** Квота YouTube считается на проект Google
Cloud, а не на пользователя: общий клиент дал бы всем установкам вместе
несколько загрузок в сутки, а публикация от вашего имени из нашего проекта
потребовала бы верификации Google.

1. Создайте проект в [Google Cloud](https://console.cloud.google.com/) и
   включите **YouTube Data API v3**.
2. Настройте OAuth consent screen и переведите статус публикации в
   **In production**. Оставить *Testing* — та самая ловушка: Google тогда выдаёт
   refresh-токены, [истекающие через 7 дней](https://developers.google.com/identity/protocols/oauth2),
   то есть публикация заработает и молча встанет неделю спустя. Для собственного
   канала верификация Google не нужна, предупреждение «unverified app» ожидаемо.
3. Credentials → OAuth client ID → тип **TVs and Limited Input devices**. Studio
   работает на сервере без браузера, и это единственный тип клиента, чей поток
   не требует обратного редиректа на достижимый адрес.
4. Впишите id и secret в `.env` как `YOUTUBE_RU_CLIENT_ID` и
   `YOUTUBE_RU_CLIENT_SECRET` (либо `YOUTUBE_EN_*`).

```bash
docker compose exec app bun /app/ops/cli.js channel-connect --platform youtube --locale ru --provider native
docker compose exec app bun /app/ops/cli.js youtube-authorize --locale ru
```

Команда печатает короткий код и адрес, ждёт, пока вы подтвердите на любом
устройстве с браузером, и печатает refresh-токен для `.env`. Это подтверждение —
единственный ручной шаг, и он делается один раз: дальше Studio сама меняет
refresh-токен на короткоживущий access-токен перед каждой загрузкой, а сам
refresh-токен не истекает, если вы не отзовёте доступ и не оставите приложение
неиспользуемым полгода.

## Что стоит знать заранее

**Токены Meta протухают, и Studio продлевает их сама.** Долгоживущие токены
Instagram и Threads истекают через 60 дней после выпуска. Укажите в `.env`
`TOKEN_ENCRYPTION_KEY`, и Studio будет продлевать их сама за месяц до срока,
сохраняя каждое продление запечатанным — база ежедневно уезжает копией, а живой
токен не та вещь, которую стоит передавать в чат. Нет ключа — нет продления:
токены остаются ровно тем, что написано в `.env`, и перевыпускать их придётся
руками.

Двух вещей она за вас не сделает. Уже истёкший токен продлить нельзя, поэтому
Studio, выключенная на два месяца, потребует нового токена вручную — положите его
в `.env`, и он победит сохранённый. И у Threads приватному профилю разрешение не
продлевается вовсе, в отличие от публичного. Подключение через провайдера
обходит оба случая.

**X берёт деньги за запись.** Четыре ключа получить несложно, но публикация
через API X требует платного тарифа их платформы для разработчиков.

**Telegram Stories публикует пользователь, а не бот.** Создайте api id и hash на
[my.telegram.org](https://my.telegram.org) в разделе *API development tools*,
впишите их в `.env` вместе с путём для сессии и войдите один раз:

```bash
docker compose exec -it app bun /app/ops/cli.js telegram-stories-login
```

Команда спросит номер телефона, код от Telegram и пароль двухфакторной защиты,
если он есть, а затем скажет, какому аккаунту теперь принадлежит сессия. Сессия —
это каталог, в который пишет приложение, поэтому вход выполняется внутри
контейнера; `-it` обязателен, это диалог.

**Видео больше 50 МБ требует локального Bot API.** Публичный API Telegram не
отдаёт файлы крупнее. Укажите в `.env` `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` и
`COMPOSE_PROFILES=telegram`, чтобы поднять его рядом с приложением и увеличить
предел до 2 ГБ.
