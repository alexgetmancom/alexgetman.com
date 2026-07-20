import { loadFeedItems } from "../server/public-site";
import { getRuntime } from "../server/runtime";
import { formatDate } from "../utils/dates";
import { siteUrlFromContext } from "../utils/site";
import { truncateText } from "../utils/text";

export const prerender = false;

export async function GET(context: any) {
  const timeZone = getRuntime().config.TIMEZONE;
  const sortedItems = loadFeedItems()
    .filter((item) => item.text_en)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const siteUrl = siteUrlFromContext(context);

  const lines = [
    "# Alex Getman",
    "",
    "> English-first AI, automation and self-hosted systems hub. Russian originals are available under /ru/.",
    "",
    "## Core URLs",
    "",
    `- Website: ${siteUrl}/`,
    `- English JSON feed: ${siteUrl}/feed.json`,
    `- English RSS: ${siteUrl}/feed.xml`,
    `- Russian section: ${siteUrl}/ru/`,
    `- Russian RSS: ${siteUrl}/ru/feed.xml`,
    `- Sitemap index: ${siteUrl}/sitemap-index.xml`,
    `- Markdown overview: ${siteUrl}/index.md`,
    "",
    "## Social profiles",
    "",
    "- Telegram: https://t.me/alexgetmancom",
    "- Threads: https://www.threads.net/@alexgetmanco",
    "- GitHub: https://github.com/alexgetmancom",
    "- LinkedIn: https://www.linkedin.com/in/alexgetmancom",
    "- YouTube: https://www.youtube.com/@alexgetmancom",
    "",
    "## Latest English posts",
    "",
  ];

  if (sortedItems.length === 0) {
    lines.push("- No English posts yet.");
  } else {
    for (const item of sortedItems.slice(0, 30)) {
      const id = item.post_id;
      const title = truncateText(item.text_en || item.text || "", 86) || `Post ${id}`;
      const date = formatDate(item.date, "en-GB", timeZone);
      if (!item.has_en || !id) continue;
      lines.push(`- [${title}](${siteUrl}/${id}/${item.slug_en}.md) - ${date} MSK`);
    }
  }

  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
