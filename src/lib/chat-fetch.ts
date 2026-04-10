/**
 * @ai-sdk/openai adds stream_options to chat/completions; many OpenAI-compatible
 * servers (OpenRouter, Ollama, vLLM, etc.) do not accept it.
 */
export function createChatCompletionsCompatibleFetch(): typeof fetch {
  return (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    let strip = false;
    try {
      const u = new URL(url);
      strip = u.hostname !== "api.openai.com";
    } catch {
      strip = true;
    }

    if (!strip || !init?.body || typeof init.body !== "string") {
      return fetch(input, init);
    }
    try {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      if ("stream_options" in parsed) {
        delete parsed.stream_options;
        return fetch(input, { ...init, body: JSON.stringify(parsed) });
      }
    } catch {
      /* keep body */
    }
    return fetch(input, init);
  };
}
