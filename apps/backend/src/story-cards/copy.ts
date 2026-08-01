/** Part of every card's source hash, so bumping it re-renders each stored card.
 * Any change to the copy rules or to the drawn layout has to bump it — otherwise
 * cards rendered under the old rules keep their hash and are never rebuilt. */
export const TEMPLATE_VERSION = "strata-v3";
/** Safety net only. The line budget below is what normally decides the cut: at
 * MAX_LINE_UNITS per line eight lines hold roughly 155 characters, so a lower
 * cap here would truncate the headline before wrapping ever got a say. */
const MAX_HEADLINE_CHARACTERS = 210;
export const MAX_LINES = 8;
export const MAX_LINE_UNITS = 10.6;
const ELLIPSIS = "…";

export type StoryCardCopy = {
  headline: string;
  emoji: string | null;
  lines: string[];
  boldLineCount: number;
  templateVersion: typeof TEMPLATE_VERSION;
};

export function buildStoryCardCopy(text: string): StoryCardCopy {
  const normalized = text.replace(/\r/g, "").trim();
  const firstParagraph = normalized.split(/\n\s*\n/, 1)[0] ?? normalized;
  const firstLine =
    firstParagraph
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "";
  const sentence = firstSentence(firstLine || firstParagraph.replace(/\s+/g, " ").trim());
  const { emoji, body } = leadingEmoji(sentence);
  const headline = truncateAtWord(body || sentence, MAX_HEADLINE_CHARACTERS);
  const lines = wrapHeadline(headline);
  return {
    headline,
    emoji,
    lines,
    boldLineCount: Math.min(lines.length, lines.length <= 2 ? 1 : 2),
    templateVersion: TEMPLATE_VERSION,
  };
}

function firstSentence(value: string): string {
  const match = value.match(/^.*?[.!?](?=\s|$)/u);
  return (match?.[0] ?? value).trim();
}

function leadingEmoji(value: string): { emoji: string | null; body: string } {
  const [segment] = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  const candidate = segment?.segment ?? "";
  if (!candidate || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(candidate)) return { emoji: null, body: value.trim() };
  return { emoji: candidate, body: value.slice(candidate.length).trim() };
}

function truncateAtWord(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const window = value.slice(0, limit + 1);
  const boundary = window.lastIndexOf(" ");
  return `${value.slice(0, boundary > limit * 0.6 ? boundary : limit).trim()}…`;
}

function wrapHeadline(headline: string): string[] {
  const words = headline.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let index = 0;
  for (; index < words.length; index++) {
    const word = words[index] ?? "";
    const candidate = current ? `${current} ${word}` : word;
    if (textUnits(candidate) <= MAX_LINE_UNITS) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = "";
    if (lines.length >= MAX_LINES) break;
    // A single word can be wider than the line box — a URL, a long compound.
    // SVG text does not clip, so an unbroken word would be drawn past the card
    // edge; break it by width instead of letting it overflow.
    let rest = word;
    while (textUnits(rest) > MAX_LINE_UNITS && lines.length < MAX_LINES) {
      const head = takeUnits(rest, MAX_LINE_UNITS);
      lines.push(head);
      rest = rest.slice(head.length);
    }
    if (lines.length >= MAX_LINES) break;
    current = rest;
  }
  const overflowed = index < words.length || (Boolean(current) && lines.length >= MAX_LINES);
  if (current && lines.length < MAX_LINES) lines.push(current);
  const last = lines.length - 1;
  if (overflowed && last >= 0) lines[last] = ellipsize(lines[last] ?? "");
  return lines.length ? lines : ["Update"];
}

/** Longest prefix of `value` that still fits `limit` text units, at least one character. */
function takeUnits(value: string, limit: number): string {
  let taken = "";
  for (const char of value) {
    if (taken && textUnits(taken + char) > limit) break;
    taken += char;
  }
  return taken || value.slice(0, 1);
}

function ellipsize(line: string): string {
  const base = line.replace(/…$/, "");
  return `${takeUnits(base, MAX_LINE_UNITS - textUnits(ELLIPSIS)).trimEnd()}${ELLIPSIS}`;
}

/** Estimated drawn width of a line, in multiples of the line box. Manrope is not
 * measured here — the renderer runs in another process — so the weights are
 * per-character approximations calibrated against the rendered card. */
export function lineUnits(value: string): number {
  return textUnits(value);
}

function textUnits(value: string): number {
  let units = 0;
  for (const char of value) {
    if (char === " ") units += 0.28;
    else if (/[ilI1|.,:;!'`]/u.test(char)) units += 0.28;
    else if (/[mwMWЖШЩЮФ]/u.test(char)) units += 0.82;
    else if (/[A-ZА-ЯЁ0-9]/u.test(char)) units += 0.64;
    else units += 0.55;
  }
  return units;
}
