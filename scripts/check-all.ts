import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECK_GROUPS } from "./check-steps.js";
import { run } from "./process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Serial on purpose: this is the run you read output from. Pre-push runs the
 * same list in parallel groups. */
for (const group of CHECK_GROUPS) for (const step of group) run("bun", ["run", ...step.args], { cwd: root });
