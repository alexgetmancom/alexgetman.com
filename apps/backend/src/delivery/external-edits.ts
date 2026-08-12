import { eq } from "drizzle-orm";
import { targetLocale } from "../botTargets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { posts, postTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { requestJson } from "../foundation/http.js";
import { platformProfile } from "../publishing/platform-profiles.js";
import { editDiscordMessage } from "./social/discord.js";

type PublishedTargetEdit = { postKey: string; textRu: string | null; textEn: string | null; target?: string; locale?: "ru" | "en" };

/** Delivery gateway for best-effort edits of content that has already left this system. */
export async function editPublishedTargets(
  backendDb: BackendDb,
  edit: PublishedTargetEdit,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<Record<string, unknown>>> {
  const post = unsafeDb(backendDb)
    .db.select({ chatId: posts.chatId, mediaCount: posts.mediaCount })
    .from(posts)
    .where(eq(posts.postKey, edit.postKey))
    .get();
  const rows = unsafeDb(backendDb)
    .db.select({
      target: postTargets.target,
      status: postTargets.status,
      externalId: postTargets.externalId,
      externalIdsJson: postTargets.externalIdsJson,
    })
    .from(postTargets)
    .where(eq(postTargets.postKey, edit.postKey))
    .all();
  const editable = rows
    .filter((row): row is typeof row & { externalId: string } => row.status === "published" && row.externalId != null)
    .filter((row) => !edit.target || row.target === edit.target)
    .filter((row) => !edit.locale || targetLocale(row.target) === edit.locale);
  const results = await Promise.all(
    editable.map(async (row): Promise<Record<string, unknown> | null> => {
      try {
        if (row.target === "telegram" && edit.textRu) {
          const token = config.controllerBotToken;
          if (!token) return { target: row.target, ok: false, skipped: true, error: "missing CONTROLLER_BOT_TOKEN" };
          const method = Number(post?.mediaCount ?? 0) > 0 ? "editMessageCaption" : "editMessageText";
          const field = Number(post?.mediaCount ?? 0) > 0 ? "caption" : "text";
          return await postJson(fetchImpl, `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/bot${token}/${method}`, row.target, {
            chat_id: post?.chatId || config.TELEGRAM_CHANNEL_USERNAME,
            message_id: Number(row.externalId),
            [field]: edit.textRu,
          });
        }
        if (row.target === "discord" && edit.textEn) {
          // Only the first message carries the edit, so a post that is split —
          // before or after the edit — cannot be corrected in place: editing
          // message one would leave message two as the stale tail of a text
          // that no longer exists. Declining here sends it down the replacement
          // path, which deletes every message and publishes the post again.
          const limit = platformProfile("discord")?.limits?.text ?? 2000;
          if ((row.externalIdsJson?.length ?? 1) > 1)
            return { target: row.target, ok: false, skipped: true, error: "discord_post_is_split" };
          if (edit.textEn.length > limit) return { target: row.target, ok: false, skipped: true, error: "edit_exceeds_discord_limit" };
          const response = await editDiscordMessage(row.externalId, edit.textEn, config, fetchImpl);
          return { target: row.target, ok: true, response };
        }
        // Every other platform's API is append-only for us. Say so instead of
        // returning nothing, so a caller can tell "no edit port" apart from
        // "edited successfully".
        return { target: row.target, ok: false, skipped: true, error: "no_edit_port_for_target" };
      } catch (error) {
        return { target: row.target, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return results.filter((result): result is Record<string, unknown> => result != null);
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  target: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  // Route external edits through the shared client: a 30s timeout and secret
  // redaction apply, and a hung platform can no longer stall the repair path.
  const body = await requestJson<Record<string, unknown>>(fetchImpl, url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  return { target, ok: body.ok !== false, response: body };
}
