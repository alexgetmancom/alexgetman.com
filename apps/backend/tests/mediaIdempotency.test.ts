import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mediaTransformKey } from "../src/delivery/media-idempotency.js";

describe("mediaTransformKey", () => {
  it("uses file contents and the recipe instead of path or mtime", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "media-key-"));
    try {
      const first = path.join(directory, "first.mp4");
      const second = path.join(directory, "second.mp4");
      fs.writeFileSync(first, "same bytes");
      fs.writeFileSync(second, "same bytes");
      fs.utimesSync(second, new Date(0), new Date(0));

      expect(await mediaTransformKey(first, "story-v2")).toBe(await mediaTransformKey(second, "story-v2"));
      expect(await mediaTransformKey(first, "story-v2")).not.toBe(await mediaTransformKey(second, "site-v2"));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
