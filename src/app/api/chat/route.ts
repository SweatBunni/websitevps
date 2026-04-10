import { createOpenAI } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import { buildLlmChatResponse } from "@/lib/chat-stream";
import { createChatCompletionsCompatibleFetch } from "@/lib/chat-fetch";
import { isLoaderId, type LoaderId } from "@/lib/loaders";
import {
  normalizeOllamaBaseUrl,
  OLLAMA_DUMMY_API_KEY,
  resolveOllamaModelCandidates,
} from "@/lib/ollama";
import { systemPrompt } from "@/lib/prompt";

export const maxDuration = 300;

function parseMaxRetries(): number {
  const n = Number.parseInt(process.env.AI_MAX_RETRIES ?? "6", 10);
  if (!Number.isFinite(n)) return 6;
  return Math.min(12, Math.max(0, n));
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

  const baseURL = normalizeOllamaBaseUrl(process.env.OLLAMA_BASE_URL);
  const llm = createOpenAI({
    apiKey: OLLAMA_DUMMY_API_KEY,
    baseURL,
    fetch: fetchCompat,
  });

  return buildLlmChatResponse({
    llm,
    modelIds: resolveOllamaModelCandidates(),
    system: prompt,
    messages,
    sessionId,
    maxRetries,
  });
}
