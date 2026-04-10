import { createOpenAI } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import { buildOpenRouterChatResponse } from "@/lib/chat-stream";
import { isLoaderId, type LoaderId } from "@/lib/loaders";
import {
  createOpenRouterFetch,
  resolveOpenRouterApiKey,
  resolveOpenRouterModelCandidates,
} from "@/lib/openrouter";
import { systemPrompt } from "@/lib/prompt";

export const maxDuration = 300;

function parseMaxRetries(): number {
  const n = Number.parseInt(process.env.AI_MAX_RETRIES ?? "6", 10);
  if (!Number.isFinite(n)) return 6;
  return Math.min(12, Math.max(0, n));
}

export async function POST(req: Request) {
  const apiKey = resolveOpenRouterApiKey();
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error:
          "Set OPENROUTER_API_KEY to your key from https://openrouter.ai/keys (starts with sk-or-v1-). No quotes. Optional: OPENAI_API_KEY if it is an OpenRouter key.",
      }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!apiKey.startsWith("sk-or-")) {
    return new Response(
      JSON.stringify({
        error:
          "OPENROUTER_API_KEY does not look like an OpenRouter key (expected prefix sk-or-). Regenerate at https://openrouter.ai/keys — remove quotes/Bearer/line breaks from .env.",
      }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  }

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

  const openrouter = createOpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    fetch: createOpenRouterFetch(),
    headers: {
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": "CodexMC",
    },
  });

  const modelIds = resolveOpenRouterModelCandidates();
  const mcLabel =
    loader === "fabric"
      ? version
      : loader === "forge"
        ? version.split("-")[0] || version
        : version;

  return buildOpenRouterChatResponse({
    openrouter,
    modelIds,
    system: systemPrompt(loader as LoaderId, mcLabel, version),
    messages,
    sessionId,
    maxRetries: parseMaxRetries(),
  });
}
