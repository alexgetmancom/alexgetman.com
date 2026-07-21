import { eq } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { posts, postTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { requestJson } from "../foundation/http.js";

type PublishedTargetEdit = { postKey: string; textRu: string | null; textEn: string | null };

/** Delivery gateway for best-effort edits of content that has already left this system. */
export async function editPublishedTargets(
  backendDb: BackendDb,
  edit: PublishedTargetEdit,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<Record<string, unknown>>> {
  const post = backendDb.db
    .select({ chatId: posts.chatId, mediaCount: posts.mediaCount })
    .from(posts)
    .where(eq(posts.postKey, edit.postKey))
    .get();
  const rows = backendDb.db
    .select({ target: postTargets.target, status: postTargets.status, externalId: postTargets.externalId })
    .from(postTargets)
    .where(eq(postTargets.postKey, edit.postKey))
    .all();
  const editable = rows.filter((row): row is typeof row & { externalId: string } => row.status === "published" && row.externalId != null);
  const results = await Promise.all(
    editable.map(async (row): Promise<Record<string, unknown> | null> => {
      try {
        if (row.target === "telegram" && edit.textRu) {
          const token = config.controllerBotToken;
          if (!token) return { target: row.target, ok: false, skipped: true, error: "missing CONTROLLER_BOT_TOKEN" };
          const method = Number(post?.mediaCount ?? 0) > 0 ? "editMessageCaption" : "editMessageText";
          const field = Number(post?.mediaCount ?? 0) > 0 ? "caption" : "text";
          return await postJson(fetchImpl, `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/bot${token}/${method}`, row.target, {
            chat_id: post?.chatId || config.CHANNEL_USERNAME,
            message_id: Number(row.externalId),
            [field]: edit.textRu,
          });
        }
        if (row.target === "facebook" && edit.textEn) {
          return await editFacebookTarget(
            fetchImpl,
            config,
            row.target,
            row.externalId,
            edit.textEn,
            config.FACEBOOK_PAGE_ACCESS_TOKEN,
            "FACEBOOK_PAGE_ACCESS_TOKEN",
          );
        }
        if (row.target === "facebook_ru" && edit.textRu) {
          return await editFacebookTarget(
            fetchImpl,
            config,
            row.target,
            row.externalId,
            edit.textRu,
            config.FACEBOOK_RU_PAGE_ACCESS_TOKEN,
            "FACEBOOK_RU_PAGE_ACCESS_TOKEN",
          );
        }
        if (row.target === "linkedin" && edit.textEn) {
          if (!config.LINKEDIN_ACCESS_TOKEN)
            return { target: row.target, ok: false, skipped: true, error: "missing LINKEDIN_ACCESS_TOKEN" };
          return await postJson(
            fetchImpl,
            `https://api.linkedin.com/rest/posts/${encodeURIComponent(row.externalId)}`,
            row.target,
            { patch: { $set: { commentary: edit.textEn } } },
            {
              Authorization: `Bearer ${config.LINKEDIN_ACCESS_TOKEN}`,
              "Linkedin-Version": config.LINKEDIN_API_VERSION,
              "X-Restli-Method": "PARTIAL_UPDATE",
              "X-Restli-Protocol-Version": "2.0.0",
            },
          );
        }
        return null;
      } catch (error) {
        return { target: row.target, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return results.filter((result): result is Record<string, unknown> => result != null);
}

async function editFacebookTarget(
  fetchImpl: typeof fetch,
  config: BackendConfig,
  target: string,
  externalId: string,
  text: string,
  token: string | undefined,
  tokenName: string,
): Promise<Record<string, unknown>> {
  if (!token) return { target, ok: false, skipped: true, error: `missing ${tokenName}` };
  return postJson(fetchImpl, `https://graph.facebook.com/${config.FACEBOOK_GRAPH_API_VERSION}/${externalId}`, target, {
    message: text,
    description: text,
    access_token: token,
  });
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
