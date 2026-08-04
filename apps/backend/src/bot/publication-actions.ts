import type { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { handlePostAction } from "./post-actions.js";
import { handlePostMessage } from "./post-screen.js";
import { getPostAdminState } from "./post-state.js";
import { parseSessionCallback, publicationFromCallbackData } from "./session-fsm.js";
import { handleVideoActionCallback } from "./video-actions.js";
import { handleVideoConversationMessage } from "./video-conversation.js";
import { getSession } from "./video-session.js";

/** Dispatches both publication kinds through the shared callback namespace. */
export async function handlePublicationCallback(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  mainMenu?: Menu<Context>,
): Promise<boolean> {
  const rawData = ctx.callbackQuery?.data;
  if (!rawData) return false;
  const callback = publicationFromCallbackData(parseSessionCallback(rawData).data);
  if (!callback) return false;
  if (callback.kind === "post") {
    await handlePostAction(ctx, backendDb, config);
    return true;
  }
  return handleVideoActionCallback(ctx, backendDb, config, mainMenu);
}

/** Routes an incoming message to the one active publication conversation. */
export async function handleActivePublicationMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const actorId = Number(ctx.from?.id);
  if (getSession(backendDb, actorId)) {
    return handleVideoConversationMessage(ctx, backendDb, config);
  }
  if (getPostAdminState(backendDb, actorId)) {
    await handlePostMessage(ctx, backendDb, config);
    return true;
  }
  return false;
}
