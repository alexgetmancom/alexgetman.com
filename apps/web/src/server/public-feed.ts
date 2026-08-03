import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { formatDate } from "../utils/dates";
import {
  hasPublishedLocale,
  localizedHtml,
  localizedSlug,
  localizedText,
  type SiteLocale,
  sortedPublishedItems,
} from "../utils/public-feed";
import { siteUrlFromContext } from "../utils/site";
import { truncateText } from "../utils/text";
import { findFeedItem, loadFeedItems } from "./public-site";
import { getRuntime } from "./runtime";

export async function publicRssResponse(context: APIContext, locale: SiteLocale): Promise<Response> {
  const items = sortedPublishedItems(loadFeedItems(), locale, 50);
  const russian = locale === "ru";

  return rss({
    title: russian ? "RU — Алекс Гетман | alexgetmancom" : "Alex Getman | AI, automation and self-hosted systems",
    description: russian
      ? "Новости ИИ, автоматизация, разработка и self-hosted системы от Алекса Гетмана."
      : "English updates from Alex Getman: AI news, automation, developer tools and self-hosted systems.",
    site: context.site || "https://alexgetman.com",
    items: items.map((item) => {
      const id = item.post_id;
      const text = localizedText(item, locale);
      const slug = localizedSlug(item, locale) ?? "";
      return {
        title: truncateText(text, 86) || (russian ? `Пост ${id}` : `Post ${id}`),
        pubDate: new Date(item.date),
        description: localizedHtml(item, locale),
        link: `${russian ? "/ru" : ""}/${id}/${slug}/`,
      };
    }),
    customData: `<language>${russian ? "ru" : "en"}</language>`,
  });
}

export function publicJsonFeedResponse(locale: SiteLocale): Response {
  const items = sortedPublishedItems(loadFeedItems(), locale, 50).map((item) => {
    if (locale === "ru") return item;
    return {
      ...item,
      text: item.text_en,
      html: item.html_en || item.text_en,
      media: Array.isArray(item.media_en) && item.media_en.length > 0 ? item.media_en : item.media,
      image: item.image_en || item.image,
      canonical_url: `https://alexgetman.com/${item.post_id}/${item.slug_en}/`,
      ru_url: hasPublishedLocale(item, "ru") ? `https://alexgetman.com/ru/${item.post_id}/${item.slug_ru}/` : null,
    };
  });

  return new Response(JSON.stringify({ items }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-Robots-Tag": "noindex, follow",
    },
  });
}

export async function publicMarkdownResponse(context: APIContext, locale: SiteLocale): Promise<Response> {
  const found = findFeedItem(context.params.postId);
  const slug = found ? localizedSlug(found, locale) : null;
  const item = found && hasPublishedLocale(found, locale) && slug === context.params.slug ? found : undefined;
  if (!item) return new Response("Markdown file not found\n", { status: 404 });

  const siteUrl = siteUrlFromContext(context);
  const russian = locale === "ru";
  const id = item.post_id;
  const text = localizedText(item, locale);
  const localPath = `${russian ? "/ru" : ""}/${id}/${slug}/`;
  const lines = [
    `# ${text.split("\n")[0] || (russian ? `Пост ${id}` : `Post ${id}`)}`,
    "",
    `${russian ? "*Опубликовано:" : "*Published on:"} ${new Date(item.date).toUTCString()}*`,
    "",
    text,
    "",
    "---",
    russian
      ? `[На главную](${siteUrl}/ru/) | [Читать статью](${siteUrl}${localPath})`
      : `[Back to Home](${siteUrl}/) | [View Article](${siteUrl}${localPath})`,
  ];

  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

export async function publicLlmsResponse(context: APIContext, locale: SiteLocale): Promise<Response> {
  const timeZone = getRuntime().config.TIMEZONE;
  const items = sortedPublishedItems(loadFeedItems(), locale);
  const russian = locale === "ru";
  const siteUrl = siteUrlFromContext(context);
  const lines = russian
    ? [
        "# Алекс Гетман",
        "",
        "> Личный хаб alexgetmancom: ИИ, разработка, автоматизация, open-source и проекты.",
        "",
        "## Разделы",
        `- Сайт (EN): ${siteUrl}/`,
        `- Сайт (RU): ${siteUrl}/ru/`,
        "- Telegram: https://t.me/alexgetmancom",
        "- Threads: https://www.threads.net/@alexgetmanru",
        "- GitHub: https://github.com/alexgetmancom",
        `- RSS (EN): ${siteUrl}/feed.xml`,
        `- RSS (RU): ${siteUrl}/ru/feed.xml`,
        `- Sitemap: ${siteUrl}/sitemap.xml`,
        "",
        "## Последние русские посты",
        "",
      ]
    : [
        "# Alex Getman",
        "",
        "> English hub for AI news, automation, developer tools, self-hosted systems and public projects.",
        "",
        "## About",
        "Alex Getman publishes short practical updates about AI products, automation workflows, developer tools and self-hosted infrastructure.",
        "",
        "## Links",
        `- Website: ${siteUrl}/`,
        `- Russian section: ${siteUrl}/ru/`,
        "- Telegram: https://t.me/alexgetmancom",
        "- Threads: https://www.threads.net/@alexgetmanco",
        "- GitHub: https://github.com/alexgetmancom",
        `- RSS: ${siteUrl}/feed.xml`,
        `- Russian RSS: ${siteUrl}/ru/feed.xml`,
        `- Sitemap: ${siteUrl}/sitemap.xml`,
        "",
        "## Latest English posts",
        "",
      ];

  if (items.length === 0) {
    lines.push(russian ? "Пока постов нет." : "No English posts yet.");
  } else {
    for (const item of items.slice(0, 10)) {
      const id = item.post_id;
      const slug = localizedSlug(item, locale);
      if (!slug) continue;
      const text = localizedText(item, locale);
      const title = truncateText(text, 86) || (russian ? `Пост ${id}` : `Post ${id}`);
      const date = formatDate(item.date, russian ? "ru-RU" : "en-GB", timeZone);
      lines.push(`### [${title}](${siteUrl}${russian ? "/ru" : ""}/${id}/${slug}/)`);
      lines.push(`${russian ? "*Опубликовано:" : "*Published:"} ${date} MSK*`);
      lines.push("", text, "", "---", "");
    }
  }

  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}
