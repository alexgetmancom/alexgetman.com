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
    if (timedOut) throw new Error(`media_processing_timeout: ffmpeg exceeded ${timeoutSeconds}s`);
    if (exitCode !== 0) throw new Error(formatFfmpegFailure(exitCode, stderr));
  });
}

/** Keep an actionable terminal reason instead of persisting megabytes of ffmpeg
 * progress frames. Exit 137 is the Linux OOM-kill convention. */
export function formatFfmpegFailure(exitCode: number, stderr: string): string {
  const meaningful = stderr
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^frame=\s*\d+\s+fps=/.test(line))
    .slice(-6)
    .join(" · ");
  const reason = exitCode === 137 ? "process was killed (likely out of memory)" : meaningful || "no diagnostic output";
  return `media_processing_failed: ffmpeg exit ${exitCode}: ${reason}`.slice(0, 1200);
}
