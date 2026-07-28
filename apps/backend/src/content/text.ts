type Wrapper = { open: string; close: string };

/** Renders Telegram entities over `text` in a single left-to-right pass,
 * emitting close tags before open tags at each boundary.
 *
 * The obvious alternative — wrapping one entity at a time by slicing the
 * accumulated HTML — is wrong for nested entities (Telegram routinely sends
 * bold and text_link over the same range): the first wrap shifts every later
 * offset, but those offsets are still computed against the original plain
 * text, so the second wrap slices in the wrong place and tears the markup.
 * Offsets here are only ever read against `text`, never against the output. */
export function entitiesToHtml(text: string, entities: Record<string, unknown>[]): string {
  const spans = entities
    .map((entity) => ({ entity, offset: Number(entity.offset), length: Number(entity.length) }))
    .filter((item) => Number.isInteger(item.offset) && Number.isInteger(item.length) && item.offset >= 0 && item.length > 0)
    .filter((item) => item.offset + item.length <= text.length)
    .flatMap((item) => {
      const wrapper = entityWrapper(String(item.entity.type ?? ""), item.entity, text.slice(item.offset, item.offset + item.length));
      return wrapper ? [{ start: item.offset, end: item.offset + item.length, wrapper }] : [];
    })
    // Outermost first at a shared start, so a longer span opens before the
    // shorter one it contains and the close order stays a mirror image.
    .sort((left, right) => left.start - right.start || right.end - left.end);

  const opens = new Map<number, Wrapper[]>();
  const closes = new Map<number, Wrapper[]>();
  for (const span of spans) {
    opens.set(span.start, [...(opens.get(span.start) ?? []), span.wrapper]);
    // Innermost closes first: prepend, mirroring the open order at this point.
    closes.set(span.end, [span.wrapper, ...(closes.get(span.end) ?? [])]);
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const boundary of [...new Set([...opens.keys(), ...closes.keys()])].sort((left, right) => left - right)) {
    parts.push(renderText(text.slice(cursor, boundary)));
    for (const wrapper of closes.get(boundary) ?? []) parts.push(wrapper.close);
    for (const wrapper of opens.get(boundary) ?? []) parts.push(wrapper.open);
    cursor = boundary;
  }
  parts.push(renderText(text.slice(cursor)));
  return parts.join("");
}

function entityWrapper(type: string, entity: Record<string, unknown>, raw: string): Wrapper | null {
  if (type === "bold") return { open: "<strong>", close: "</strong>" };
  if (type === "italic") return { open: "<em>", close: "</em>" };
  if (type === "underline") return { open: "<u>", close: "</u>" };
  if (type === "strikethrough") return { open: "<s>", close: "</s>" };
  if (type === "spoiler") return { open: '<span class="spoiler">', close: "</span>" };
  if (type === "code") return { open: "<code>", close: "</code>" };
  if (type === "pre") return { open: "<pre><code>", close: "</code></pre>" };
  if (type === "text_link" && typeof entity.url === "string" && safeHttpUrl(entity.url))
    return { open: `<a href="${escapeHtml(entity.url)}" rel="noopener noreferrer">`, close: "</a>" };
  // A bare `url` entity's href is its own text. Telegram also auto-detects
  // schemeless domains, so it gets the same protocol check as text_link.
  if (type === "url" && safeHttpUrl(raw)) return { open: `<a href="${escapeHtml(raw)}" rel="noopener noreferrer">`, close: "</a>" };
  if (type === "url" && safeHttpUrl(`https://${raw}`))
    return { open: `<a href="https://${escapeHtml(raw)}" rel="noopener noreferrer">`, close: "</a>" };
  return null;
}

function renderText(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

/** The first hidden link in reading order, for platforms that append at most one.
 * Telegram sends entities in offset order, but a payload can be re-serialized on
 * the way here, so the order is established rather than assumed. */
export function firstTextLinkUrl(entities: Record<string, unknown>[]): string | null {
  return (
    [...entities]
      .sort((left, right) => Number(left.offset ?? 0) - Number(right.offset ?? 0))
      .flatMap((entity) => (entity.type === "text_link" && typeof entity.url === "string" && safeHttpUrl(entity.url) ? [entity.url] : []))
      .at(0) ?? null
  );
}

function safeHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (char) => entities[char] ?? char);
}

/** Canonical leading-emoji stripper, shared by the social payload builder and the
 * web app (apps/web/src/utils/text.ts re-exports it) so a post's headline strips
 * identically in both. It lives in Content rather than in delivery/social because
 * the site is its only other caller and presentation code must not reach into a
 * delivery adapter for a string helper. Handles flag pairs and ZWJ sequences; a
 * bare "#"/digit is not treated as an emoji so hashtags and numbered lists
 * survive. */
export function stripLeadingEmojis(text: string): string {
  if (!text) return "";
  const cleaned = text.trim();
  const flagGroup = cleaned.match(/^(\p{RI}{2})\s*/u)?.[1];
  if (flagGroup) return cleaned.slice(flagGroup.length).trim();
  const baseEmojiPart = `(?:[^\\s\\w\\d.,!?;:()""''«»а-яА-ЯёЁa-zA-Z][\\ufe00-\\ufe0f\\u20e3]?|[\\ud83c][\\udffb-\\udfff]?)`;
  const zwjRegex = new RegExp(`^(?:${baseEmojiPart}(?:\\u200d${baseEmojiPart})*)`, "u");
  const matched = cleaned.match(zwjRegex)?.[0];
  if (matched && /\p{Emoji}/u.test(matched) && !/^[#*0-9]$/.test(matched[0] ?? "")) return cleaned.slice(matched.length).trim();
  return cleaned;
}
