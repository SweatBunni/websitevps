/**
 * Ollama OpenAI-compatible API: https://github.com/ollama/ollama/blob/main/docs/openai.md
 * Base URL should be .../v1 (e.g. http://127.0.0.1:11434/v1).
 */

export function normalizeOllamaBaseUrl(raw?: string): string {
  let base = (raw ?? "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
  if (!base.includes("://")) base = `http://${base}`;
  if (!base.endsWith("/v1")) base = `${base}/v1`;
  return base;
}

/** Flagship Qwen3 Coder on Ollama (MoE); ollama pull qwen3-coder-next */
const OLLAMA_DEFAULT_PRIMARY = "qwen3-coder-next";

/** After primary + env fallbacks — smaller / older Qwen coder lines only */
const OLLAMA_DEFAULT_CHAIN = [
  "qwen3-coder:30b",
  "qwen3-coder",
  "qwen2.5-coder:32b",
  "qwen2.5-coder:7b",
];

/**
 * Order: primary model (default = best Qwen3 Coder), then OLLAMA_MODEL_FALLBACKS, then built-in chain.
 */
export function resolveOllamaModelCandidates(): string[] {
  const primary = (process.env.OLLAMA_MODEL?.trim() || OLLAMA_DEFAULT_PRIMARY).trim();
  const fallbacks = process.env.OLLAMA_MODEL_FALLBACKS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  if (primary) out.push(primary);
  for (const m of [...(fallbacks ?? []), ...OLLAMA_DEFAULT_CHAIN]) {
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/** Ollama ignores the key; the SDK requires a non-empty string. */
export const OLLAMA_DUMMY_API_KEY = "ollama";
