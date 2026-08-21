import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupMedia, mediaBackupStatus } from "../src/operations/media-backup.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/** A throwaway host with the two directories a real deployment has: the data
 * volume, and a backup location that is deliberately not on it. */
function fixture(): { root: string; config: ReturnType<typeof loadTestConfig> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solo-publisher-media-backup-"));
  const config = loadTestConfig({ DATA_DIR: path.join(root, "data"), BACKUP_DIR: path.join(root, "backups") });
  return { root, config };
}

describe("media backup", () => {
  it("archives every media tree and reports the deployment healthy", async () => {
    const { root, config } = fixture();
    try {
      fs.mkdirSync(path.join(config.STUDIO_MEDIA_DIR), { recursive: true });
      fs.mkdirSync(path.join(config.SITE_PUBLIC_DIR, "media"), { recursive: true });
      fs.writeFileSync(path.join(config.STUDIO_MEDIA_DIR, "clip.mp4"), "video bytes");
      fs.writeFileSync(path.join(config.SITE_PUBLIC_DIR, "media", "cover.jpg"), "image bytes");

      expect(mediaBackupStatus(config).ok).toBe(false);

      const result = await backupMedia(config);
      expect(result.bytes).toBeGreaterThan(0);

      const status = mediaBackupStatus(config);
      expect(status.ok).toBe(true);
      expect(status.latest?.path).toBe(result.path);
      expect(status.onDataVolume).toBe(false);

      // Paths are stored relative to DATA_DIR, so the archive restores onto a
      // fresh volume whatever the host path was when it was taken.
      const listing = Bun.spawnSync(["tar", "-tzf", result.path]);
      const names = new TextDecoder().decode(listing.stdout);
      expect(names).toContain("video-media/clip.mp4");
      expect(names).toContain("site/media/cover.jpg");
      expect(names).not.toContain(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to write the backup onto the volume it exists to survive", async () => {
    const { root, config } = fixture();
    try {
      fs.mkdirSync(config.STUDIO_MEDIA_DIR, { recursive: true });
      await expect(backupMedia(config, path.join(config.DATA_DIR, "backups"))).rejects.toThrow("inside DATA_DIR");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops counting an archive that has gone stale", async () => {
    const { root, config } = fixture();
    try {
      fs.mkdirSync(config.STUDIO_MEDIA_DIR, { recursive: true });
      const { path: archive } = await backupMedia(config);
      // Eight days: one past the week `doctor` allows.
      const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(archive, stale, stale);

      const status = mediaBackupStatus(config);
      expect(status.ok).toBe(false);
      expect(status.ageDays).toBeGreaterThan(7);
      // The archive is still found and reported — it is stale, not missing.
      expect(status.latest?.path).toBe(archive);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
