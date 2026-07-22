import { and, eq } from "drizzle-orm";
import { targetLocale } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import { postTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { requestJson } from "../foundation/http.js";
import { getBlueskySession } from "./social/bluesky.js";

type RemovalOptions = { postKey: string; target?: string; locale?: "ru" | "en" };

/** Removes published remote objects before a controlled replacement.  Every result is
 * returned to Operations (and hence the audit log); unsupported targets are explicit
 * skips rather than silently treated as successful deletions. */
export async function removePublishedTargets(
  backendDb: BackendDb,
  config: BackendConfig,
  options: RemovalOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<Record<string, unknown>>> {
  const rows = backendDb.db
    .select()
    .from(postTargets)
    .where(and(eq(postTargets.postKey, options.postKey), eq(postTargets.status, "published")))
    .all()
    .filter((row) => !options.target || row.target === options.target)
    .filter((row) => !options.locale || targetLocale(row.target) === options.locale);
  const results: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    try {
      const ids = row.externalIdsJson?.length ? row.externalIdsJson : row.externalId ? [row.externalId] : [];
      if (!ids.length) {
        results.push({ target: row.target, ok: false, skipped: true, error: "missing external id" });
        continue;
      }
      await removeTarget(row.target, ids, config, fetchImpl);
      const now = new Date().toISOString();
      backendDb.db
        .update(postTargets)
        .set({
          status: "deleted",
          externalId: null,
          externalIdsJson: null,
          url: null,
          error: null,
          updatedAt: now,
          rawJson: JSON.stringify({ deleted: true, ids }),
        })
        .where(and(eq(postTargets.postKey, row.postKey), eq(postTargets.target, row.target)))
        .run();
      results.push({ target: row.target, ok: true, deleted: ids.length });
    } catch (error) {
      results.push({ target: row.target, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

async function removeTarget(target: string, ids: string[], config: BackendConfig, fetchImpl: typeof fetch): Promise<void> {
  if (target === "telegram") {
    if (!config.controllerBotToken) throw new Error("missing CONTROLLER_BOT_TOKEN");
    for (const id of ids)
      await requestJson(fetchImpl, `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/bot${config.controllerBotToken}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.CHANNEL_USERNAME, message_id: Number(id) }),
      });
    return;
  }
  if (target === "facebook") {
    const token = config.FACEBOOK_PAGE_ACCESS_TOKEN;
    if (!token) throw new Error("missing FACEBOOK_PAGE_ACCESS_TOKEN");
    for (const id of ids)
      await requestJson(
        fetchImpl,
        `https://graph.facebook.com/${config.FACEBOOK_GRAPH_API_VERSION}/${encodeURIComponent(id)}?access_token=${encodeURIComponent(token)}`,
        {
          method: "DELETE",
        },
      );
    return;
  }
  if (target === "threads_en" || target === "threads_ru") {
    const token = target === "threads_en" ? config.THREADS_EN_ACCESS_TOKEN : config.THREADS_ACCESS_TOKEN;
    if (!token) throw new Error(`missing ${target === "threads_en" ? "THREADS_EN_ACCESS_TOKEN" : "THREADS_ACCESS_TOKEN"}`);
    for (const id of ids)
      await requestJson(fetchImpl, `https://graph.threads.net/v1.0/${encodeURIComponent(id)}?access_token=${encodeURIComponent(token)}`, {
        method: "DELETE",
      });
    return;
  }
  if (target === "bluesky") {
    const session = await getBlueskySession(config, fetchImpl);
    for (const uri of ids) {
      const rkey = uri.split("/").at(-1);
      if (!rkey) throw new Error("invalid Bluesky URI");
      await requestJson(fetchImpl, "https://bsky.social/xrpc/com.atproto.repo.deleteRecord", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessJwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", rkey }),
      });
    }
    return;
  }
  throw new Error(`remote deletion is not supported for ${target}`);
}
