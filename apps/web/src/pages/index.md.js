import fs from 'node:fs';
import path from 'node:path';

export async function GET(context) {
  const dataDir = process.env.DATA_DIR || '/home/deploy/ialexey-feed/data';
  const prodFeedJsonPath = path.join(dataDir, 'feed.json');
  const localFeedJsonPath = path.resolve('apps/web/src/data/feed.json');

  let parsedData = null;
  for (const filePath of [prodFeedJsonPath, localFeedJsonPath]) {
    if (!parsedData && fs.existsSync(filePath)) {
      try {
        parsedData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (e) {
        console.error(e);
      }
    }
  }

  let feedItems = [];
  if (Array.isArray(parsedData)) {
    feedItems = parsedData;
  } else if (parsedData?.items && Array.isArray(parsedData.items)) {
    feedItems = parsedData.items;
  }

  const sortedItems = feedItems
    .filter(item => item.text_en)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const siteUrl = context.site ? context.site.toString().replace(/\/$/, '') : 'https://alexgetman.com';

  function cleanText(text) {
    return (text || "").replace(/\n{3,}/g, "\n\n").trim();
  }
  function compactText(text) {
    return cleanText(text).replace(/\s+/g, " ").trim();
  }
  function truncateText(value, limit) {
    const text = compactText(value);
    if (text.length <= limit) {
      return text;
    }
    return text.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
  }
  function formatDate(value) {
    if (!value) return "";
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Moscow",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value));
    } catch (e) {
      return value;
    }
  }

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

  return new Response(lines.join("\n") + "\n", {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8'
    }
  });
}
