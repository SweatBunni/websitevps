import { rememberChatInteraction } from './site-memory.mjs';

const DEFAULT_MODEL = 'deepseek/deepseek-chat:free';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_CHAT_RETRIES = 4;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;
const NORMALIZED_CHUNK_SIZE = 320;

export async function buildChatRequest({ body }) {
  const latestUserMessage = getLatestUserMessage(body.messages);
  const conversation = Array.isArray(body.messages)
    ? body.messages
        .filter(message => message && (message.role === 'user' || message.role === 'assistant'))
        .map(message => ({
          role: message.role,
          content: String(message.content || '').trim(),
        }))
        .filter(message => message.content)
    : [];

  const messages = [
    {
      role: 'system',
      content: buildMinimalSystemPrompt(body.loader, body.version),
    },
    ...conversation,
  ];

  return {
    latestUserMessage,
    model: body.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
    maxTokens: body.max_tokens || DEFAULT_MAX_TOKENS,
    temperature: body.temperature ?? DEFAULT_TEMPERATURE,
    messages,
  };
}

export async function completeChat({
  apiKey,
  model,
  maxTokens,
  temperature,
  messages,
}) {
  let response;

  for (let attempt = 0; attempt < MAX_CHAT_RETRIES; attempt += 1) {
    response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3000',
        'X-Title': process.env.OPENROUTER_APP_TITLE || 'CodexMC',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
    });

    if (response.ok || !isRetryableStatus(response.status) || attempt === MAX_CHAT_RETRIES - 1) {
      break;
    }

    await delay(resolveRetryDelayMs(response, attempt));
  }

  if (!response.ok) {
    const message = await readErrorMessage(response);
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  const usedModel = payload?.model || model;
  const text = extractCompletionText(payload);
  if (!text) {
    const error = new Error(`Provider returned no text for model ${usedModel}. Raw payload: ${compactPayload(payload)}`);
    error.status = 502;
    throw error;
  }
  return { model: usedModel, text, payload };
}

export async function createNormalizedChatResponse({
  model,
  text,
  loader,
  version,
  latestUserMessage,
}) {
  await rememberChatInteraction({
    loader,
    version,
    prompt: latestUserMessage,
    response: text,
    model,
  });

  const streamBody = buildNormalizedSseBody(text, model);
  return new Response(streamBody, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}

export async function readErrorMessage(response) {
  const text = await response.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }

  return json?.error?.message
    || json?.message
    || json?.error
    || text
    || `HTTP ${response.status}`;
}

function buildNormalizedSseBody(text, model) {
  const chunks = splitIntoChunks(text || '', NORMALIZED_CHUNK_SIZE);
  const lines = [];

  if (!chunks.length) {
    lines.push(`data: ${JSON.stringify({ delta: '', model })}\n\n`);
  } else {
    for (const chunk of chunks) {
      lines.push(`data: ${JSON.stringify({ delta: chunk, model })}\n\n`);
    }
  }

  lines.push(`data: ${JSON.stringify({ done: true, model })}\n\n`);
  return lines.join('');
}

function splitIntoChunks(text, maxLength) {
  const value = String(text || '');
  if (!value) return [];
  const chunks = [];
  for (let index = 0; index < value.length; index += maxLength) {
    chunks.push(value.slice(index, index + maxLength));
  }
  return chunks;
}

function compactPayload(payload) {
  try {
    const text = JSON.stringify(payload);
    return text.length > 800 ? `${text.slice(0, 800)}...` : text;
  } catch {
    return '[unserializable payload]';
  }
}

function extractCompletionText(payload) {
  const choice = payload?.choices?.[0] || {};
  return (
    textFromValue(choice?.message?.content)
    || textFromValue(choice?.text)
    || textFromValue(payload?.output_text)
    || textFromValue(payload?.response)
    || ''
  ).trim();
}

function textFromValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(item => textFromValue(item)).join('');
  }
  if (typeof value === 'object') {
    return (
      textFromValue(value.text)
      || textFromValue(value.content)
      || textFromValue(value.output_text)
      || textFromValue(value.reasoning)
      || ''
    );
  }
  return '';
}

function isRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function resolveRetryDelayMs(response, attempt) {
  const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
  if (retryAfter !== null) {
    return retryAfter;
  }
  return Math.min(30000, 4000 * (attempt + 1));
}

function parseRetryAfterMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1000, Math.round(seconds * 1000));
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(1000, dateMs - Date.now());
  }
  return null;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getLatestUserMessage(messages) {
  return [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find(message => message?.role === 'user')?.content || '';
}

function buildMinimalSystemPrompt(loader, version) {
  const lines = [
    'You are a helpful coding assistant for Minecraft modding and plugins.',
    'Answer clearly and directly.',
    'If you provide code, keep it valid for the requested loader and version.',
    'Do not invent APIs, package names, or dependencies.',
  ];

  if (loader && version) {
    lines.push(`Target loader: ${loader}.`);
    lines.push(`Target version: ${version}.`);
  }

  if (loader === 'fabric') {
    lines.push('Prefer Fabric-compatible code and mappings for the selected Fabric target.');
  }
  if (loader === 'forge' || loader === 'neoforge') {
    lines.push('Use official Mojang-named APIs for modern Forge/NeoForge targets unless the conversation clearly requires otherwise.');
  }
  if (loader === 'paper') {
    lines.push('Use Paper-compatible plugin code.');
  }

  return lines.join('\n');
}
