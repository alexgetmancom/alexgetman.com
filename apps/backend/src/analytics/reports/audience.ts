import { desc } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { socialComments } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { requestJson } from "../../foundation/http.js";
import type { StudioLocale as BotLocale } from "../../foundation/locale.js";
import { t } from "../../interfaces/telegram/i18n/index.js";

export async function audienceAnalysis(
  backendDb: BackendDb,
  config: BackendConfig,
  locale: BotLocale = "ru",
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.DEEPSEEK_API_KEY) return `🤖 ${t(locale, "audience.unavailable")}`;
  const comments = backendDb.db
    .select({ platform: socialComments.platform, text: socialComments.text })
    .from(socialComments)
    .orderBy(desc(socialComments.publishedAt))
    .limit(100)
    .all();
  if (!comments.length) return `🤖 ${t(locale, "audience.no-comments")}`;
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
            content: t(locale, "audience.prompt"),
          },
          { role: "user", content: comments.map((comment) => `[${comment.platform}] ${comment.text}`).join("\n") },
        ],
      }),
      signal: AbortSignal.timeout(40_000),
    },
  );
  return `🤖 *${t(locale, "audience.title")}*\n\n${result.choices?.[0]?.message?.content?.trim() || t(locale, "audience.no-report")}`;
}
