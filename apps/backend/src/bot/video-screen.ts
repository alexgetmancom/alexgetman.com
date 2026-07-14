import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { handleVideoActionCallback } from "./video-actions.js";
import { handleVideoConversationMessage } from "./video-conversation.js";

/** Compatibility entrypoint for the bot controller; rendering lives in video-preview. */
export function handleVideoMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  return handleVideoConversationMessage(ctx, backendDb, config);
}

export function handleVideoCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  return handleVideoActionCallback(ctx, backendDb, config);
}
