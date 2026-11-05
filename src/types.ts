/** A single chat turn. System instructions go in `RunOptions.system`, not here. */
export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** USD per one million tokens. */
export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** What the pipe hands to a provider for one attempt. */
export interface ProviderRequest {
  system?: string;
  messages: Message[];
  maxTokens: number;
  temperature?: number;
  /** True when the caller passed a schema: the provider should ask for JSON output. */
  json: boolean;
  signal: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  usage: Usage;
  /** The model that actually served the request, as reported by the API. */
  model: string;
  finishReason?: string;
}

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "done"; usage: Usage; model: string; finishReason?: string };

/**
 * A provider adapter. Implementations throw `ProviderError` so the pipe can
 * tell a retryable failure (429, 5xx, timeout) from a terminal one (401, 400).
 */
export interface Provider {
  /** Short label used in attempts and events, e.g. "gemini". */
  name: string;
  model: string;
  pricing?: Pricing;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
  stream?(req: ProviderRequest): AsyncIterable<StreamChunk>;
}

export type ErrorKind =
  | "rate_limit"
  | "server"
  | "timeout"
  | "network"
  | "auth"
  | "bad_request"
  | "refusal"
  | "validation"
  | "unknown";

export interface Attempt {
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  usage: Usage;
  costUsd: number | null;
  error?: { kind: ErrorKind; message: string; status?: number };
}

export interface RunResult<T> {
  /** Parsed and validated output when a schema was given, otherwise the raw text. */
  output: T;
  text: string;
  provider: string;
  model: string;
  /** Every attempt, failed ones included, in order. */
  attempts: Attempt[];
  /** Summed across all attempts: failed attempts still cost tokens. */
  usage: Usage;
  /** Summed across all attempts. `null` if any attempt used a model with no known price. */
  costUsd: number | null;
  latencyMs: number;
}

export type PipeEvent =
  | { type: "attempt_start"; provider: string; model: string; attempt: number }
  | { type: "attempt_error"; provider: string; model: string; attempt: number; kind: ErrorKind; message: string; willRetry: boolean }
  | { type: "validation_failed"; provider: string; model: string; issues: string[] }
  | { type: "fallback"; from: string; to: string }
  | { type: "success"; provider: string; model: string; costUsd: number | null };
