const root = new URL("../", import.meta.url).pathname;

async function run(name: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["bun", "run", ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${name} failed`);
}

await run("language", ["check:language"]);
await run("studio boundaries", ["--filter", "@alexgetman/backend", "test", "tests/studioArchitecture.test.ts"]);
await Promise.all([run("lint", ["lint"]), run("knip", ["knip"]), run("typecheck", ["typecheck"]), run("svelte", ["check:svelte"])]);
await Promise.all([run("test", ["test"]), run("web", ["check:web"]), run("backend", ["--filter", "@alexgetman/backend", "build"])]);
