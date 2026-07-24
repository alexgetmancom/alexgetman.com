/** Canonical Story transcode recipe, shared by the in-process path
 * (apps/backend/src/delivery/story-media.ts) and this remote worker.
 * The two build contexts are isolated (this Docker image copies only its own
 * directory), so apps/backend imports this file directly across the repo tree
 * instead of duplicating the ffmpeg arguments. Keep both callers in sync by
 * changing only this file. */

// One second of headroom below the 60-second story limit used by every
// supported publishing target.
export const STORY_MAX_DURATION_SECONDS = 59;

// Shared high-quality master: 1080x1920, 50 FPS, H.264 video and AAC 320k audio.
// H.264/AVC is required, not HEVC: Telegram's story upload rejects HEVC-encoded
// video with MEDIA_FILE_INVALID (400).
// force_divisible_by=2 keeps both dimensions even, which yuv420p and VAAPI require.
const STORY_SCALE_FILTER =
  "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black";

export function storyFfmpegArgs(input: string, output: string, kind: "video" | "image", extraVideoArgs: string[] = []): string[] {
  if (kind === "image") return ["-y", "-i", input, "-vf", STORY_SCALE_FILTER, "-frames:v", "1", "-q:v", "2", output];
  return [
    "-y",
    "-i",
    input,
    "-t",
    String(STORY_MAX_DURATION_SECONDS),
    "-vf",
    STORY_SCALE_FILTER,
    "-r",
    "50",
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-b:v",
    "3150k",
    "-maxrate",
    "3300k",
    "-bufsize",
    "6600k",
    "-g",
    "50",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "320k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-tag:v",
    "avc1",
    "-movflags",
    "+faststart",
    ...extraVideoArgs,
    output,
  ];
}

/**
 * VM-106's Intel iGPU owns the remote executor.  This is deliberately a
 * separate command from storyFfmpegArgs(): the local executor may not have a
 * VAAPI device, and provider selection is explicit in MEDIA_PROCESSOR_PROVIDER
 * rather than an automatic fallback.
 */
export function remoteStoryFfmpegArgs(input: string, standardOutput: string, telegramOutput: string, telegramVideoKbps: number): string[] {
  // One decode, one scale/hwupload and one VAAPI encoder session per output.
  // split is intentional: rendering the Telegram derivative in a separate
  // ffmpeg process doubles the expensive decode/scale work on the N100.
  return [
    "-init_hw_device",
    "vaapi=va:/dev/dri/renderD128",
    "-filter_hw_device",
    "va",
    "-y",
    "-i",
    input,
    "-filter_complex",
    `[0:v:0]trim=duration=${STORY_MAX_DURATION_SECONDS},fps=50,${STORY_SCALE_FILTER},format=nv12,hwupload,split=2[standard][telegram]`,
    "-r",
    "50",
    "-map",
    "[standard]",
    "-map",
    "0:a?",
    "-c:v",
    "h264_vaapi",
    "-b:v",
    "3150k",
    "-maxrate",
    "3300k",
    "-bufsize",
    "6600k",
    "-g",
    "50",
    // Copy preserves the submitted AAC track exactly (64…320 kbps stays as
    // submitted), rather than needlessly re-encoding or upsampling it.
    "-c:a",
    "copy",
    "-tag:v",
    "avc1",
    "-movflags",
    "+faststart",
    standardOutput,
    "-map",
    "[telegram]",
    "-map",
    "0:a?",
    "-c:v",
    "h264_vaapi",
    "-b:v",
    `${telegramVideoKbps}k`,
    "-maxrate",
    `${telegramVideoKbps}k`,
    "-bufsize",
    `${telegramVideoKbps * 2}k`,
    "-g",
    "50",
    "-c:a",
    "copy",
    "-tag:v",
    "avc1",
    "-movflags",
    "+faststart",
    telegramOutput,
  ];
}
