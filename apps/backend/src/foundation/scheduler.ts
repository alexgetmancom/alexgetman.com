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
  let stopped = false;
  const notify = (hook: (() => void) | undefined) => {
    if (!hook) return;
    try {
      hook();
    } catch (error) {
      log("warn", `${name} lifecycle hook failed`, { error: String(error) });
    }
  };
  const run = async () => {
    if (stopped || running) return;
    running = true;
    notify(hooks.onStart);
    let failure: unknown | null = null;
    try {
      await task();
    } catch (error) {
      failure = error;
      log("error", `${name} loop failed`, { error: String(error) });
    } finally {
      notify(() => hooks.onFinish?.(failure));
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  const heartbeatTimer =
    hooks.onHeartbeat && hooks.heartbeatIntervalMs ? setInterval(() => notify(hooks.onHeartbeat), hooks.heartbeatIntervalMs) : undefined;
  void run();
  return {
    name,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  };
}
