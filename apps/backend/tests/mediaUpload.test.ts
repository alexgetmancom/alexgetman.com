import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaUploadTooLargeError, streamUploadToFile } from "../src/interfaces/http/media-upload.js";

describe("streamUploadToFile", () => {
  it("writes a request body without keeping the upload in memory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alexgetman-upload-"));
    const target = join(directory, "incoming");
    try {
      const size = await streamUploadToFile(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3, 4]));
            controller.close();
          },
        }),
        target,
        4,
      );
      expect(size).toBe(4);
      expect([...readFileSync(target)]).toEqual([1, 2, 3, 4]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stops reading when the byte limit is exceeded", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alexgetman-upload-limit-"));
    try {
      await expect(
        streamUploadToFile(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.enqueue(new Uint8Array([4]));
            },
          }),
          join(directory, "incoming"),
          3,
        ),
      ).rejects.toBeInstanceOf(MediaUploadTooLargeError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
