import type { APIContext } from "astro";
import { loadFeedItems } from "../server/public-site";
import { getRuntime } from "../server/runtime";
import { formatDate } from "../utils/dates";
import { siteUrlFromContext } from "../utils/site";
import { truncateText } from "../utils/text";

export const prerender = false;

export async function GET(context: APIContext) {
  const timeZone = getRuntime().config.TIMEZONE;
  const sortedItems = loadFeedItems()
    // Every condition the loop below relies on belongs here: filtering inside
    // the loop would silently shrink the slice to fewer than 10 posts.
    .filter((item) => item.text_en && item.has_en && item.post_id && item.slug_en)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const siteUrl = siteUrlFromContext(context);

  const lines = [
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

  if (sortedItems.length === 0) {
    lines.push("No English posts yet.");
  } else {
    for (const item of sortedItems.slice(0, 10)) {
      const id = item.post_id;
      const title = truncateText(item.text_en || item.text || "", 86) || `Post ${id}`;
      const date = formatDate(item.date, "en-GB", timeZone);
      lines.push(`### [${title}](${siteUrl}/${id}/${item.slug_en}/)`);
      lines.push(`*Published: ${date} MSK*`);
      lines.push("");
      lines.push(item.text_en || "");
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
