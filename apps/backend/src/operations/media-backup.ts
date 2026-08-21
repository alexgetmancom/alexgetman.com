import fs from "node:fs";
import path from "node:path";
import type { EnvConfig } from "../foundation/config.js";

/** How stale the newest media archive may be before `doctor` calls the
 * deployment unhealthy. The database leaves daily; media changes far less
 * often, and a week is short enough that a forgotten backup is still noticed
 * while the volume it protects is intact. */
const MEDIA_BACKUP_MAX_AGE_DAYS = 7;

const ARCHIVE_PREFIX = "media-";
const ARCHIVE_SUFFIX = ".tar.gz";

/** The media trees a database backup does not carry. They live on the data
 * volume, so losing the volume loses all of them at once — which is the whole
 * reason this exists separately from `backup`. */
function mediaBackupSources(config: EnvConfig): { name: string; path: string }[] {
  return [
    { name: "video-media", path: config.STUDIO_MEDIA_DIR },
    { name: "media-cache", path: config.MEDIA_CACHE_DIR },
    { name: "story-cards", path: config.STORY_CARD_DIR },
    { name: "site", path: config.SITE_PUBLIC_DIR },
  ];
}

export type MediaBackupStatus = {
  directory: string;
  /** True when BACKUP_DIR sits on the data volume. Such a "backup" dies with
   * the thing it backs up, so it does not count as one. */
  onDataVolume: boolean;
  latest: { path: string; createdAt: string; bytes: number } | null;
  ageDays: number | null;
  ok: boolean;
};

function isInside(child: string, parent: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

export function mediaBackupStatus(config: EnvConfig, now = new Date()): MediaBackupStatus {
  const directory = config.BACKUP_DIR;
  const onDataVolume = isInside(directory, config.DATA_DIR);
  const entries = fs.existsSync(directory)
    ? fs
        .readdirSync(directory)
        .filter((name) => name.startsWith(ARCHIVE_PREFIX) && name.endsWith(ARCHIVE_SUFFIX))
        .map((name) => {
          const file = path.join(directory, name);
          const stat = fs.statSync(file);
          return { path: file, createdAt: stat.mtime.toISOString(), bytes: stat.size, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
    : [];
  const newest = entries[0];
  const latest = newest ? { path: newest.path, createdAt: newest.createdAt, bytes: newest.bytes } : null;
  const ageDays = newest ? (now.getTime() - newest.mtimeMs) / (24 * 60 * 60 * 1000) : null;
  return {
    directory,
    onDataVolume,
    latest,
    ageDays: ageDays === null ? null : Math.round(ageDays * 100) / 100,
    ok: !onDataVolume && ageDays !== null && ageDays <= MEDIA_BACKUP_MAX_AGE_DAYS,
  };
}

/** Writes one gzipped tar of every media tree that exists. Sources are passed
 * relative to DATA_DIR so the archive restores onto a fresh volume unchanged,
 * whatever the host path was when it was taken. */
export async function backupMedia(config: EnvConfig, destinationDirectory?: string): Promise<{ path: string; bytes: number }> {
  const directory = destinationDirectory ?? config.BACKUP_DIR;
  if (isInside(directory, config.DATA_DIR))
    throw new Error(`media backups must not live on the data volume: ${directory} is inside DATA_DIR (${config.DATA_DIR})`);
  fs.mkdirSync(directory, { recursive: true });
  const present = mediaBackupSources(config).filter((source) => fs.existsSync(source.path));
  if (!present.length) throw new Error("no media directories exist to back up");
  const relative = present.map((source) => path.relative(config.DATA_DIR, source.path));
  if (relative.some((entry) => entry.startsWith("..") || path.isAbsolute(entry)))
    throw new Error("every media directory must live under DATA_DIR for the archive to restore onto a fresh volume");
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const destination = path.join(directory, `${ARCHIVE_PREFIX}${stamp}${ARCHIVE_SUFFIX}`);
  const child = Bun.spawn(["tar", "-czf", destination, "-C", config.DATA_DIR, ...relative], { stdout: "ignore", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) {
    fs.rmSync(destination, { force: true });
    throw new Error(`tar failed (${exitCode}): ${stderr.trim()}`);
  }
  return { path: destination, bytes: fs.statSync(destination).size };
}
