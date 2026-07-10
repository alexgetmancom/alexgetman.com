import { execFileSync } from "node:child_process";

export function gitRevision(cwd = process.cwd()): string | null {
  const injected = process.env.GIT_REVISION?.trim();
  if (injected && injected !== "unknown") return injected;
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
