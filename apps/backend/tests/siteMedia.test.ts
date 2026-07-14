import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { materializeSiteMedia } from "../src/delivery/site-media.js";

let directory: string | null = null;

afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = null;
});

describe("site media materialization", () => {
  it("replaces stable media files and preserves a known source extension", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-media-"));
    const first = path.join(directory, "first.png");
    const second = path.join(directory, "second.png");
    fs.writeFileSync(first, "first");
    fs.writeFileSync(second, "second");
    const config = loadConfig({ SITE_PUBLIC_DIR: directory });

    const initial = await materializeSiteMedia(config, 1, "ru", [{ type: "image", local_path: first }]);
    await materializeSiteMedia(config, 1, "ru", [{ type: "image", local_path: second }]);

    expect(initial[0]?.path).toBe("media/posts/1-ru-0.png");
    expect(fs.readFileSync(path.join(directory, "media", "posts", "1-ru-0.png"), "utf8")).toBe("second");
  });
});
