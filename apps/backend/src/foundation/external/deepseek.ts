import type { BackendConfig } from "../config.js";
import { requestJson } from "../http.js";

export type DeepSeekMessage = { role: "system" | "user" | "assistant"; content: string };

type DeepSeekCompletion = { choices?: Array<{ message?: { content?: string } }> };

export async function deepSeekChat(
  config: BackendConfig,
  messages: DeepSeekMessage[],
  options: { temperature: number; timeoutMs: number; json?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not configured");
  const result = await requestJson<DeepSeekCompletion>(fetchImpl, "https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      temperature: options.temperature,
      ...(options.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  return result.choices?.[0]?.message?.content?.trim() ?? "";
}
