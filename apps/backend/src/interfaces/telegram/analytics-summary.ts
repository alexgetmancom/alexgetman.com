import { eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { creatorDashboard } from "../../analytics/reports/dashboard.js";
import { markSynced } from "../../analytics/snapshots/creator-store.js";
import type { BackendDb } from "../../db/client.js";
import { analyticsSync } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";

/** Telegram-only weekly delivery of an already computed Analytics report. */
export async function sendWeeklyAnalyticsSummary(
  config: BackendConfig,
  backendDb: BackendDb,
  bot: Bot | null,
  now = new Date(),
): Promise<boolean> {
  if (!bot || !config.studio.modules.analytics || !config.studio.modules.video_posting) return false;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow",
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  if (parts.weekday !== "Sun" || Number(parts.hour) < 21) return false;
  const key = `weekly_summary:${parts.year}-${parts.month}-${parts.day}`;
  if (backendDb.db.select().from(analyticsSync).where(eq(analyticsSync.source, key)).get()) return false;
  const report = creatorDashboard(backendDb, config, 7).text.replace("📊 *Статистика за 7 дней*", "📊 *Итоги недели*");
  for (const adminId of config.ADMIN_IDS) await bot.api.sendMessage(adminId, report, { parse_mode: "Markdown" });
  markSynced(backendDb, key);
  return true;
}
