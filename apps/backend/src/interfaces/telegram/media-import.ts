import fs from "node:fs";
import type { BackendConfig } from "../../foundation/config.js";
import { materializeTelegramFile } from "../../foundation/external/telegram-files.js";
import type { StudioServices } from "../../studio/services/index.js";

/** Imports one Telegram transport file into Content ownership and removes only
 * the temporary download created for that import. */
export async function importTelegramAsset(
  studioMedia: StudioServices["media"],
  config: BackendConfig,
  actorId: number,
  filePath: string,
  input: { extension: string; filename: string; contentType: string },
): Promise<Awaited<ReturnType<StudioServices["media"]["importFile"]>>> {
  const downloaded = await materializeTelegramFile(config, { filePath }, { extension: input.extension });
  try {
    return await studioMedia.importFile(actorId, {
      filename: input.filename,
      contentType: input.contentType,
      localPath: downloaded.path,
      source: "telegram_upload",
    });
  } finally {
    if (downloaded.temporary) await fs.promises.rm(downloaded.path, { force: true });
  }
}
