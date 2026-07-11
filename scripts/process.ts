export function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const result = Bun.spawnSync([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.exitCode}`);
}

export function output(command: string, args: string[], cwd?: string): string {
  const result = Bun.spawnSync([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `${command} exited with ${result.exitCode}`);
  return result.stdout.toString().trim();
}
