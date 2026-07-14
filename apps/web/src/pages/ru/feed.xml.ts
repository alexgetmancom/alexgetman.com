import rss from "@astrojs/rss";
import { loadFeedItems } from "../../server/public-site";
import { truncateText } from "../../utils/text";

export const prerender = false;

export async function GET(context: any) {
  const sortedItems = loadFeedItems()
    .filter((item) => item.has_ru && item.post_id)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 50);

  return rss({
    title: "RU — Алексей Гетманец | alexgetmancom",
    description: "Новости ИИ, автоматизация, разработка и self-hosted системы от Алексея Гетманца.",
    site: context.site || "https://alexgetman.com",
    items: sortedItems.map((item) => {
      const id = item.post_id;
      const title = truncateText(item.text || "", 86) || `Пост ${id}`;
      return {
        title: title,
        pubDate: new Date(item.date),
        description: item.html || item.text,
        link: `/ru/${id}/${item.slug_ru}/`,
      };
    }),
    customData: `<language>ru</language>`,
  });
}
