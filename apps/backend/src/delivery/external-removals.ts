import { and, eq, isNull } from "drizzle-orm";
import { targetLocale } from "../botTargets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { postTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { requestJson } from "../foundation/http.js";
import { deleteDiscordMessage } from "./social/discord.js";

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
  const rows = unsafeDb(backendDb)
    .db.select()
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
      const { deleted, remaining, error } = await removeTarget(row.target, ids, config, fetchImpl);
      const now = new Date().toISOString();
      // Only the row that still names the objects just deleted. Between the read
      // above and this write the target can have been requeued and published
      // again, and the delete of the old post used to mark the new one deleted.
      const sameRemoteObject = and(
        eq(postTargets.postKey, row.postKey),
        eq(postTargets.target, row.target),
        eq(postTargets.status, "published"),
        row.externalId == null ? isNull(postTargets.externalId) : eq(postTargets.externalId, row.externalId),
      );
      if (remaining.length) {
        // A post split across several messages deletes them one at a time, and
        // the survivors have to stay on the row: retrying from the original id
        // list starts on an object that is already gone and never reaches them.
        unsafeDb(backendDb)
          .db.update(postTargets)
          .set({
            externalId: remaining[0] ?? null,
            externalIdsJson: remaining,
            error: error ?? "partial remote deletion",
            updatedAt: now,
            rawJson: JSON.stringify({ deleted, remaining }),
          })
          .where(sameRemoteObject)
          .run();
        results.push({ target: row.target, ok: false, deleted: deleted.length, remaining: remaining.length, error });
        continue;
      }
      unsafeDb(backendDb)
        .db.update(postTargets)
        .set({
          status: "deleted",
          externalId: null,
          externalIdsJson: null,
          url: null,
          error: null,
          publishedAt: null,
          verifiedAt: null,
          updatedAt: now,
          rawJson: JSON.stringify({ deleted: true, ids }),
        })
        .where(sameRemoteObject)
        .run();
      results.push({ target: row.target, ok: true, deleted: ids.length });
    } catch (error) {
      results.push({ target: row.target, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

type RemovalOutcome = { deleted: string[]; remaining: string[]; error?: string };

/** Deletes every id it was given, rather than stopping at the first failure:
 * the ones behind it are the tail of a split post, and abandoning them leaves a
 * publication half-visible with no record of which half. */
async function removeTarget(target: string, ids: string[], config: BackendConfig, fetchImpl: typeof fetch): Promise<RemovalOutcome> {
  const remove = removeOne(target, config, fetchImpl);
  const deleted: string[] = [];
  const remaining: string[] = [];
  let error: string | undefined;
  for (const id of ids) {
    try {
      await remove(id);
      deleted.push(id);
    } catch (failure) {
      remaining.push(id);
      error ??= failure instanceof Error ? failure.message : String(failure);
    }
  }
  return { deleted, remaining, ...(error ? { error } : {}) };
}

function removeOne(target: string, config: BackendConfig, fetchImpl: typeof fetch): (id: string) => Promise<unknown> {
  if (target === "telegram") {
    if (!config.controllerBotToken) throw new Error("missing CONTROLLER_BOT_TOKEN");
    const token = config.controllerBotToken;
    return (id) =>
      requestJson(fetchImpl, `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/bot${token}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.TELEGRAM_CHANNEL_USERNAME, message_id: Number(id) }),
      });
  }
  if (target === "threads_en" || target === "threads_ru") {
    const token = target === "threads_en" ? config.THREADS_EN_ACCESS_TOKEN : config.THREADS_RU_ACCESS_TOKEN;
    if (!token) throw new Error(`missing ${target === "threads_en" ? "THREADS_EN_ACCESS_TOKEN" : "THREADS_RU_ACCESS_TOKEN"}`);
    return (id) =>
      requestJson(fetchImpl, `https://graph.threads.net/v1.0/${encodeURIComponent(id)}?access_token=${encodeURIComponent(token)}`, {
        method: "DELETE",
      });
  }
  if (target === "discord") return (id) => deleteDiscordMessage(id, config, fetchImpl);
  throw new Error(`remote deletion is not supported for ${target}`);
}
