import { join } from "node:path";

const appDir = join(import.meta.dir, "..");
const files = [...new Bun.Glob("tests/*.test.ts").scanSync({ cwd: appDir, onlyFiles: true })].sort();

if (files.length === 0) {
  throw new Error("No backend test files found");
}

for (const file of files) {
  console.log(`Running ${file}`);
  const child = Bun.spawn([
    process.execPath,
    "--bun",
    "vitest",
    "run",
    file,
    "--pool=forks",
    "--maxWorkers=1",
    "--minWorkers=1",
  ], {
    cwd: appDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") {
      console.error(`::error title=Backend test failed::${file} exited with code ${exitCode}`);
    }
    throw new Error(`${file} failed with exit code ${exitCode}`);
  }
}

console.log(`Backend tests passed: ${files.length} files`);
