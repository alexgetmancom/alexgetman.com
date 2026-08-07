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
  catalog: {
    /** Which build the `commands` below came from. */
    source: "this working tree";
    authoritative: boolean;
    reason: string;
    /** How to read the catalog the recommended route will actually accept. */
    command: string;
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
  // The catalog is compiled into this process. On the local route that is the
  // binary being run, so it is the truth. On the production route it is not:
  // the container runs whatever revision was last deployed, and between a
  // commit and a deploy the two disagree — a command listed here earns
  // "unknown command" there, which reads as a broken deployment rather than a
  // stale one. Say which build is being described and where the other lives.
  const catalog = {
    source: "this working tree",
    authoritative: route === "local",
    reason:
      route === "local"
        ? "The local route runs this build, so these are the commands it accepts."
        : "The production container runs its last deployed revision, which may not accept every command listed here.",
    command: route === "local" ? localCommand.replace("<command>", "guide --json") : productionCommand.replace("<command>", "guide --json"),
  } as const;
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
    catalog,
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
    guide.catalog.authoritative
      ? "Catalog: this build."
      : `Catalog below is THIS WORKING TREE, not the deployed one. ${guide.catalog.reason}`,
    guide.catalog.authoritative ? "" : `Read the deployed catalog with: ${guide.catalog.command}`,
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
