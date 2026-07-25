import { loadConfig } from "../foundation/config.js";
import { configureLogging, log } from "../foundation/logger.js";
import {
  checkDataDirectoriesWritable,
  fixDataDirectoriesOwnership,
  requiredDataDirectories,
  resolveUnixUser,
} from "../foundation/runtime/data-dirs.js";

const SERVER_ENTRY = "/app/runtime/server.js";
const RUNTIME_USER = "bun";

/** Container entrypoint (invoked as `tini -- bun runtime/entrypoint/index.js`).
 * A bind-mounted volume whose host path didn't exist yet is auto-created by
 * Docker as root, which silently blocks the unprivileged app user the moment
 * it first tries to write there — a real video upload, days after the deploy
 * that actually broke it. Running as root only long enough to fix ownership,
 * then dropping privileges in-process (no exec, no su-exec, same PID tini
 * already supervises) and loading the real server, means a fresh self-hosted
 * deploy just works without anyone pre-provisioning host directory
 * permissions by hand. */
async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    const { uid, gid } = resolveUnixUser(RUNTIME_USER);
    const config = loadConfig(process.env);
    configureLogging(config.LOG_LEVEL);
    const fixes = fixDataDirectoriesOwnership(requiredDataDirectories(config), uid, gid);
    const applied = fixes.filter((fix) => fix.changed || fix.error);
    if (applied.length) log("info", "fixed data directory ownership before dropping privileges", { fixes: applied });
    const stillUnwritable = checkDataDirectoriesWritable(requiredDataDirectories(config)).filter((check) => !check.writable);
    if (stillUnwritable.length)
      log("error", "data directories remain unwritable after ownership fix; check the host bind mount", {
        directories: stillUnwritable,
      });
    process.setgroups?.([gid]);
    process.setgid?.(gid);
    process.setuid?.(uid);
  }
  await import(SERVER_ENTRY);
}

await main();
