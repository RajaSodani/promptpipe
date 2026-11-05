import type { Attempt, ErrorKind } from "./types.js";

const RETRYABLE: ReadonlySet<ErrorKind> = new Set(["rate_limit", "server", "timeout", "network"]);

/** Thrown by provider adapters. `retryable` decides between "retry here" and "move to the next provider". */
export class ProviderError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(kind: ErrorKind, message: string, opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/** Thrown by the pipe when every provider has been exhausted. */
export class PipeError extends Error {
  readonly attempts: Attempt[];

  constructor(message: string, attempts: Attempt[]) {
    super(message);
    this.name = "PipeError";
    this.attempts = attempts;
  }
}

export function kindFromStatus(status: number): ErrorKind {
  if (status === 429) return "rate_limit";
  if (status === 408) return "timeout";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "unknown";
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Normalises anything thrown during an attempt into a ProviderError. */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  // AbortSignal.timeout() rejects fetch (and the SDKs) with a DOMException named TimeoutError
  if (err instanceof Error && err.name === "TimeoutError") {
    return new ProviderError("timeout", "Request timed out", { cause: err });
  }
  if (err instanceof TypeError) {
    // fetch() rejects with TypeError on DNS / connection failures
    return new ProviderError("network", err.message, { cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError("unknown", message, { cause: err });
}
