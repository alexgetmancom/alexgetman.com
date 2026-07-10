import { fileURLToPath } from "node:url";
import path from "node:path";
import { run } from "./process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

run("pnpm", ["run", "check:language"], { cwd: root });
run("pnpm", ["run", "check:web"], { cwd: root });
run("pnpm", ["run", "check:backend"], { cwd: root });
