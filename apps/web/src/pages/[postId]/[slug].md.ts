import type { APIContext } from "astro";
import { findFeedItem } from "../../server/public-site";
import { siteUrlFromContext } from "../../utils/site";

export const prerender = false;

export async function GET(context: APIContext) {
  const found = findFeedItem(context.params.postId);
  const item = found?.slug_en === context.params.slug ? found : undefined;
  if (!item) return new Response("Markdown file not found\n", { status: 404 });
  const siteUrl = siteUrlFromContext(context);

  const lines = [
    `# ${item.text_en.split("\n")[0] || `Post ${item.post_id}`}`,
    "",
    `*Published on: ${new Date(item.date).toUTCString()}*`,
    "",
    item.text_en || "",
    "",
    "---",
    `[Back to Home](${siteUrl}/) | [View Article](${siteUrl}/${item.post_id}/${item.slug_en}/)`,
  ];

  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}
