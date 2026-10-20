import { kindFromStatus, parseRetryAfter, ProviderError } from "../errors.js";

/** POSTs JSON and throws a classified ProviderError on any non-2xx response. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ProviderError(kindFromStatus(res.status), `HTTP ${res.status}: ${detail.slice(0, 300)}`, {
      status: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }
  return res;
}
