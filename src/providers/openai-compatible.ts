import { ProviderError } from "../errors.js";
import { resolvePricing } from "../pricing.js";
import { readSse } from "../sse.js";
import type { Pricing, Provider, ProviderRequest, StreamChunk, Usage } from "../types.js";
import { postJson } from "./http.js";

export interface OpenAICompatibleOptions {
  apiKey: string;
  model: string;
  /** Base URL up to and including the version segment, e.g. "https://api.groq.com/openai/v1". */
  baseUrl: string;
  /** Label used in attempts and events. Defaults to "openai-compatible". */
  name?: string;
  pricing?: Pricing;
  fetch?: typeof fetch;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface ChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
  usage?: ChatUsage;
}

interface ChatChunk {
  model?: string;
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: ChatUsage | null;
  /** Groq reports streaming usage here instead of `usage`. */
  x_groq?: { usage?: ChatUsage };
}

const toUsage = (u: ChatUsage | null | undefined): Usage => ({
  inputTokens: u?.prompt_tokens ?? 0,
  outputTokens: u?.completion_tokens ?? 0,
});

/** Any OpenAI Chat Completions compatible endpoint (OpenAI, Groq, Together, OpenRouter, Ollama...). */
export function openaiCompatible(opts: OpenAICompatibleOptions): Provider {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers = { authorization: `Bearer ${opts.apiKey}` };

  const body = (req: ProviderRequest, stream: boolean) => ({
    model: opts.model,
    messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
    max_tokens: req.maxTokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.json ? { response_format: { type: "json_object" } } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  });

  return {
    name: opts.name ?? "openai-compatible",
    model: opts.model,
    pricing: resolvePricing(opts.model, opts.pricing),

    async complete(req) {
      const res = await postJson(url, headers, body(req, false), req.signal, opts.fetch);
      const data = (await res.json()) as ChatResponse;
      const choice = data.choices?.[0];
      if (choice?.message?.refusal) throw new ProviderError("refusal", choice.message.refusal);
      return {
        text: choice?.message?.content ?? "",
        usage: toUsage(data.usage),
        model: data.model ?? opts.model,
        finishReason: choice?.finish_reason,
      };
    },

    async *stream(req): AsyncGenerator<StreamChunk> {
      const res = await postJson(url, headers, body(req, true), req.signal, opts.fetch);
      if (!res.body) throw new ProviderError("server", "Empty response body");
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let model = opts.model;
      let finishReason: string | undefined;
      for await (const data of readSse(res.body)) {
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as ChatChunk;
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) yield { type: "text", text };
        const u = chunk.usage ?? chunk.x_groq?.usage;
        if (u) usage = toUsage(u);
        if (chunk.model) model = chunk.model;
        finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
      }
      yield { type: "done", usage, model, finishReason };
    },
  };
}

/** Groq preset. */
export function groq(opts: Omit<OpenAICompatibleOptions, "baseUrl" | "name"> & { baseUrl?: string }): Provider {
  return openaiCompatible({ name: "groq", baseUrl: "https://api.groq.com/openai/v1", ...opts });
}

/** OpenAI preset. */
export function openai(opts: Omit<OpenAICompatibleOptions, "baseUrl" | "name"> & { baseUrl?: string }): Provider {
  return openaiCompatible({ name: "openai", baseUrl: "https://api.openai.com/v1", ...opts });
}
