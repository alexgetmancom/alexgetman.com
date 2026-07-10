import { spawnSync } from "node:child_process";

export function assertFfmpegAvailable(): boolean {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

export async function runFfmpeg(args: string[]): Promise<void> {
  const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr.slice(-2000)}`);
  }
}
