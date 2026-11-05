/**
 * Offline demo: no API keys needed. The primary provider is rate limited and then
 * returns malformed JSON; watch PromptPipe retry, validate, and fall back.
 *
 *   npx tsx examples/fallback-demo.ts
 */
import { z } from "zod";
import { createPipe, mock } from "../src/index.js";

const Hearing = z.object({
  caseNumber: z.string(),
  court: z.string(),
  date: z.iso.date(),
});

const pipe = createPipe({
  providers: [
    mock({
      name: "primary",
      script: [{ fail: "rate_limit", status: 429 }, '{"caseNumber": "WP 1234/2026", "court": "Bombay HC"}'],
      pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
      delayMs: 120,
    }),
    mock({
      name: "backup",
      script: ['{"caseNumber": "WP 1234/2026", "court": "Bombay HC", "date": "2026-11-03"}'],
      pricing: { inputPerMTok: 0.6, outputPerMTok: 0.8 },
      delayMs: 80,
    }),
  ],
  validationRetries: 0,
  onEvent: (e) => console.log(`  · ${JSON.stringify(e)}`),
});

const res = await pipe.run({
  system: "Extract the hearing details as JSON.",
  prompt: "Notice: WP 1234/2026 listed before the Bombay High Court on 3 Nov 2026.",
  schema: Hearing,
});

console.log("\noutput:", res.output);
console.log(`served by ${res.provider} after ${res.attempts.length} attempts, $${res.costUsd?.toFixed(6)}`);
