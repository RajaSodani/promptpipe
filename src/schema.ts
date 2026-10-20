/**
 * Minimal copy of the Standard Schema v1 interface (https://standardschema.dev).
 * Zod 3.24+, Valibot, ArkType and others implement it, so PromptPipe works with
 * any of them without depending on one.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined }> };

export type InferOutput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"];

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** Pulls a JSON value out of model text, tolerating ```json fences and leading prose. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start === -1 || end <= start) throw new SyntaxError("No JSON found in model output");
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

export async function parseWithSchema<S extends StandardSchemaV1>(
  schema: S,
  text: string,
): Promise<ParseResult<InferOutput<S>>> {
  let value: unknown;
  try {
    value = extractJson(text);
  } catch (err) {
    return { ok: false, issues: [`Output is not valid JSON: ${(err as Error).message}`] };
  }
  const result = await schema["~standard"].validate(value);
  if (!result.issues) return { ok: true, value: result.value as InferOutput<S> };
  return {
    ok: false,
    issues: result.issues.map((issue) => {
      const path = issue.path
        ?.map((p) => (typeof p === "object" ? String(p.key) : String(p)))
        .join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
  };
}
