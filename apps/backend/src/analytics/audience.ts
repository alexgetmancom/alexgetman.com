import { desc } from "drizzle-orm";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { socialComments } from "../db/schema.js";
import { requestJson } from "../social/http.js";

export async function audienceAnalysis(backendDb: BackendDb, config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!config.DEEPSEEK_API_KEY) return "🤖 ИИ-анализ недоступен: добавьте DEEPSEEK_API_KEY в secrets.env.";
  const comments = backendDb.db
    .select({ platform: socialComments.platform, text: socialComments.text })
    .from(socialComments)
    .orderBy(desc(socialComments.publishedAt))
    .limit(100)
    .all();
  if (!comments.length)
    return "🤖 Пока нет закэшированных комментариев. Они появятся после следующего безопасного ежедневного сбора статистики.";
  const result = await requestJson<{ choices?: Array<{ message?: { content?: string } }> }>(
    fetchImpl,
    "https://api.deepseek.com/v1/chat/completions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "Ты редактор сообщества. По комментариям составь короткий отчёт на русском: 1) какие игры или темы чаще просят, 2) FAQ, 3) настроение аудитории. Не выдумывай фактов, не раскрывай имена авторов, максимум 8 пунктов.",
          },
          { role: "user", content: comments.map((comment) => `[${comment.platform}] ${comment.text}`).join("\n") },
        ],
      }),
      signal: AbortSignal.timeout(40_000),
    },
  );
  return `🤖 *ИИ-анализ аудитории*\n\n${result.choices?.[0]?.message?.content?.trim() || "Не удалось подготовить отчёт."}`;
}
