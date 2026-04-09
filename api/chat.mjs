export const config = { runtime: 'nodejs' };

import { buildChatRequest, completeChat, createNormalizedChatResponse } from './_lib/chat-service.mjs';
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

  try {
    const requestData = await buildChatRequest({ body });
    const completion = await completeChat({
      apiKey,
      model: requestData.model,
      maxTokens: requestData.maxTokens,
      temperature: requestData.temperature,
      messages: requestData.messages,
    });

    return createNormalizedChatResponse({
      model: completion.model,
      text: completion.text,
      loader: body.loader,
      version: body.version,
      latestUserMessage: requestData.latestUserMessage,
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return jsonResponse(
      { message: `AI error (${status}): ${String(error?.message || 'Unknown error').slice(0, 400)}` },
      { status },
    );
  }
}
