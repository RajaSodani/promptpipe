import type { Pricing, Usage } from "./types.js";

/**
 * Built-in prices (USD per 1M tokens), Anthropic first-party rates as of October 2026.
 * Prices change: pass `pricing` to a provider to override, or for any model not listed.
 * Models missing from this table report `costUsd: null` rather than a guessed number.
 */
export const DEFAULT_PRICING: Readonly<Record<string, Pricing>> = {
  "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

export function costOf(usage: Usage, pricing: Pricing | undefined): number | null {
  if (!pricing) return null;
  return (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
}

export function resolvePricing(model: string, override?: Pricing): Pricing | undefined {
  return override ?? DEFAULT_PRICING[model];
}
