import fs from "node:fs";
import path from "node:path";
import { deduplicateSiteMediaFile, isSiteMediaExtension, sha256File } from "../delivery/site-media-storage.js";
import type { BackendConfig } from "../foundation/config.js";

type Entry = { file: string; legacy: boolean; size: number; key: string; inode: string };

/** Historical migration: preserve every old URL and turn it into a hard link. */
export async function deduplicateSiteMedia(config: BackendConfig, apply: boolean): Promise<Record<string, unknown>> {
  const mediaRoot = path.join(config.SITE_PUBLIC_DIR, "media");
  const candidates = await publicMediaFiles(mediaRoot);
  const entries: Entry[] = [];
  for (const candidate of candidates) {
    // Bun's async stat can reuse a just-read directory-entry stat on APFS;
    // use a fresh stat here because inode identity is the accounting contract.
    const stat = fs.statSync(candidate.file);
    entries.push({
      ...candidate,
      size: stat.size,
      key: `${await sha256File(candidate.file)}:${path.extname(candidate.file).toLowerCase()}`,
      inode: `${stat.dev}:${stat.ino}`,
    });
  }
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) groups.set(entry.key, [...(groups.get(entry.key) ?? []), entry]);
  const logicalDuplicates = [...groups.values()].reduce(
    (total, group) => total + group.slice(1).reduce((sum, entry) => sum + entry.size, 0),
    0,
  );
  // Same-inode files already share data. This makes a post-migration dry run
  // accurately report zero physical bytes left to reclaim.
  const reclaimable = [...groups.values()].reduce((total, group) => {
    const [first] = group;
    if (!first) return total;
    const physicalBytes = new Map<string, number>();
    for (const entry of group) physicalBytes.set(entry.inode, entry.size);
    return total + [...physicalBytes.values()].reduce((sum, size) => sum + size, 0) - first.size;
  }, 0);
  if (apply) for (const entry of entries) await deduplicateSiteMediaFile(mediaRoot, entry.file);
  return {
    ok: true,
    apply,
    files: entries.length,
    legacy_url_files: entries.filter((entry) => entry.legacy).length,
    logical_bytes: entries.reduce((total, entry) => total + entry.size, 0),
    unique_blobs: groups.size,
    logical_duplicate_bytes: logicalDuplicates,
    reclaimable_bytes: reclaimable,
    excluded: ["media/.blobs", "media/threads", "other media caches"],
  };
}

async function publicMediaFiles(mediaRoot: string): Promise<Array<Omit<Entry, "size" | "key" | "inode">>> {
  const result: Array<Omit<Entry, "size" | "key" | "inode">> = [];
  const rootItems = await readDirectory(mediaRoot);
  for (const item of rootItems)
    if (item.isFile() && isSiteMediaExtension(item.name)) result.push({ file: path.join(mediaRoot, item.name), legacy: true });
  await collect(path.join(mediaRoot, "posts"), result);
  return result;
}

async function collect(directory: string, result: Array<Omit<Entry, "size" | "key" | "inode">>): Promise<void> {
  for (const item of await readDirectory(directory)) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await collect(file, result);
    else if (item.isFile() && isSiteMediaExtension(item.name)) result.push({ file, legacy: false });
  }
}

async function readDirectory(directory: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
