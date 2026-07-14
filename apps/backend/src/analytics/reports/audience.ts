import { desc } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { socialComments } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { requestJson } from "../../foundation/http.js";
import { type StudioLocale as BotLocale, localize as ui } from "../../foundation/locale.js";

export async function audienceAnalysis(
  backendDb: BackendDb,
  config: BackendConfig,
  locale: BotLocale = "ru",
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.DEEPSEEK_API_KEY)
    return `🤖 ${ui(locale, "AI analysis is unavailable: add DEEPSEEK_API_KEY to secrets.env.", "ИИ-анализ недоступен: добавьте DEEPSEEK_API_KEY в secrets.env.")}`;
  const comments = backendDb.db
    .select({ platform: socialComments.platform, text: socialComments.text })
    .from(socialComments)
    .orderBy(desc(socialComments.publishedAt))
    .limit(100)
    .all();
  if (!comments.length)
    return `🤖 ${ui(
      locale,
      "There are no cached comments yet. They will appear after the next daily metrics collection.",
      "Пока нет закэшированных комментариев. Они появятся после следующего ежедневного сбора статистики.",
    )}`;
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
            content: ui(
              locale,
              "You are a community editor. From these comments, write a concise report in English: 1) games or topics requested most often, 2) FAQ, 3) audience sentiment, 4) up to 3 ideas for the next Shorts/Reels. Use only these comments, do not invent facts or reveal author names, and use at most 10 bullet points.",
              "Ты редактор сообщества. По комментариям составь короткий отчёт на русском: 1) какие игры или темы чаще просят, 2) FAQ, 3) настроение аудитории, 4) до 3 идей следующих Shorts/Reels, основанных только на этих комментариях. Не выдумывай фактов, не раскрывай имена авторов, максимум 10 пунктов.",
            ),
          },
          { role: "user", content: comments.map((comment) => `[${comment.platform}] ${comment.text}`).join("\n") },
        ],
      }),
      signal: AbortSignal.timeout(40_000),
    },
  );
  return `🤖 *${ui(locale, "AI audience analysis", "ИИ-анализ аудитории")}*\n\n${result.choices?.[0]?.message?.content?.trim() || ui(locale, "I couldn't prepare a report.", "Не удалось подготовить отчёт.")}`;
}
