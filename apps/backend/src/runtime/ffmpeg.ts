import { spawnSync } from "node:child_process";

export function assertFfmpegAvailable(): boolean {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

export async function runFfmpeg(args: string[], timeoutSeconds = 600): Promise<void> {
  const result = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: timeoutSeconds * 1000, killSignal: "SIGKILL" });
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
    throw new Error(`ffmpeg timed out after ${timeoutSeconds}s`);
  }
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${(result.stderr ?? result.error?.message ?? "unknown error").slice(-2000)}`);
  }
}
