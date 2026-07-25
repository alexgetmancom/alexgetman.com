import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../config.js";

export type DataDirectoryCheck = { name: string; path: string; writable: boolean; error?: string };

/** Every host path the running process must be able to create files/directories
 * under. A bind-mounted host path that didn't exist yet is auto-created by
 * Docker as root; only the module-relevant directories are listed here so a
 * disabled feature (e.g. video on a text-only Studio) never reports a false
 * unwritable-directory failure for a path the app will never touch. */
export function requiredDataDirectories(config: BackendConfig): { name: string; path: string }[] {
  const entries = [
    { name: "DATA_DIR", path: config.DATA_DIR },
    ...(config.studio.modules.video_posting
      ? [
          { name: "STUDIO_MEDIA_DIR", path: config.STUDIO_MEDIA_DIR },
          { name: "VIDEO_MEDIA_DIR", path: config.VIDEO_MEDIA_DIR },
        ]
      : []),
    { name: "MEDIA_CACHE_DIR", path: config.MEDIA_CACHE_DIR },
    ...(config.studio.modules.site ? [{ name: "SITE_PUBLIC_DIR", path: config.SITE_PUBLIC_DIR }] : []),
  ];
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const resolved = path.resolve(entry.path);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

/** Creates each directory if missing and probes it with a real write. A
 * directory can already exist (Docker auto-vivified it for a bind mount) yet
 * still be unwritable by this process — existsSync alone would miss exactly
 * that case, which is the one that actually bites self-hosters. */
export function checkDataDirectoriesWritable(directories: { name: string; path: string }[]): DataDirectoryCheck[] {
  return directories.map(({ name, path: dirPath }) => {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      const probe = path.join(dirPath, `.write-check-${process.pid}-${Date.now()}`);
      fs.writeFileSync(probe, "");
      fs.rmSync(probe, { force: true });
      return { name, path: dirPath, writable: true };
    } catch (error) {
      return { name, path: dirPath, writable: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export type DataDirectoryOwnershipFix = { name: string; path: string; changed: boolean; error?: string };

/** Ensures each directory exists and is owned by uid:gid, changing ownership
 * only when it doesn't already match. Run once, as root, before the app
 * process drops privileges — see runtime/docker-entrypoint.ts. */
export function fixDataDirectoriesOwnership(
  directories: { name: string; path: string }[],
  uid: number,
  gid: number,
): DataDirectoryOwnershipFix[] {
  return directories.map(({ name, path: dirPath }) => {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      const stat = fs.statSync(dirPath);
      if (stat.uid === uid && stat.gid === gid) return { name, path: dirPath, changed: false };
      fs.chownSync(dirPath, uid, gid);
      return { name, path: dirPath, changed: true };
    } catch (error) {
      return { name, path: dirPath, changed: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** Resolves a Unix username to its numeric uid/gid by reading /etc/passwd —
 * Node/Bun have no built-in getpwnam, and this avoids shelling out to `id`
 * from what is otherwise a pure-TypeScript codebase (see check:language). */
export function resolveUnixUser(username: string, passwdFile = "/etc/passwd"): { uid: number; gid: number } {
  const passwd = fs.readFileSync(passwdFile, "utf8");
  for (const line of passwd.split("\n")) {
    const [name, , uidText, gidText] = line.split(":");
    if (name === username) {
      const uid = Number(uidText);
      const gid = Number(gidText);
      if (Number.isInteger(uid) && Number.isInteger(gid)) return { uid, gid };
    }
  }
  throw new Error(`Unix user not found in ${passwdFile}: ${username}`);
}

/** The supplementary groups to keep when dropping privileges. Compose grants
 * the container extra groups it needs to read other containers' data — the
 * `group_add: ${BOT_API_GID}` entry for the telegram-bot-api download
 * directory. Those gids exist only in the running container's group list, not
 * in the image's /etc/group, so they can only be preserved from the live
 * process; replacing the list with just the user's own gid is what silently
 * broke reading downloaded videos. Group 0 is dropped deliberately: it is
 * root's own membership and must not survive the drop. Root's remaining
 * memberships (bin, daemon, disk, …) are kept rather than filtered by a
 * heuristic: nothing in the image is group-restricted to them, and any rule
 * clever enough to guess which gids "came from Docker" could just as well drop
 * the one gid the app actually needs — which is the outage this replaced. */
export function retainedSupplementaryGroups(gid: number, currentGroups: number[]): number[] {
  return [gid, ...new Set(currentGroups.filter((group) => group !== 0 && group !== gid))];
}
