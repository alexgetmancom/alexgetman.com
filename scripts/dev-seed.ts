import fs from "node:fs";
import path from "node:path";
import { seedDashboardFixture } from "../apps/web/src/server/dashboard-fixture.js";
import { devFixture, seedSiteFixture } from "../apps/web/src/server/site-fixture.js";

/**
 * Fills a local pipeline database and public media directory with published
 * posts, so `bun run dev` shows a real story player instead of an empty feed,
 * and /command-center shows a populated dashboard instead of zeroes.
 *
 * The story player only becomes interesting with more than one post and with a
 * post that has several images: the rail, the feed-mode filters and the
 * segmented gallery progress bar are all invisible on an empty or single-post
 * feed. Defaults are chosen to exercise exactly those.
 *
 *   bun scripts/dev-seed.ts                       # 3 posts, first with 2 images
 *   bun scripts/dev-seed.ts --posts 5 --gallery 3
 *   bun scripts/dev-seed.ts --db /tmp/x.db --public-dir /tmp/site
 *   bun scripts/dev-seed.ts --no-dashboard        # site rows only
 *
 * Then point the dev server at the same paths:
 *   PIPELINE_DB=<db> SITE_PUBLIC_DIR=<public-dir> bun run dev
 *
 * The dashboard sits behind a token. Any value works locally as long as the
 * server and the browser agree, so the launch config sets COMMAND_CENTER_TOKEN=dev
 * and the seed prints the URL that logs you straight in.
 */

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const defaultRoot = path.join(process.cwd(), ".dev-fixture");
const dbPath = path.resolve(flag("db", path.join(defaultRoot, "pipeline.db")));
const publicDir = path.resolve(flag("public-dir", path.join(defaultRoot, "site")));
const count = Math.max(1, Number(flag("posts", "3")) || 3);
const galleryImages = Math.max(1, Number(flag("gallery", "2")) || 2);
const reset = process.argv.includes("--reset");
const withDashboard = !process.argv.includes("--no-dashboard");

if (reset) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(publicDir, { recursive: true, force: true });
}
// A second run against a populated database would collide on post_key; make
// re-seeding the normal path rather than something to remember a flag for.
if (fs.existsSync(dbPath)) {
  console.error(`${dbPath} already exists — re-run with --reset to rebuild it.`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });

const posts = devFixture(count, galleryImages);
const { imagePaths } = seedSiteFixture({ dbPath, publicDir, posts });

console.log(`Seeded ${count} post(s), first with ${galleryImages} image(s); ${imagePaths.length} media file(s) written.`);

if (withDashboard) {
  const { targetRows, sampleRows } = seedDashboardFixture({ dbPath, postIds: posts.map((post) => post.postId) });
  console.log(`Dashboard: ${targetRows} target row(s), ${sampleRows} metric sample(s).`);
}

console.log(`\nPIPELINE_DB=${dbPath} SITE_PUBLIC_DIR=${publicDir} COMMAND_CENTER_TOKEN=dev bun run dev`);
console.log("  site       http://localhost:4321/");
if (withDashboard) console.log("  dashboard  http://localhost:4321/command-center?token=dev");
