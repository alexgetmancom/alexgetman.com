import { type BackendDb, unsafeDb } from "../db/client.js";

export type EditorialText = { post_key: string; text_en: string; date_utc: string | null };
export type XActivityText = { text: string; publishedAt: string | null };

/** HTML entities and emoji presentation selectors are how one text arrives
 * spelled two ways: an export writes `&gt;` where the post has `>`, and `⚡`
 * where the post has `⚡️`. Neither is a difference in what was published, and
 * either one used to break the comparison at its first character. */
function comparableText(value: string | undefined): string {
  return (value ?? "")
    .replace(/&(gt|lt|amp|quot|#39|apos|nbsp);/giu, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/[\uFE0E\uFE0F\u200B-\u200D\u2060]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

const HTML_ENTITIES: Record<string, string> = {
  "&gt;": ">",
  "&lt;": "<",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** The prefix the linker is allowed to act on. Uniqueness carries most of the
 * weight — two posts sharing an opening never match either — and the length
 * keeps a one-word post from claiming a longer one. */
const LINK_PREFIX_LENGTH = 30;

/** How alike two texts must read, and by how much the runner-up must be beaten,
 * before a same-day match counts. This is the rule for a post whose wording was
 * changed after it went out, which no prefix relation can express. */
const LINK_SIMILARITY = 0.55;
const LINK_SIMILARITY_MARGIN = 0.1;

export function editorialTexts(backendDb: BackendDb): EditorialText[] {
  return unsafeDb(backendDb)
    .sqlite.prepare("SELECT post_key, text_en, date_utc FROM posts WHERE trim(COALESCE(text_en, '')) <> ''")
    .all() as EditorialText[];
}

/**
 * The editorial post one tweet belongs to, or nothing.
 *
 * Two rules, both requiring a single clear winner. A unique long prefix is the
 * strict one: X truncates an export's text, so the tweet reads as the opening
 * of the post. The other covers a post edited after publication, where the two
 * texts diverge mid-sentence — there the day has to agree as well, which is
 * what keeps three tweets about one launch from all claiming its post.
 *
 * Replies are never offered here: their text describes the conversation, not
 * the material being measured.
 */
export function matchEditorialPost(item: XActivityText, posts: EditorialText[]): string | null {
  const source = comparableText(item.text);
  if (source.length < LINK_PREFIX_LENGTH) return null;
  const prefixed = posts.filter((post) => comparableText(post.text_en).startsWith(source));
  if (prefixed.length === 1) return prefixed[0]?.post_key ?? null;
  if (prefixed.length > 1) return null;
  const day = item.publishedAt?.slice(0, 10);
  if (!day) return null;
  const best = bestSimilarMatch(item.text, posts);
  if (!best || best.similarity < LINK_SIMILARITY || best.similarity - best.runnerUp < LINK_SIMILARITY_MARGIN) return null;
  return best.date?.slice(0, 10) === day ? best.postKey : null;
}

export type SimilarMatch = { postKey: string; similarity: number; runnerUp: number; date: string | null; text: string };

/** The post a text reads most like, with the score the runner-up reached. */
export function bestSimilarMatch(text: string, posts: EditorialText[]): SimilarMatch | null {
  const source = words(text);
  if (source.size < 4) return null;
  let best: SimilarMatch | null = null;
  let runnerUp = 0;
  for (const post of posts) {
    const similarity = jaccard(source, words(post.text_en));
    if (best && similarity <= best.similarity) {
      runnerUp = Math.max(runnerUp, similarity);
      continue;
    }
    if (best) runnerUp = Math.max(runnerUp, best.similarity);
    best = { postKey: post.post_key, similarity, runnerUp: 0, date: post.date_utc, text: post.text_en };
  }
  return best ? { ...best, runnerUp } : null;
}

function words(value: string): Set<string> {
  return new Set(
    comparableText(value)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}
