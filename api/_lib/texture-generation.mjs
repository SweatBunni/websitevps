import path from 'node:path';

const MAX_TEXTURE_TARGETS = 3;

// Cache the image-generation agent ID per API key/model within a function instance.
// This avoids creating a new agent on every texture generation call.
const agentIdCache = new Map();

export async function enrichProjectWithGeneratedTextures({ apiKey, loader, version, modName, files, conversation }) {
  const generatedTextures = [];
  const textureWarnings = [];

  if (!apiKey || !files || typeof files !== 'object') {
    return { generatedTextures, textureWarnings };
  }

  const modId = safeModId(modName);
  const targets = detectTextureTargets({ loader, modId, files }).slice(0, MAX_TEXTURE_TARGETS);
  if (!targets.length) {
    return { generatedTextures, textureWarnings };
  }

  const userRequest = extractLatestUserRequest(conversation);

  for (const target of targets) {
    try {
      if (hasTextureFile(files, modId, target)) {
        continue;
      }

      const imageBytes = await generateTextureImage({
        apiKey,
        prompt: buildTexturePrompt({ loader, version, modName, modId, target, userRequest }),
      });
      applyTextureFiles(files, modId, target, imageBytes);
      generatedTextures.push({
        kind: target.kind,
        id: target.id,
        texturePath: texturePathFor(modId, target),
      });
    } catch (error) {
      textureWarnings.push(`Texture generation skipped for ${target.kind} "${target.id}": ${error.message || 'unknown error'}`);
    }
  }

  return { generatedTextures, textureWarnings };
}

