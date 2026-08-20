/** X's rich-text representation for Article bodies. It is DraftJS raw state
 * with snake_case field names: blocks carry their own text and ranges, and one
 * entity map is shared across them.
 *
 * The source form is the one every other target already reads -- plain text
 * plus offset/length entities -- so an article body is written once and
 * rendered per platform, the same way `entitiesToHtml` renders it for the site. */
type ContentStateBlockType = "unstyled" | "header-one" | "header-two" | "unordered-list-item" | "blockquote" | "code-block";

type InlineStyle = "BOLD" | "ITALIC" | "UNDERLINE" | "STRIKETHROUGH" | "CODE";

type ContentStateBlock = {
  key: string;
  text: string;
  type: ContentStateBlockType | "atomic";
  depth: number;
  inline_style_ranges: Array<{ offset: number; length: number; style: InlineStyle }>;
  entity_ranges: Array<{ offset: number; length: number; key: number }>;
};

type ContentStateEntity = {
  type: "LINK" | "MEDIA";
  mutability: "MUTABLE" | "IMMUTABLE";
  data: Record<string, unknown>;
};

export type ContentState = { blocks: ContentStateBlock[]; entity_map: Record<string, ContentStateEntity> };

const INLINE_STYLES: Record<string, InlineStyle> = {
  bold: "BOLD",
  italic: "ITALIC",
  underline: "UNDERLINE",
  strikethrough: "STRIKETHROUGH",
  code: "CODE",
};

const BLOCK_TYPES: Record<string, ContentStateBlockType> = {
  heading: "header-two",
  quote: "blockquote",
  list_item: "unordered-list-item",
  pre: "code-block",
};

type Span = { start: number; end: number; entity: Record<string, unknown> };

/** Renders a body into `content_state`. `media` becomes trailing atomic blocks:
 * the source format carries media beside the text rather than positioned inside
 * it, and inventing a position would put an image somewhere the author never
 * put it. */
export function toContentState(text: string, entities: Record<string, unknown>[], media: readonly string[] = []): ContentState {
  const spans = normalizeSpans(text, entities);
  const entityMap: Record<string, ContentStateEntity> = {};
  const blocks: ContentStateBlock[] = [];
  let cursor = 0;
  let entityKey = 0;

  for (const [index, line] of text.split("\n").entries()) {
    const lineStart = cursor;
    const lineEnd = lineStart + line.length;
    cursor = lineEnd + 1; // the newline the split consumed
    // A blank line separates paragraphs in the source text and carries no
    // content of its own; emitting it would double every paragraph gap.
    if (!line.trim()) continue;

    const covering = spans.filter((span) => span.start < lineEnd && span.end > lineStart);
    const block: ContentStateBlock = {
      key: `b${index}`,
      text: line,
      type: blockTypeOf(covering, lineStart, lineEnd),
      depth: 0,
      inline_style_ranges: [],
      entity_ranges: [],
    };
    for (const span of covering) {
      const offset = Math.max(span.start, lineStart) - lineStart;
      const length = Math.min(span.end, lineEnd) - lineStart - offset;
      if (length <= 0) continue;
      const style = INLINE_STYLES[String(span.entity.type ?? "")];
      if (style) {
        block.inline_style_ranges.push({ offset, length, style });
        continue;
      }
      const url = linkUrl(span, text);
      if (!url) continue;
      entityMap[String(entityKey)] = { type: "LINK", mutability: "MUTABLE", data: { url } };
      block.entity_ranges.push({ offset, length, key: entityKey });
      entityKey += 1;
    }
    blocks.push(block);
  }

  for (const [index, mediaId] of media.entries()) {
    entityMap[String(entityKey)] = { type: "MEDIA", mutability: "IMMUTABLE", data: { media_id: mediaId } };
    blocks.push({
      key: `m${index}`,
      text: " ",
      type: "atomic",
      depth: 0,
      inline_style_ranges: [],
      entity_ranges: [{ offset: 0, length: 1, key: entityKey }],
    });
    entityKey += 1;
  }

  // An Article with no body still needs one block: an empty `blocks` array is
  // rejected by the draft endpoint rather than treated as an empty document.
  if (blocks.length === 0) blocks.push({ key: "b0", text: "", type: "unstyled", depth: 0, inline_style_ranges: [], entity_ranges: [] });
  return { blocks, entity_map: entityMap };
}

/** A block type is declared by an entity covering the whole line. Anything
 * partial is inline styling, whatever its type says. */
function blockTypeOf(covering: Span[], lineStart: number, lineEnd: number): ContentStateBlockType {
  for (const span of covering) {
    const type = BLOCK_TYPES[String(span.entity.type ?? "")];
    if (!type) continue;
    if (span.start > lineStart || span.end < lineEnd) continue;
    if (type !== "header-two") return type;
    return Number(span.entity.level ?? 2) <= 1 ? "header-one" : "header-two";
  }
  return "unstyled";
}

function normalizeSpans(text: string, entities: Record<string, unknown>[]): Span[] {
  return entities
    .map((entity) => ({ entity, offset: Number(entity.offset), length: Number(entity.length) }))
    .filter((item) => Number.isInteger(item.offset) && Number.isInteger(item.length) && item.offset >= 0 && item.length > 0)
    .filter((item) => item.offset + item.length <= text.length)
    .map((item) => ({ start: item.offset, end: item.offset + item.length, entity: item.entity }))
    .sort((left, right) => left.start - right.start || right.end - left.end);
}

function linkUrl(span: Span, text: string): string | null {
  const type = String(span.entity.type ?? "");
  if (type === "text_link") return typeof span.entity.url === "string" && safeHttpUrl(span.entity.url) ? span.entity.url : null;
  if (type !== "url") return null;
  const raw = text.slice(span.start, span.end);
  if (safeHttpUrl(raw)) return raw;
  return safeHttpUrl(`https://${raw}`) ? `https://${raw}` : null;
}

function safeHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
