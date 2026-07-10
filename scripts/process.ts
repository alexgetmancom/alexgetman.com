import { spawnSync } from "node:child_process";

export function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "no status"}`);
}

export function output(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || `${command} exited with ${result.status}`));
  return String(result.stdout).trim();
}
