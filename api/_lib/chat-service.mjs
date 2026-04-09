import { getBuildResearch } from './research-metadata.mjs';
import { rememberChatInteraction, retrieveRelevantMemories } from './site-memory.mjs';

const DEFAULT_MODEL = 'qwen/qwen-2.5-coder-32b-instruct:free';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_CHAT_RETRIES = 4;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;
const NORMALIZED_CHUNK_SIZE = 320;

export async function buildChatRequest({ body }) {
  const latestUserMessage = getLatestUserMessage(body.messages);
  const [researchMessage, memoryMessage] = await Promise.all([
    createResearchMessage(body.loader, body.version),
    createMemoryMessage(body.loader, body.version, latestUserMessage),
  ]);

  const baseMessages = Array.isArray(body.messages)
    ? body.messages.filter(message => ['system', 'user', 'assistant'].includes(message?.role))
    : [];
  const injectedMessages = [researchMessage, memoryMessage].filter(Boolean);
  const messages = injectedMessages.length
    ? [baseMessages[0], ...injectedMessages, ...baseMessages.slice(1)]
    : baseMessages;

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

async function createResearchMessage(loader, version) {
  const lines = [];
  const mappingMode = getMappingMode(loader, version);
  const researchedBuild = await loadBuildResearch(loader, version);

  if (loader === 'fabric' && mappingMode === 'yarn') {
    lines.push(`Fabric ${version} uses Yarn mappings. Use net.minecraft.block.*, net.minecraft.item.*, net.minecraft.registry.*, net.minecraft.util.Identifier.`);
    lines.push('For modern Fabric/Yarn targets, use Identifier.of(namespace, path) or Identifier.of(fullId).');
    lines.push('Prefer Item.Settings and AbstractBlock.Settings.copy(...).');
    if (usesModernFabricRegistryKeys(version)) {
      lines.push('For modern Fabric blocks and block items, set registryKey(...) on AbstractBlock.Settings and Item.Settings before constructing instances.');
    }
  }

  if (loader === 'fabric' && mappingMode === 'none') {
    lines.push(`Fabric ${version} is non-obfuscated. Use official names, not Yarn-era imports.`);
    lines.push('Do not assume net.minecraft.block.*, net.minecraft.registry.*, or net.minecraft.util.Identifier exist unless verified for this exact target.');
  }

  if ((loader === 'forge' || loader === 'neoforge') && /^(1\.21|26\.)/.test(String(version || ''))) {
    lines.push(`${loader} ${version}: use official Mojang mapping names only. Do not mix Fabric/Yarn imports.`);
  }

  if (loader === 'paper') {
    lines.push(`Paper ${version}: use https://repo.papermc.io/repository/maven-public/ and avoid the old papermc.io repository URL.`);
  }

  if (researchedBuild) {
    lines.push(formatResearchedVersions(loader, researchedBuild));
  }

  if (!lines.length) {
    return null;
  }

  lines.push('Never invent package names, imports, APIs, or version numbers.');
  return { role: 'system', content: lines.join('\n') };
}

async function createMemoryMessage(loader, version, latestUserMessage) {
  if (!latestUserMessage || (loader === 'fabric' && isFabricNonObfuscated(version))) {
    return null;
  }

  const memories = await retrieveRelevantMemories({
    query: latestUserMessage,
    loader,
    version,
    type: 'chat',
    limit: 3,
  });

  if (!memories.length) {
    return null;
  }

  return {
    role: 'system',
    content: `Relevant prior site memory:\n${memories.map(memory => `- ${memory.text}`).join('\n')}\nUse these only as hints. Prefer the current prompt and researched metadata when they conflict.`,
  };
}

async function loadBuildResearch(loader, version) {
  if (!['fabric', 'forge', 'neoforge'].includes(loader)) {
    return null;
  }

  try {
    return (await getBuildResearch(loader, version))?.build || null;
  } catch {
    return null;
  }
}

function getMappingMode(loader, version) {
  if (loader !== 'fabric') {
    return 'official';
  }
  return isFabricNonObfuscated(version) ? 'none' : 'yarn';
}

function formatResearchedVersions(loader, build) {
  if (loader === 'fabric') {
    return `Use researched versions where relevant: loader ${build.loaderVersion}, loom ${build.loomVersion}, Gradle ${build.gradleVersion}${build.yarnVersion ? `, Yarn ${build.yarnVersion}` : ''}${build.fabricApiVersion ? `, Fabric API ${build.fabricApiVersion}` : ''}.`;
  }
  if (loader === 'forge') {
    return `Use researched versions where relevant: Forge ${build.forgeVersion}, ForgeGradle ${build.forgeGradleVersion}, Gradle ${build.gradleVersion}, toolchain resolver ${build.toolchainResolverVersion}.`;
  }
  if (loader === 'neoforge') {
    return `Use researched versions where relevant: NeoForge ${build.neoforgeVersion}, userdev plugin ${build.userdevVersion}, Gradle ${build.gradleVersion}.`;
  }
  return '';
}

function isFabricNonObfuscated(version) {
  return /^26\./.test(String(version || ''));
}

function usesModernFabricRegistryKeys(version) {
  return /^1\.21\.(?:2|3|4|10|11)$/.test(String(version || '')) || isFabricNonObfuscated(version);
}
