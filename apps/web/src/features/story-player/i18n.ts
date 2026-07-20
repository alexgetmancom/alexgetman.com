/* =============================================================================
 * ВСЕ СТРОКИ ИНТЕРФЕЙСА ПЛЕЕРА (en + ru)
 * -----------------------------------------------------------------------------
 * Единственное место, где живут надписи кнопок/меню плеера.
 * Новая надпись: добавь ключ в StoryUi (ниже) и значение в ОБЕ локали.
 * Использование: const ui = storyUi(locale) — объект передаётся в компоненты.
 * НЕ хардкодь строки в .svelte/.astro — иначе en и ru разъедутся.
 * ========================================================================== */

export interface StoryUi {
  storyLabel: string;
  discuss: string;
  backToPost: string;
  share: string;
  copied: string;
  readMore: string;
  collapse: string;
  read: string;
  back: string;
  mute: string;
  muted: string;
  tapForSound: string;
  storyRail: string;
  feedMode: string;
  feedLatest: string;
  feedDeep: string;
  feedWatched: string;
  menu: string;
  language: string;
  telegram: string;
  discussionTab: string;
}

const en: StoryUi = {
  storyLabel: "AI news player",
  discuss: "Discuss",
  backToPost: "Back to post",
  share: "Share",
  copied: "Copied",
  readMore: "Read more",
  collapse: "Collapse",
  read: "Read",
  back: "Back",
  mute: "Audio",
  muted: "Muted",
  tapForSound: "Tap for sound",
  storyRail: "Story rail",
  feedMode: "Feed mode",
  feedLatest: "Latest",
  feedDeep: "Deep",
  feedWatched: "Watched",
  menu: "Menu",
  language: "Русский",
  telegram: "Telegram",
  discussionTab: "Discussion",
};

const ru: StoryUi = {
  storyLabel: "Новостной плеер",
  discuss: "Обсудить",
  backToPost: "К посту",
  share: "Поделиться",
  copied: "Скопировано",
  readMore: "Читать дальше",
  collapse: "Свернуть",
  read: "Читать",
  back: "Назад",
  mute: "Звук",
  muted: "Звук выкл",
  tapForSound: "Включить звук",
  storyRail: "Выбор новостей",
  feedMode: "Режим ленты",
  feedLatest: "Latest",
  feedDeep: "Deep",
  feedWatched: "Watched",
  menu: "Меню",
  language: "English",
  telegram: "Telegram",
  discussionTab: "Обсуждение",
};

export function storyUi(locale: "en" | "ru"): StoryUi {
  return locale === "ru" ? ru : en;
}
