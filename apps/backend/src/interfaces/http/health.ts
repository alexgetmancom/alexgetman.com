import fs from "node:fs";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { workerState } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { json, text } from "../../foundation/http-response.js";
import { workerLiveness } from "../../foundation/runtime/worker-state.js";
import type { RouteModule } from "./context.js";

export const healthRoutes: RouteModule = (app, { config, backendDb }) => {
  app.get("/healthz", () => text("ok\n"));
  app.get("/tg-feed/healthz", () => text("ok\n"));

  app.get("/readyz", () => {
    const report = readiness(config, backendDb);
    return json(report, report.ok ? 200 : 503);
  });
};

/** Readiness for the deploy gate (`/readyz` in .github/workflows/check.yml).
 *
 * Existence of the database file proves almost nothing: the old check stayed
 * green on a read-only volume, a corrupt database and an unwritable media
 * mount alike. The checks below are deliberately limited to invariants that
 * hold the instant the process is up, so a healthy deploy cannot fail on a
 * race — worker heartbeats are reported for diagnosis but never gate, since at
 * activation time no cycle has necessarily run yet. */
function readiness(config: BackendConfig, backendDb: BackendDb): Record<string, unknown> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  checks.database = attempt(() => {
    // A real query, not a stat: this is what every request path needs, and it
    // is what fails on a corrupt file or a read-only volume.
    unsafeDb(backendDb).sqlite.prepare("SELECT count(*) FROM worker_state").get();
  });

  // Data directory holds the database and its WAL; unwritable means every
  // publish and metric write fails, while reads keep looking healthy.
  checks.data_dir_writable = attempt(() => fs.accessSync(config.DATA_DIR, fs.constants.W_OK));

  // Media mounts are created lazily, so absence is not a failure — but an
  // existing directory we cannot write to is exactly the mount misconfiguration
  // this check exists to catch.
  const mediaDirectories = [
    ["media_cache_dir", config.MEDIA_CACHE_DIR],
    ["studio_media_dir", config.STUDIO_MEDIA_DIR],
    ...(config.studio.siteEnabled ? [["site_public_dir", config.SITE_PUBLIC_DIR] as const] : []),
  ] as const;
  for (const [name, dir] of mediaDirectories) {
    if (fs.existsSync(dir)) checks[`${name}_writable`] = attempt(() => fs.accessSync(dir, fs.constants.W_OK));
  }

  const workers = Object.fromEntries(
    unsafeDb(backendDb)
      .db.select()
      .from(workerState)
      .all()
      .map((row) => [
        row.name,
        {
          updated_at: row.updatedAt,
          ...workerLiveness(row.stateJson, row.updatedAt),
        },
      ]),
  );

  return {
    ok: Object.values(checks).every((check) => check.ok),
    checks,
    workers,
  };
}

function attempt(check: () => void): { ok: boolean; detail?: string } {
  try {
    check();
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
