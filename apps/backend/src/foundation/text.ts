/** Truncates text by Unicode code points and repairs lone UTF-16 surrogates.
 * Telegram accepts Unicode text, not a half of a JavaScript surrogate pair. */
export function truncateUnicode(value: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return "";
  let result = "";
  let count = 0;
  for (const character of value) {
    if (count >= maxCharacters) break;
    const codePoint = character.codePointAt(0) ?? 0;
    result += codePoint >= 0xd800 && codePoint <= 0xdfff ? "�" : character;
    count += 1;
  }
  return result;
}
