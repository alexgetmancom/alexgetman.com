import pLimit from "p-limit";

let maxConcurrency = 2;
let limiter = pLimit(maxConcurrency);

export function assertFfmpegAvailable(): boolean {
  return Bun.spawnSync(["ffmpeg", "-version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

export function configureFfmpegConcurrency(value: number): void {
  maxConcurrency = Math.max(1, Math.min(2, Math.floor(value)));
  limiter = pLimit(maxConcurrency);
}

export function ffmpegMaxConcurrency(): number {
  return maxConcurrency;
}

export async function runFfmpeg(args: string[], timeoutSeconds = 600): Promise<void> {
  await limiter(async () => {
    const child = Bun.spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    clearTimeout(timer);
    if (timedOut) throw new Error(`ffmpeg timed out after ${timeoutSeconds}s`);
    if (exitCode !== 0) throw new Error(`ffmpeg failed: ${stderr.trim().slice(-2000) || `exit code ${exitCode}`}`);
  });
}
