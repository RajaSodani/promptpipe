/**
 * Real providers, tried in order. Set whichever keys you have:
 *
 *   GEMINI_API_KEY=... GROQ_API_KEY=... ANTHROPIC_API_KEY=... npx tsx examples/real-providers.ts
 */
import { createPipe, gemini, groq, type Provider } from "../src/index.js";
import { anthropic } from "../src/providers/anthropic.js";

const providers: Provider[] = [];
if (process.env.GEMINI_API_KEY) providers.push(gemini({ apiKey: process.env.GEMINI_API_KEY, model: "gemini-2.5-flash" }));
if (process.env.GROQ_API_KEY) providers.push(groq({ apiKey: process.env.GROQ_API_KEY, model: "llama-3.3-70b-versatile" }));
if (process.env.ANTHROPIC_API_KEY) providers.push(anthropic({ model: "claude-haiku-5-5" }));
if (providers.length === 0) throw new Error("Set at least one of GEMINI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY");

const pipe = createPipe({ providers });
const stream = pipe.stream({ prompt: "In two sentences, why do dead letter queues matter?", maxTokens: 200 });
for await (const text of stream) process.stdout.write(text);
const res = await stream.result;
console.log(`\n\n${res.provider}/${res.model} · ${res.usage.inputTokens}+${res.usage.outputTokens} tokens · ${res.latencyMs}ms`);
