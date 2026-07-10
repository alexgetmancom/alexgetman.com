import fs from "node:fs";
import path from "node:path";
import { output, run } from "./process.js";

const repository = requiredEnv("WEB_REPOSITORY");
const publicDirectory = requiredEnv("WEB_PUBLIC_DIR");
const lockDirectory = process.env.WEB_SYNC_LOCK ?? "/tmp/alexgetman-web-sync.lock";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function acquireLock(): boolean {
  try {
    fs.mkdirSync(lockDirectory);
    fs.writeFileSync(path.join(lockDirectory, "owner"), `${process.pid}\n${new Date().toISOString()}\n`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const age = Date.now() - fs.statSync(lockDirectory).mtimeMs;
    if (age < 60 * 60 * 1_000) return false;
    fs.rmSync(lockDirectory, { recursive: true, force: true });
    return acquireLock();
  }
}

function syncDirectory(source: string, destination: string, preserve: ReadonlySet<string> = new Set()): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(destination)) {
    if (!preserve.has(entry)) fs.rmSync(path.join(destination, entry), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(source)) {
    fs.cpSync(path.join(source, entry), path.join(destination, entry), { recursive: true, force: true });
  }
}

if (!acquireLock()) process.exit(0);
try {
  process.env.HOME = process.env.HOME || "/home/deploy";
  const before = output("/usr/bin/git", ["rev-parse", "HEAD"], repository);
  run("/usr/bin/git", ["fetch", "origin", "main", "--quiet"], { cwd: repository });
  const after = output("/usr/bin/git", ["rev-parse", "origin/main"], repository);
  if (before !== after) {
    console.log(`${new Date().toISOString()} updating ${before} -> ${after}`);
    run("/usr/bin/git", ["pull", "--ff-only", "origin", "main"], { cwd: repository });
  }
  run("corepack", ["enable"], { cwd: repository });
  run("bun", ["install", "--frozen-lockfile"], { cwd: repository });
  run("bun", ["run", "build"], { cwd: repository });
  syncDirectory(path.join(repository, "dist"), publicDirectory, new Set(["media", "habr-images"]));

  const habrSource = path.join(repository, "apps/web/public/habr-images");
  if (fs.existsSync(habrSource)) syncDirectory(habrSource, path.join(publicDirectory, "habr-images"));
  const mediaSource = [path.join(repository, "apps/web/public/media"), path.join(repository, "media")].find(fs.existsSync);
  if (mediaSource) syncDirectory(mediaSource, path.join(publicDirectory, "media"));
} finally {
  fs.rmSync(lockDirectory, { recursive: true, force: true });
}
