import { execFileSync } from "node:child_process";

export function gitRevision(cwd = process.cwd()): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
