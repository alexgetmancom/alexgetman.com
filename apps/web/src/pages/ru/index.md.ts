import { loadFeedItems } from "../../utils/feed";
import { formatDate, siteUrlFromContext, truncateText } from "../../utils/helpers";

export const prerender = false;

export async function GET(context: any) {
  const sortedItems = loadFeedItems()
    .filter((item) => item.text_ru)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const siteUrl = siteUrlFromContext(context);

  const lines = [
    "# Алексей Гетманец",
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
    `- Sitemap: ${siteUrl}/sitemap-index.xml`,
    "",
    "## Последние русские посты",
    "",
  ];

  if (sortedItems.length === 0) {
    lines.push("Пока постов нет.");
  } else {
    for (const item of sortedItems.slice(0, 10)) {
      const id = item.post_id;
      const title = truncateText(item.text_ru || item.text || "", 86) || `Пост ${id}`;
      const date = formatDate(item.date, "ru-RU");
      if (!item.has_ru || !id) continue;
      lines.push(`### [${title}](${siteUrl}/ru/${id}/${item.slug_ru}/)`);
      lines.push(`*Опубликовано: ${date} MSK*`);
      lines.push("");
      lines.push(item.text_ru || "");
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}
