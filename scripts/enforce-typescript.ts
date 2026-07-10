import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", ".astro", "node_modules", "dist", "coverage"]);
const forbiddenExtensions = new Set([".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs"]);
const shellNames = new Set(["sh", "bash", "zsh"]);
const violations: string[] = [];

function visit(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = path.relative(root, absolute);
    const extension = path.extname(entry.name);
    if (forbiddenExtensions.has(extension)) violations.push(relative);
    const disabledTypecheckDirective = "@ts-" + "nocheck";
    if (extension === ".ts" && fs.readFileSync(absolute, "utf8").includes(disabledTypecheckDirective)) violations.push(relative);
    if (!extension || extension === ".sh") {
      const descriptor = fs.openSync(absolute, "r");
      const buffer = Buffer.alloc(256);
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      fs.closeSync(descriptor);
      const firstLine = buffer.subarray(0, bytes).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
      if (firstLine.startsWith("#!") && [...shellNames].some((name) => firstLine.includes(name))) violations.push(relative);
    }
  }
}

visit(root);
if (violations.length > 0) {
  console.error("Non-TypeScript executable source found:\n" + [...new Set(violations)].sort().map((file) => `- ${file}`).join("\n"));
  process.exit(1);
}
console.log("Language gate passed: no Python, JavaScript, or shell source files.");
