function cleanText(text: string): string {
  return (text || "").replace(/\n{3,}/g, "\n\n").trim();
}

export function compactText(text: string): string {
  return cleanText(text)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateText(value: string, limit: number): string {
  const text = compactText(value);
  if (text.length <= limit) return text;
  const cut = text.slice(0, Math.max(0, limit - 1));
  const lastSpace = cut.lastIndexOf(" ");
  // Cut on a word boundary unless that would drop most of the excerpt.
  const truncated = lastSpace > (limit - 1) * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${truncated.replace(/[\s,;:—–-]+$/, "")}…`;
}

export function excerptAfterTitle(text: string, title: string, limit: number): string {
  const source = compactText(text);
  const cleanTitle = compactText(title);
  let excerpt = source;
  if (cleanTitle && source.toLowerCase().startsWith(cleanTitle.toLowerCase())) {
    excerpt = source
      .slice(cleanTitle.length)
      .replace(/^[\s:—–-]+/, "")
      .trim();
    if (!excerpt || excerpt.length < 24) return "";
  }
  return truncateText(excerpt || source, limit);
}

// Canonical implementation lives in the backend (delivery/social/payload.ts) so a
// headline strips identically whether it's rendered on the site or sent to socials.
export { stripLeadingEmojis as removeLeadingEmoji } from "../../../backend/src/delivery/social/payload.js";

export function getFirstSentence(text: string): string {
  if (!text) return "";
  const newlineIdx = text.indexOf("\n");
  const match = text.match(/^.*?[.!?](?:\s|\n|$)/s);
  if (match) return newlineIdx !== -1 && newlineIdx < match[0].length ? text.slice(0, newlineIdx).trim() : match[0].trim();
  return newlineIdx !== -1 ? text.slice(0, newlineIdx).trim() : text.trim();
}
