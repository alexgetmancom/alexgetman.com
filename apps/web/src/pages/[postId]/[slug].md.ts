import { loadFeedItems, siteUrlFromContext } from '../../utils/helpers';

export async function getStaticPaths() {
  return loadFeedItems()
    .filter((item) => item.has_en && item.text_en && item.post_id)
    .map((item) => {
    return {
      params: { postId: String(item.post_id), slug: item.slug_en },
      props: { item }
    };
  });
}

export async function GET(context: any) {
  const { item } = context.props;
  const siteUrl = siteUrlFromContext(context);

  const lines = [
    `# ${item.text_en.split('\n')[0] || `Post ${item.post_id}`}`,
    "",
    `*Published on: ${new Date(item.date).toUTCString()}*`,
    "",
    item.text_en || "",
    "",
    "---",
    `[Back to Home](${siteUrl}/) | [View Article](${siteUrl}/${item.post_id}/${item.slug_en}/)`
  ];

  return new Response(lines.join("\n") + "\n", {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8'
    }
  });
}
