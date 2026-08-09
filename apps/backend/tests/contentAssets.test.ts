import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { importStudioMediaFile } from "../src/content/assets.js";
import type { BackendDb } from "../src/db/client.js";
import { loadConfig } from "../src/foundation/config.js";
import { openBackendDb } from "./helpers/open-db.js";

let backendDb: BackendDb | null = null;
let directories: string[] = [];

afterEach(() => {
  backendDb?.close();
  backendDb = null;
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

describe("Studio media storage", () => {
  it("does not leave an extension-specific orphan when the content hash already exists", async () => {
    backendDb = openBackendDb(":memory:");
    const inputDirectory = mkdtempSync(path.join(os.tmpdir(), "studio-media-input-"));
    const storageDirectory = mkdtempSync(path.join(os.tmpdir(), "studio-media-storage-"));
    directories.push(inputDirectory, storageDirectory);
    const bytes = Buffer.from("same image bytes");
    const firstPath = path.join(inputDirectory, "one.jpg");
    const secondPath = path.join(inputDirectory, "two.png");
    writeFileSync(firstPath, bytes);
    writeFileSync(secondPath, bytes);
    const config = loadConfig({ STUDIO_MEDIA_DIR: storageDirectory, STUDIO_MEDIA_MAX_BYTES: "1000" });

    const first = await importStudioMediaFile(backendDb, config, 42, {
      filename: "one.jpg",
      contentType: "image/jpeg",
      localPath: firstPath,
      source: "ops_upload",
    });
    const second = await importStudioMediaFile(backendDb, config, 42, {
      filename: "two.png",
      contentType: "image/png",
      localPath: secondPath,
      source: "ops_upload",
    });

    expect(second.id).toBe(first.id);
    expect(second.localPath).toBe(first.localPath);
    expect(readdirSync(path.join(storageDirectory, "42"))).toEqual([path.basename(first.localPath)]);
  });
});