function detectTextureTargets({ loader, modId, files }) {
  const targets = new Map();
  const textEntries = Object.entries(files)
    .map(([filePath, file]) => [filePath, normalizeTextFile(file)])
    .filter(([, file]) => file);

  for (const [filePath, file] of textEntries) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const content = String(file.content || '');

    collectTargets(targets, content, 'block', /Registr(?:y|ies)\.BLOCK[\s\S]{0,260}?(?:Identifier\.of|new Identifier|ResourceLocation\.fromNamespaceAndPath|new ResourceLocation)\s*\([^,\n]+,\s*"([a-z0-9_/-]+)"/g);
    collectTargets(targets, content, 'item', /Registr(?:y|ies)\.ITEM[\s\S]{0,260}?(?:Identifier\.of|new Identifier|ResourceLocation\.fromNamespaceAndPath|new ResourceLocation)\s*\([^,\n]+,\s*"([a-z0-9_/-]+)"/g);
    collectTargets(targets, content, 'block', /(?:DeferredRegister\.Blocks|DeferredBlock<|RegistryObject<\s*Block|BLOCKS\.register)\b[\s\S]{0,160}?"([a-z0-9_/-]+)"/g);
    collectTargets(targets, content, 'item', /(?:DeferredRegister\.Items|DeferredItem<|RegistryObject<\s*Item|ITEMS\.register)\b[\s\S]{0,160}?"([a-z0-9_/-]+)"/g);
    collectTargets(targets, content, 'block', /(?:BlockItem\s*\(\s*[A-Z0-9_]+\s*,[\s\S]{0,80}?"([a-z0-9_/-]+)"|new\s+Block\s*\([\s\S]{0,120}?"([a-z0-9_/-]+)")/g);
    collectTargets(targets, content, 'item', /(?:new\s+Item\s*\(|Item\.Settings[\s\S]{0,120}?"([a-z0-9_/-]+)")/g);

    if (/Blocks?\.java$/i.test(normalizedPath)) {
      collectTargets(targets, content, 'block', /"([a-z0-9_/-]+)"/g);
    } else if (/Items?\.java$/i.test(normalizedPath)) {
      collectTargets(targets, content, 'item', /"([a-z0-9_/-]+)"/g);
    }

    collectTargetsFromResourceFile(targets, normalizedPath, content, modId);
  }

  const list = Array.from(targets.values())
    .filter(target => target.id && !target.id.startsWith('minecraft/'));

  if (!list.length) {
    const fallbackKind = inferFallbackKind(loader, textEntries);
    if (fallbackKind) {
      list.push({ kind: fallbackKind, id: modId });
    }
  }

  return list;
}

function collectTargets(targets, content, kind, regex) {
  let match;
  while ((match = regex.exec(content)) !== null) {
    const rawId = match.slice(1).find(Boolean);
    const id = sanitizeTextureId(rawId);
    if (!id) continue;
    const key = `${kind}:${id}`;
    if (!targets.has(key)) {
      targets.set(key, { kind, id });
    }
  }
}

function collectTargetsFromResourceFile(targets, normalizedPath, content, modId) {
  const blockModelMatch = normalizedPath.match(new RegExp(`^src/main/resources/assets/${escapeRegExp(modId)}/models/block/([a-z0-9_/-]+)\\.json$`, 'i'));
  if (blockModelMatch) {
    const id = sanitizeTextureId(blockModelMatch[1]);
    if (id) targets.set(`block:${id}`, { kind: 'block', id });
  }

  const itemModelMatch = normalizedPath.match(new RegExp(`^src/main/resources/assets/${escapeRegExp(modId)}/models/item/([a-z0-9_/-]+)\\.json$`, 'i'));
  if (itemModelMatch && /minecraft:item\/generated|minecraft:item\/handheld/i.test(content)) {
    const id = sanitizeTextureId(itemModelMatch[1]);
    if (id) targets.set(`item:${id}`, { kind: 'item', id });
  }

  const blockTextureRefs = Array.from(content.matchAll(/"(?:all|top|bottom|side|end|particle|north|south|east|west|up|down)"\s*:\s*"[^"]*?:block\/([a-z0-9_/-]+)"/g));
  blockTextureRefs.forEach(match => {
    const id = sanitizeTextureId(match[1]);
    if (id) targets.set(`block:${id}`, { kind: 'block', id });
  });

  const itemTextureRefs = Array.from(content.matchAll(/"layer\d+"\s*:\s*"[^"]*?:item\/([a-z0-9_/-]+)"/g));
  itemTextureRefs.forEach(match => {
    const id = sanitizeTextureId(match[1]);
    if (id) targets.set(`item:${id}`, { kind: 'item', id });
  });
}

function normalizeTextFile(file) {
  if (typeof file === 'string') {
    return { encoding: 'utf8', content: file };
  }
  if (!file || file.encoding === 'base64' || typeof file.content !== 'string') {
    return null;
  }
  return {
    encoding: 'utf8',
    content: file.content,
  };
}

function inferFallbackKind(loader, textEntries) {
  if (loader === 'fabric' || loader === 'forge' || loader === 'neoforge') {
    const blob = textEntries.map(([, file]) => file.content).join('\n');
    if (/\bBlock\b/.test(blob)) return 'block';
    if (/\bItem\b/.test(blob)) return 'item';
  }
  return null;
}

function sanitizeTextureId(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^.*:/, '')
    .replace(/[^a-z0-9_/-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || null;
}

function buildTexturePrompt({ loader, version, modName, modId, target, userRequest }) {
  const kindText = target.kind === 'block'
    ? 'block texture'
    : 'item icon texture';
  const usageHint = target.kind === 'block'
    ? 'Create a seamless square block texture suitable for a simple cube block model.'
    : 'Create a centered item sprite suitable for a standard generated item model with transparency.';

  return [
    `Generate one Minecraft-inspired pixel art ${kindText}.`,
    `Mod name: ${modName}. Mod id: ${modId}. Loader: ${loader}. Minecraft version: ${version}.`,
    `Asset id: ${target.id}.`,
    userRequest ? `Original user request: ${userRequest}` : '',
    usageHint,
    'Style rules:',
    '- Pixel art only.',
    '- Readable in vanilla Minecraft at small size.',
    '- 16x16 texture feel, even if rendered at higher resolution.',
    '- Clean silhouette, simple shading, game-ready.',
    '- No text, no UI, no watermark, no mockup frame.',
    '- Preserve a Minecraft-like survival-game aesthetic without copying any exact Mojang texture.',
    target.kind === 'item'
      ? '- Transparent background outside the sprite.'
      : '- Fill the full square canvas and keep edges tile-friendly.',
  ].filter(Boolean).join('\n');
}

async function createImageAgent(apiKey, model) {
  const response = await fetch('https://api.mistral.ai/v1/agents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model,
      name: 'Texture Generation Agent',
      description: 'Temporary agent for Minecraft texture generation.',
      instructions: 'Use the image generation tool to create the requested texture image.',
      tools: [{ type: 'image_generation' }],
      completion_args: { temperature: 0.3, top_p: 0.95 },
    }),
  });

  const text = await response.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = {}; }

  if (!response.ok) {
    const message = json?.message || json?.error?.message || json?.error || text || `Agent creation failed with HTTP ${response.status}.`;
    throw new Error(message);
  }

  const agentId = json?.id;
  if (!agentId) throw new Error('Mistral did not return an agent ID.');
  return agentId;
}

async function generateTextureImage({ apiKey, prompt }) {
  const model = process.env.MISTRAL_TEXTURE_MODEL || 'mistral-medium-2505';
  const cacheKey = `${apiKey}:${model}`;
  const baseHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let agentId = agentIdCache.get(cacheKey);
    if (!agentId) {
      agentId = await createImageAgent(apiKey, model);
      agentIdCache.set(cacheKey, agentId);
    }

    const convResponse = await fetch('https://api.mistral.ai/v1/conversations', {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        agent_id: agentId,
        inputs: prompt,
        stream: false,
        store: false,
      }),
    });

    const convText = await convResponse.text();
    let convJson = {};
    try { convJson = JSON.parse(convText); } catch { convJson = {}; }

    if (!convResponse.ok) {
      agentIdCache.delete(cacheKey);
      const message = convJson?.message || convJson?.error?.message || convJson?.error || convText || `Texture generation failed with HTTP ${convResponse.status}.`;
      if (attempt < 2) continue;
      throw new Error(message);
    }

    const fileId = findFirstFileId(convJson);
    if (!fileId) {
      agentIdCache.delete(cacheKey);
      if (attempt < 2) continue;
      throw new Error('Texture generation did not return an image file id.');
    }

    const fileResponse = await fetch(`https://api.mistral.ai/v1/files/${encodeURIComponent(fileId)}/content`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'image/png,application/octet-stream',
      },
    });

    if (!fileResponse.ok) {
      const message = await fileResponse.text().catch(() => '');
      agentIdCache.delete(cacheKey);
      if (attempt < 2) continue;
      throw new Error(message || `Could not download generated texture (HTTP ${fileResponse.status}).`);
    }

    return Buffer.from(await fileResponse.arrayBuffer());
  }

  throw new Error('Texture generation failed unexpectedly.');
}

