import fs from "node:fs";

export class MediaUploadTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Media upload exceeds the ${Math.ceil(maxBytes / 1024 / 1024)} MB limit.`);
    this.name = "MediaUploadTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export function isMediaUploadTooLarge(error: unknown): boolean {
  return error instanceof MediaUploadTooLargeError;
}

/** Streams an upload into a private temporary file while enforcing a byte cap. */
export async function streamUploadToFile(body: ReadableStream<Uint8Array>, targetPath: string, maxBytes: number): Promise<number> {
  const handle = await fs.promises.open(targetPath, "w", 0o600);
  const reader = body.getReader();
  let byteSize = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteSize += value.byteLength;
      if (byteSize > maxBytes) throw new MediaUploadTooLargeError(maxBytes);
      let offset = 0;
      while (offset < value.byteLength) {
        const result = await handle.write(value, offset, value.byteLength - offset, null);
        offset += result.bytesWritten;
      }
    }
    if (byteSize === 0) throw new Error("Media file is empty.");
    completed = true;
    return byteSize;
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
    await handle.close();
  }
}
