import { afterEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeSiteMedia } from "../src/delivery/site-media.js";
import { loadConfig } from "../src/foundation/config.js";

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

    expect(initial[0]?.path).toMatch(/^media\/posts\/1-ru-0\.png\?v=[a-f0-9]{12}$/);
    expect(fs.readFileSync(path.join(directory, "media", "posts", "1-ru-0.png"))).toEqual(image);
    for (const width of [360, 640, 960])
      expect(fs.existsSync(path.join(directory, "generated", "responsive", `media-posts-1-ru-0-${width}.webp`))).toBe(true);
  });

  it("does not regenerate unchanged responsive derivatives on every feed build", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const image = path.join(directory, "image.jpg");
    fs.writeFileSync(image, "source");
    const config = loadConfig({ SITE_PUBLIC_DIR: directory });

    await materializeSiteMedia(config, 2, "en", [{ type: "image", local_path: image }]);
    await materializeSiteMedia(config, 2, "en", [{ type: "image", local_path: image }]);

    expect(ffmpegCalls).toBe(3);
  });
});
