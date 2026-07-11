import type { BackendConfig } from "../config.js";
import type { PublishResult } from "../queue/errors.js";
import { formBody, requestJson } from "./http.js";
import { guessContentType, payloadMedia, payloadText, readFileBlob, splitText } from "./payload.js";

type MastodonStatus = {
  id?: string;
  url?: string;
};

type MastodonMedia = {
  id?: string;
};

export async function publishToMastodon(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  if (!config.MASTODON_INSTANCE || !config.MASTODON_ACCESS_TOKEN) return { skipped: true, reason: "missing Mastodon credentials" };
  const base = `https://${config.MASTODON_INSTANCE.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  const text = payloadText(payload);
  const mediaIds: string[] = [];
  for (const item of payloadMedia(payload)) {
    if (item.type !== "IMAGE" || !item.localPath) continue;
    const form = new FormData();
    form.append("file", await readFileBlob(item.localPath, guessContentType(item.localPath)), "media");
    const uploaded = await requestJson<MastodonMedia>(fetchImpl, `${base}/api/v2/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.MASTODON_ACCESS_TOKEN}` },
      body: form,
    });
    if (uploaded.id) mediaIds.push(uploaded.id);
    if (mediaIds.length >= 4) break;
  }

  const ids: string[] = [];
  const urls: string[] = [];
  let parentId: string | null = null;
  for (const [index, part] of splitText(text, 480).entries()) {
    const body = formBody({ status: part, in_reply_to_id: parentId });
    if (index === 0) for (const id of mediaIds) body.append("media_ids[]", id);
    const status = await requestJson<MastodonStatus>(fetchImpl, `${base}/api/v1/statuses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.MASTODON_ACCESS_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (status.id) {
      ids.push(status.id);
      parentId = status.id;
    }
    if (status.url) urls.push(status.url);
  }
  return { ok: ids.length > 0 || urls.length > 0, id: urls[0] ?? ids[0] ?? null, url: urls[0] ?? null, ids, urls };
}
