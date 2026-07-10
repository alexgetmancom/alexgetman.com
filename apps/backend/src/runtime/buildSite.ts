import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.env.APP_ROOT ?? "/app";
const outputDirectory = path.join(root, "dist");
const publicDirectory = process.env.SITE_PUBLIC_DIR ?? "/site-public";
const feedDirectory = process.env.SITE_DATA_DIR ?? path.dirname(process.env.FEED_JSON ?? "/feed-data/feed.json");

const build = spawnSync("pnpm", ["run", "build"], {
  cwd: root,
  env: { ...process.env, DATA_DIR: feedDirectory },
  encoding: "utf8",
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

fs.mkdirSync(publicDirectory, { recursive: true });
for (const entry of fs.readdirSync(publicDirectory)) {
  if (entry !== "media") fs.rmSync(path.join(publicDirectory, entry), { recursive: true, force: true });
}
for (const entry of fs.readdirSync(outputDirectory)) {
  if (entry === "media") continue;
  fs.cpSync(path.join(outputDirectory, entry), path.join(publicDirectory, entry), { recursive: true, force: true });
}
