import { fileURLToPath } from "node:url";
import path from "node:path";
import { run } from "./process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

run("bun", ["run", "check:language"], { cwd: root });
run("bun", ["run", "typecheck"], { cwd: root });
run("bun", ["run", "test"], { cwd: root });
run("bun", ["run", "check:web"], { cwd: root });
run("bun", ["run", "--filter", "@alexgetman/backend", "build"], { cwd: root });
