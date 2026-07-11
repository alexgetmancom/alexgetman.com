import { loadFeedItems } from "../utils/feed";
import { compactText, excerptAfterTitle, getFirstSentence, getSmartCategory, postImagePath, truncateText } from "../utils/helpers";

export const prerender = false;

function telegramToSearchItems(item: any) {
  const postId = item.post_id;
  const entries = [];

  if (item.has_en && item.text_en && item.slug_en) {
    const text = compactText(item.text_en || item.html_en || "");
    const title = compactText(getFirstSentence(item.text_en || text)) || `Post ${postId}`;
    entries.push({
      id: `post:${postId}:en`,
      type: "post",
      title: truncateText(title, 120),
      excerpt: excerptAfterTitle(text, title, 180),
      url: `/${postId}/${item.slug_en}/`,
      date: item.date,
      source: "alexgetman.com",
      category: getSmartCategory(item.text || text),
      image: postImagePath(item, "en"),
    });
  }

  if (item.has_ru && item.text && item.slug_ru) {
    const text = compactText(item.text || item.html || "");
    const title = compactText(item.title || getFirstSentence(item.text || text)) || `Публикация ${postId}`;
    entries.push({
      id: `post:${postId}:ru`,
      type: "post",
      title: truncateText(title, 120),
      excerpt: excerptAfterTitle(text, title, 180),
      url: `/ru/${postId}/${item.slug_ru}/`,
      date: item.date,
      source: "alexgetman.com",
      category: getSmartCategory(item.text || text),
      image: postImagePath(item, "ru"),
    });
  }

  return entries;
}

export async function GET() {
  const telegramItems = loadFeedItems()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .flatMap(telegramToSearchItems);

  return new Response(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        items: telegramItems,
      },
      null,
      2,
    ),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
