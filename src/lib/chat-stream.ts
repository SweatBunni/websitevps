import { createOpenAI } from "@ai-sdk/openai";
import { createTextStreamResponse, streamText, type ModelMessage } from "ai";
import { extractCodexMcFiles } from "@/lib/parse-codexmc";
import { applyGeneratedFiles } from "@/lib/workspace";

type OpenRouter = ReturnType<typeof createOpenAI>;

export type OpenRouterChatStreamOptions = {
  openrouter: OpenRouter;
  modelIds: string[];
  system: string;
  messages: ModelMessage[];
  sessionId: string;
  maxRetries: number;
};

/** Try each model until one completes; surfaces 429/provider errors as next-model hints. */
export async function* streamChatWithModelFallbacks(
  options: OpenRouterChatStreamOptions,
): AsyncGenerator<string, void, undefined> {
  const { openrouter, modelIds, system, messages, sessionId, maxRetries } = options;
  let lastErr: unknown;

  for (let i = 0; i < modelIds.length; i++) {
    const modelId = modelIds[i];
    let acc = "";
    try {
      const result = streamText({
        model: openrouter.chat(modelId),
        system,
        messages,
        maxRetries,
        onError: ({ error }) => {
          console.error(`[codexmc] stream error (model=${modelId}):`, error);
        },
      });
      for await (const delta of result.textStream) {
        acc += delta;
        yield delta;
      }
      const files = extractCodexMcFiles(acc);
      if (files.length) await applyGeneratedFiles(sessionId, files);
      return;
    } catch (e) {
      lastErr = e;
      if (i < modelIds.length - 1) {
        const snippet =
          e instanceof Error
            ? e.message.replace(/\s+/g, " ").slice(0, 180)
            : String(e).slice(0, 180);
        yield `\n\n_[CodexMC: “${modelId}” failed (${snippet}…) — trying another model…]_\n\n`;
      }
    }
  }

  const msg =
    lastErr instanceof Error ? lastErr.message : String(lastErr ?? "Unknown error");
  yield `\n\n**All configured models failed.** ${msg}\n\n_Free “:free” endpoints are often rate-limited (HTTP 429). Wait and retry, set \`AI_MODEL_FALLBACKS\` in \`.env\`, or add OpenRouter credits / provider keys (BYOK): https://openrouter.ai/settings/integrations_\n`;
}

export function buildOpenRouterChatResponse(
  options: OpenRouterChatStreamOptions,
): Response {
  const textStream = new ReadableStream<string>({
    async start(controller) {
      try {
        for await (const chunk of streamChatWithModelFallbacks(options)) {
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(`\n\n**Error:** ${msg}\n`);
        controller.close();
      }
    },
  });

  return createTextStreamResponse({
    textStream,
    headers: { "Cache-Control": "no-store" },
  });
}
