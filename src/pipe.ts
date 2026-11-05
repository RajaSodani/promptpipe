import { PipeError, ProviderError, toProviderError } from "./errors.js";
import { costOf } from "./pricing.js";
import { parseWithSchema, type InferOutput, type StandardSchemaV1 } from "./schema.js";
import type { Attempt, Message, PipeEvent, Provider, ProviderRequest, RunResult, Usage } from "./types.js";

export interface RetryOptions {
  /** Tries per provider for transient failures (429, 5xx, timeout, network). Default 2. */
  attempts?: number;
  /** First backoff delay; doubles each retry, with jitter. Default 250ms. */
  baseDelayMs?: number;
  /** Upper bound for any single wait, including server Retry-After hints. Default 4000ms. */
  maxDelayMs?: number;
}

export interface PipeOptions {
  /** Tried in order. A provider is abandoned on a terminal error or once its retries run out. */
  providers: Provider[];
  retry?: RetryOptions;
  /** Per-attempt timeout. For streams it bounds the whole stream. Default 30s. */
  timeoutMs?: number;
  /** How many times to re-ask the same provider after its output fails the schema. Default 2. */
  validationRetries?: number;
  onEvent?: (event: PipeEvent) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable for tests. */
  random?: () => number;
}

export interface RunOptions {
  system?: string;
  /** Shorthand for a single user message. */
  prompt?: string;
  messages?: Message[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface Pipe {
  run<S extends StandardSchemaV1>(opts: RunOptions & { schema: S }): Promise<RunResult<InferOutput<S>>>;
  run(opts: RunOptions): Promise<RunResult<string>>;
  /** Streams text. Falls back to the next provider only if a failure happens before the first chunk. */
  stream(opts: RunOptions): PipeStream;
}

export interface PipeStream extends AsyncIterable<string> {
  /** Resolves once the stream has been fully consumed. */
  result: Promise<RunResult<string>>;
}

type Control = { retryWith: Message[] } | { giveUp: true };

const ZERO: Usage = { inputTokens: 0, outputTokens: 0 };

export function createPipe(options: PipeOptions): Pipe {
  if (options.providers.length === 0) throw new Error("createPipe needs at least one provider");

  const maxTries = Math.max(1, options.retry?.attempts ?? 2);
  const baseDelay = options.retry?.baseDelayMs ?? 250;
  const maxDelay = options.retry?.maxDelayMs ?? 4000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const validationRetries = options.validationRetries ?? 2;
  const emit = options.onEvent ?? (() => {});
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  const backoff = (retry: number, hint?: number) => {
    const exp = Math.min(maxDelay, baseDelay * 2 ** (retry - 1));
    const jittered = exp / 2 + (random() * exp) / 2;
    return Math.min(maxDelay, Math.max(jittered, hint ?? 0));
  };

  const toMessages = (opts: RunOptions): Message[] => {
    const messages = [...(opts.messages ?? [])];
    if (opts.prompt !== undefined) messages.push({ role: "user", content: opts.prompt });
    if (messages.length === 0) throw new Error("run() needs `prompt` or `messages`");
    return messages;
  };

  const requestFor = (opts: RunOptions, messages: Message[], json: boolean): ProviderRequest => ({
    system: opts.system,
    messages,
    maxTokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature,
    json,
    signal: opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });

  const failedAttempt = (p: Provider, t0: number, err: ProviderError, usage: Usage = ZERO): Attempt => ({
    provider: p.name,
    model: p.model,
    ok: false,
    latencyMs: Date.now() - t0,
    usage,
    costUsd: usage === ZERO ? 0 : costOf(usage, p.pricing),
    error: { kind: err.kind, message: err.message, status: err.status },
  });

  const finish = <T>(output: T, text: string, provider: Provider, model: string, attempts: Attempt[], start: number): RunResult<T> => {
    const usage = attempts.reduce(
      (acc, a) => ({ inputTokens: acc.inputTokens + a.usage.inputTokens, outputTokens: acc.outputTokens + a.usage.outputTokens }),
      ZERO,
    );
    const costs = attempts.map((a) => a.costUsd);
    const costUsd = costs.some((c) => c === null) ? null : costs.reduce<number>((s, c) => s + (c ?? 0), 0);
    emit({ type: "success", provider: provider.name, model, costUsd });
    return { output, text, provider: provider.name, model, attempts, usage, costUsd, latencyMs: Date.now() - start };
  };

  /**
   * Runs `once` against each provider in turn. `once` returns a result to stop,
   * or `{ retryWith }` to re-ask the same provider with a new conversation.
   */
  async function drive<R>(
    opts: RunOptions,
    attempts: Attempt[],
    once: (p: Provider, messages: Message[], attemptNo: number) => Promise<R | Control>,
  ): Promise<R> {
    const base = toMessages(opts);
    let attemptNo = 0;
    for (const [i, provider] of options.providers.entries()) {
      const prev = options.providers[i - 1];
      if (prev) emit({ type: "fallback", from: prev.name, to: provider.name });
      let messages = base;
      let transient = 0;
      while (true) {
        attemptNo++;
        emit({ type: "attempt_start", provider: provider.name, model: provider.model, attempt: attemptNo });
        const t0 = Date.now();
        let outcome: R | Control;
        try {
          outcome = await once(provider, messages, attemptNo);
        } catch (raw) {
          if (opts.signal?.aborted) throw opts.signal.reason;
          if (raw instanceof PipeError) throw raw;
          const err = toProviderError(raw);
          attempts.push(failedAttempt(provider, t0, err));
          const willRetry = err.retryable && transient + 1 < maxTries;
          emit({ type: "attempt_error", provider: provider.name, model: provider.model, attempt: attemptNo, kind: err.kind, message: err.message, willRetry });
          if (!willRetry) break;
          transient++;
          await sleep(backoff(transient, err.retryAfterMs), opts.signal);
          continue;
        }
        if (outcome && typeof outcome === "object" && "retryWith" in outcome) {
          messages = outcome.retryWith;
          continue;
        }
        if (outcome && typeof outcome === "object" && "giveUp" in outcome) break;
        return outcome as R;
      }
    }
    const last = attempts.at(-1)?.error;
    throw new PipeError(
      `All ${options.providers.length} provider(s) failed after ${attempts.length} attempt(s)` + (last ? `; last error: ${last.kind}: ${last.message}` : ""),
      attempts,
    );
  }

  async function run(opts: RunOptions & { schema?: StandardSchemaV1 }): Promise<RunResult<unknown>> {
    const start = Date.now();
    const attempts: Attempt[] = [];
    const schema = opts.schema;
    const validationFails = new Map<Provider, number>();

    return drive<RunResult<unknown>>(opts, attempts, async (provider, messages) => {
      const t0 = Date.now();
      const res = await provider.complete(requestFor(opts, messages, schema !== undefined));
      const costUsd = costOf(res.usage, provider.pricing);

      if (!schema) {
        attempts.push({ provider: provider.name, model: res.model, ok: true, latencyMs: Date.now() - t0, usage: res.usage, costUsd });
        return finish(res.text, res.text, provider, res.model, attempts, start);
      }

      const parsed = await parseWithSchema(schema, res.text);
      if (parsed.ok) {
        attempts.push({ provider: provider.name, model: res.model, ok: true, latencyMs: Date.now() - t0, usage: res.usage, costUsd });
        return finish(parsed.value, res.text, provider, res.model, attempts, start);
      }

      attempts.push({
        provider: provider.name,
        model: res.model,
        ok: false,
        latencyMs: Date.now() - t0,
        usage: res.usage,
        costUsd,
        error: { kind: "validation", message: parsed.issues.join("; ") },
      });
      emit({ type: "validation_failed", provider: provider.name, model: res.model, issues: parsed.issues });

      const fails = (validationFails.get(provider) ?? 0) + 1;
      validationFails.set(provider, fails);
      if (fails > validationRetries) return { giveUp: true as const };
      return {
        retryWith: [
          ...messages,
          { role: "assistant" as const, content: res.text },
          {
            role: "user" as const,
            content:
              "Your previous reply did not match the required JSON schema:\n" +
              parsed.issues.map((i) => `- ${i}`).join("\n") +
              "\nReply again with only the corrected JSON.",
          },
        ],
      };
    });
  }

  function stream(opts: RunOptions): PipeStream {
    const start = Date.now();
    const attempts: Attempt[] = [];
    let resolveResult!: (r: RunResult<string>) => void;
    let rejectResult!: (e: unknown) => void;
    const result = new Promise<RunResult<string>>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    // the iterator surfaces the same error, so don't also report it as unhandled
    result.catch(() => {});

    async function* iterate(): AsyncGenerator<string> {
      // Chunks are handed out through this queue so that drive() can own retries
      // while the caller still receives text as it arrives.
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      let failure: unknown;
      let started = false;

      const work = drive<RunResult<string>>(opts, attempts, async (provider, messages) => {
        const t0 = Date.now();
        const req = requestFor(opts, messages, false);
        let text = "";
        try {
          const source = provider.stream
            ? provider.stream(req)
            : (async function* () {
                const r = await provider.complete(req);
                yield { type: "text" as const, text: r.text };
                yield { type: "done" as const, usage: r.usage, model: r.model, finishReason: r.finishReason };
              })();
          for await (const chunk of source) {
            if (chunk.type === "text") {
              started = true;
              text += chunk.text;
              queue.push(chunk.text);
              wake?.();
            } else {
              const costUsd = costOf(chunk.usage, provider.pricing);
              attempts.push({ provider: provider.name, model: chunk.model, ok: true, latencyMs: Date.now() - t0, usage: chunk.usage, costUsd });
              return finish(text, text, provider, chunk.model, attempts, start);
            }
          }
          throw new ProviderError("server", "Stream ended without completion");
        } catch (err) {
          if (!started) throw err;
          // Output already reached the caller: switching providers would splice two answers together.
          const perr = toProviderError(err);
          attempts.push(failedAttempt(provider, t0, perr));
          throw new PipeError(`Stream from ${provider.name} failed after output started: ${perr.message}`, attempts);
        }
      });

      work.then(
        (r) => {
          done = true;
          resolveResult(r);
          wake?.();
        },
        (e) => {
          done = true;
          failure = e;
          rejectResult(e);
          wake?.();
        },
      );

      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
      if (failure !== undefined) throw failure;
    }

    return { result, [Symbol.asyncIterator]: iterate };
  }

  return { run: run as Pipe["run"], stream };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}
