import fs from "node:fs/promises";
import path from "node:path";
import type { APIRoute } from "astro";
import { getRuntime } from "../../../server/runtime.js";

export const prerender = false;

/** On-demand responsive variants. The build-time generator (scripts/generate-responsive-images.ts)
 * only covers media that exists at build time, but posts publish continuously and their media
 * lands in SITE_PUBLIC_DIR at runtime — so every srcset URL for a post newer than the deployed
 * image used to 404. This route derives the source file from the variant name, resizes it with
 * sharp on first request and caches the result on disk next to the build-time output. */

const ALLOWED_WIDTHS = new Set(["360", "640", "960"]);
const SOURCE_EXTENSIONS = [".jpg", ".jpeg", ".png"];
// The generator flattens the source path by replacing "/" with "-"; reversing that is ambiguous,
// so only the known content directories are tried, longest prefix first.
const SOURCE_PREFIXES: Array<[string, string]> = [
  ["media-posts-", "media/posts/"],
  ["og-posts-", "og/posts/"],
  ["media-", "media/"],
];

function sourceRoots(): string[] {
  const roots = [path.resolve(process.cwd(), "apps/web/public"), path.resolve(process.cwd(), "public")];
  try {
    roots.unshift(path.resolve(getRuntime().config.SITE_PUBLIC_DIR));
  } catch {}
  return roots;
}

async function findSource(base: string): Promise<string | null> {
  for (const [flatPrefix, dirPrefix] of SOURCE_PREFIXES) {
    if (!base.startsWith(flatPrefix)) continue;
    const nameBase = base.slice(flatPrefix.length);
    if (!nameBase || nameBase.includes("/") || nameBase.includes("..")) continue;
    for (const root of sourceRoots()) {
      for (const extension of SOURCE_EXTENSIONS) {
        const candidate = path.join(root, dirPrefix, `${nameBase}${extension}`);
        if (!candidate.startsWith(root + path.sep)) continue;
        if (await Bun.file(candidate).exists()) return candidate;
      }
    }
  }
  return null;
}

export const GET: APIRoute = async ({ params }) => {
  const requested = String(params.file ?? "");
  const match = /^([A-Za-z0-9._-]+)-(\d{3})\.webp$/.exec(requested);
  if (!match || !ALLOWED_WIDTHS.has(match[2])) return new Response("not found\n", { status: 404 });
  const [, base, width] = match;

  const headers = new Headers({
    "Content-Type": "image/webp",
    "Cache-Control": "public, max-age=604800, stale-while-revalidate=86400",
  });

  // Serve a previously generated variant (build-time or cached by this route) if present.
  for (const root of sourceRoots()) {
    const cached = Bun.file(path.join(root, "generated/responsive", requested));
    if (await cached.exists()) return new Response(cached, { headers });
  }

  const sourcePath = await findSource(base);
  if (!sourcePath) return new Response("not found\n", { status: 404 });

  const variant = await generateVariant(sourcePath, Number(width));
  if (!variant) return new Response("unprocessable\n", { status: 404 });
  headers.set("Content-Type", variant.type);

  // Only true webp output is cached under the .webp name; the jpeg last resort
  // is served as-is so a later run with working encoders can replace it.
  if (variant.type === "image/webp") {
    const cacheDir = path.join(sourceRoots()[0], "generated/responsive");
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await Bun.write(path.join(cacheDir, requested), variant.bytes);
    } catch {}
  }

  return new Response(new Uint8Array(variant.bytes), { headers });
};

type Variant = { bytes: Uint8Array; type: "image/webp" | "image/jpeg" };

async function runFfmpegVariant(sourcePath: string, width: number, codecArgs: string[], ext: string): Promise<Uint8Array | null> {
  const os = await import("node:os");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "responsive-"));
  const scratch = path.join(dir, `variant.${ext}`);
  try {
    const ffmpeg = Bun.spawn(["ffmpeg", "-y", "-i", sourcePath, "-vf", `scale='min(${width},iw)':-2`, ...codecArgs, scratch], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await ffmpeg.exited) !== 0) return null;
    return new Uint8Array(await Bun.file(scratch).arrayBuffer());
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The production image runs on Alpine while node_modules install on Debian, so
 * sharp's native binding may be missing there; ffmpeg ships in the image and is
 * the reliable path. sharp covers environments whose ffmpeg lacks libwebp, and a
 * resized jpeg is the last resort — still far smaller than the original. */
async function generateVariant(sourcePath: string, width: number): Promise<Variant | null> {
  const webp = await runFfmpegVariant(sourcePath, width, ["-c:v", "libwebp", "-quality", "80"], "webp");
  if (webp) return { bytes: webp, type: "image/webp" };
  try {
    const { default: sharp } = await import("sharp");
    const bytes = await sharp(sourcePath).resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    return { bytes: new Uint8Array(bytes), type: "image/webp" };
  } catch {}
  const jpeg = await runFfmpegVariant(sourcePath, width, ["-q:v", "5"], "jpg");
  return jpeg ? { bytes: jpeg, type: "image/jpeg" } : null;
}
