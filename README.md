# PromptPipe

**LLM calls that fail gracefully.** A small TypeScript library for production LLM workflows:

- **Provider fallbacks:** Gemini, then Groq, then Claude (any order, any OpenAI compatible endpoint)
- **Schema validated output:** works with Zod, Valibot, ArkType or any [Standard Schema](https://standardschema.dev); invalid output is sent back to the model with the exact issues
- **Retries with backoff:** exponential with jitter, honours `Retry-After`, never retries a 401
- **Per call cost tracking:** every attempt is recorded, failed ones included, because they cost tokens too
- **Streaming** with safe fallback: switches provider only before the first token, never mid answer

Zero runtime dependencies in the core. The Claude adapter uses the official `@anthropic-ai/sdk` as an optional peer.

```ts
import { createPipe, gemini, groq } from "promptpipe";
import { z } from "zod";

const pipe = createPipe({
  providers: [
    gemini({ apiKey: process.env.GEMINI_API_KEY!, model: "gemini-2.5-flash" }),
    groq({ apiKey: process.env.GROQ_API_KEY!, model: "llama-3.3-70b-versatile" }),
  ],
});

const res = await pipe.run({
  system: "Extract the hearing details.",
  prompt: noticeText,
  schema: z.object({ caseNumber: z.string(), court: z.string(), date: z.iso.date() }),
});

res.output.date;   // typed from the schema
res.provider;      // "gemini", or "groq" if Gemini was down
res.attempts;      // every try: provider, latency, tokens, cost, error kind
res.costUsd;       // summed across attempts
```

## Why

Every LLM feature I've shipped hit the same failures in production: a provider returns 429s at peak, a model wraps JSON in prose, a field comes back as `"42"` instead of `42`. Hand rolled `try/catch` around each call doesn't scale, and the full frameworks are a lot to adopt for "call a model, get valid data, don't fall over". PromptPipe is the part I kept rewriting.

## How a call flows

```
for each provider, in order:
  ├─ call it (with a per-attempt timeout)
  ├─ transient error (429 / 5xx / timeout / network)?  → back off, retry same provider
  ├─ terminal error (401 / 400 / refusal)?             → next provider immediately
  ├─ output fails the schema?                          → re-ask with the issues listed
  │                                                       (up to validationRetries), then next provider
  └─ success → return output + full attempt log
all providers exhausted → throw PipeError (with .attempts)
```

The caller's own `AbortSignal` always wins: an abort stops the run without trying another provider.

## Try it without API keys

```bash
npm install
npm run demo
```

The demo scripts a rate limited primary that then returns JSON missing a field, and shows the retry, the validation failure, and the fallback:

```
  · {"type":"attempt_error","provider":"primary","kind":"rate_limit","willRetry":true}
  · {"type":"validation_failed","provider":"primary","issues":["date: Invalid input: expected string, received undefined"]}
  · {"type":"fallback","from":"primary","to":"backup"}
  · {"type":"success","provider":"backup","costUsd":0.000072}
```

## Providers

| Import | Provider | Notes |
|---|---|---|
| `gemini()` | Google Gemini | REST via `fetch`; thinking tokens counted as output |
| `groq()` | Groq | OpenAI compatible preset |
| `openai()` | OpenAI | OpenAI compatible preset |
| `openaiCompatible({ baseUrl })` | Together, OpenRouter, Ollama, ... | Anything that speaks Chat Completions |
| `anthropic()` from `promptpipe/anthropic` | Claude | Official SDK, with SDK level retries disabled so PromptPipe owns them |
| `mock({ script })` | Scripted | For tests and demos |

Writing your own is one object with `complete()` and optionally `stream()`. Throw `ProviderError` with a `kind` so the pipe knows whether to retry.

## Streaming

```ts
const stream = pipe.stream({ prompt: "Explain dead letter queues", maxTokens: 300 });
for await (const text of stream) res.write(text);
const { provider, usage, costUsd } = await stream.result;
```

If a provider fails before sending anything, the pipe falls back. If it fails after text has reached you, it throws instead: splicing two models' answers together would be worse than an error.

## Options

```ts
createPipe({
  providers,                 // tried in order
  retry: {
    attempts: 2,             // tries per provider for transient errors
    baseDelayMs: 250,        // doubles each retry, with jitter
    maxDelayMs: 4000,        // cap, including Retry-After hints
  },
  timeoutMs: 30_000,         // per attempt (whole stream for stream())
  validationRetries: 2,      // re-asks per provider when output fails the schema
  onEvent: (e) => log(e),    // attempt_start | attempt_error | validation_failed | fallback | success
});
```

## Cost tracking

Built-in prices cover current Claude models. For anything else, pass `pricing` to the provider:

```ts
gemini({ apiKey, model: "gemini-2.5-flash", pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 } });
```

A model with no known price reports `costUsd: null` instead of a guessed number. Prices change, so check your provider's pricing page.

## Development

```bash
npm install
npm test          # vitest, no network: providers are tested against recorded response shapes
npm run typecheck
npm run build
```

## License

MIT
