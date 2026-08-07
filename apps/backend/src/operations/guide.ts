import fs from "node:fs";
import path from "node:path";
import { type OperationCatalogEntry, operationCatalog } from "./registry.js";

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
  commands: readonly OperationCatalogEntry[];
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
    commands: operationCatalog(),
  };
}

export function formatOperationsGuide(guide: OperationsGuide): string {
  const routeLabel = guide.route === "local" ? "LOCAL" : "PRODUCTION";
  const commandLines = guide.commands.flatMap((command) => {
    const safety = command.mutates ? "MUTATION" : "read-only";
    const note = command.notes ? ` (${command.notes})` : "";
    return [`  [${safety}] ${command.usage}`, `             ${command.summary}${note}`];
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
