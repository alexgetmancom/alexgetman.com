import type { DraftMessage } from "./message.js";

/** Turns a Markdown article into the representation the rest of the system
 * already reads: plain text plus offset/length entities.
 *
 * Markdown lives only here, at the edge where a file arrives. Nothing
 * downstream knows the body was ever Markdown -- the site renderer and the X
 * Article renderer both read the same text and entities a Telegram message
 * produces, so an article written in a file and one written in a chat are the
 * same thing by the time they are stored. */
export type ParsedArticle = { title: string; body: DraftMessage };

type Entity = Record<string, unknown>;

const INLINE_PATTERNS: Array<{ pattern: RegExp; type: string; url?: (match: RegExpExecArray) => string }> = [
  { pattern: /\[([^\]\n]+)\]\(([^)\s]+)\)/, type: "text_link", url: (match) => match[2] ?? "" },
  { pattern: /\*\*([^*\n]+)\*\*/, type: "bold" },
  { pattern: /__([^_\n]+)__/, type: "bold" },
  { pattern: /(?<![*\w])\*([^*\n]+)\*(?!\*)/, type: "italic" },
  { pattern: /(?<![_\w])_([^_\n]+)_(?!_)/, type: "italic" },
  { pattern: /~~([^~\n]+)~~/, type: "strikethrough" },
  { pattern: /`([^`\n]+)`/, type: "code" },
];

/** The first `# ` heading is the article's title and leaves the body; a
 * document without one keeps its whole text as the body and reports no title,
 * so the caller decides what to do rather than being handed a guess. */
export function parseMarkdownArticle(source: string): ParsedArticle {
  const lines = normalize(source).split("\n");
  const titleIndex = lines.findIndex((line) => /^#\s+\S/.test(line));
  const title = titleIndex === -1 ? "" : (lines[titleIndex] ?? "").replace(/^#\s+/, "").trim();
  const bodyLines = titleIndex === -1 ? lines : [...lines.slice(0, titleIndex), ...lines.slice(titleIndex + 1)];
  return { title, body: renderBody(trimBlankEdges(bodyLines)) };
}

function renderBody(lines: string[]): DraftMessage {
  const out: string[] = [];
  const entities: Entity[] = [];
  let offset = 0;
  for (const raw of lines) {
    const block = blockOf(raw);
    const { text, inline } = inlineEntities(block.text);
    if (block.type) entities.push({ type: block.type, offset, length: text.length, ...block.extra });
    for (const entity of inline) entities.push({ ...entity, offset: offset + Number(entity.offset) });
    out.push(text);
    offset += text.length + 1; // the newline that rejoins the lines
  }
  return { text: out.join("\n"), media: [], entities };
}

type Block = { text: string; type: string | null; extra: Record<string, unknown> };

function blockOf(line: string): Block {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return { text: (heading[2] ?? "").trim(), type: "heading", extra: { level: (heading[1] ?? "#").length } };
  const quote = /^>\s?(.*)$/.exec(line);
  if (quote) return { text: (quote[1] ?? "").trim(), type: "quote", extra: {} };
  const item = /^\s*[-*+]\s+(.*)$/.exec(line);
  if (item) return { text: (item[1] ?? "").trim(), type: "list_item", extra: {} };
  const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
  if (ordered) return { text: (ordered[1] ?? "").trim(), type: "list_item", extra: {} };
  return { text: line, type: null, extra: {} };
}

/** Strips one line's markers, leftmost first, and records what each covered.
 * Offsets are against the stripped text, which is what every consumer measures
 * against -- computing them over the marked-up source is how a bold range ends
 * up two characters off. */
function inlineEntities(line: string): { text: string; inline: Entity[] } {
  let text = line;
  const inline: Entity[] = [];
  for (;;) {
    const next = INLINE_PATTERNS.map(({ pattern, type, url }) => {
      const match = pattern.exec(text);
      return match ? { match, type, url } : null;
    })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((left, right) => left.match.index - right.match.index)
      .at(0);
    if (!next) break;
    const inner = next.match[1] ?? "";
    const start = next.match.index;
    text = text.slice(0, start) + inner + text.slice(start + next.match[0].length);
    const consumed = next.match[0].length - inner.length;
    // Everything already recorded that sits after this marker shifts left by
    // exactly what the marker took with it.
    for (const entity of inline) if (Number(entity.offset) > start) entity.offset = Number(entity.offset) - consumed;
    const url = next.url?.(next.match);
    if (next.type === "text_link" && !safeHttpUrl(url ?? "")) continue;
    inline.push({ type: next.type, offset: start, length: inner.length, ...(url ? { url } : {}) });
  }
  return { text, inline };
}

function normalize(source: string): string {
  return source.replace(/\r\n?/g, "\n").trimEnd();
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !(lines[start] ?? "").trim()) start += 1;
  while (end > start && !(lines[end - 1] ?? "").trim()) end -= 1;
  return lines.slice(start, end);
}

function safeHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
