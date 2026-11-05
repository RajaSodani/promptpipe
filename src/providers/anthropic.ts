import Anthropic from "@anthropic-ai/sdk";
import { kindFromStatus, ProviderError } from "../errors.js";
import { resolvePricing } from "../pricing.js";
import type { Pricing, Provider, ProviderRequest, StreamChunk } from "../types.js";

export interface AnthropicOptions {
  /** e.g. "claude-opus-5-5" or "claude-haiku-5-5". */
  model: string;
  /** Omit to let the SDK resolve credentials from the environment. */
  apiKey?: string;
  /** Bring your own configured client instead of `apiKey`. */
  client?: Anthropic;
  pricing?: Pricing;
}

const JSON_INSTRUCTION = "Respond with a single JSON object and nothing else.";

/**
 * Claude via the official Anthropic SDK. Lives in the `promptpipe/anthropic`
 * entry point so the core package stays dependency free.
 *
 * Temperature is only sent when you pass it: current Claude models reject
 * sampling parameters, so leave it unset for them.
 */
export function anthropic(opts: AnthropicOptions): Provider {
  // PromptPipe owns retries and fallbacks, so the SDK must not retry on its own.
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 });

  const params = (req: ProviderRequest) => ({
    model: opts.model,
    max_tokens: req.maxTokens,
    ...(req.system || req.json
      ? { system: [req.system, req.json ? JSON_INSTRUCTION : ""].filter(Boolean).join("\n\n") }
      : {}),
    messages: req.messages,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  });

  const checkRefusal = (stopReason: string | null | undefined) => {
    if (stopReason === "refusal") throw new ProviderError("refusal", "Claude declined the request");
  };

  return {
    name: "anthropic",
    model: opts.model,
    pricing: resolvePricing(opts.model, opts.pricing),

    async complete(req) {
      try {
        const msg = await client.messages.create(params(req), { signal: req.signal });
        checkRefusal(msg.stop_reason);
        const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        return {
          text,
          usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
          model: msg.model,
          finishReason: msg.stop_reason ?? undefined,
        };
      } catch (err) {
        throw mapError(err);
      }
    },

    async *stream(req): AsyncGenerator<StreamChunk> {
      try {
        const stream = client.messages.stream(params(req), { signal: req.signal });
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield { type: "text", text: event.delta.text };
          }
        }
        const msg = await stream.finalMessage();
        checkRefusal(msg.stop_reason);
        yield {
          type: "done",
          usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
          model: msg.model,
          finishReason: msg.stop_reason ?? undefined,
        };
      } catch (err) {
        throw mapError(err);
      }
    },
  };
}

function mapError(err: unknown): unknown {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError("timeout", err.message, { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError("network", err.message, { cause: err });
  }
  if (err instanceof Anthropic.APIError && typeof err.status === "number") {
    const retryAfter = Number(err.headers?.get?.("retry-after"));
    return new ProviderError(kindFromStatus(err.status), err.message, {
      status: err.status,
      retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      cause: err,
    });
  }
  // aborts and anything unexpected are classified by the pipe
  return err;
}
