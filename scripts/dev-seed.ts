import fs from "node:fs";
import path from "node:path";
import { registerChannel } from "../apps/backend/src/channels/registry.js";
import { openBackendDb } from "../apps/backend/src/db/client.js";
import { seedDashboardFixture, seedOverviewParityFixture } from "../apps/web/src/server/dashboard-fixture.js";
import {
  devFixture,
  FULL_DEV_HISTORY_DAYS,
  fullDevFixture,
  overviewParityFixture,
  seedSiteFixture,
} from "../apps/web/src/server/site-fixture.js";

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
 *   bun scripts/dev-seed.ts                       # 30 days, 1–5 text and video posts per day
 *   bun scripts/dev-seed.ts --days 14 --min-posts 2 --max-posts 4 --gallery 3
 *   bun scripts/dev-seed.ts --simple --posts 5 --gallery 3
 *   bun scripts/dev-seed.ts --db /tmp/x.db --public-dir /tmp/site
 *   bun scripts/dev-seed.ts --no-dashboard        # site rows only
 *   bun scripts/dev-seed.ts --mock                # reference-layout parity data
 *   bun scripts/dev-seed.ts --one-language        # a Studio that publishes text in Russian only
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
const days = Math.max(1, Math.floor(Number(flag("days", String(FULL_DEV_HISTORY_DAYS))) || FULL_DEV_HISTORY_DAYS));
const minPostsPerDay = Math.max(1, Math.floor(Number(flag("min-posts", "1")) || 1));
const maxPostsPerDay = Math.max(minPostsPerDay, Math.floor(Number(flag("max-posts", "5")) || 5));
const reset = process.argv.includes("--reset");
const withDashboard = !process.argv.includes("--no-dashboard");
const parity = process.argv.includes("--mock");
const simple = process.argv.includes("--simple");
// A Studio's connected channels decide which languages every screen is drawn
// in, so the seed connects them: without this the local dashboard only ever
// showed the fresh-install shape, where both languages are offered because
// nothing is connected yet.
const oneLanguage = process.argv.includes("--one-language");
const textTargets = oneLanguage ? ["telegram"] : ["telegram", "site_ru", "site_en", "threads_en", "x"];

if (reset) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(publicDir, { recursive: true, force: true });
}
// A second run against a populated database would collide on publication_key; make
// re-seeding the normal path rather than something to remember a flag for.
if (fs.existsSync(dbPath)) {
  console.error(`${dbPath} already exists — re-run with --reset to rebuild it.`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });

const posts = parity
  ? overviewParityFixture()
  : simple
    ? devFixture(count, galleryImages)
    : fullDevFixture(galleryImages, { days, minPostsPerDay, maxPostsPerDay });
const { imagePaths } = seedSiteFixture({ dbPath, publicDir, posts });

console.log(`Seeded ${posts.length} post(s), first with ${galleryImages} image(s); ${imagePaths.length} media file(s) written.`);

if (withDashboard) {
  const seed = parity ? seedOverviewParityFixture : seedDashboardFixture;
  const { targetRows, sampleRows } = parity
    ? seed({ dbPath, postIds: posts.map((post) => post.postId) })
    : seedDashboardFixture({
        dbPath,
        postIds: posts.map((post) => post.postId),
        postDates: posts.map((post) => post.dateUtc),
        full: simple ? undefined : { days, minPostsPerDay, maxPostsPerDay },
        targets: textTargets,
      });
  console.log(`Dashboard: ${targetRows} target row(s), ${sampleRows} metric sample(s).`);
}

connectChannels();

function connectChannels(): void {
  const backendDb = openBackendDb(dbPath);
  try {
    const platforms: Record<string, { platform: string; locale: "ru" | "en" }> = {
      telegram: { platform: "telegram", locale: "ru" },
      site_ru: { platform: "site", locale: "ru" },
      site_en: { platform: "site", locale: "en" },
      threads_en: { platform: "threads_en", locale: "en" },
      x: { platform: "x", locale: "en" },
    };
    const text = textTargets.flatMap((targetId) => {
      const platform = platforms[targetId];
      return platform ? [{ ...platform, targetId }] : [];
    });
    for (const channel of [...text, { platform: "youtube", locale: "ru" as const }, { platform: "youtube", locale: "en" as const }])
      registerChannel(backendDb, { provider: "native", source: "fixture", ...channel });
    console.log(`Channels: ${oneLanguage ? "Russian text only" : "text in both languages"}, video in both.`);
  } finally {
    backendDb.close();
  }
}

console.log(
  `\nbun run build\nDATA_DIR=${path.join(defaultRoot, "data")} STUDIO_MEDIA_DIR=${path.join(defaultRoot, "video-media")} VIDEO_MEDIA_DIR=${path.join(defaultRoot, "video-media")} MEDIA_CACHE_DIR=${path.join(defaultRoot, "media-cache")} STORY_CARD_DIR=${path.join(defaultRoot, "story-cards")} PIPELINE_DB=${dbPath} SITE_PUBLIC_DIR=${publicDir} COMMAND_CENTER_TOKEN=dev ASTRO_DIST_DIR=${path.resolve("dist")} bun run --filter @alexgetman/backend dev`,
);
console.log("  site       http://localhost:8788/");
if (withDashboard) console.log("  dashboard  http://localhost:8788/command-center?token=dev");
