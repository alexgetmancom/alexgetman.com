import { loadConfig } from "../foundation/config.js";
import { configureLogging, log } from "../foundation/logger.js";
import {
  checkDataDirectoriesWritable,
  fixDataDirectoriesOwnership,
  requiredDataDirectories,
  resolveUnixUser,
  retainedSupplementaryGroups,
} from "../foundation/runtime/data-dirs.js";

const SERVER_ENTRY = "/app/runtime/server.js";
const RUNTIME_USER = "bun";

/** Switches this process to the unprivileged runtime user for good. `setuid`
 * from root also overwrites the saved uid, so the drop is irreversible — the
 * server can never regain root even if it is compromised, which is the whole
 * point of starting as root. Missing syscalls are fatal rather than skipped:
 * silently continuing would leave the server running as root (and holding
 * root's group 0) with nothing in the logs to say so. */
function dropPrivileges(uid: number, gid: number): void {
  const { getgroups, setgroups, setgid, setuid } = process;
  if (!getgroups || !setgroups || !setgid || !setuid)
    throw new Error("cannot drop privileges: process.getgroups/setgroups/setgid/setuid unavailable");
  setgroups(retainedSupplementaryGroups(gid, getgroups()));
  setgid(gid);
  setuid(uid);
  const [currentUid, currentGid] = [process.getuid?.(), process.getgid?.()];
  if (currentUid !== uid || currentGid !== gid)
    throw new Error(`privilege drop failed: still running as uid ${currentUid}, gid ${currentGid}`);
}

/** Container entrypoint (invoked as `tini -- bun --smol entrypoint/docker-entrypoint.js`).
 * A bind-mounted volume whose host path didn't exist yet is auto-created by
 * Docker as root, which silently blocks the unprivileged app user the moment
 * it first tries to write there — a real video upload, days after the deploy
 * that actually broke it. Running as root only long enough to fix ownership,
 * then dropping privileges in-process (no exec, no su-exec, same PID tini
 * already supervises) and loading the real server, means a fresh self-hosted
 * deploy just works without anyone pre-provisioning host directory
 * permissions by hand. */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  configureLogging(config.LOG_LEVEL);
  const directories = requiredDataDirectories(config);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    const { uid, gid } = resolveUnixUser(RUNTIME_USER);
    const fixes = fixDataDirectoriesOwnership(directories, uid, gid);
    const applied = fixes.filter((fix) => fix.changed || fix.error);
    if (applied.length) log("info", "fixed data directory ownership before dropping privileges", { fixes: applied });
    dropPrivileges(uid, gid);
  }
  // Deliberately probed after the drop: as root every write succeeds, so the
  // check only means something once it runs with the app's real credentials.
  const stillUnwritable = checkDataDirectoriesWritable(directories).filter((check) => !check.writable);
  if (stillUnwritable.length)
    log("error", "data directories remain unwritable; check the host bind mount", { directories: stillUnwritable });
  await import(SERVER_ENTRY);
}

await main();
