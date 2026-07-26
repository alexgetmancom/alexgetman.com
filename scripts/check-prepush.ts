import { CHECK_GROUPS, type CheckStep } from "./check-steps.js";

const root = new URL("../", import.meta.url).pathname;

async function run(step: CheckStep): Promise<void> {
  const child = Bun.spawn(["bun", "run", ...step.args], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${step.name} failed`);
}

/** Same checks as `check:all`, run group-parallel because nobody reads a passing
 * pre-push run's output. */
for (const group of CHECK_GROUPS) await Promise.all(group.map(run));
