import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/foundation/config.js";
import {
  checkDataDirectoriesWritable,
  fixDataDirectoriesOwnership,
  requiredDataDirectories,
  resolveUnixUser,
} from "../src/foundation/runtime/data-dirs.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "alexgetman-data-dirs-"));
}

describe("requiredDataDirectories", () => {
  it("excludes video/site directories when their module is disabled", () => {
    const root = tempRoot();
    const config = loadConfig({
      DATA_DIR: join(root, "data"),
      MEDIA_CACHE_DIR: join(root, "media-cache"),
      STUDIO_MEDIA_DIR: join(root, "video-media"),
      VIDEO_MEDIA_DIR: join(root, "video-media"),
      SITE_PUBLIC_DIR: join(root, "site"),
    });
    // Repo studio.yaml: site enabled, video_posting disabled.
    const names = requiredDataDirectories(config).map((entry) => entry.name);
    expect(names).toContain("DATA_DIR");
    expect(names).toContain("MEDIA_CACHE_DIR");
    expect(names).toContain("SITE_PUBLIC_DIR");
    expect(names).not.toContain("STUDIO_MEDIA_DIR");
    expect(names).not.toContain("VIDEO_MEDIA_DIR");
  });

  it("includes video directories and dedupes an identical path when video is enabled", () => {
    const root = tempRoot();
    // Absolute path: loadStudioConfig resolves a relative STUDIO_CONFIG against
    // process.cwd(), which differs between a root-level `bun test` run and
    // `bun run --filter @alexgetman/backend test` (cwd apps/backend).
    const config = loadConfig({
      STUDIO_CONFIG: join(import.meta.dir, "../../../studio.video-only.example.yaml"),
      YOUTUBE_CLIENT_ID: "test",
      YOUTUBE_CLIENT_SECRET: "test",
      YOUTUBE_REFRESH_TOKEN: "test",
      INSTAGRAM_ACCESS_TOKEN: "test",
      INSTAGRAM_USER_ID: "test",
      DATA_DIR: join(root, "data"),
      MEDIA_CACHE_DIR: join(root, "media-cache"),
      STUDIO_MEDIA_DIR: join(root, "video-media"),
      VIDEO_MEDIA_DIR: join(root, "video-media"),
      SITE_PUBLIC_DIR: join(root, "site"),
    });
    const entries = requiredDataDirectories(config);
    const names = entries.map((entry) => entry.name);
    expect(names).toContain("STUDIO_MEDIA_DIR");
    // Same resolved path as STUDIO_MEDIA_DIR in this config: listed once.
    expect(names).not.toContain("VIDEO_MEDIA_DIR");
    expect(names).not.toContain("SITE_PUBLIC_DIR");
    expect(entries.filter((entry) => entry.path === join(root, "video-media"))).toHaveLength(1);
  });
});

describe("checkDataDirectoriesWritable", () => {
  it("creates a missing directory and reports it writable", () => {
    const root = tempRoot();
    const target = join(root, "fresh", "nested");
    const [result] = checkDataDirectoriesWritable([{ name: "TEST_DIR", path: target }]);
    expect(result?.writable).toBe(true);
    expect(result?.error).toBeUndefined();
  });

  it("reports an existing directory the process cannot write to", () => {
    // Docker auto-vivifies an unset bind-mount target as root; the app user
    // then sees exactly this: the directory exists but every write fails.
    if (process.getuid?.() === 0) return; // root bypasses permission bits; nothing to assert.
    const root = tempRoot();
    const locked = join(root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const [result] = checkDataDirectoriesWritable([{ name: "LOCKED_DIR", path: locked }]);
      expect(result?.writable).toBe(false);
      expect(result?.error).toBeTruthy();
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

describe("resolveUnixUser", () => {
  it("parses uid/gid for a known user from a passwd-style file", () => {
    const root = tempRoot();
    const passwdFile = join(root, "passwd");
    writeFileSync(passwdFile, "root:x:0:0:root:/root:/bin/sh\nbun:x:1000:1000:bun:/home/bun:/bin/sh\n");
    expect(resolveUnixUser("bun", passwdFile)).toEqual({ uid: 1000, gid: 1000 });
  });

  it("throws for a user missing from the file", () => {
    const root = tempRoot();
    const passwdFile = join(root, "passwd");
    writeFileSync(passwdFile, "root:x:0:0:root:/root:/bin/sh\n");
    expect(() => resolveUnixUser("bun", passwdFile)).toThrow("Unix user not found");
  });
});

describe("fixDataDirectoriesOwnership", () => {
  it("reports no change when the directory already has the target owner", () => {
    const root = tempRoot();
    const target = join(root, "already-owned");
    mkdirSync(target);
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const [result] = fixDataDirectoriesOwnership([{ name: "TEST_DIR", path: target }], uid, gid);
    expect(result?.changed).toBe(false);
    expect(result?.error).toBeUndefined();
  });

  it("reports an error instead of throwing when chown is not permitted", () => {
    // Mirrors what happens in the entrypoint if it somehow isn't running as
    // root: fail loudly per-directory rather than crash the whole process.
    if (process.getuid?.() === 0) return; // root can chown to anything; nothing to assert.
    const root = tempRoot();
    const target = join(root, "foreign-owner");
    mkdirSync(target);
    const [result] = fixDataDirectoriesOwnership([{ name: "TEST_DIR", path: target }], 65534, 65534);
    expect(result?.changed).toBe(false);
    expect(result?.error).toBeTruthy();
  });
});
