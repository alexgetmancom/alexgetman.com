import { desc } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { socialComments } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { deepSeekChat } from "../../foundation/external/deepseek.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";

const SYSTEM_PROMPT =
  "You are a community editor. From these comments, write a concise report in English: 1) games or topics requested most often, 2) FAQ, 3) audience sentiment, 4) up to 3 ideas for the next Shorts/Reels. Use only these comments, do not invent facts or reveal author names, and use at most 10 bullet points.";

export async function audienceAnalysis(
  backendDb: BackendDb,
  config: BackendConfig,
  locale: StudioLocale = "ru",
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.DEEPSEEK_API_KEY) return `🤖 ${t(locale, "audience.unavailable")}`;
  const comments = unsafeDb(backendDb)
    .db.select({ platform: socialComments.platform, text: socialComments.text })
    .from(socialComments)
    .orderBy(desc(socialComments.publishedAt))
    .limit(100)
    .all();
  if (!comments.length) return `🤖 ${t(locale, "audience.no-comments")}`;
  const content = await deepSeekChat(
    config,
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: comments.map((comment) => `[${comment.platform}] ${comment.text}`).join("\n") },
    ],
    { temperature: 0.2, timeoutMs: 40_000 },
    fetchImpl,
  );
  return `🤖 *${t(locale, "audience.title")}*\n\n${content || t(locale, "audience.no-report")}`;
}
