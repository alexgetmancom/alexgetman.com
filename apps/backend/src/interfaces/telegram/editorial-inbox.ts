import { desc, eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { markSynced } from "../../analytics/snapshots/creator-store.js";
import type { BackendDb } from "../../db/client.js";
import { analyticsSync, posts } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { requestJson } from "../../foundation/http.js";
import { log } from "../../foundation/logger.js";

type ChatCompletion = { choices?: Array<{ message?: { content?: string } }> };
type Opportunity = { kind?: string; title?: string; reason?: string; posts?: number[] };
type EditorialResponse = { items?: Opportunity[] };

/**
 * One small daily inbox, not an autonomous editorial system. It turns the
 * accumulated post archive into a few review, guide, data and roundup ideas;
 * a human still decides whether any of them deserve publication.
 */
export async function sendDailyEditorialInbox(
  config: BackendConfig,
  backendDb: BackendDb,
  bot: Bot | null,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!bot || !config.DEEPSEEK_API_KEY || config.ADMIN_IDS.length === 0) return false;
  const date = moscowDate(now);
  if (date.hour < config.EDITORIAL_INBOX_HOUR_MSK) return false;
  const key = `editorial_inbox:${date.day}`;
  if (backendDb.db.select().from(analyticsSync).where(eq(analyticsSync.source, key)).get()) return false;

  const material = backendDb.db
    .select({ postId: posts.postId, date: posts.dateUtc, text: posts.text, textEn: posts.textEn })
    .from(posts)
    .where(eq(posts.status, "active"))
    .orderBy(desc(posts.dateUtc), desc(posts.createdAt))
    .limit(24)
    .all()
    .flatMap((post) => {
      const text = (post.text ?? post.textEn ?? "").trim();
      return post.postId != null && text ? [{ id: post.postId, date: post.date, text: text.slice(0, 900) }] : [];
    });
  if (material.length === 0) return false;

  try {
    const response = await requestJson<ChatCompletion>(fetchImpl, "https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: [
              "You are an editorial research assistant for a solo AI news creator.",
              "Using only the supplied published posts, propose at most three useful next pieces: a deep review, a practical guide, an official-data update, or a weekly roundup.",
              "Do not invent facts, demand a conclusion, write publication copy, or use generic SEO ideas.",
              "Each reason must name the concrete cluster or gap found in the supplied posts.",
              'Return strict JSON only: {"items":[{"kind":"review|guide|data|roundup","title":"...","reason":"...","posts":[1,2]}]}.',
            ].join("\n"),
          },
          { role: "user", content: JSON.stringify({ posts: material }) },
        ],
        response_format: { type: "json_object" },
        signal: AbortSignal.timeout(45_000),
      }),
    });
    const generated = response.choices?.[0]?.message?.content ?? "";
    const items = editorialItems(generated);
    if (items.length === 0) throw new Error("editorial inbox returned no usable opportunities");
    const message = renderInbox(items);
    for (const adminId of config.ADMIN_IDS) await bot.api.sendMessage(adminId, message);
    markSynced(backendDb, key);
    return true;
  } catch (error) {
    // One failed provider call should not retry every five seconds all day.
    markSynced(backendDb, key, String(error).slice(0, 500));
    log("warn", "daily editorial inbox failed", { error: String(error) });
    return false;
  }
}

function moscowDate(now: Date): { day: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function editorialItems(value: string): Required<Pick<Opportunity, "kind" | "title" | "reason" | "posts">>[] {
  const parsed = JSON.parse(value) as EditorialResponse;
  if (!Array.isArray(parsed.items)) return [];
  return parsed.items
    .flatMap((item) => {
      const title = item.title?.trim().replace(/\s+/g, " ").slice(0, 180);
      const reason = item.reason?.trim().replace(/\s+/g, " ").slice(0, 360);
      const kind = ["review", "guide", "data", "roundup"].includes(item.kind ?? "") ? (item.kind ?? "review") : "review";
      const postIds = (item.posts ?? []).filter((id) => Number.isSafeInteger(id)).slice(0, 6);
      return title && reason ? [{ kind, title, reason, posts: postIds }] : [];
    })
    .slice(0, 3);
}

function renderInbox(items: Required<Pick<Opportunity, "kind" | "title" | "reason" | "posts">>[]): string {
  const labels: Record<string, string> = { review: "Разбор", guide: "Гайд", data: "Данные", roundup: "Итог" };
  const rows = items.map((item, index) => {
    const refs = item.posts.length ? `\nПосты: ${item.posts.map((id) => `#${id}`).join(", ")}` : "";
    return `${index + 1}. ${labels[item.kind] ?? "Идея"}: ${item.title}\n${item.reason}${refs}`;
  });
  return `Редакционный inbox\n\n${rows.join("\n\n")}`;
}
