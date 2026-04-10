/**
 * OpenRouter auth + fetch quirks for @ai-sdk/openai.
 */

export function normalizeOpenRouterApiKey(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  let k = raw.trim();
  if (!k) return undefined;
  const lower = k.toLowerCase();
  if (lower.startsWith("bearer ")) k = k.slice(7).trim();
  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1).trim();
  }
  return k || undefined;
}

/** Prefer OPENROUTER_API_KEY; allow OPENAI_API_KEY when it is clearly an OpenRouter key. */
export function resolveOpenRouterApiKey(): string | undefined {
  const primary = normalizeOpenRouterApiKey(process.env.OPENROUTER_API_KEY);
  if (primary) return primary;
  const fallback = normalizeOpenRouterApiKey(process.env.OPENAI_API_KEY);
  if (fallback?.startsWith("sk-or-")) return fallback;
  return undefined;
}

/** Primary model from env, then fallbacks (comma-separated AI_MODEL_FALLBACKS), then built-ins. */
export function resolveOpenRouterModelCandidates(): string[] {
  const primary = process.env.AI_MODEL?.trim();
  const extra = process.env.AI_MODEL_FALLBACKS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const defaults = [
    "qwen/qwen2.5-coder-32b-instruct:free",
    "deepseek/deepseek-chat:free",
    "meta-llama/llama-3.3-70b-instruct:free",
  ];
  const out: string[] = [];
  if (primary) out.push(primary);
  for (const m of [...(extra ?? []), ...defaults]) {
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}
