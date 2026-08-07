import type { SiteLocale } from "../utils/locale";

/**
 * Every string the machine-facing endpoints emit — RSS, JSON feed, the AI feed,
 * per-post markdown and llms.txt.
 *
 * These endpoints used to spell their copy inline as `russian ? … : …`, which
 * meant a third language would have had to touch every line of every builder.
 * English is the source of truth for the key set; each other locale is typed
 * `satisfies SiteCopy`, so the compiler rejects a missing key.
 */
export type SiteCopy = {
  feedTitle: string;
  feedDescription: string;
  /** Title for a post whose text starts with something unusable. */
  postFallback: string;
  publishedOn: string;
  backHome: string;
  viewArticle: string;
  llmsTitle: string;
  llmsTagline: string;
  llmsAbout: string;
  headingAbout: string;
  headingLinks: string;
  headingSocial: string;
  headingPosts: string;
  labelWebsite: string;
  /** This language named in itself, for cross-links from the other languages. */
  nativeName: string;
  labelJsonFeed: string;
  labelRss: string;
  labelSitemap: string;
  labelMarkdownIndex: string;
  noPosts: string;
  /** Social profiles are per-language: the RU and EN accounts differ. */
  social: [label: string, url: string][];
};

const en: SiteCopy = {
  feedTitle: "Alex Getman | AI, automation and self-hosted systems",
  feedDescription: "English updates from Alex Getman: AI news, automation, developer tools and self-hosted systems.",
  postFallback: "Post {id}",
  publishedOn: "Published on",
  backHome: "Back to Home",
  viewArticle: "View Article",
  llmsTitle: "Alex Getman",
  llmsTagline: "English hub for AI news, automation, developer tools, self-hosted systems and public projects.",
  llmsAbout:
    "Alex Getman publishes short practical updates about AI products, automation workflows, developer tools and self-hosted infrastructure.",
  headingAbout: "About",
  headingLinks: "Core URLs",
  headingSocial: "Social profiles",
  headingPosts: "Latest posts",
  labelWebsite: "Website",
  nativeName: "English",
  labelJsonFeed: "JSON feed",
  labelRss: "RSS",
  labelSitemap: "Sitemap",
  labelMarkdownIndex: "Markdown overview",
  noPosts: "No posts yet.",
  social: [
    ["Telegram", "https://t.me/alexgetmancom"],
    ["Threads", "https://www.threads.net/@alexgetmanco"],
    ["GitHub", "https://github.com/alexgetmancom"],
    ["YouTube", "https://www.youtube.com/@alexgetmancom"],
  ],
};

const ru: SiteCopy = {
  feedTitle: "RU — Алекс Гетман | alexgetmancom",
  feedDescription: "Новости ИИ, автоматизация, разработка и self-hosted системы от Алекса Гетмана.",
  postFallback: "Пост {id}",
  publishedOn: "Опубликовано",
  backHome: "На главную",
  viewArticle: "Читать статью",
  llmsTitle: "Алекс Гетман",
  llmsTagline: "Личный хаб alexgetmancom: ИИ, разработка, автоматизация, open-source и проекты.",
  llmsAbout:
    "Алекс Гетман публикует короткие практические заметки об ИИ-продуктах, автоматизации, инструментах разработки и self-hosted инфраструктуре.",
  headingAbout: "О сайте",
  headingLinks: "Основные адреса",
  headingSocial: "Профили",
  headingPosts: "Последние посты",
  labelWebsite: "Сайт",
  nativeName: "Русский",
  labelJsonFeed: "JSON-лента",
  labelRss: "RSS",
  labelSitemap: "Карта сайта",
  labelMarkdownIndex: "Обзор в Markdown",
  noPosts: "Пока постов нет.",
  social: [
    ["Telegram", "https://t.me/alexgetmancom"],
    ["Threads", "https://www.threads.net/@alexgetmanru"],
    ["GitHub", "https://github.com/alexgetmancom"],
    ["YouTube", "https://www.youtube.com/@alexgetmancom"],
  ],
} satisfies SiteCopy;

const catalog: Record<SiteLocale, SiteCopy> = { en, ru };

export function siteCopy(locale: SiteLocale): SiteCopy {
  return catalog[locale];
}

/** Fills `{name}` placeholders, the same convention the backend catalog uses. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in values ? String(values[name]) : `{${name}}`));
}
