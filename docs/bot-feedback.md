# Telegram-бот — что улучшить

Только точки роста, без пересказа хорошего.

## 1. Вход / Intake

**Лишний хендлер:** `apps/backend/src/bot.ts:109` слушает `⚙️`, но `persistentKeyboard` (`bot/menu-render.ts:21`) шлёт только `☰ Меню`. Переход в настройки работает только через инлайн-меню главного экрана. Удалить `bot.hears("⚙️")` или добавить кнопку.

**Дорогая загрузка до решения:** `bot/intake.ts:273` `downloadDocument` качает `.md` без лимита и таймаута. Защита: `AbortSignal.timeout(10000)` + проверка `content-length` / размера после `response.text()` > 1–2 Мб → `StudioError`.

**Неочевидный порог:** `POST_WITHOUT_ASKING=900` (`intake.ts:31`) без подсказки в `intake.choose-kind`. Добавить в текст выбора `intake.choose-kind` примечание «короткий текст → пост по умолчанию».

## 2. Карточка поста (`bot/preview.ts`)

**Дубль режимов:** кнопка `Режим: ...` (`cycle_mode`, `preview.ts:247` + `post-actions.ts:61`) дублирует `🌐 Выбрать площадки`. Даёт 5 пресетов (`full/ru/en/tg/manual`) без объяснения. Убрать `cycle_mode` с карточки, оставить только выбор площадок. Пресеты нужны только для дебага — спрятать в `/dev` или в настройки.

**Лишний экран платформ:** `view:platforms` показывает чекбоксы `✓/□` и `← К предпросмотру`. При 6–8 целях это 4 ряда ради галочек. Заменить на страницу выбора внутри той же карточки или мультиселект без отдельного `view`.

**Расписание — лишний уровень:**
- `view:schedule` → `sched_scope: both/ru_now/en_now` (`preview.ts:138`) → `schedule_ru/schedule_en` → слоты → `sched_confirm`. 3 клика до времени.
- Для `RU-only` студии (`postLocales` без `en`) ветка `both` скрыта, но остаётся `RU сейчас` vs `RU по расписанию` — второй сразу ведёт в грид, можно объединить в один грид с кнопкой `Сейчас` сверху.

**Подтверждение публикации:** `confirm_publish` (`preview.ts:192`) показывает «Не будет отправлено (нет медиа): …» и всё равно даёт `✅ Опубликовать`. Либо блокировать кнопку, либо делать её `disabled`-стиль + тост «добавьте медиа».

**Story-карточки:** `bot/post-story-cards.ts:14` всегда спрашивает `Опубликовать со Stories / без` если `cards.length>0`. Если на посте нет `telegram_stories/instagram_stories` в выбранных целях, вопрос лишний. Проверять `targets` перед `showStoryCardChoice`.

## 3. Видео-флоу (`studio/video-fsm.ts`, `bot/video-ui.ts`, `bot/video-conversation.ts`)

**Мёртвый шаг `label`:** `VIDEO_STEPS.label` (`video-fsm.ts:72`) никогда не достигается из `asset` (`asset.next → firstVideoMetadataStep`). `label` используется только как `edit_field:label` (`video-actions.ts:44`). Удалить из `VIDEO_FLOW` или завести как первый шаг визарда, если нужен внутренний нейминг.

**Платформы пишутся до подтверждения:** `video-actions.ts:172` `wizard_toggle` сразу вызывает `services.videos.toggleTarget` (БД), а `targets_done:185` ещё раз `replaceTargets`. Отмена диалога (`cancel_dialog:142`) оставляет черновик изменённым. Тоггл должен мутировать только `session.selected`, запись в БД — только на `targets_done`.

**Дубль выбора расписания:**
- `video-actions.ts:246-253` `handleScheduleStart` строит клавиатуру `Одна дата всем / Разное время`.
- `video-ui.ts:177-185` `scheduleChoiceEffects` строит ту же клавиатуру.
Удалить дубль, оставить `video-ui.ts` как единственный рендерер.

**Лишняя клавиатура `schedule_common/target`:** оба шага рендерят одинаковые `08:00 11:00 …` (`SCHEDULE_SLOT_PRESETS` в `scheduling.ts:74`) + `✏️ Ввести время`. Для `schedule_target` шаг повторяется N раз (по числу таргетингов) — каждый раз спрашивать полный грид тяжело. Сделать один грид с выбором цели сверху или авто-подстановку «то же время всем» по умолчанию.

**Length-warning:** `video-conversation.ts:149` показывает `Да, загрузить` без кнопки «Отправить другой файл». Пользователь должен просто прислать новый файл, но подсказки нет. Добавить вторую кнопку «Отправить другой» → сброс `assetId`.

