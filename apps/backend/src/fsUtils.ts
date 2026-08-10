import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { jsonObject } from "./json.js";

/** Unique per call, not per process: two concurrent writers of the same file
 * shared one `<file>.<pid>.tmp` and raced on the rename, so one of them could
 * publish a half-written file. */
function tempPath(filePath: string): string {
  return `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
}

export function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = tempPath(filePath);
  try {
    // fsync before rename: rename is atomic, but without the flush a crash can
    // leave the renamed file present and empty, which reads as valid-but-blank.
    const descriptor = fs.openSync(temp, "w", 0o664);
    try {
      fs.writeFileSync(descriptor, content, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temp, filePath);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export function parseObject(value: unknown): Record<string, unknown> | null {
  const object = jsonObject(value);
  return Object.keys(object).length > 0 ? object : null;
}
