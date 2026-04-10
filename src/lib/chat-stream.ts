import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type ModelMessage } from "ai";
import { extractCodexMcFiles } from "@/lib/parse-codexmc";
import { applyGeneratedFiles } from "@/lib/workspace";

type OpenAiCompatProvider = ReturnType<typeof createOpenAI>;

const MISTRAL_FAILURE_HINT = `_Check \`MISTRAL_API_KEY\` and your model id (default \`codestral-latest\`). You can set \`MISTRAL_MODEL\` and optional \`MISTRAL_MODEL_FALLBACKS\` in \`.env\`._`;

export type LlmChatStreamOptions = {
  llm: OpenAiCompatProvider;
  modelIds: string[];
  system: string;
  messages: ModelMessage[];
  sessionId: string;
  maxRetries: number;
};

/** Try each model until one completes; surfaces errors as next-model hints. */
export async function* streamChatWithModelFallbacks(
  options: LlmChatStreamOptions,
): AsyncGenerator<string, void, undefined> {
  const { llm, modelIds, system, messages, sessionId, maxRetries } = options;
  let lastErr: unknown;

  for (let i = 0; i < modelIds.length; i++) {
    const modelId = modelIds[i];
    let acc = "";
    try {
      const result = streamText({
        model: llm.chat(modelId),
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
  yield `\n\n**All configured models failed.** ${msg}\n\n${MISTRAL_FAILURE_HINT}\n`;
}

export function buildLlmChatResponse(options: LlmChatStreamOptions): Response {
  const encoder = new TextEncoder();
  const byteStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of streamChatWithModelFallbacks(options)) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(`\n\n**Error:** ${msg}\n`));
        controller.close();
      }
    },
  });

  return new Response(byteStream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
