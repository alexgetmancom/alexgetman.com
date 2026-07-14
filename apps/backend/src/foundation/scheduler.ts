import { log } from "./logger.js";

export type ScheduledLoop = {
  name: string;
  stop: () => void;
};

export function startLoop(name: string, intervalMs: number, task: () => void | Promise<void>): ScheduledLoop {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (error) {
      log("error", `${name} loop failed`, { error: String(error) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  void run();
  return {
    name,
    stop: () => clearInterval(timer),
  };
}
