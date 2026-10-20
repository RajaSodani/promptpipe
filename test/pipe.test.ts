import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPipe, mock, PipeError, type PipeEvent } from "../src/index.js";

const noSleep = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
};

describe("run", () => {
  it("returns the first provider's text with usage and cost", async () => {
    const pipe = createPipe({
      providers: [mock({ script: ["hello there"], pricing: { inputPerMTok: 1, outputPerMTok: 2 } })],
    });
    const res = await pipe.run({ prompt: "hi" });
    expect(res.output).toBe("hello there");
    expect(res.provider).toBe("mock");
    expect(res.attempts).toHaveLength(1);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.costUsd).toBeCloseTo((res.usage.inputTokens * 1 + res.usage.outputTokens * 2) / 1e6);
  });

  it("reports null cost when a model has no known price", async () => {
    const pipe = createPipe({ providers: [mock({ script: ["ok"] })] });
    expect((await pipe.run({ prompt: "hi" })).costUsd).toBeNull();
  });

  it("retries a transient failure on the same provider with backoff", async () => {
    const { waits, sleep } = noSleep();
    const p = mock({ script: [{ fail: "server", status: 503 }, "recovered"] });
    const pipe = createPipe({ providers: [p], sleep, random: () => 1, retry: { attempts: 3, baseDelayMs: 100 } });
    const res = await pipe.run({ prompt: "hi" });
    expect(res.output).toBe("recovered");
    expect(p.calls).toHaveLength(2);
    expect(waits).toEqual([100]);
    expect(res.attempts.map((a) => a.ok)).toEqual([false, true]);
  });

  it("doubles the backoff and respects Retry-After within the cap", async () => {
    const { waits, sleep } = noSleep();
    const p = mock({
      script: [{ fail: "server" }, { fail: "rate_limit", retryAfterMs: 60_000 }, "ok"],
    });
    const pipe = createPipe({ providers: [p], sleep, random: () => 1, retry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 } });
    await pipe.run({ prompt: "hi" });
    expect(waits).toEqual([100, 1000]);
  });

  it("skips straight to the next provider on a terminal error", async () => {
    const events: PipeEvent[] = [];
    const bad = mock({ name: "a", script: [{ fail: "auth", status: 401 }] });
    const good = mock({ name: "b", script: ["from b"] });
    const pipe = createPipe({ providers: [bad, good], sleep: noSleep().sleep, onEvent: (e) => events.push(e) });
    const res = await pipe.run({ prompt: "hi" });
    expect(res.provider).toBe("b");
    expect(bad.calls).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(["attempt_start", "attempt_error", "fallback", "attempt_start", "success"]);
  });

  it("falls back once retries are exhausted", async () => {
    const a = mock({ name: "a", script: [{ fail: "rate_limit", status: 429 }] });
    const b = mock({ name: "b", script: ["from b"] });
    const pipe = createPipe({ providers: [a, b], sleep: noSleep().sleep, retry: { attempts: 2 } });
    const res = await pipe.run({ prompt: "hi" });
    expect(a.calls).toHaveLength(2);
    expect(res.provider).toBe("b");
    expect(res.attempts.map((x) => x.error?.kind ?? "ok")).toEqual(["rate_limit", "rate_limit", "ok"]);
  });

  it("throws PipeError with every attempt when all providers fail", async () => {
    const pipe = createPipe({
      providers: [mock({ name: "a", script: [{ fail: "auth" }] }), mock({ name: "b", script: [{ fail: "bad_request" }] })],
      sleep: noSleep().sleep,
    });
    const err = await pipe.run({ prompt: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(PipeError);
    expect((err as PipeError).attempts.map((a) => a.provider)).toEqual(["a", "b"]);
    expect((err as PipeError).message).toMatch(/bad_request/);
  });

  it("classifies a timeout as retryable", async () => {
    const slow = mock({ name: "slow", script: ["late"], delayMs: 200 });
    const fast = mock({ name: "fast", script: ["quick"] });
    const pipe = createPipe({ providers: [slow, fast], timeoutMs: 20, retry: { attempts: 1 } });
    const res = await pipe.run({ prompt: "hi" });
    expect(res.provider).toBe("fast");
    expect(res.attempts[0]?.error?.kind).toBe("timeout");
  });

  it("stops immediately when the caller aborts, without falling back", async () => {
    const controller = new AbortController();
    const a = mock({ name: "a", script: ["x"], delayMs: 200 });
    const b = mock({ name: "b", script: ["y"] });
    const pipe = createPipe({ providers: [a, b] });
    setTimeout(() => controller.abort(new Error("user cancelled")), 10);
    await expect(pipe.run({ prompt: "hi", signal: controller.signal })).rejects.toThrow("user cancelled");
    expect(b.calls).toHaveLength(0);
  });
});

