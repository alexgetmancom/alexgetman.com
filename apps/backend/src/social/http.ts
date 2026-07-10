import { HttpPublishError } from "../queue/errors.js";

export async function requestJson<T = Record<string, unknown>>(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchImpl(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new HttpPublishError(`${init.method ?? "GET"} ${url} failed: ${response.status} ${body}`, response.status, body);
  }
  if (!body) return {} as T;
  return JSON.parse(body) as T;
}

export async function requestText(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<string> {
  const response = await fetchImpl(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new HttpPublishError(`${init.method ?? "GET"} ${url} failed: ${response.status} ${body}`, response.status, body);
  }
  return body;
}

export function formBody(fields: Record<string, string | number | boolean | null | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    body.append(key, String(value));
  }
  return body;
}
