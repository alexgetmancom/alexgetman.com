import type { DraftMessage } from "../../content/index.js";
import type { VideoLocale } from "../../publishing/video-types.js";
import type { StudioActorId } from "../contracts.js";
import type { postService } from "./posts.js";
import type { videoService } from "./videos.js";

/** What an adapter has on hand when it wants to publish something: raw text/media
 * content, or a video file already imported as a studio media asset. */
type PublicationMedia = { kind: "post"; message: DraftMessage } | { kind: "video"; studioMediaAssetId: number; locale?: VideoLocale };

/** A reference to whichever entity `create` produced. */
type PublicationHandle = { kind: "post" | "video"; id: number };

/**
 * Single entry point for turning incoming media into a publication, whichever
 * pipeline it belongs to. Telegram, the future Web Studio and MCP no longer
 * need to decide "post or video" themselves before creating a draft; they
 * hand over the media and get back a handle. Post/video internals differ
 * downstream, so this facade only covers the verb that is genuinely uniform:
 * create.
 */
export function publicationService(posts: ReturnType<typeof postService>, videos: ReturnType<typeof videoService>) {
  return {
    create(actorId: StudioActorId, media: PublicationMedia): PublicationHandle {
      if (media.kind === "video") return { kind: "video", id: videos.create(actorId, media.studioMediaAssetId, media.locale) };
      return { kind: "post", id: posts.create(actorId, media.message) };
    },
  };
}
