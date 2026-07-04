import { loadFeedItems, siteUrlFromContext } from '../../../utils/helpers';

export async function getStaticPaths() {
  return loadFeedItems()
    .filter((item) => item.has_ru && item.text && item.post_id)
    .map((item) => {
    return {
      params: { postId: String(item.post_id), slug: item.slug_ru },
      props: { item }
    };
  });
}

export async function GET(context) {
  const { item } = context.props;
  const siteUrl = siteUrlFromContext(context);

  const lines = [
    `# ${item.text.split('\n')[0] || `Пост ${item.post_id}`}`,
    "",
    `*Опубликовано: ${new Date(item.date).toUTCString()}*`,
    "",
    item.text || "",
    "",
    "---",
    `[На главную](${siteUrl}/ru/) | [Читать статью](${siteUrl}/ru/${item.post_id}/${item.slug_ru}/)`
  ];

  return new Response(lines.join("\n") + "\n", {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8'
    }
  });
}
