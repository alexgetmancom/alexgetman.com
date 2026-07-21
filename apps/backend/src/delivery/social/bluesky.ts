import fs from "node:fs";
import type { BackendConfig } from "../../foundation/config.js";
import { ExternalHttpError, requestJson } from "../../foundation/http.js";
import type { PublishResult } from "../../publishing/errors.js";
import { guessContentType, payloadMedia, payloadText, splitText } from "./payload.js";

type Session = {
  did: string;
  accessJwt: string;
};

// Every publish call used to log in fresh via createSession, which is an
// extra request-and-a-half on the critical path and burns Bluesky's login
// rate limit if a burst of posts go out together. Access JWTs are valid for
// ~2h; cache well under that and force a refresh on any 401 so a revoked or
// rotated app password is caught immediately instead of failing silently
// until the TTL expires.
const SESSION_TTL_MS = 50 * 60 * 1000;
let cachedSession: { key: string; session: Session; expiresAt: number } | null = null;

async function getBlueskySession(config: BackendConfig, fetchImpl: typeof fetch, forceRefresh = false): Promise<Session> {
  const key = `${config.BLUESKY_HANDLE}:${config.BLUESKY_APP_PASSWORD}`;
  if (!forceRefresh && cachedSession && cachedSession.key === key && cachedSession.expiresAt > Date.now()) {
    return cachedSession.session;
  }
  const session = await requestJson<Session>(fetchImpl, "https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: config.BLUESKY_HANDLE, password: config.BLUESKY_APP_PASSWORD }),
  });
  cachedSession = { key, session, expiresAt: Date.now() + SESSION_TTL_MS };
  return session;
}

/** Runs an authenticated Bluesky call with the cached session, refreshing once and
 * retrying if the token was rejected (expired early, revoked, or rotated elsewhere). */
async function withBlueskySession<T>(
  config: BackendConfig,
  fetchImpl: typeof fetch,
  session: Session,
  run: (session: Session) => Promise<T>,
): Promise<{ result: T; session: Session }> {
  try {
    return { result: await run(session), session };
  } catch (error) {
    if (!(error instanceof ExternalHttpError) || error.status !== 401) throw error;
    const refreshed = await getBlueskySession(config, fetchImpl, true);
    return { result: await run(refreshed), session: refreshed };
  }
}

type BlobResponse = {
  blob?: Record<string, unknown>;
};

type CreateRecordResponse = {
  uri?: string;
  cid?: string;
};

type AuthorFeedResponse = {
  feed?: Array<{ post?: { uri?: string } }>;
};

function blueskyPublicUrl(uri: string | undefined | null, handle: string | undefined | null): string | null {
  if (!uri?.includes("/app.bsky.feed.post/")) return null;
  const postId = uri.split("/").pop();
  const profile = handle || "alexgetmancom.bsky.social";
  return postId ? `https://bsky.app/profile/${profile}/post/${postId}` : null;
}

export async function publishToBluesky(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  if (!config.BLUESKY_HANDLE || !config.BLUESKY_APP_PASSWORD) return { skipped: true, reason: "missing Bluesky credentials" };
  const reconcileIds = Array.isArray(payload._reconcile_ids)
    ? payload._reconcile_ids.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (reconcileIds.length > 0) {
    const rootId = reconcileIds[0];
    if (!rootId) return { ok: false, error: "bluesky_reconciliation_missing_id", retryable: false };
    const visible = await verifyBlueskyRootVisible(rootId, config, fetchImpl);
    const urls = reconcileIds.map((id) => blueskyPublicUrl(id, config.BLUESKY_HANDLE)).filter((url): url is string => Boolean(url));
    return visible.ok
      ? { ok: true, id: rootId, ids: reconcileIds, url: urls[0] ?? null, urls }
      : {
          ok: false,
          id: rootId,
          ids: reconcileIds,
          url: urls[0] ?? null,
          urls,
          error: `bluesky_visibility_failed:${visible.reason}`,
          retryable: true,
        };
  }
  let session = await getBlueskySession(config, fetchImpl);

  const images: Record<string, unknown>[] = [];
  for (const item of payloadMedia(payload)) {
    if (item.type !== "IMAGE" || !item.localPath) continue;
    const bytes = await fs.promises.readFile(item.localPath);
    const uploadResult = await withBlueskySession(config, fetchImpl, session, (activeSession) =>
      requestJson<BlobResponse>(fetchImpl, "https://bsky.social/xrpc/com.atproto.repo.uploadBlob", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${activeSession.accessJwt}`,
          "Content-Type": guessContentType(item.localPath as string),
        },
        body: bytes,
      }),
    );
    session = uploadResult.session;
    if (uploadResult.result.blob) images.push({ alt: "", image: uploadResult.result.blob });
    if (images.length >= 4) break;
  }

  const ids: string[] = [];
  const urls: string[] = [];
  let root: { uri: string; cid: string } | null = null;
  let parent: { uri: string; cid: string } | null = null;
  const createdAt = Date.now();
  for (const [index, part] of splitText(payloadText(payload), 300).entries()) {
    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text: part,
      createdAt: new Date(createdAt + index * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
      langs: ["ru", "en"],
    };
    if (index === 0 && images.length > 0) record.embed = { $type: "app.bsky.embed.images", images };
    if (root && parent) record.reply = { root, parent };
    const createResult = await withBlueskySession(config, fetchImpl, session, (activeSession) =>
      requestJson<CreateRecordResponse>(fetchImpl, "https://bsky.social/xrpc/com.atproto.repo.createRecord", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${activeSession.accessJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ repo: activeSession.did, collection: "app.bsky.feed.post", record }),
      }),
    );
    session = createResult.session;
    const created = createResult.result;
    if (!created.uri || !created.cid) continue;
    const ref = { uri: created.uri, cid: created.cid };
    if (!root) root = ref;
    parent = ref;
    ids.push(created.uri);
    const url = blueskyPublicUrl(created.uri, config.BLUESKY_HANDLE);
    if (url) urls.push(url);
  }
  if (ids[0]) {
    const visible = await verifyBlueskyRootVisible(ids[0], config, fetchImpl);
    if (!visible.ok) {
      return {
        ok: false,
        id: ids[0],
        url: urls[0] ?? null,
        ids,
        urls,
        error: `bluesky_visibility_failed:${visible.reason}`,
        retryable: true,
      };
    }
  }
  return { ok: ids.length > 0, id: ids[0] ?? null, url: urls[0] ?? null, ids, urls, retryable: false };
}

async function verifyBlueskyRootVisible(
  uri: string,
  config: BackendConfig,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; reason: string }> {
  const rkey = uri.split("/").pop();
  const actor = config.BLUESKY_HANDLE || "alexgetmancom.bsky.social";
  if (!rkey || !actor) return { ok: false, reason: "missing_bluesky_uri_or_handle" };
  const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
  url.searchParams.set("actor", actor);
  url.searchParams.set("limit", "30");
  url.searchParams.set("filter", "posts_no_replies");
  const data = await requestJson<AuthorFeedResponse>(fetchImpl, url.toString(), {
    headers: { "User-Agent": "alexgetman-backend/1.0" },
  });
  const found = (data.feed ?? []).some((item) => item.post?.uri?.split("/").pop() === rkey);
  return found ? { ok: true, reason: "visible_in_author_feed" } : { ok: false, reason: "not_in_author_feed" };
}
