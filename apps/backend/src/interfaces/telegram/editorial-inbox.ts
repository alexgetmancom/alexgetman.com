import { desc, eq, sql } from "drizzle-orm";
import { claimSync, markSynced } from "../../analytics/snapshots/creator-store.js";
import { botLocale } from "../../bot/i18n.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { knowledgeEntities, postEntityLinks, posts } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { requestJson } from "../../foundation/http.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { log } from "../../foundation/logger.js";
import { truncateUnicode } from "../../foundation/text.js";

type ChatCompletion = { choices?: Array<{ message?: { content?: string } }> };
type Opportunity = { kind?: string; title?: string; reason?: string; posts?: number[] };
type EditorialResponse = { items?: Opportunity[] };

export type EditorialInboxBot = {
  api: {
    sendMessage: (actorId: number, text: string) => Promise<unknown>;
  };
};

/**
 * One small daily inbox, not an autonomous editorial system. It turns the
 * accumulated post archive into a few review, guide, data and roundup ideas;
 * a human still decides whether any of them deserve publication.
 */
export async function sendDailyEditorialInbox(
  config: BackendConfig,
  backendDb: BackendDb,
  bot: EditorialInboxBot | null,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!bot || !config.DEEPSEEK_API_KEY || config.ADMIN_IDS.length === 0) return false;
  const date = zonedDate(config.TIMEZONE, now);
  if (date.hour < config.EDITORIAL_INBOX_HOUR_MSK) return false;
  const key = `editorial_inbox:${date.day}`;

  const material = unsafeDb(backendDb)
    .db.select({ postId: posts.postId, date: posts.dateUtc, text: posts.text, textEn: posts.textEn })
    .from(posts)
    .where(eq(posts.status, "active"))
    .orderBy(desc(posts.dateUtc), desc(posts.createdAt))
    .limit(24)
    .all()
    .flatMap((post) => {
      const textRu = (post.text ?? "").trim();
      const textEn = (post.textEn ?? "").trim();
      return post.postId != null && (textRu || textEn)
        ? [{ id: post.postId, date: post.date, textRu: truncateUnicode(textRu, 900), textEn: truncateUnicode(textEn, 900) }]
        : [];
    });
  if (material.length === 0) return false;
  const owner = "telegram:editorial-inbox";
  if (!claimSync(backendDb, key, 24 * 60 * 60, owner)) return false;
  const clusters = unsafeDb(backendDb)
    .db.select({
      slug: knowledgeEntities.slug,
      titleRu: knowledgeEntities.titleRu,
      titleEn: knowledgeEntities.titleEn,
      count: sql<number>`count(*)`,
    })
    .from(postEntityLinks)
    .innerJoin(knowledgeEntities, eq(knowledgeEntities.id, postEntityLinks.entityId))
    .groupBy(knowledgeEntities.id)
    .orderBy(desc(sql<number>`count(*)`))
    .limit(12)
    .all();

  // One read of each owner's interface language, reused for both the request
  // and the send: reading it twice let a language switch in between address a
  // message nobody had generated.
  const recipients = config.ADMIN_IDS.map((actorId) => ({ actorId, locale: botLocale(backendDb, actorId) }));

  try {
    const messages = new Map<StudioLocale, string>();
    for (const locale of new Set(recipients.map((recipient) => recipient.locale))) {
      const response = await requestJson<ChatCompletion>(fetchImpl, "https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
        // The signal belongs to the request, not to the chat-completion payload:
        // nested inside the body it was both a no-op and an unknown `"signal":{}`
        // field sent to the provider.
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({
          model: "deepseek-chat",
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: [
                "You are an editorial research assistant for a solo AI news creator.",
                `Write the title and reason in ${languageName(locale)}.`,
                "Using only the supplied published posts and entity clusters, propose at most three useful next pages: a hub update, a page that answers one real question, a comparison, a practical guide, an official-data update, or a weekly roundup.",
                "Prefer one concrete query-shaped page over generic SEO. A cluster is not enough by itself: name the question the page would answer.",
                "Do not invent facts, demand a conclusion, write publication copy, or use generic SEO ideas.",
                "Each reason must name the concrete cluster or gap found in the supplied posts.",
                'Return strict JSON only: {"items":[{"kind":"review|guide|data|roundup","title":"...","reason":"...","posts":[1,2]}]}.',
              ].join("\n"),
            },
            {
              role: "user",
              content: JSON.stringify({
                posts: material.map((post) => ({ id: post.id, date: post.date, text: sourceText(post.textEn, post.textRu, locale) })),
                clusters: clusters.map((cluster) => ({
                  slug: cluster.slug,
                  count: cluster.count,
                  title: sourceText(cluster.titleEn, cluster.titleRu, locale),
                })),
              }),
            },
          ],
          response_format: { type: "json_object" },
        }),
      });
      const items = editorialItems(response.choices?.[0]?.message?.content ?? "");
      if (items.length === 0) throw new Error("editorial inbox returned no usable opportunities");
      messages.set(locale, renderInbox(items, locale));
    }
    for (const { actorId, locale } of recipients) {
      const message = messages.get(locale);
      if (message) await bot.api.sendMessage(actorId, message);
    }
    markSynced(backendDb, key, null, owner);
    return true;
  } catch (error) {
    // One failed provider call should not retry every five seconds all day.
    markSynced(backendDb, key, String(error).slice(0, 500), owner);
    log("warn", "daily editorial inbox failed", { error: String(error) });
    return false;
  }
}

function zonedDate(timeZone: string, now: Date): { day: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
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
      const title = item.title ? truncateUnicode(item.title.trim().replace(/\s+/g, " "), 180) : undefined;
      const reason = item.reason ? truncateUnicode(item.reason.trim().replace(/\s+/g, " "), 360) : undefined;
      const kind = ["review", "guide", "data", "roundup"].includes(item.kind ?? "") ? (item.kind ?? "review") : "review";
      const postIds = (item.posts ?? []).filter((id) => Number.isSafeInteger(id)).slice(0, 6);
      return title && reason ? [{ kind, title, reason, posts: postIds }] : [];
    })
    .slice(0, 3);
}

/** The language to write in, named in English for the prompt. Intl knows every
 * language ICU does, so a new interface language needs nothing here. */
function languageName(locale: StudioLocale): string {
  return new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale;
}

/** Published material exists in RU and EN only. An interface language that is
 * neither reads the Russian original, which is the source the posts are written
 * from; the model translates as it summarises. */
function sourceText(english: string | null, russian: string | null, locale: StudioLocale): string {
  return (locale === "en" ? english || russian : russian || english) ?? "";
}

function renderInbox(items: Required<Pick<Opportunity, "kind" | "title" | "reason" | "posts">>[], locale: StudioLocale): string {
  const labels: Record<string, string> = {
    review: t(locale, "editorial.kind-review"),
    guide: t(locale, "editorial.kind-guide"),
    data: t(locale, "editorial.kind-data"),
    roundup: t(locale, "editorial.kind-roundup"),
  };
  const rows = items.map((item, index) => {
    const refs = item.posts.length ? `\n${t(locale, "editorial.posts")}: ${item.posts.map((id) => `#${id}`).join(", ")}` : "";
    return `${index + 1}. ${labels[item.kind] ?? t(locale, "editorial.kind-idea")}: ${item.title}\n${item.reason}${refs}`;
  });
  return `${t(locale, "editorial.title")}\n\n${rows.join("\n\n")}`;
}
