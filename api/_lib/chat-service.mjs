import { getBuildResearch } from './research-metadata.mjs';
import { rememberChatInteraction, retrieveRelevantMemories } from './site-memory.mjs';

const DEFAULT_MODEL = 'qwen/qwen2.5-coder';
const UPSTREAM_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function buildChatMessages({ messages, loader, version }) {
  const latestUserMessage = getLatestUserMessage(messages);
  const [researchMessage, memoryMessage] = await Promise.all([
    createResearchMessage(loader, version),
    createMemoryMessage(loader, version, latestUserMessage),
  ]);

  const injectedMessages = [researchMessage, memoryMessage].filter(Boolean);
  const filteredMessages = messages.filter(message => ['system', 'user', 'assistant'].includes(message?.role));

  return {
    latestUserMessage,
    messages: injectedMessages.length
      ? [filteredMessages[0], ...injectedMessages, ...filteredMessages.slice(1)]
      : filteredMessages,
  };
}

export async function requestStreamingChatCompletion({
  apiKey,
  body,
  messages,
}) {
  const model = body.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const requestBody = {
    model,
    messages,
    max_tokens: body.max_tokens || 4096,
    temperature: body.temperature ?? 0.2,
    stream: true,
  };

  const MAX_CHAT_RETRIES = 4;
  let upstream;
  for (let i = 0; i < MAX_CHAT_RETRIES; i++) {
    upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3000',
        'X-Title': process.env.OPENROUTER_APP_TITLE || 'CodexMC',
      },
      body: JSON.stringify(requestBody),
    });

    if (upstream.status !== 429 && upstream.status !== 503) break;
    if (i === MAX_CHAT_RETRIES - 1) break;

    const retryAfter = upstream.headers.get('retry-after');
    const seconds = retryAfter ? Number(retryAfter) : null;
    const backoffMs = (Number.isFinite(seconds) && seconds > 0)
      ? Math.round(seconds * 1000)
      : Math.min(30000, 5000 * (i + 1));
    await new Promise(resolve => setTimeout(resolve, backoffMs));
  }

  return { model, upstream };
}

export async function createChatStreamResponse({
  upstream,
  fallbackModel,
  loader,
  version,
  latestUserMessage,
}) {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  let usedModel = fallbackModel;
  let fullResponse = '';

  void streamUpstreamChunks({
    upstream,
    writer,
    encoder,
    onDelta(delta, model) {
      usedModel = model || usedModel;
      fullResponse += delta;
    },
    async onDone() {
      await rememberChatInteraction({
        loader,
        version,
        prompt: latestUserMessage,
        response: fullResponse,
        model: usedModel,
      });
    },
  });

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}

export async function readUpstreamError(upstream) {
  const text = await upstream.text();
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
    || `HTTP ${upstream.status}`;
}

function getLatestUserMessage(messages) {
  return [...messages].reverse().find(message => message?.role === 'user')?.content || '';
}

async function createResearchMessage(loader, version) {
  const lines = [];
  const mapping = getMappingMode(loader, version);
  const researchedBuild = await loadBuildResearch(loader, version);

  if (loader === 'fabric' && mapping === 'yarn') {
    lines.push(`Fabric ${version} uses Yarn mappings. Use net.minecraft.block.*, net.minecraft.item.*, net.minecraft.registry.*, net.minecraft.util.Identifier.`);
    lines.push('For modern Fabric/Yarn targets, use Identifier.of(namespace, path) or Identifier.of(fullId).');
    lines.push('Prefer Item.Settings and AbstractBlock.Settings.copy(...).');
    if (usesModernFabricRegistryKeys(version)) {
      lines.push('For modern Fabric blocks and block items, set registryKey(...) on AbstractBlock.Settings and Item.Settings before constructing instances.');
    }
  }

  if (loader === 'fabric' && mapping === 'none') {
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
  return { role: 'system', content: lines.filter(Boolean).join('\n') };
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

async function streamUpstreamChunks({ upstream, writer, encoder, onDelta, onDone }) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usedModel = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') continue;

        let chunk;
        try {
          chunk = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (chunk.model) {
          usedModel = chunk.model;
        }

        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          onDelta(delta, usedModel);
          await writer.write(encoder.encode(`data: ${JSON.stringify({ delta, model: usedModel })}\n\n`));
        }
      }
    }

    await writer.write(encoder.encode(`data: ${JSON.stringify({ done: true, model: usedModel })}\n\n`));
    await onDone();
  } catch (error) {
    await writer.write(encoder.encode(`data: ${JSON.stringify({ error: error.message })}\n\n`));
  } finally {
    writer.close().catch(() => {});
  }
}

function isFabricNonObfuscated(version) {
  return /^26\./.test(String(version || ''));
}

function usesModernFabricRegistryKeys(version) {
  return /^1\.21\.(?:2|3|4|10|11)$/.test(String(version || '')) || isFabricNonObfuscated(version);
}
