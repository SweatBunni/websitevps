import { createOpenAI } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import { buildLlmChatResponse } from "@/lib/chat-stream";
import { createChatCompletionsCompatibleFetch } from "@/lib/chat-fetch";
import { isLoaderId, type LoaderId } from "@/lib/loaders";
import {
  normalizeOllamaBaseUrl,
  OLLAMA_DUMMY_API_KEY,
  resolveAiBackend,
  resolveOllamaModelCandidates,
} from "@/lib/ollama";
import { resolveOpenRouterApiKey, resolveOpenRouterModelCandidates } from "@/lib/openrouter";
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

  const backend = resolveAiBackend();
  const fetchCompat = createChatCompletionsCompatibleFetch();
  const mcLabel =
    loader === "fabric"
      ? version
      : loader === "forge"
        ? version.split("-")[0] || version
        : version;
  const prompt = systemPrompt(loader as LoaderId, mcLabel, version);
  const maxRetries = parseMaxRetries();

  if (backend === "ollama") {
    const baseURL = normalizeOllamaBaseUrl(process.env.OLLAMA_BASE_URL);
    const llm = createOpenAI({
      apiKey: OLLAMA_DUMMY_API_KEY,
      baseURL,
      fetch: fetchCompat,
    });
    const modelIds = resolveOllamaModelCandidates();

    return buildLlmChatResponse({
      llm,
      modelIds,
      system: prompt,
      messages,
      sessionId,
      maxRetries,
      failureHint: "ollama",
    });
  }

  const apiKey = resolveOpenRouterApiKey();
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error:
          "OpenRouter: set OPENROUTER_API_KEY (sk-or-v1-…), or use local Ollama with AI_PROVIDER=ollama in .env.",
      }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!apiKey.startsWith("sk-or-")) {
    return new Response(
      JSON.stringify({
        error:
          "OPENROUTER_API_KEY should start with sk-or-. For local models, set AI_PROVIDER=ollama.",
      }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  }

  const llm = createOpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    fetch: fetchCompat,
    headers: {
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": "CodexMC",
    },
  });

  return buildLlmChatResponse({
    llm,
    modelIds: resolveOpenRouterModelCandidates(),
    system: prompt,
    messages,
    sessionId,
    maxRetries,
    failureHint: "openrouter",
  });
}
