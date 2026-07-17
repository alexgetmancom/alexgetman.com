import type { DraftMessage } from "../../content/message.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioActorId } from "../contracts.js";
import { postService } from "./posts.js";
import { videoService } from "./videos.js";

/** What an adapter has on hand when it wants to publish something: raw text/media
 * content, or a video file already imported as a studio media asset. */
type PublicationMedia = { kind: "post"; message: DraftMessage } | { kind: "video"; studioMediaAssetId: number };

/** A reference to whichever entity `create` produced, so callers can operate on
 * it without re-deriving which pipeline owns it. */
type PublicationHandle = { kind: "post" | "video"; id: number };

/**
 * Single entry point for turning incoming media into a publication, whichever
 * pipeline it belongs to. Telegram, the future Web Studio and MCP no longer
 * need to decide "post or video" themselves before creating a draft; they
 * hand over the media and get back a handle. Post/video internals (schedule
 * inputs, publish results) genuinely differ downstream, so this facade only
 * covers the verbs that are actually uniform: create, then read/cancel.
 */
export function publicationService(backendDb: BackendDb, config: BackendConfig) {
  const posts = postService(backendDb);
  const videos = videoService(backendDb, config);

  function entity(kind: PublicationHandle["kind"]) {
    return kind === "video" ? videos : posts;
  }

  return {
    create(actorId: StudioActorId, media: PublicationMedia): PublicationHandle {
      if (media.kind === "video") return { kind: "video", id: videos.create(actorId, media.studioMediaAssetId) };
      return { kind: "post", id: posts.create(actorId, media.message) };
    },
    get(actorId: StudioActorId, handle: PublicationHandle) {
      return entity(handle.kind).get(actorId, handle.id);
    },
    preview(actorId: StudioActorId, handle: PublicationHandle) {
      return entity(handle.kind).preview(actorId, handle.id);
    },
    validate(actorId: StudioActorId, handle: PublicationHandle) {
      return entity(handle.kind).validate(actorId, handle.id);
    },
    status(actorId: StudioActorId, handle: PublicationHandle) {
      return entity(handle.kind).status(actorId, handle.id);
    },
    history(actorId: StudioActorId, handle: PublicationHandle, limit?: number) {
      return entity(handle.kind).history(actorId, handle.id, limit);
    },
    cancel(actorId: StudioActorId, handle: PublicationHandle): void {
      entity(handle.kind).cancel(actorId, handle.id);
    },
  };
}
