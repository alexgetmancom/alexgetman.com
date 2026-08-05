import fs from "node:fs";
import path from "node:path";

type OperationsGuideCommand = {
  name: string;
  usage: string;
  mutates: boolean;
  notes?: string;
};

const OPERATIONS_GUIDE_COMMANDS: readonly OperationsGuideCommand[] = [
  { name: "status", usage: "status [--db PATH]", mutates: false },
  { name: "migrations", usage: "migrations [--db PATH]", mutates: false },
  { name: "migrations-baseline", usage: "migrations-baseline --db PATH", mutates: true, notes: "writes the migration baseline" },
  { name: "backup", usage: "backup [--db PATH] [--output DIRECTORY]", mutates: true },
  { name: "restore", usage: "restore --source PATH [--db PATH] --force", mutates: true, notes: "replaces the database" },
  { name: "audit", usage: "audit [--db PATH]", mutates: false },
  {
    name: "metrics-backfill",
    usage: "metrics-backfill [--targets a,b] [--refs post:1,post:2] [--from ISO] [--to ISO] [--apply] [--reset-counts]",
    mutates: true,
    notes: "read-only plan unless --apply is present",
  },
  {
    name: "publication-repair",
    usage: "publication-repair [--ref post:1|video:1] [--apply]",
    mutates: true,
    notes: "read-only plan unless --apply is present; scoped repair is preferred",
  },
  { name: "import-x-analytics", usage: "import-x-analytics --file PATH --sampled-at ISO", mutates: true },
  { name: "import-manual-analytics", usage: "import-manual-analytics [options]", mutates: true },
  { name: "capabilities", usage: "capabilities [--db PATH]", mutates: false },
  { name: "usage", usage: "usage [--days N] [--unused-days N] [--db PATH]", mutates: false },
  { name: "doctor", usage: "doctor", mutates: false },
  { name: "capability-record", usage: "capability-record --test T01 --message-id 123 [--notes TEXT]", mutates: true },
  { name: "verify", usage: "verify --ref post:1", mutates: false },
  { name: "timeline", usage: "timeline --ref post:1", mutates: false },
  { name: "media-status", usage: "media-status", mutates: false },
  { name: "media-diagnose", usage: "media-diagnose", mutates: false },
  { name: "media-job", usage: "media-job --ref post:1", mutates: false },
  {
    name: "media-reprocess",
    usage: "media-reprocess --ref post:1 [--apply]",
    mutates: true,
    notes: "read-only plan unless --apply is present",
  },
  { name: "republish", usage: "republish --ref post:1 [--target x] [--locale ru|en]", mutates: true },
  { name: "retry", usage: "retry --ref post:1 [--target x] [--locale ru|en]", mutates: true },
  { name: "reschedule", usage: 'reschedule --ref post:1 --locale ru|en|both --at "06.08.2026 08:00"', mutates: true },
  { name: "site-media-images", usage: "site-media-images [--apply --max-upload-kbps 6250]", mutates: true },
  { name: "site-media-deduplicate", usage: "site-media-deduplicate [--apply]", mutates: true },
  { name: "story-card-backfill", usage: "story-card-backfill --ref post:1 [--apply] [--force]", mutates: true },
  { name: "channels", usage: "channels", mutates: false },
  { name: "channel-connect", usage: "channel-connect --platform PLATFORM --locale ru|en [options]", mutates: true },
  { name: "channel-disable", usage: "channel-disable --channel CHANNEL [--forget-credentials]", mutates: true },
];

type LocalState = "available" | "missing" | "unusable";

type LocalOperationsProbe = {
  path: string;
  state: LocalState;
  reason: string;
};

export type OperationsGuide = {
  version: 1;
  local: LocalOperationsProbe;
  route: "local" | "production";
  next: {
    reason: string;
    localCommand: string;
    productionCommand: string;
  };
  production: {
    sshAlias: "tw-nl";
    containers: { alex: "alexgetman-backend"; maru: "maru-backend" };
    execUser: "bun";
  };
  commands: readonly OperationsGuideCommand[];
};

function probeLocalOperations(databasePath: string): LocalOperationsProbe {
  const resolvedPath = path.resolve(databasePath);
  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) return { path: resolvedPath, state: "unusable", reason: "database path is not a regular file" };
    fs.accessSync(resolvedPath, fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(path.dirname(resolvedPath), fs.constants.R_OK | fs.constants.W_OK);
    return { path: resolvedPath, state: "available", reason: "database file and its directory are readable and writable" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { path: resolvedPath, state: "missing", reason: "database file was not found" };
    return { path: resolvedPath, state: "unusable", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function buildOperationsGuide(databasePath = process.env.PIPELINE_DB ?? "/data/pipeline.db"): OperationsGuide {
  const local = probeLocalOperations(databasePath);
  const localCommand = "bun run --filter @alexgetman/backend ops <command>";
  const productionCommand = "bun run ops:prod --account <alex|maru> <command>";
  const route = local.state === "available" ? "local" : "production";
  return {
    version: 1,
    local,
    route,
    next: {
      reason:
        route === "local"
          ? "The local database is available; run the requested read-only command locally first."
          : "The local database is unavailable; do not repair local /data and continue with the production route.",
      localCommand,
      productionCommand,
    },
    production: {
      sshAlias: "tw-nl",
      containers: { alex: "alexgetman-backend", maru: "maru-backend" },
      execUser: "bun",
    },
    commands: OPERATIONS_GUIDE_COMMANDS,
  };
}

export function formatOperationsGuide(guide: OperationsGuide): string {
  const routeLabel = guide.route === "local" ? "LOCAL" : "PRODUCTION";
  const commandLines = guide.commands.map((command) => {
    const safety = command.mutates ? "MUTATION" : "read-only";
    const note = command.notes ? ` — ${command.notes}` : "";
    return `  [${safety}] ${command.usage}${note}`;
  });
  return [
    "alexgetman operations guide",
    "",
    `Local database: ${guide.local.state.toUpperCase()}`,
    `Path: ${guide.local.path}`,
    `Reason: ${guide.local.reason}`,
    `Recommended route: ${routeLabel}`,
    "",
    guide.next.reason,
    `Local command: ${guide.next.localCommand}`,
    `Production command: ${guide.next.productionCommand}`,
    "",
    "Production access:",
    "  SSH alias: tw-nl",
    "  Containers: alexgetman-backend, maru-backend",
    "  Exec user: bun",
    "",
    "Commands:",
    ...commandLines,
  ].join("\n");
}

export function operationsGuideUsage(): string {
  return "  guide [--json]";
}
