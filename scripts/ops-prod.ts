import { basename } from "node:path";

const argv = process.argv.slice(2);
const accountIndex = argv.indexOf("--account");
const account = accountIndex >= 0 ? argv[accountIndex + 1] : "alex";
if (accountIndex >= 0) argv.splice(accountIndex, 2);
if (account !== "alex" && account !== "maru") {
  console.error("--account must be alex or maru");
  process.exit(1);
}
if (argv.length === 0) {
  console.error("usage: bun run ops:prod [--account alex|maru] <command> [arguments]");
  process.exit(1);
}

const container = account === "maru" ? "maru-backend" : "alexgetman-backend";

/** A path argument names a file on this Mac, and the command runs in a
 * container that cannot see it. Ship it in, run against the copy, remove it. */
const FILE_FLAGS = new Set(["--file", "--x-file"]);
const shipped: string[] = [];
for (const [index, value] of argv.entries()) {
  if (!FILE_FLAGS.has(value)) continue;
  const local = argv[index + 1];
  if (!local || !(await Bun.file(local).exists())) continue;
  const remotePath = `/tmp/${basename(local)}`;
  await run(["ssh", "tw-nl", `docker exec -i -u bun ${container} sh -c ${shellQuote(`cat > ${shellQuote(remotePath)}`)}`], local);
  shipped.push(remotePath);
  argv[index + 1] = remotePath;
}

const exitCode = await run([
  "ssh",
  "tw-nl",
  ["docker", "exec", "-u", "bun", container, "bun", "/app/ops/cli.js", ...argv].map(shellQuote).join(" "),
]);
for (const remotePath of shipped) await run(["ssh", "tw-nl", `docker exec -u bun ${container} rm -f ${shellQuote(remotePath)}`]);
process.exit(exitCode);

async function run(command: string[], stdinFile?: string): Promise<number> {
  const child = Bun.spawn(command, {
    stdin: stdinFile ? Bun.file(stdinFile) : "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0 && stdinFile) {
    console.error(`failed to copy ${stdinFile} into ${container}`);
    process.exit(code);
  }
  return code;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
