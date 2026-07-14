import { loadFeedItems } from "../../../utils/feed";
import { siteUrlFromContext } from "../../../utils/site";

export const prerender = false;

export async function GET(context: any) {
  const item = loadFeedItems().find(
    (entry) => String(entry.post_id) === String(context.params.postId) && entry.slug_ru === context.params.slug,
  );
  if (!item) return new Response("Markdown file not found\n", { status: 404 });
  const siteUrl = siteUrlFromContext(context);

  const lines = [
    `# ${item.text.split("\n")[0] || `Пост ${item.post_id}`}`,
    "",
    `*Опубликовано: ${new Date(item.date).toUTCString()}*`,
    "",
    item.text || "",
    "",
    "---",
    `[На главную](${siteUrl}/ru/) | [Читать статью](${siteUrl}/ru/${item.post_id}/${item.slug_ru}/)`,
  ];

  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}
