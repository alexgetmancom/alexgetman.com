/** Telegram interface message catalog.
 *
 * English is the source of truth for the key set. Every other locale is typed
 * `satisfies Record<MessageKey, string>`, so the compiler rejects a missing or
 * misspelled key — this IS the locale-parity check, no runtime test needed.
 * Adding a language is one new object here plus the union member below. */

export type UiLocale = "en" | "ru";

const en = {
  "menu.control-panel": "Control panel",
  "menu.new-post": "📝 New post",
  "menu.new-video": "🎬 New video",
  "menu.work-queue": "📋 Work queue",
  "menu.work-queue-count": "📋 Work queue · {count}",
  "menu.analytics": "📊 Analytics",
  "menu.settings": "⚙️ Settings",
  "menu.settings-unread": "⚙️ Settings · 🔴{count}",
  "menu.button": "☰ Menu",
  "settings.title": "⚙️ Settings",
  "settings.youtube-signature": "▶️ YouTube signature",
  "settings.notifications": "🔔 Notifications",
  "settings.publication-notifications": "🔔 Publication notifications",
  "settings.language": "🌐 Language",
  "settings.back-to-menu": "← Menu",
} as const;

export type MessageKey = keyof typeof en;

const ru = {
  "menu.control-panel": "Панель управления",
  "menu.new-post": "📝 Новый пост",
  "menu.new-video": "🎬 Новое видео",
  "menu.work-queue": "📋 Очередь",
  "menu.work-queue-count": "📋 Очередь · {count}",
  "menu.analytics": "📊 Статистика",
  "menu.settings": "⚙️ Настройки",
  "menu.settings-unread": "⚙️ Настройки · 🔴{count}",
  "menu.button": "☰ Меню",
  "settings.title": "⚙️ Настройки",
  "settings.youtube-signature": "▶️ Подпись YouTube",
  "settings.notifications": "🔔 Уведомления",
  "settings.publication-notifications": "🔔 Уведомления о публикациях",
  "settings.language": "🌐 Язык",
  "settings.back-to-menu": "← К меню",
} satisfies Record<MessageKey, string>;

export const catalog: Record<UiLocale, Record<MessageKey, string>> = { en, ru };
