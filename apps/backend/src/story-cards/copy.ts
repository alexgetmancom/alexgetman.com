const TEMPLATE_VERSION = "strata-v2";
const MAX_HEADLINE_CHARACTERS = 150;
const MAX_LINES = 8;
const MAX_LINE_UNITS = 10.6;

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
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || textUnits(candidate) <= MAX_LINE_UNITS) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === MAX_LINES) break;
  }
  if (current && lines.length < MAX_LINES) lines.push(current);
  const consumed = lines.join(" ").replace(/…$/, "");
  if (consumed.length < headline.replace(/…$/, "").length && lines.length) {
    const last = lines.length - 1;
    lines[last] = `${truncateAtWord(lines[last] ?? "", Math.max(1, (lines[last]?.length ?? 1) - 1)).replace(/…$/, "")}…`;
  }
  return lines.length ? lines : ["Update"];
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
