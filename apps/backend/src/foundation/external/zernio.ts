import type { BackendConfig } from "../config.js";
import { requestJson } from "../http.js";

export type ZernioAccount = {
  _id?: string;
  username?: string;
  displayName?: string;
  platform?: string;
  followersCount?: number;
};

type ZernioAccounts = { accounts?: ZernioAccount[] } | ZernioAccount[];
type ZernioRequestInit = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

export function zernioRequest<T>(
  config: BackendConfig,
  path: string,
  fetchImpl: typeof fetch = fetch,
  init: ZernioRequestInit = {},
): Promise<T> {
  if (!config.ZERNIO_API_KEY) throw new Error("ZERNIO_API_KEY is missing");
  return requestJson<T>(fetchImpl, `https://zernio.com/api/v1/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.ZERNIO_API_KEY}`, ...init.headers },
  });
}

export async function listZernioAccounts(config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<ZernioAccount[]> {
  const response = await zernioRequest<ZernioAccounts>(config, "accounts", fetchImpl);
  return Array.isArray(response) ? response : (response.accounts ?? []);
}

export async function zernioAccount(config: BackendConfig, accountId: string, fetchImpl: typeof fetch = fetch): Promise<ZernioAccount> {
  const account = (await listZernioAccounts(config, fetchImpl)).find((item) => item._id === accountId);
  if (!account) throw new Error("Zernio account was not found");
  return account;
}
