import { ProviderError } from "../errors.js";
import type { ErrorKind, Pricing, Provider, ProviderRequest, StreamChunk } from "../types.js";

/** One scripted outcome: a reply string, or a failure of the given kind. */
export type MockStep = string | { fail: ErrorKind; status?: number; retryAfterMs?: number };

export interface MockOptions {
  name?: string;
  model?: string;
  pricing?: Pricing;
  /** Played in order; the last step repeats once the script runs out. */
  script: MockStep[] | ((req: ProviderRequest, call: number) => MockStep);
  /** Simulated latency per call. */
  delayMs?: number;
}

/**
 * Deterministic provider for tests, demos and offline development.
 * Token usage is estimated at ~4 characters per token.
 */
export function mock(opts: MockOptions): Provider & { calls: ProviderRequest[] } {
  const calls: ProviderRequest[] = [];

  const next = async (req: ProviderRequest): Promise<string> => {
    calls.push(req);
    const n = calls.length - 1;
    const step =
      typeof opts.script === "function" ? opts.script(req, n) : opts.script[Math.min(n, opts.script.length - 1)];
    if (step === undefined) throw new Error("mock provider has an empty script");
    if (opts.delayMs) await sleepAbortable(opts.delayMs, req.signal);
    if (typeof step !== "string") {
      throw new ProviderError(step.fail, `mock ${step.fail}`, { status: step.status, retryAfterMs: step.retryAfterMs });
    }
    return step;
  };

  const usageFor = (req: ProviderRequest, text: string) => ({
    inputTokens: Math.ceil(((req.system ?? "") + req.messages.map((m) => m.content).join("")).length / 4),
    outputTokens: Math.ceil(text.length / 4),
  });

  const model = opts.model ?? "mock-1";

  return {
    name: opts.name ?? "mock",
    model,
    pricing: opts.pricing,
    calls,

    async complete(req) {
      const text = await next(req);
      return { text, usage: usageFor(req, text), model, finishReason: "stop" };
    },

    async *stream(req): AsyncGenerator<StreamChunk> {
      const text = await next(req);
      for (const word of text.match(/\S+\s*/g) ?? []) yield { type: "text", text: word };
      yield { type: "done", usage: usageFor(req, text), model, finishReason: "stop" };
    },
  };
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}
