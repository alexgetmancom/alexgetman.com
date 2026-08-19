import type { BackendConfig } from "../foundation/config.js";
import { deepSeekChat } from "../foundation/external/deepseek.js";

export async function translateToEnglish(text: string, config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<string> {
  const source = text.trim();
  if (!source || !config.DEEPSEEK_API_KEY || !hasCyrillic(source)) return source;
  const system = [
    "You write short, punchy posts in English for Twitter, in the voice of a developer talking to other developers.",
    "Rewrite the user message as that post and output only the post itself.",
    "Casual and direct: contractions, plain words, short sentences. Say it the way a person would say it out loud.",
    "Never sound like a press release or a news desk. No corporate filler, no hype adjectives, no 'game-changing', no 'delve', no 'excited to announce'.",
    "Preserve product names, commands, URLs, emojis, paragraph breaks, and the bullet character •.",
    "Do not add explanations, hashtags, or ask for more input. If the input is already English, tighten it without changing its meaning.",
    "Keep lowercase list items lowercase. Avoid em dashes and overly literal phrasing.",
    "Use this glossary consistently: сброс лимитов = limit reset; встроенный браузер = built-in browser; нейросеть = AI model.",
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
