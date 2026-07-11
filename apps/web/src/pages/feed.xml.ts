import rss from "@astrojs/rss";
import { loadFeedItems } from "../utils/feed";
import { truncateText } from "../utils/helpers";

export async function GET(context: any) {
  const sortedItems = loadFeedItems()
    .filter((item) => item.has_en && item.text_en && item.post_id)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 50);

  return rss({
    title: "Alex Getman | AI, automation and self-hosted systems",
    description: "English updates from Alex Getman: AI news, automation, developer tools and self-hosted systems.",
    site: context.site || "https://alexgetman.com",
    items: sortedItems.map((item) => {
      const id = item.post_id;
      const text = item.text_en || item.text || "";
      const title = truncateText(text, 86) || `Post ${id}`;
      return {
        title,
        pubDate: new Date(item.date),
        description: item.html_en || item.text_en,
        link: `/${id}/${item.slug_en}/`,
      };
    }),
    customData: `<language>en</language>`,
  });
}
