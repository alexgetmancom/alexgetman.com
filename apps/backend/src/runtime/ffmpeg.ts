import { spawn, spawnSync } from "node:child_process";
import pLimit from "p-limit";

let maxConcurrency = 2;
let limiter = pLimit(maxConcurrency);

export function assertFfmpegAvailable(): boolean {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

export function configureFfmpegConcurrency(value: number): void {
  maxConcurrency = Math.max(1, Math.min(2, Math.floor(value)));
  limiter = pLimit(maxConcurrency);
}

export function ffmpegMaxConcurrency(): number {
  return maxConcurrency;
}

export async function runFfmpeg(args: string[], timeoutSeconds = 600): Promise<void> {
  await limiter(
    () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutSeconds * 1000);

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-2000);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (timedOut) reject(new Error(`ffmpeg timed out after ${timeoutSeconds}s`));
          else if (code !== 0) reject(new Error(`ffmpeg failed: ${stderr || `exit code ${code ?? "unknown"}`}`));
          else resolve();
        });
      }),
  );
}
