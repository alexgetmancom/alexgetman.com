import { log } from "./logger.js";

export type ScheduledLoop = {
  name: string;
  stop: () => void;
};

export type LoopHooks = {
  onStart?: () => void;
  onHeartbeat?: () => void;
  heartbeatIntervalMs?: number;
  onFinish?: (error: unknown | null) => void;
};

export function startLoop(name: string, intervalMs: number, task: () => void | Promise<void>, hooks: LoopHooks = {}): ScheduledLoop {
  let running = false;
  const notify = (hook: (() => void) | undefined) => {
    if (!hook) return;
    try {
      hook();
    } catch (error) {
      log("warn", `${name} lifecycle hook failed`, { error: String(error) });
    }
  };
  const run = async () => {
    if (running) return;
    running = true;
    notify(hooks.onStart);
    const heartbeatTimer =
      hooks.onHeartbeat && hooks.heartbeatIntervalMs ? setInterval(() => notify(hooks.onHeartbeat), hooks.heartbeatIntervalMs) : undefined;
    let failure: unknown | null = null;
    try {
      await task();
    } catch (error) {
      failure = error;
      log("error", `${name} loop failed`, { error: String(error) });
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      notify(() => hooks.onFinish?.(failure));
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
