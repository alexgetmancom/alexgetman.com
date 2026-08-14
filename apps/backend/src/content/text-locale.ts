/** Which language a post is written in, or null when the text does not say.
 *
 * Alphabet, not vocabulary. A Russian post here is Cyrillic with Latin islands
 * — product names, code, handles, links — and an English post is Latin with no
 * Cyrillic at all. Counting letters by script and demanding a wide margin is
 * what keeps "используем React и Bun" from reading as English.
 *
 * Everything between the two margins is unknown, and unknown never blocks: a
 * wrong refusal costs a publication that was fine, a missed one costs nothing
 * but the check. The margins are set so no real post lands in the middle — a
 * translated post is above 0.9 Cyrillic or at 0.
 */
export type TextLocale = "ru" | "en";

/** Links, handles, hashtags and code are Latin in both languages, so they are
 * noise here: without this a short Russian post carrying a URL reads English. */
const NOT_PROSE = /(https?:\/\/\S+|www\.\S+|[@#]\S+|`[^`]*`)/gu;
const CYRILLIC = /\p{Script=Cyrillic}/gu;
const LATIN = /\p{Script=Latin}/gu;
/** Words a sentence is built from, as opposed to the names it mentions. */
const LOWERCASE_WORD = /(?<![\p{L}\p{N}_])\p{Ll}[\p{L}]*/gu;

/** Under this there is no signal to read: a link, an emoji and a brand name are
 * not a language. */
const MINIMUM_LETTERS = 24;
const RUSSIAN_SHARE = 0.5;
const ENGLISH_SHARE = 0.1;

export function textLocale(value: string): TextLocale | null {
  const prose = value.replace(NOT_PROSE, " ");
  const cyrillic = prose.match(CYRILLIC)?.length ?? 0;
  const latin = prose.match(LATIN)?.length ?? 0;
  const letters = cyrillic + latin;
  if (letters < MINIMUM_LETTERS) return null;
  const share = cyrillic / letters;
  if (share >= RUSSIAN_SHARE) return "ru";
  if (share > ENGLISH_SHARE) return null;
  // Absence of Cyrillic is not English. A Russian post can be a list of the
  // things it is about — "Astra, Bun, Threads API, YouTube Shorts" — and calling
  // that English would refuse it on the Russian channel it was written for.
  // English prose is carried by its lowercase words; a list of names has none.
  return lowercaseLetters(prose) >= MINIMUM_LETTERS ? "en" : null;
}

function lowercaseLetters(prose: string): number {
  return (prose.match(LOWERCASE_WORD) ?? []).reduce((total, word) => total + word.length, 0);
}
