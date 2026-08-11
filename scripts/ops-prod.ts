import { basename } from "node:path";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("usage: bun run ops:prod <command> [arguments]");
  process.exit(1);
}

const sshTarget = process.env.OPS_SSH_TARGET?.trim();
if (!sshTarget) {
  console.error("OPS_SSH_TARGET is required; set it in .env.local before using ops:prod");
  process.exit(1);
}

const container = process.env.OPS_CONTAINER?.trim() || "alexgetman-backend";

/** A path argument names a file on this Mac, and the command runs in a
 * container that cannot see it. Ship it in, run against the copy, remove it. */
const FILE_FLAGS = new Set(["--file", "--x-file"]);

const exitCode = await runProductionCommand();
process.exit(exitCode);

async function runProductionCommand(): Promise<number> {
  const shipped: string[] = [];
  try {
    for (const [index, value] of argv.entries()) {
      if (!FILE_FLAGS.has(value)) continue;
      const local = argv[index + 1];
      if (!local || !(await Bun.file(local).exists())) continue;
      const remotePath = `/tmp/${basename(local)}`;
      const copyCommand = remoteCommand(["docker", "exec", "-i", "-u", "bun", container, "sh", "-c", `cat > ${shellQuote(remotePath)}`]);
      const copyCode = await run(["ssh", sshTarget, copyCommand], local);
      if (copyCode !== 0) {
        console.error(`failed to copy ${local} into ${container}`);
        return copyCode;
      }
      shipped.push(remotePath);
      argv[index + 1] = remotePath;
    }

    return await run(["ssh", sshTarget, remoteCommand(["docker", "exec", "-u", "bun", container, "bun", "/app/ops/cli.js", ...argv])]);
  } finally {
    for (const remotePath of shipped) {
      await run(["ssh", sshTarget, remoteCommand(["docker", "exec", "-u", "bun", container, "rm", "-f", remotePath])]);
    }
  }
}

async function run(command: string[], stdinFile?: string): Promise<number> {
  const child = Bun.spawn(command, {
    stdin: stdinFile ? Bun.file(stdinFile) : "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

function remoteCommand(parts: readonly string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
