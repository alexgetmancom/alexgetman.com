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
| Threads | Studio → Каналы, RU или EN | `THREADS_APP_ID`, `THREADS_APP_SECRET`, `TOKEN_ENCRYPTION_KEY` либо `ZERNIO_API_KEY` |
| X | `--target x` | `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` |
| Instagram Stories | Studio → Каналы, RU или EN | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `TOKEN_ENCRYPTION_KEY` либо `ZERNIO_API_KEY` |
| Telegram Stories | `--target telegram_stories` | `TELEGRAM_CHANNEL_STORIES_API_ID`, `_API_HASH`, `_SESSION` |
| YouTube | `--platform youtube --locale ru` | `YOUTUBE_*_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN` |
| Instagram лента и Reels | Studio → Каналы, RU или EN | тот же native-вход Instagram либо `ZERNIO_API_KEY` |
| TikTok | `--platform tiktok --provider zernio` | `ZERNIO_API_KEY` — только аналитика, публикации нет |

## Нативно или через провайдера

Площадки Meta достижимы двумя путями, и канал помнит, каким именно он
пользуется. Для native-доставки создайте своё приложение Meta и положите его id
и secret в `.env`; Instagram требует Professional-аккаунт. Один раз создайте
`TOKEN_ENCRYPTION_KEY` командой `openssl rand -hex 32`.

Зарегистрируйте в Dashboard приложения точные callback URL:

```text
https://ваш-домен.example/oauth/threads
https://ваш-домен.example/oauth/instagram
```

После этого откройте Command Center → Studio → Каналы или Telegram → Настройки →
Каналы и нажмите native-кнопку RU либо EN. Браузер вернётся в Studio, она сама
обменяет code, запечатает долгоживущий токен в БД, сохранит account id и
подключит все native-маршруты аккаунта. Копировать URL, запускать CLI, менять
token в `.env` и перезапускать сервис больше не нужно. Development mode работает
для аккаунтов, которым назначена роль в приложении; Meta review нужен, когда
приложение начинает подключать чужие аккаунты.

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

## Threads

Нативная публикация требует своего приложения Meta с use case Threads. У такого
приложения **две** пары id и секрета: нужна пара Threads — App settings → Basic,
поля **Threads App ID** и **Threads App secret**.

1. Впишите их в `.env` как `THREADS_APP_ID` и `THREADS_APP_SECRET`.
2. Зарегистрируйте `<ваш базовый адрес>/oauth/threads` в списке valid OAuth
   redirect URIs этого приложения. Команда печатает точный адрес.

```bash
docker compose exec -it app bun /app/ops/cli.js threads-authorize --locale ru
```

Она печатает ссылку, вы подтверждаете её тем аккаунтом, от имени которого публикуете,
и Meta делает редирект на этот адрес. **Страница ничего не отдаёт, браузер
покажет ошибку — так и задумано.** Смысл в адресной строке: скопируйте адрес
целиком и вставьте обратно. Команда обменяет его на долгоживущий токен и напечатает
его для `.env`.

В отличие от YouTube, закончить на другом устройстве не выйдет: у Threads нет
device flow — Meta отвечает на согласие редиректом, и код приезжает внутри него.

## Что стоит знать заранее

**Токены Meta протухают, и Studio продлевает их сама.** Долгоживущие токены
Instagram и Threads истекают через 60 дней после выпуска. Укажите в `.env`
`TOKEN_ENCRYPTION_KEY`, и Studio будет продлевать их сама за месяц до срока,
сохраняя каждое продление запечатанным — база ежедневно уезжает копией, а живой
токен не та вещь, которую стоит передавать в чат. Нет ключа — нет продления:
токены остаются ровно тем, что написано в `.env`, и перевыпускать их придётся
руками.

Одного она за вас не сделает. Уже истёкший токен продлить нельзя, поэтому
Studio, выключенная на два месяца, потребует нового токена вручную — положите его
в `.env`, и он победит сохранённый. Подключение через провайдера обходит этот
случай.

**Не оставляйте приложение Meta в режиме разработки.** Такое приложение
публикует только в аккаунты, у которых есть роль в нём, — своей Studio хватает,
чужому аккаунту нет. Переключите его в live в App Dashboard, прежде чем
подключать аккаунт, которым не управляете.

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
