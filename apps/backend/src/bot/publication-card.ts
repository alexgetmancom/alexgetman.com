import type { InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { type VideoPreviewData, videoPreview } from "../interfaces/telegram/video-preview.js";
import type { BotLocale } from "./i18n.js";
import { type DraftView, draftPreview } from "./preview.js";

export type PublicationCard = {
  text: string;
  keyboard: InlineKeyboard;
};

type PostCardInput = {
  backendDb: BackendDb;
  config: BackendConfig;
  publicationId: number;
  view?: DraftView;
};

type VideoCardInput = {
  data: unknown;
  config: Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">;
  locale: BotLocale;
};

/** Renders the Telegram card for either publication kind through one boundary. */
export function renderPublicationCard(kind: "post", input: PostCardInput): PublicationCard;
export function renderPublicationCard(kind: "video", input: VideoCardInput): PublicationCard;
export function renderPublicationCard(kind: "post" | "video", input: PostCardInput | VideoCardInput): PublicationCard {
  if (kind === "post") {
    const post = input as PostCardInput;
    return draftPreview(post.backendDb, post.publicationId, post.config, post.view);
  }
  const video = input as VideoCardInput;
  return videoPreview(video.data as VideoPreviewData, video.config, video.locale);
}
