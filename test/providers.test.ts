import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createPipe, extractJson, gemini, groq, ProviderError } from "../src/index.js";
import { anthropic } from "../src/providers/anthropic.js";
import { readSse } from "../src/sse.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const sse = (events: string[], chunkSize = 7) => {
  const bytes = new TextEncoder().encode(events.map((e) => `data: ${e}\n\n`).join(""));
  // deliberately split mid-event to exercise the parser's buffering
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const req = (overrides = {}) => ({
  system: "be brief",
  messages: [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: "hello" },
    { role: "user" as const, content: "again" },
  ],
  maxTokens: 50,
  json: false,
  signal: new AbortController().signal,
  ...overrides,
});

describe("gemini", () => {
  it("maps roles, system and JSON mode, and reads usage including thinking tokens", async () => {
    const { fn, calls } = fakeFetch(() =>
      json({
        candidates: [{ content: { parts: [{ text: "plan", thought: true }, { text: "answer" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6 },
        modelVersion: "gemini-x-001",
      }),
    );
    const p = gemini({ apiKey: "k", model: "gemini-x", fetch: fn });
    const res = await p.complete(req({ json: true }));

    expect(res).toMatchObject({ text: "answer", model: "gemini-x-001", usage: { inputTokens: 10, outputTokens: 10 } });
    expect(calls[0]?.url).toMatch(/models\/gemini-x:generateContent$/);
    expect((calls[0]?.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.systemInstruction.parts[0].text).toBe("be brief");
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 50, responseMimeType: "application/json" });
  });

  it("classifies 429 with Retry-After", async () => {
    const { fn } = fakeFetch(() => json({ error: "slow down" }, 429, { "retry-after": "2" }));
    const err = await gemini({ apiKey: "k", model: "m", fetch: fn }).complete(req()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "rate_limit", status: 429, retryAfterMs: 2000, retryable: true });
  });

  it("treats a blocked prompt as a refusal", async () => {
    const { fn } = fakeFetch(() => json({ promptFeedback: { blockReason: "SAFETY" } }));
    await expect(gemini({ apiKey: "k", model: "m", fetch: fn }).complete(req())).rejects.toMatchObject({ kind: "refusal" });
  });

  it("streams SSE chunks and reports final usage", async () => {
    const { fn, calls } = fakeFetch(() =>
      sse([
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hel" }] } }] }),
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }),
      ]),
    );
    const out = [];
    for await (const c of gemini({ apiKey: "k", model: "m", fetch: fn }).stream!(req())) out.push(c);
    expect(calls[0]?.url).toMatch(/:streamGenerateContent\?alt=sse$/);
    expect(out).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "done", usage: { inputTokens: 3, outputTokens: 2 }, model: "m", finishReason: "STOP" },
    ]);
  });
});

describe("openai-compatible (groq)", () => {
  it("sends system as the first message and bearer auth", async () => {
    const { fn, calls } = fakeFetch(() =>
      json({ model: "llama", choices: [{ message: { content: "yo" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
    );
    const res = await groq({ apiKey: "g", model: "llama", fetch: fn }).complete(req({ json: true }));
    expect(res).toMatchObject({ text: "yo", usage: { inputTokens: 5, outputTokens: 1 } });
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer g");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("streams deltas and reads Groq's x_groq usage", async () => {
    const { fn } = fakeFetch(() =>
      sse([
        JSON.stringify({ model: "llama", choices: [{ delta: { content: "a" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "b" }, finish_reason: "stop" }], x_groq: { usage: { prompt_tokens: 4, completion_tokens: 2 } } }),
        "[DONE]",
      ]),
    );
    const out = [];
    for await (const c of groq({ apiKey: "g", model: "llama", fetch: fn }).stream!(req())) out.push(c);
    expect(out.at(-1)).toEqual({ type: "done", usage: { inputTokens: 4, outputTokens: 2 }, model: "llama", finishReason: "stop" });
    expect(out.slice(0, 2).map((c) => (c.type === "text" ? c.text : ""))).toEqual(["a", "b"]);
  });

  it("is a terminal error on 401", async () => {
    const { fn } = fakeFetch(() => json({}, 401));
    const err = await groq({ apiKey: "bad", model: "m", fetch: fn }).complete(req()).catch((e) => e);
    expect(err).toMatchObject({ kind: "auth", retryable: false });
  });
});

describe("anthropic", () => {
  const client = (respond: (call: Call) => Response) =>
    new Anthropic({ apiKey: "a", maxRetries: 0, fetch: fakeFetch(respond).fn });

  it("reads text and usage, and applies the built-in price", async () => {
    const p = anthropic({
      model: "claude-haiku-5-5",
      client: client(() =>
        json({
          id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5",
          content: [{ type: "text", text: "Namaste" }],
          stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 200 },
        }),
      ),
    });
    const res = await createPipe({ providers: [p] }).run({ prompt: "hi" });
    expect(res.output).toBe("Namaste");
    expect(res.costUsd).toBeCloseTo((1000 * 0.1 + 200 * 0.5) / 1e6);
  });

  it("maps SDK errors to retryable ProviderErrors", async () => {
    const p = anthropic({
      model: "claude-haiku-5-5",
      client: client(() => json({ type: "error", error: { type: "overloaded_error", message: "busy" } }, 529)),
    });
    await expect(p.complete(req())).rejects.toMatchObject({ kind: "server", status: 529, retryable: true });
  });

  it("treats stop_reason refusal as a refusal", async () => {
    const p = anthropic({
      model: "claude-haiku-5-5",
      client: client(() =>
        json({
          id: "msg_2", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [],
          stop_reason: "refusal", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
        }),
      ),
    });
    await expect(p.complete(req())).rejects.toMatchObject({ kind: "refusal" });
  });
});

describe("helpers", () => {
  it("extractJson handles fences, prose and bare JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Here you go: {"a":3} hope that helps')).toEqual({ a: 3 });
    expect(() => extractJson("no json here")).toThrow();
  });

  it("readSse joins multi-line data and ignores comments", async () => {
    const body = new Response(": ping\n\ndata: line1\ndata: line2\n\nevent: x\ndata: {}\n\n").body!;
    const out = [];
    for await (const d of readSse(body)) out.push(d);
    expect(out).toEqual(["line1\nline2", "{}"]);
  });
});
