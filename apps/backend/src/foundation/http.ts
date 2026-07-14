class ExternalHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

export async function requestJson<T = Record<string, unknown>>(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<T> {
  const response = await externalFetch(fetchImpl, url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new ExternalHttpError(
      `${init.method ?? "GET"} ${safeUrl(url)} failed: ${response.status} ${redactExternalSecrets(body)}`,
      response.status,
      redactExternalSecrets(body),
    );
  }
  if (!body) return {} as T;
  return JSON.parse(body) as T;
}

export async function requestText(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<string> {
  const response = await externalFetch(fetchImpl, url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new ExternalHttpError(
      `${init.method ?? "GET"} ${safeUrl(url)} failed: ${response.status} ${redactExternalSecrets(body)}`,
      response.status,
      redactExternalSecrets(body),
    );
  }
  return body;
}

export async function externalFetch(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetchImpl(url, { ...init, signal: init.signal ?? controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${init.method ?? "GET"} ${safeUrl(url)} timed out after 30s`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of ["access_token", "token", "api_key", "api-key", "password"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "[REDACTED]");
    }
    url.pathname = url.pathname.replace(/\/bot[^/]+(?=\/|$)/, "/bot[REDACTED]");
    return url.toString();
  } catch {
    return redactExternalSecrets(value);
  }
}

export function redactExternalSecrets(value: string): string {
  return value
    .replace(/(access_token|api[_-]?key|password|token)=([^\s&"']+)/gi, "$1=[REDACTED]")
    .replace(/\/bot\d{6,}:[A-Za-z0-9_-]+/g, "/bot[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

export function formBody(fields: Record<string, string | number | boolean | null | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    body.append(key, String(value));
  }
  return body;
}