function findFirstFileId(value) {
  const seen = new Set();
  const queue = [value];

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    if (typeof current.file_id === 'string' && current.file_id) return current.file_id;
    if (typeof current.fileId === 'string' && current.fileId) return current.fileId;
    if (Array.isArray(current.file_ids)) {
      const first = current.file_ids.find(item => typeof item === 'string' && item);
      if (first) return first;
    }
    if (Array.isArray(current.fileIds)) {
      const first = current.fileIds.find(item => typeof item === 'string' && item);
      if (first) return first;
    }

    for (const child of Object.values(current)) {
      if (child && typeof child === 'object') {
        queue.push(child);
      }
    }
  }

  return null;
}

function hasTextureFile(files, modId, target) {
  return Boolean(files[texturePathFor(modId, target)]);
}

function applyTextureFiles(files, modId, target, imageBytes) {
  files[texturePathFor(modId, target)] = {
    encoding: 'base64',
    content: Buffer.from(imageBytes).toString('base64'),
  };

  if (target.kind === 'item') {
    files[`src/main/resources/assets/${modId}/models/item/${target.id}.json`] = {
      encoding: 'utf8',
      content: JSON.stringify({
        parent: 'minecraft:item/generated',
        textures: {
          layer0: `${modId}:item/${target.id}`,
        },
      }, null, 2),
    };
  } else {
    files[`src/main/resources/assets/${modId}/blockstates/${target.id}.json`] = {
      encoding: 'utf8',
      content: JSON.stringify({
        variants: {
          '': {
            model: `${modId}:block/${target.id}`,
          },
        },
      }, null, 2),
    };
    files[`src/main/resources/assets/${modId}/models/block/${target.id}.json`] = {
      encoding: 'utf8',
      content: JSON.stringify({
        parent: 'minecraft:block/cube_all',
        textures: {
          all: `${modId}:block/${target.id}`,
        },
      }, null, 2),
    };
    files[`src/main/resources/assets/${modId}/models/item/${target.id}.json`] = {
      encoding: 'utf8',
      content: JSON.stringify({
        parent: `${modId}:block/${target.id}`,
      }, null, 2),
    };
  }

  mergeLangEntry(files, modId, target);
}

function mergeLangEntry(files, modId, target) {
  const langPath = `src/main/resources/assets/${modId}/lang/en_us.json`;
  let json = {};
  const existing = files[langPath];
  const normalizedExisting = typeof existing === 'string'
    ? { encoding: 'utf8', content: existing }
    : existing;
  if (normalizedExisting && normalizedExisting.encoding !== 'base64') {
    try {
      json = JSON.parse(normalizedExisting.content || '{}');
    } catch {
      json = {};
    }
  }

  const key = `${target.kind}.${modId}.${target.id}`;
  if (!json[key]) {
    json[key] = toDisplayName(target.id);
  }

  files[langPath] = {
    encoding: 'utf8',
    content: JSON.stringify(json, null, 2),
  };
}

function texturePathFor(modId, target) {
  const folder = target.kind === 'block' ? 'block' : 'item';
  return `src/main/resources/assets/${modId}/textures/${folder}/${target.id}.png`;
}

function extractLatestUserRequest(conversation) {
  const items = Array.isArray(conversation) ? conversation.slice().reverse() : [];
  for (const item of items) {
    if (item?.role !== 'user') continue;
    const content = String(item.content || '');
    const marker = '[User request]';
    if (content.includes(marker)) {
      return content.split(marker).pop().trim();
    }
    if (content.trim()) {
      return content.trim();
    }
  }
  return '';
}

function toDisplayName(id) {
  return String(id || '')
    .split(/[\/_-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Generated Asset';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeModId(modName) {
  const cleaned = String(modName || 'minecraftmod')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'minecraftmod';
}
