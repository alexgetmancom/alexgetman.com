import type { BackendConfig } from "../foundation/config.js";
import { deepSeekChat } from "../foundation/external/deepseek.js";

export async function translateToEnglish(text: string, config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<string> {
  const source = text.trim();
  if (!source || !config.DEEPSEEK_API_KEY || !hasCyrillic(source)) return source;
  const system = [
    "Translate the user message into English, adapted for Twitter: informal and natural, the way someone who knows the subject writes for an audience that follows it.",
    "Translate only. Keep the author's structure, order, length, facts and numbers. Do not rewrite, reorder, shorten, expand, or add anything of your own.",
    "Output only the translation. No explanations, no hashtags, no commentary, no asking for more input.",
    "Preserve product names, version numbers, commands, URLs, emojis, paragraph breaks, and the bullet character •.",
    "Keep lowercase list items lowercase. Avoid em dashes and word-for-word phrasing that reads translated.",
    "For every term, use the established English word that people in that subject already use, whatever the subject is. Never invent a term and never translate a term literally when the field has its own name for it.",
  ].join("\n");
  const translated = await deepSeekChat(
    config,
    [
      { role: "system", content: system },
      { role: "user", content: source },
    ],
    { temperature: 0.1, timeoutMs: 40_000 },
    fetchImpl,
  );
  if (!translated || /please provide|i'd be happy to help/i.test(translated)) throw new Error("translation returned an invalid response");
  return translated;
}

function hasCyrillic(value: string): boolean {
  return /[\u0400-\u04FF]/.test(value);
}
