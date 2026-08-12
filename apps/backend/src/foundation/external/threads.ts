import type { BackendConfig } from "../config.js";

export type ThreadsTarget = "threads_ru" | "threads_en";

export function threadsCredentials(config: BackendConfig, target: ThreadsTarget): { accessToken: string | undefined; envName: string } {
  return target === "threads_en"
    ? { accessToken: config.THREADS_EN_ACCESS_TOKEN, envName: "THREADS_EN_ACCESS_TOKEN" }
    : { accessToken: config.THREADS_RU_ACCESS_TOKEN, envName: "THREADS_RU_ACCESS_TOKEN" };
}
