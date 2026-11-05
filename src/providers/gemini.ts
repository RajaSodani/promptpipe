import { ProviderError } from "../errors.js";
import { resolvePricing } from "../pricing.js";
import { readSse } from "../sse.js";
import type { Pricing, Provider, ProviderRequest, StreamChunk, Usage } from "../types.js";
import { postJson } from "./http.js";

export interface GeminiOptions {
  apiKey: string;
  /** e.g. "gemini-2.5-flash". */
  model: string;
  pricing?: Pricing;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
}

/** Google Gemini via the Generative Language REST API. */
export function gemini(opts: GeminiOptions): Provider {
  const base = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  const headers = { "x-goog-api-key": opts.apiKey };

  const body = (req: ProviderRequest) => ({
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    contents: req.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      maxOutputTokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.json ? { responseMimeType: "application/json" } : {}),
    },
  });

  const usageOf = (data: GeminiResponse): Usage => ({
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    // thinking tokens are billed as output
    outputTokens: (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0),
  });

  const textOf = (data: GeminiResponse) =>
    (data.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("");

  const checkBlocked = (data: GeminiResponse) => {
    const reason = data.promptFeedback?.blockReason;
    if (reason) throw new ProviderError("refusal", `Gemini blocked the prompt: ${reason}`);
  };

  return {
    name: "gemini",
    model: opts.model,
    pricing: resolvePricing(opts.model, opts.pricing),

    async complete(req) {
      const url = `${base}/models/${opts.model}:generateContent`;
      const res = await postJson(url, headers, body(req), req.signal, opts.fetch);
      const data = (await res.json()) as GeminiResponse;
      checkBlocked(data);
      return {
        text: textOf(data),
        usage: usageOf(data),
        model: data.modelVersion ?? opts.model,
        finishReason: data.candidates?.[0]?.finishReason,
      };
    },

    async *stream(req): AsyncGenerator<StreamChunk> {
      const url = `${base}/models/${opts.model}:streamGenerateContent?alt=sse`;
      const res = await postJson(url, headers, body(req), req.signal, opts.fetch);
      if (!res.body) throw new ProviderError("server", "Empty response body");
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let model = opts.model;
      let finishReason: string | undefined;
      for await (const data of readSse(res.body)) {
        const chunk = JSON.parse(data) as GeminiResponse;
        checkBlocked(chunk);
        const text = textOf(chunk);
        if (text) yield { type: "text", text };
        if (chunk.usageMetadata) usage = usageOf(chunk);
        if (chunk.modelVersion) model = chunk.modelVersion;
        finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
      }
      yield { type: "done", usage, model, finishReason };
    },
  };
}
