export function gitRevision(cwd = process.cwd()): string | null {
  const injected = process.env.GIT_REVISION?.trim();
  if (injected && injected !== "unknown") return injected;
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : null;
  } catch {
    return null;
  }
}
