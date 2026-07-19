import { loadFeedItems } from "../server/public-site";
import { compactText, truncateText } from "../utils/text";

export const prerender = false;

function keyEntities(value: string): string[] {
  const terms =
    compactText(value).match(
      /\b(?:AI|API|LLM|GPT-\d+|Claude(?:\s+Code)?|Codex|Gemini|OpenAI|Anthropic|Google|GitHub|Telegram|Docker|Bun|TypeScript|Astro)\b/gi,
    ) ?? [];
  return [...new Set(terms.map((term) => term.trim()))].slice(0, 12);
}

export async function GET() {
  const items = loadFeedItems()
    .filter((item) => item.has_en && item.text_en && item.post_id && item.slug_en)
    .map((item) => {
      const text = compactText(item.text_en);
      const canonicalUrl = `https://alexgetman.com/${item.post_id}/${item.slug_en}/`;
      return {
        id: `post:${item.post_id}`,
        title: truncateText(text, 100),
        tldr: truncateText(text, 280),
        key_entities: keyEntities(text),
        published_at: item.date,
        canonical_url: canonicalUrl,
        markdown_url: `${canonicalUrl.slice(0, -1)}.md`,
        ru_url: item.has_ru ? `https://alexgetman.com/ru/${item.post_id}/${item.slug_ru}/` : null,
        actions: [],
      };
    })
    .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())
    .slice(0, 100);

  return new Response(JSON.stringify({ version: 1, updated_at: new Date().toISOString(), items }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-Robots-Tag": "noindex, follow",
    },
  });
}
