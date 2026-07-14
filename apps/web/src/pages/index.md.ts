import { loadFeedItems } from "../server/public-site";
import { formatDate } from "../utils/dates";
import { siteUrlFromContext } from "../utils/site";
import { truncateText } from "../utils/text";

export const prerender = false;

export async function GET(context: any) {
  const sortedItems = loadFeedItems()
    .filter((item) => item.text_en)
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
    "- LinkedIn: https://www.linkedin.com/in/alexgetmancom",
    `- RSS: ${siteUrl}/feed.xml`,
    `- Russian RSS: ${siteUrl}/ru/feed.xml`,
    `- Sitemap: ${siteUrl}/sitemap-index.xml`,
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
      const date = formatDate(item.date);
      if (!item.has_en || !id) continue;
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
