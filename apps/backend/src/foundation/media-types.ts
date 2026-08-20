const MIME_BY_EXTENSION = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
} as const;

export type ImageExtension = ".jpg" | ".png" | ".webp" | ".gif" | ".avif";

export function fileExtension(value: string): string {
  const name = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).split(/[?#]/, 1)[0] ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function mediaContentType(value: string): string | null {
  return MIME_BY_EXTENSION[fileExtension(value) as keyof typeof MIME_BY_EXTENSION] ?? null;
}

export function imageExtension(value: string): ImageExtension | null {
  const extension = fileExtension(value);
  if (extension === ".jpeg") return ".jpg";
  return [".jpg", ".png", ".webp", ".gif", ".avif"].includes(extension) ? (extension as ImageExtension) : null;
}

export function imageExtensionForContentType(contentType: string): ImageExtension | null {
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "image/gif") return ".gif";
  if (contentType === "image/avif") return ".avif";
  return contentType === "image/jpeg" ? ".jpg" : null;
}
