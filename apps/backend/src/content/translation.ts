import type { BackendConfig } from "../foundation/config.js";
import { requestJson } from "../foundation/http.js";

type ChatCompletion = { choices?: Array<{ message?: { content?: string } }> };

export async function translateToEnglish(text: string, config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<string> {
  const source = text.trim();
  if (!source || !config.DEEPSEEK_API_KEY || !hasCyrillic(source)) return source;
  const system = [
    "You are a senior English tech-news editor preparing concise posts for English-speaking developers.",
    "Convert the user message into clean natural English and output only the translated post.",
    "Preserve product names, commands, URLs, emojis, paragraph breaks, and the bullet character •.",
    "Do not add explanations or ask for more input. If the input is already English, polish it without changing its meaning.",
    "Keep lowercase list items lowercase. Avoid em dashes and overly literal phrasing.",
    "Use this glossary consistently: сброс лимитов = limit reset; встроенный браузер = built-in browser; нейросеть = AI model.",
  ].join("\n");
  const result = await requestJson<ChatCompletion>(fetchImpl, "https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: system },
        { role: "user", content: source },
      ],
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(40_000),
  });
  const translated = result.choices?.[0]?.message?.content?.trim() ?? "";
  if (!translated || /please provide|i'd be happy to help/i.test(translated)) throw new Error("translation returned an invalid response");
  return translated;
}

function hasCyrillic(value: string): boolean {
  return /[\u0400-\u04FF]/.test(value);
}
