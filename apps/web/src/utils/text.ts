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
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
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

export function removeLeadingEmoji(text: string): string {
  if (!text) return "";
  const cleaned = text.trim();
  const flagMatch = cleaned.match(/^(\p{RI}{2})\s*/u);
  if (flagMatch) return cleaned.slice(flagMatch[1].length).trim();
  const baseEmojiPart = `(?:[^\\s\\w\\d.,!?;:()""''«»а-яА-ЯёЁa-zA-Z][\\ufe00-\\ufe0f\\u20e3]?|[\\ud83c][\\udffb-\\udfff]?)`;
  const zwjRegex = new RegExp(`^(?:${baseEmojiPart}(?:\\u200d${baseEmojiPart})*)`, "u");
  const match = cleaned.match(zwjRegex);
  if (match?.[0] && /\p{Emoji}/u.test(match[0]) && !/^[#*0-9]$/.test(match[0][0])) return cleaned.slice(match[0].length).trim();
  return cleaned;
}

export function getFirstSentence(text: string): string {
  if (!text) return "";
  const newlineIdx = text.indexOf("\n");
  const match = text.match(/^.*?[.!?](?:\s|\n|$)/s);
  if (match) return newlineIdx !== -1 && newlineIdx < match[0].length ? text.slice(0, newlineIdx).trim() : match[0].trim();
  return newlineIdx !== -1 ? text.slice(0, newlineIdx).trim() : text.trim();
}
