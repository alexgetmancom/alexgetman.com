import { afterEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeSiteMedia } from "../src/delivery/site-media.js";
import { loadConfig } from "../src/foundation/config.js";
import { deduplicateSiteMedia } from "../src/operations/site-media-deduplicate.js";

let ffmpegCalls = 0;
mock.module("../src/foundation/runtime/ffmpeg.js", () => ({
  runFfmpeg: async (args: string[]) => {
    ffmpegCalls += 1;
    const output = args.at(-1);
    if (!output) throw new Error("missing responsive output path");
    fs.writeFileSync(output, "webp");
  },
}));

let directory: string | null = null;

afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = null;
  ffmpegCalls = 0;
});

describe("site media materialization", () => {
  it("replaces stable media files and preserves a known source extension", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const first = path.join(directory, "first.png");
    const second = path.join(directory, "second.png");
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    fs.writeFileSync(first, image);
    fs.writeFileSync(second, image);
    const config = loadConfig({ SITE_PUBLIC_DIR: directory });

    const initial = await materializeSiteMedia(config, 1, "ru", [{ type: "image", local_path: first }]);
    await materializeSiteMedia(config, 1, "ru", [{ type: "image", local_path: second }]);

    expect(initial[0]?.path).toMatch(/^media\/posts\/1-ru-0-vertical\.jpg\?v=[a-f0-9]{12}$/);
    expect(fs.readFileSync(path.join(directory, "media", "posts", "1-ru-0.png"))).toEqual(image);
    for (const width of [360, 640, 960])
      expect(fs.existsSync(path.join(directory, "generated", "responsive", `media-posts-1-ru-0-vertical-${width}.webp`))).toBe(true);
  });

  it("does not regenerate unchanged responsive derivatives on every feed build", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const image = path.join(directory, "image.jpg");
    fs.writeFileSync(image, "source");
    const config = loadConfig({ SITE_PUBLIC_DIR: directory });

    await materializeSiteMedia(config, 2, "en", [{ type: "image", local_path: image }]);
    await materializeSiteMedia(config, 2, "en", [{ type: "image", local_path: image }]);

    // one vertical projection plus its three responsive derivatives; the
    // unchanged second build must not add further work.
    expect(ffmpegCalls).toBe(4);
  });

  it("shares equal locale files and atomically detaches a later replacement", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const first = path.join(directory, "first.jpg");
    const changed = path.join(directory, "changed.jpg");
    fs.writeFileSync(first, "same-source");
    fs.writeFileSync(changed, "new-source");
    const config = loadConfig({ SITE_PUBLIC_DIR: directory });
    await materializeSiteMedia(config, 3, "ru", [{ type: "image", local_path: first }]);
    await materializeSiteMedia(config, 3, "en", [{ type: "image", local_path: first }]);
    const ru = path.join(directory, "media", "posts", "3-ru-0.jpg");
    const en = path.join(directory, "media", "posts", "3-en-0.jpg");
    expect(fs.statSync(ru).ino).toBe(fs.statSync(en).ino);
    await materializeSiteMedia(config, 3, "ru", [{ type: "image", local_path: changed }]);
    expect(fs.readFileSync(ru, "utf8")).toBe("new-source");
    expect(fs.readFileSync(en, "utf8")).toBe("same-source");
    expect(fs.statSync(ru).ino).not.toBe(fs.statSync(en).ino);
  });

  it("keeps only the vertical video master and poster in permanent site media", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const source = path.join(directory, "source.mp4");
    fs.writeFileSync(source, "video-source");
    const config = loadConfig({ SITE_PUBLIC_DIR: directory });
    const [item] = await materializeSiteMedia(config, 4, "en", [{ type: "video", local_path: source }]);
    const media = path.join(directory, "media", "posts");
    expect(fs.existsSync(path.join(media, "4-en-0.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(media, "4-en-0-vertical.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(media, "4-en-0-poster.jpg"))).toBe(true);
    expect(item?.path).toMatch(/^media\/posts\/4-en-0-vertical\.mp4\?v=/);
  });

  it("migrates historical URLs without changing their paths or bytes", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const media = path.join(directory, "media");
    const posts = path.join(media, "posts");
    fs.mkdirSync(posts, { recursive: true });
    const legacy = path.join(media, "35.mp4");
    const current = path.join(posts, "35-en-0.mp4");
    fs.writeFileSync(legacy, "historical-video");
    fs.writeFileSync(current, "historical-video");
    const config = loadConfig({ SITE_PUBLIC_DIR: directory });
    expect(await deduplicateSiteMedia(config, false)).toMatchObject({ files: 2, legacy_url_files: 1, reclaimable_bytes: 16 });
    await deduplicateSiteMedia(config, true);
    expect(fs.readFileSync(legacy, "utf8")).toBe("historical-video");
    expect(fs.readFileSync(current, "utf8")).toBe("historical-video");
    expect(fs.statSync(legacy).ino).toBe(fs.statSync(current).ino);
    expect(await deduplicateSiteMedia(config, false)).toMatchObject({ reclaimable_bytes: 0, logical_duplicate_bytes: 16 });
  });
});
