import { loadFeedItems } from "../../utils/feed";
import { siteUrlFromContext } from "../../utils/helpers";

export const prerender = false;

export async function GET(context: any) {
  const item = loadFeedItems().find(
    (entry) => String(entry.post_id) === String(context.params.postId) && entry.slug_en === context.params.slug,
  );
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
