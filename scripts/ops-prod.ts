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
const remote = ["docker", "exec", "-u", "bun", container, "bun", "/app/ops/cli.js", ...argv].map(shellQuote).join(" ");
const child = Bun.spawn(["ssh", "tw-nl", remote], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