describe("schema validation", () => {
  const Invoice = z.object({ total: z.number(), currency: z.string().length(3) });

  it("parses fenced JSON into a typed value", async () => {
    const pipe = createPipe({ providers: [mock({ script: ['Sure:\n```json\n{"total": 42, "currency": "INR"}\n```'] })] });
    const res = await pipe.run({ prompt: "extract", schema: Invoice });
    expect(res.output).toEqual({ total: 42, currency: "INR" });
    expect(res.output.total + 1).toBe(43);
  });

  it("tells the provider it is generating JSON", async () => {
    const p = mock({ script: ['{"total":1,"currency":"USD"}'] });
    await createPipe({ providers: [p] }).run({ prompt: "x", schema: Invoice });
    expect(p.calls[0]?.json).toBe(true);
  });

  it("re-asks with the validation issues and sums cost across attempts", async () => {
    const p = mock({
      script: ['{"total": "42", "currency": "rupees"}', '{"total": 42, "currency": "INR"}'],
      pricing: { inputPerMTok: 1, outputPerMTok: 1 },
    });
    const res = await createPipe({ providers: [p] }).run({ prompt: "extract", schema: Invoice });
    expect(res.output).toEqual({ total: 42, currency: "INR" });
    expect(res.attempts.map((a) => a.error?.kind ?? "ok")).toEqual(["validation", "ok"]);

    const retry = p.calls[1]!.messages;
    expect(retry).toHaveLength(3);
    expect(retry[1]).toEqual({ role: "assistant", content: '{"total": "42", "currency": "rupees"}' });
    expect(retry[2]?.content).toMatch(/total:/);
    expect(retry[2]?.content).toMatch(/currency:/);

    const tokens = res.attempts.reduce((s, a) => s + a.usage.inputTokens + a.usage.outputTokens, 0);
    expect(res.costUsd).toBeCloseTo(tokens / 1e6);
  });

  it("moves to the next provider once validation retries run out", async () => {
    const a = mock({ name: "a", script: ["not json at all"] });
    const b = mock({ name: "b", script: ['{"total": 1, "currency": "EUR"}'] });
    const res = await createPipe({ providers: [a, b], validationRetries: 1 }).run({ prompt: "x", schema: Invoice });
    expect(a.calls).toHaveLength(2);
    expect(res.provider).toBe("b");
    // the fallback provider starts from the original conversation, not a's corrections
    expect(b.calls[0]?.messages).toHaveLength(1);
  });
});

describe("stream", () => {
  it("yields text as it arrives and resolves the result", async () => {
    const pipe = createPipe({ providers: [mock({ script: ["one two three"] })] });
    const s = pipe.stream({ prompt: "count" });
    const chunks: string[] = [];
    for await (const c of s) chunks.push(c);
    expect(chunks).toEqual(["one ", "two ", "three"]);
    const res = await s.result;
    expect(res.text).toBe("one two three");
  });

  it("falls back when a provider fails before the first chunk", async () => {
    const pipe = createPipe({
      providers: [mock({ name: "a", script: [{ fail: "auth" }] }), mock({ name: "b", script: ["from b"] })],
    });
    const s = pipe.stream({ prompt: "x" });
    let text = "";
    for await (const c of s) text += c;
    expect(text).toBe("from b");
    expect((await s.result).provider).toBe("b");
  });

  it("does not splice providers once output has started", async () => {
    const broken = {
      name: "broken",
      model: "m",
      complete: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 }, model: "m" }),
      async *stream() {
        yield { type: "text" as const, text: "partial " };
        throw new Error("connection reset");
      },
    };
    const backup = mock({ name: "backup", script: ["never"] });
    const s = createPipe({ providers: [broken, backup] }).stream({ prompt: "x" });
    const chunks: string[] = [];
    await expect(async () => {
      for await (const c of s) chunks.push(c);
    }).rejects.toThrow(PipeError);
    expect(chunks).toEqual(["partial "]);
    expect(backup.calls).toHaveLength(0);
    await expect(s.result).rejects.toThrow(/after output started/);
  });

  it("uses complete() for providers without streaming support", async () => {
    const p = { ...mock({ script: ["whole answer"] }), stream: undefined };
    const s = createPipe({ providers: [p] }).stream({ prompt: "x" });
    const chunks: string[] = [];
    for await (const c of s) chunks.push(c);
    expect(chunks).toEqual(["whole answer"]);
  });
});
