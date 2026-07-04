import fs from 'node:fs';
import path from 'node:path';

export async function getStaticPaths() {
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
  if (parsedData) {
    if (Array.isArray(parsedData)) {
      feedItems = parsedData;
    } else if (parsedData.items && Array.isArray(parsedData.items)) {
      feedItems = parsedData.items;
    }
  }

  const filteredItems = feedItems.filter((item) => item.has_ru && item.text && item.post_id);

  return filteredItems.map((item) => {
    return {
      params: { postId: String(item.post_id), slug: item.slug_ru },
      props: { item }
    };
  });
}

export async function GET(context) {
  const { item } = context.props;
  const siteUrl = context.site ? context.site.toString().replace(/\/$/, '') : 'https://alexgetman.com';

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
