import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../foundation/config.js";

/** Content-owned persistence for raw video assets, independent of ingress UI. */
export function videoPath(config: BackendConfig, assetKey: string): string | null {
  if (!existsSync(config.VIDEO_MEDIA_DIR)) return null;
  const match = readdirSync(config.VIDEO_MEDIA_DIR).find((entry) => entry.startsWith(`${assetKey}.`));
  return match ? path.join(config.VIDEO_MEDIA_DIR, match) : null;
}

export function deleteVideo(config: BackendConfig, assetKey: string): void {
  const file = videoPath(config, assetKey);
  if (file) rmSync(file, { force: true });
}
