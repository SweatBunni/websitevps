export const config = { runtime: 'nodejs' };

import { buildChatMessages, createChatStreamResponse, readUpstreamError, requestStreamingChatCompletion } from './_lib/chat-service.mjs';
import { jsonResponse, methodNotAllowed, parseJsonRequest } from './_lib/http-utils.mjs';

export default async function handler(request) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return jsonResponse({ message: 'Server is missing OPENROUTER_API_KEY.' }, { status: 500 });
  }

  const parsedBody = await parseJsonRequest(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const body = parsedBody.value || {};
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse({ message: 'A non-empty messages array is required.' }, { status: 400 });
  }

  const { latestUserMessage, messages } = await buildChatMessages({
    messages: body.messages,
    loader: body.loader,
    version: body.version,
  });

  const { model, upstream } = await requestStreamingChatCompletion({
    apiKey,
    body,
    messages,
  });

  if (!upstream.ok) {
    const errorMessage = await readUpstreamError(upstream);
    return jsonResponse(
      { message: `AI error (${upstream.status}): ${String(errorMessage).slice(0, 400)}` },
      { status: upstream.status },
    );
  }

  return createChatStreamResponse({
    upstream,
    fallbackModel: model,
    loader: body.loader,
    version: body.version,
    latestUserMessage,
  });
}
