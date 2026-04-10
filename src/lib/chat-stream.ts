import { createOpenAI } from "@ai-sdk/openai";
import { createTextStreamResponse, streamText, type ModelMessage } from "ai";
import { extractCodexMcFiles } from "@/lib/parse-codexmc";
import { applyGeneratedFiles } from "@/lib/workspace";

type OpenAiCompatProvider = ReturnType<typeof createOpenAI>;

const OPENROUTER_FAILURE_HINT = `_Free “:free” endpoints are often rate-limited (HTTP 429). Wait and retry, set \`AI_MODEL_FALLBACKS\` in \`.env\`, switch to local \`AI_PROVIDER=ollama\`, or add OpenRouter credits / BYOK: https://openrouter.ai/settings/integrations_`;

const OLLAMA_FAILURE_HINT = `_Check that Ollama is running (\`ollama serve\`), reachable at \`OLLAMA_BASE_URL\`, and that you have pulled a model (e.g. \`ollama pull llama3.2\`). List models: \`ollama list\`._`;

export type LlmChatStreamOptions = {
  llm: OpenAiCompatProvider;
  modelIds: string[];
  system: string;
  messages: ModelMessage[];
  sessionId: string;
  maxRetries: number;
  /** Shown after all models fail */
  failureHint?: "openrouter" | "ollama";
};

/** Try each model until one completes; surfaces errors as next-model hints. */
export async function* streamChatWithModelFallbacks(
  options: LlmChatStreamOptions,
): AsyncGenerator<string, void, undefined> {
  const { llm, modelIds, system, messages, sessionId, maxRetries, failureHint } =
    options;
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
  const hint =
    failureHint === "ollama" ? OLLAMA_FAILURE_HINT : OPENROUTER_FAILURE_HINT;
  yield `\n\n**All configured models failed.** ${msg}\n\n${hint}\n`;
}

export function buildLlmChatResponse(options: LlmChatStreamOptions): Response {
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
