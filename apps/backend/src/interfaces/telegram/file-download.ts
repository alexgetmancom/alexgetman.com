import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../../foundation/config.js";

const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 300_000;

export async function downloadTelegramFile(
  config: BackendConfig,
  filePath: string,
  extension: string,
): Promise<{ path: string; temporary: boolean }> {
  if (path.isAbsolute(filePath)) return { path: filePath, temporary: false };
  if (!config.controllerBotToken) throw new Error("Telegram bot token is not configured.");
  const url = `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/file/bot${config.controllerBotToken}/${filePath}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw new Error(`Telegram media download timed out after ${TELEGRAM_DOWNLOAD_TIMEOUT_MS / 1000}s.`);
    throw new Error("Telegram media download failed.", { cause: error });
  }
  if (!response.ok) throw new Error(`Telegram media download failed: ${response.status}`);
  const target = path.join(config.STUDIO_MEDIA_DIR, ".incoming", `telegram-media-${crypto.randomUUID()}${extension}`);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await Bun.write(target, response);
  return { path: target, temporary: true };
}
