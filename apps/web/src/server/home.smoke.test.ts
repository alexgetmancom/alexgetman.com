import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBackendDb } from "../../../backend/src/db/client.js";
import { knowledgeEntities, postEntityLinks, postLocales, postSources, posts, publications } from "../../../backend/src/db/schema.js";

/**
 * A single end-to-end smoke test: it boots the real Astro dev server against
 * a throwaway seeded database and fetches the SSR HTML, the same way a
 * crawler or a first-time visitor would. Unlike the rest of the suite it does
 * not check individual functions — it exists to catch "the home page (and
 * therefore the Svelte story player) silently stopped rendering", which unit
 * tests for the player's internals cannot see. Keep this to a couple of
 * scenarios; anything more belongs in a real UI testing tool instead.
 *
 * Two non-obvious things this had to work around:
 * - `astro dev` must run under `bun --bun`, not its Node shebang directly —
 *   the backend opens `bun:sqlite`, which Node's ESM loader cannot resolve.
 * - `astro dev` keeps a single background daemon per project directory and
 *   ignores a new `--port` if one is already running (e.g. left over from a
 *   crashed previous run, or a `bun run dev` a human has open). We call
 *   `astro dev stop` before and after to avoid hanging on someone else's
 *   server — don't run this smoke test while you're also using `bun run dev`.
 */

const projectRoot = path.resolve(import.meta.dir, "../../../..");
const astroBin = path.join(projectRoot, "node_modules/.bin/astro");
const port = 4400 + Math.floor(Math.random() * 400);
const host = "127.0.0.1";
const baseUrl = `http://${host}:${port}`;

/** Smallest valid 1x1 JPEG — enough for the media route to read real bytes off disk. */
const FIXTURE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64",
);
/** Deterministic filename `existingSiteImage`/`site-read-model` produce for post 1, locale en, media index 0. */
const FIXTURE_IMAGE_PATH = "media/posts/1-en-0.jpg";

let dbDir: string;
let publicDir: string;
let server: ReturnType<typeof Bun.spawn> | undefined;

function seedDatabase(dbPath: string): void {
  const backendDb = openBackendDb(dbPath);
  const now = new Date().toISOString();
  backendDb.db.insert(publications).values({ postId: 1, status: "published", createdAt: now, updatedAt: now }).run();
  backendDb.db
    .insert(posts)
    .values({
      postKey: "post:1",
      postId: 1,
      source: "bot",
      channel: "controller",
      messageId: 1,
      dateUtc: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  backendDb.db
    .insert(postLocales)
    .values([
      {
        postId: 1,
        locale: "en",
        slug: "smoke-test-post",
        text: "Smoke test post body.\nSecond paragraph.",
        mediaJson: [{ type: "photo", file_id: "smoke-test-photo" }],
        siteEnabled: 1,
        publishedAt: now,
        updatedAt: now,
      },
      {
        postId: 1,
        locale: "ru",
        slug: "dymovoy-test-post",
        text: "Тело дымового теста.\nВторой абзац.",
        siteEnabled: 1,
        publishedAt: now,
        updatedAt: now,
      },
    ])
    .run();
  backendDb.db
    .insert(postSources)
    .values({
      postId: 1,
      url: "https://example.com/official-announcement",
      labelRu: "Официально",
      labelEn: "Official",
      displayKind: "official",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const entity = backendDb.db
    .insert(knowledgeEntities)
    .values({ kind: "company", slug: "example-ai", titleRu: "Example AI", titleEn: "Example AI", createdAt: now, updatedAt: now })
    .returning({ id: knowledgeEntities.id })
    .get();
  backendDb.db.insert(postEntityLinks).values({ postId: 1, entityId: entity.id, createdAt: now }).run();
  backendDb.close();
}

async function stopAnyDaemon(): Promise<void> {
  const stop = Bun.spawn([astroBin, "dev", "stop"], { cwd: projectRoot, stdout: "ignore", stderr: "ignore" });
  await stop.exited;
}

async function waitUntilReady(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Dev server did not become ready on ${baseUrl}: ${String(lastError)}`);
}

/** Real `<h1>` tags only — Svelte's dev-mode inline `<style>` blocks keep
 * source comments verbatim, and this file's own comments mention `<h1>`. */
function countRealTags(html: string, tag: string): number {
  const withoutStyles = html.replace(/<style[\s\S]*?<\/style>/g, "");
  return (withoutStyles.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
}

beforeAll(async () => {
  await stopAnyDaemon();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-home-smoke-"));
  const dbPath = path.join(dbDir, "pipeline.db");
  seedDatabase(dbPath);
  publicDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-home-smoke-media-"));
  const imagePath = path.join(publicDir, FIXTURE_IMAGE_PATH);
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, FIXTURE_JPEG);
  server = Bun.spawn(["bun", "--bun", astroBin, "dev", "--port", String(port), "--host", host], {
    cwd: projectRoot,
    env: { ...process.env, PIPELINE_DB: dbPath, SITE_PUBLIC_DIR: publicDir, ENABLE_WORKERS: "0" },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitUntilReady(30_000);
}, 40_000);

afterAll(async () => {
  server?.kill();
  await stopAnyDaemon();
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(publicDir, { recursive: true, force: true });
});

describe("home page SSR smoke test", () => {
  it("renders the story player with a single SEO h1 and the seeded post", async () => {
    const html = await (await fetch(baseUrl)).text();

    expect(countRealTags(html, "h1")).toBe(1);
    expect(html).toContain("Smoke test post body");
    expect(html).toContain("data-story-player");
  });

  it("renders the Russian home page with its own locale content", async () => {
    const html = await (await fetch(`${baseUrl}/ru/`)).text();

    expect(countRealTags(html, "h1")).toBe(1);
    expect(html).toContain("дымового теста");
  });

  it("renders the individual post page with NewsArticle structured data", async () => {
    const html = await (await fetch(`${baseUrl}/1/smoke-test-post/`)).text();

    expect(countRealTags(html, "h1")).toBe(1);
    expect(html).toContain('"@type":"NewsArticle"');
    expect(html).toContain('"isBasedOn":["https://example.com/official-announcement"]');
    expect(html).toContain('"url":"https://alexgetman.com/entities/company/example-ai/"');
  });

  it("serves the seeded post's image through the real media route", async () => {
    const html = await (await fetch(baseUrl)).text();
    expect(html).toContain(`/${FIXTURE_IMAGE_PATH}`);

    const response = await fetch(`${baseUrl}/${FIXTURE_IMAGE_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("image/");
    expect((await response.arrayBuffer()).byteLength).toBe(FIXTURE_JPEG.byteLength);
  });
});
