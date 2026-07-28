import crypto from "node:crypto";
import fs from "node:fs";

/** Stable media work identity. Paths and mtimes vary across targets and hosts,
 * while identical bytes plus the same recipe must always reuse one derivative. */
export async function mediaTransformKey(source: string, recipe: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(`${recipe}\0`);
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(source);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}
