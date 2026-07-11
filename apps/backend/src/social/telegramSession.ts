import { TelegramClient } from "@mtcute/bun";
import type { BackendConfig } from "../config.js";

export function createChannelStoryClient(config: BackendConfig): TelegramClient {
  const sessionPath = config.TELEGRAM_CHANNEL_STORIES_SESSION;
  const apiId = config.TELEGRAM_CHANNEL_STORIES_API_ID;
  const apiHash = config.TELEGRAM_CHANNEL_STORIES_API_HASH;
  if (!sessionPath || !apiId || !apiHash) throw new Error("missing_channel_story_credentials");
  return new TelegramClient({ apiId, apiHash, storage: sessionPath, disableUpdates: true });
}
