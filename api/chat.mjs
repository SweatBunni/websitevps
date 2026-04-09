export const config = { runtime: 'nodejs' };

import { getBuildResearch } from './_lib/research-metadata.mjs';
import { rememberChatInteraction, retrieveRelevantMemories } from './_lib/site-memory.mjs';

function errJson(msg, status = 500) {
  return new Response(JSON.stringify({ message: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function isFabricNonObfuscated(v) { return /^26\./.test(String(v || '')); }
function isModernFabricYarn(v) { return /^1\\.21(?:\\.\\d+)?$/.test(String(v || '')); }
function usesModernFabricRegistryKeys(v) { return /^1\\.21\\.(?:2|3|4|10|11)$/.test(String(v || '')) || isFabricNonObfuscated(v); }

function mappingMode(loader, version) {
  if (loader === 'fabric') {
    if (isFabricNonObfuscated(version)) return 'none';
    return 'yarn';
  }
  return 'official';
}

async function researchMsg(loader, version) {
  const mode = mappingMode(loader, version);
  const lines = [];
  let researchedBuild = null;
  if (loader === 'fabric' || loader === 'forge' || loader === 'neoforge') {
    try {
      researchedBuild = (await getBuildResearch(loader, version))?.build || null;
    } catch {
      researchedBuild = null;
    }
  }
  if (loader === 'fabric' && mode === 'yarn') {
    lines.push(`Fabric ${version} uses Yarn mappings. Use net.minecraft.block.*, net.minecraft.item.*, net.minecraft.registry.*, net.minecraft.util.Identifier.`);
    lines.push('For modern Fabric/Yarn targets, Identifier constructors are not public. Use Identifier.of(namespace, path) or Identifier.of(fullId).');
    lines.push('Prefer Item.Settings and AbstractBlock.Settings.copy(...) - avoid FabricItemSettings/FabricBlockSettings unless certain.');
    if (usesModernFabricRegistryKeys(version)) {
      lines.push('For modern Fabric blocks and block items, set registryKey(...) on AbstractBlock.Settings and Item.Settings before constructing the instances.');
    }
    if (researchedBuild) {
      lines.push(`Use researched versions where relevant: loader ${researchedBuild.loaderVersion}, loom ${researchedBuild.loomVersion}, Gradle ${researchedBuild.gradleVersion}${researchedBuild.yarnVersion ? `, Yarn ${researchedBuild.yarnVersion}` : ''}${researchedBuild.fabricApiVersion ? `, Fabric API ${researchedBuild.fabricApiVersion}` : ''}.`);
    }
  }
  if (loader === 'fabric' && mode === 'none') {
    lines.push(`Fabric ${version} (26.1+) is non-obfuscated. Use official deobfuscated names, not Yarn-era tutorial imports.`);
    lines.push('Fabric API 26.1 renamed many APIs. Avoid guessing biome/worldgen imports - prefer a smaller safe scaffold.');
    lines.push('NEVER assume Yarn packages like net.minecraft.block.*, net.minecraft.registry.*, or net.minecraft.util.Identifier exist on Fabric 26.x unless verified for the exact target.');
  }
  if ((loader === 'forge' || loader === 'neoforge') && /^1\.21|^26\./.test(String(version||''))) {
    lines.push(`${loader} ${version}: use official Mojang mapping names only. Do not mix Fabric/Yarn imports.`);
  }
  if (loader === 'forge' && researchedBuild) {
    lines.push(`Use researched versions where relevant: Forge ${researchedBuild.forgeVersion}, ForgeGradle ${researchedBuild.forgeGradleVersion}, Gradle ${researchedBuild.gradleVersion}, toolchain resolver ${researchedBuild.toolchainResolverVersion}.`);
  }
  if (loader === 'neoforge' && researchedBuild) {
    lines.push(`Use researched versions where relevant: NeoForge ${researchedBuild.neoforgeVersion}, userdev plugin ${researchedBuild.userdevVersion}, Gradle ${researchedBuild.gradleVersion}.`);
  }
  if (loader === 'paper') {
    lines.push(`Paper ${version}: use the current Paper repository https://repo.papermc.io/repository/maven-public/ and avoid the old papermc.io repository URL.`);
  }
  if (!lines.length) return null;
  lines.push('Never invent package names, imports, or APIs for the selected target version.');
  return { role: 'system', content: lines.join('\n') };
}

export default async function handler(req) {
  if (req.method !== 'POST') return errJson('Method not allowed.', 405);

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) return errJson('Server is missing MISTRAL_API_KEY.', 500);

  let body;
  try { body = await req.json(); }
  catch { return errJson('Invalid JSON body.', 400); }

  if (!Array.isArray(body.messages) || body.messages.length === 0)
    return errJson('A non-empty messages array is required.', 400);

  const model = body.model || process.env.MISTRAL_MODEL || 'codestral-latest';
  const latestUserMessage = [...body.messages].reverse().find(message => message?.role === 'user')?.content || '';
  const siteMemories = body.loader === 'fabric' && isFabricNonObfuscated(body.version)
    ? []
    : await retrieveRelevantMemories({
        query: latestUserMessage,
        loader: body.loader,
        version: body.version,
        type: 'chat',
        limit: 3,
      });
  const extra = await researchMsg(body.loader, body.version);
  const memoryMessage = siteMemories.length
    ? {
        role: 'system',
        content: `Relevant prior site memory:\n${siteMemories.map(memory => `- ${memory.text}`).join('\n')}\nUse these only as hints. Prefer the current prompt and researched metadata when they conflict.`,
      }
    : null;
  const injectedMessages = [extra, memoryMessage].filter(Boolean);
  const messages = injectedMessages.length
    ? [body.messages[0], ...injectedMessages, ...body.messages.slice(1)]
    : body.messages;

  const upstream = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: body.max_tokens || 4096,
      temperature: body.temperature ?? 0.2,
      stream: true,
    }),
  });

  if (!upstream.ok) {
    const t = await upstream.text();
    let j = {}; try { j = JSON.parse(t); } catch {}
    const msg = j?.message || j?.error?.message || j?.error || t || `HTTP ${upstream.status}`;
    return errJson(`Mistral error (${upstream.status}): ${String(msg).slice(0,400)}`, upstream.status);
  }

  const enc = new TextEncoder();
  let usedModel = model;
  let fullResponse = '';

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t || t === 'data: [DONE]') continue;
          if (!t.startsWith('data:')) continue;
          try {
            const c = JSON.parse(t.slice(5).trim());
            if (c.model) usedModel = c.model;
            const delta = c.choices?.[0]?.delta?.content;
            if (delta) {
              fullResponse += delta;
              await writer.write(enc.encode(`data: ${JSON.stringify({ delta, model: usedModel })}\n\n`));
            }
          } catch { /* skip malformed */ }
        }
      }
      await writer.write(enc.encode(`data: ${JSON.stringify({ done: true, model: usedModel })}\n\n`));
      await rememberChatInteraction({
        loader: body.loader,
        version: body.version,
        prompt: latestUserMessage,
        response: fullResponse,
        model: usedModel,
      });
    } catch (e) {
      await writer.write(enc.encode(`data: ${JSON.stringify({ error: e.message })}\n\n`));
    } finally {
      writer.close().catch(() => {});
    }
  })();

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
