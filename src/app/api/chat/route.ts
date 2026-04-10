import { createOpenAI } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import { buildLlmChatResponse } from "@/lib/chat-stream";
import { createChatCompletionsCompatibleFetch } from "@/lib/chat-fetch";
import { isLoaderId, type LoaderId } from "@/lib/loaders";
import { systemPrompt } from "@/lib/prompt";

export const maxDuration = 300;
const DEFAULT_MISTRAL_MODEL = "codestral-latest";

function parseMaxRetries(): number {
  const n = Number.parseInt(process.env.AI_MAX_RETRIES ?? "6", 10);
  if (!Number.isFinite(n)) return 6;
  return Math.min(12, Math.max(0, n));
}

function mistralModelCandidates(): string[] {
  const primary = process.env.MISTRAL_MODEL?.trim() || DEFAULT_MISTRAL_MODEL;
  const extras = process.env.MISTRAL_MODEL_FALLBACKS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [primary];
  for (const m of extras ?? []) {
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    sessionId?: string;
    loader?: string;
    version?: string;
    messages?: ModelMessage[];
  };

  const { sessionId, loader, version, messages } = body;
  if (
    !sessionId ||
    !loader ||
    !version ||
    !Array.isArray(messages) ||
    !isLoaderId(loader)
  ) {
    return new Response(JSON.stringify({ error: "Bad request." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const fetchCompat = createChatCompletionsCompatibleFetch();
  const mcLabel =
    loader === "fabric"
      ? version
      : loader === "forge"
        ? version.split("-")[0] || version
        : version;
  const prompt = systemPrompt(loader as LoaderId, mcLabel, version);
  const maxRetries = parseMaxRetries();
  const apiKey = process.env.MISTRAL_API_KEY?.trim();
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error:
          "Set MISTRAL_API_KEY in your .env/.env.local to use Mistral coding models.",
      }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  }

  const baseURL = process.env.MISTRAL_BASE_URL?.trim() || "https://api.mistral.ai/v1";
  const llm = createOpenAI({
    apiKey,
    baseURL,
    fetch: fetchCompat,
  });

  return buildLlmChatResponse({
    llm,
    modelIds: mistralModelCandidates(),
    system: prompt,
    messages,
    sessionId,
    maxRetries,
  });
}