**Edit-меню:** `video-actions.ts:417` `handleEditMenu` строит кнопки по `EDIT_FIELDS` (6 штук) + `🎬 Заменить файл` всегда строкой. При `draft.status != editing/draft` часть полей скрыта, но меню всё равно открывается. Скрывать пункт меню полностью, если нет редактируемых полей.

## 4. Очередь (`bot/queue.ts`)

**Нумерация страниц:** `queue_page:noop` (`queue.ts:40,64`) — кликабельная кнопка `1/3`, которая ничего не делает, но отвечает `answerCallbackQuery`. Сделать `callback_data` некликабельным (или не рендерить кнопку, если `pages==1` — сейчас страница `1/1` всё равно показывается в `queueScreen:80`).

**Дубль заголовка:** `renderMainMenuHeadline` (`menu-render.ts:44`) и `itemButton` (`queue.ts:123`) оба форматируют `formatQueueTime` по-разному. Вынести в один `queueHeadline` (уже есть часть).

**Внимание vs Очередь:** `queue_attention` открывается только если есть `snapshot.attention.length` (`queue.ts:35`), но `showQueueAttention:69` рендерит пустой экран `Ничего не требует внимания` — недостижим без прямого `queue_attention_page`. Убрать проверку или убрать пустое состояние.

## 5. Статистика (`bot/analytics-screen.ts`)

**Лишние переходы:** `analytics_section:overview:7` пересоздаёт дашборд даже если уже на `overview/7`. Добавить ранний `return` если `section==current && days==currentDays`.

**Пагинация архивов:** `archive_noop` (`analytics-screen.ts:231`) — та же проблема что в очереди: `1/5` кликабельна. Заменить на `InlineKeyboard` без `callback_data` или игнорировать без `answerCallbackQuery`.

**Мёртвый раздел `audience`:** `analytics-screen.ts:17` комментарий «только MCP просит» — кнопок нет, но `studio/services/analytics` готовит данные. Либо добавить кнопку, либо пометить как `agent-only`.

## 6. Настройки (`bot/settings/*`)

**Zernio discovery в памяти:** `settings/publishing.ts:26` `discoveredAccounts = new Map()` живёт в процессе, теряется при рестарте, без TTL. Вынести в `conversationState`/`settings` или в кеш с `Date.now()` + 10 мин.

**Часовой пояс — перебор кнопок:** `settings/general.ts:56` рендерит 16 зон по 2 в ряд + кастом. При каждом переключении весь экран перерисовывается. Дедуплицировать с уже имеющимся `TIMEZONE_OPTIONS` — вынести в `foundation/timezones.ts`.

**Новости-дайджест:** `settings/notifications.ts:116` грид `00:00 … 23:00` (24 кнопки) + кастом. Дублирует отдельный экран `newsDigestTime`. Оставить один: грид 4×6 или только ввод `HH:MM`.

**Несогласованный `plainText`:** часть `settingsUpdate` вызывает `editMessageText` с `parse_mode: Markdown`, часть с `plainText:true` (`settings/publishing.ts:40,108`). Каналы с `|`/`*` в названии ломают Markdown. Унифицировать: всегда `plainText` для `channelsText`.

## 7. Кросс-сквозное / дедуп кода

**Два места ловят `common.schedule-parse-error`:** `bot/post-screen.ts:57` и `bot/video-conversation.ts:264`. Вынести в `describePublicationError` (`bot/publication-actions.ts:41`) и переиспользовать.

**`promptEffect` дублирует логику версии:** `bot/dialog-ui.ts:41` внутри берёт `getConversationState(...).revision`, а вызывающие в `post-input-actions.ts`, `video-conversation.ts` уже имеют `session.revision`. Итог — двойной источник ревизии. Передавать `revision` явно параметром, убрать чтение из БД.

**`isNavigationMessage` (`settings/shared.ts:88`) хардкодит `t("en", menu.button)` + `t("ru", ...)`. При добавлении языка — разъедется. Использовать уже существующий `localizedTextVariants` из `bot.ts:289` или проверять по `persistentKeyboard` значениям.

**Идемпотентность колбэков:** `bot/callback-boundary.ts:9` `seenCallbackQueries` в памяти, `bot/callback-effects.ts:34` `withActionLock` по `lockKey`. Для опечатки в `publicationCallback` с `":"` в аргументе (`publication-callback.ts:31`) бросается `StudioError` до лока, но уже съеден `answerCallbackQuery` — пользователь видит `action.in-flight`. Проверять `:` на валидации до лока и отвечать явным тостом.

**Мелкие мертвые пути:**
- `bot/publication-renderers.ts:78` `postPreviewCard` используется везде кроме `bot/video-scheduling.ts:108` где напрямую `publicationRenderers(...).video.card` — унифицировать через `videoPreviewCard`.
- `bot/queue-time.ts` и `foundation/time.ts` оба имеют `formatZoned*` — оставить один.
