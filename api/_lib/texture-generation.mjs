const MAX_TEXTURE_TARGETS = 3;
const DEFAULT_TEXTURE_MODEL = 'mistral-medium-2505';
const agentCache = new Map();

export async function enrichProjectWithGeneratedTextures({ apiKey, loader, version, modName, files, conversation }) {
  const generatedTextures = [];
  const textureWarnings = [];

  if (!apiKey || !files || typeof files !== 'object') {
    return { generatedTextures, textureWarnings };
  }

  const modId = safeModId(modName);
  const targets = detectTextureTargets({ loader, files, modId }).slice(0, MAX_TEXTURE_TARGETS);
  if (!targets.length) {
    return { generatedTextures, textureWarnings };
  }

  const latestUserRequest = extractLatestUserRequest(conversation);

  for (const target of targets) {
    try {
      if (files[getTexturePath(modId, target)]) {
        continue;
      }

      const imageBytes = await generateTextureImage({
        apiKey,
        prompt: buildTexturePrompt({
          loader,
          version,
          modName,
          modId,
          target,
          latestUserRequest,
        }),
      });

      applyTextureFiles(files, modId, target, imageBytes);
      generatedTextures.push({
        kind: target.kind,
        id: target.id,
        texturePath: getTexturePath(modId, target),
      });
    } catch (error) {
      textureWarnings.push(`Texture generation skipped for ${target.kind} "${target.id}": ${error?.message || 'unknown error'}`);
    }
  }

  return { generatedTextures, textureWarnings };
}

function detectTextureTargets({ loader, files, modId }) {
  const textEntries = Object.entries(files)
    .map(([filePath, file]) => [normalizePath(filePath), normalizeTextFile(file)])
    .filter(([, file]) => file);

  const targets = new Map();
  for (const [filePath, file] of textEntries) {
    collectTargetsFromCode(targets, file.content);
    collectTargetsFromResources(targets, filePath, file.content, modId);
  }

  const resolved = [...targets.values()].filter(target => target.id && !target.id.startsWith('minecraft/'));
  if (resolved.length) {
    return resolved;
  }

  const fallbackKind = inferFallbackKind(loader, textEntries);
  return fallbackKind ? [{ kind: fallbackKind, id: modId }] : [];
}

function collectTargetsFromCode(targets, content) {
  const rules = [
    { kind: 'block', regex: /Registr(?:y|ies)\.BLOCK[\s\S]{0,260}?(?:Identifier\.of|new Identifier|ResourceLocation\.fromNamespaceAndPath|new ResourceLocation)\s*\([^,\n]+,\s*"([a-z0-9_/-]+)"/g },
    { kind: 'item', regex: /Registr(?:y|ies)\.ITEM[\s\S]{0,260}?(?:Identifier\.of|new Identifier|ResourceLocation\.fromNamespaceAndPath|new ResourceLocation)\s*\([^,\n]+,\s*"([a-z0-9_/-]+)"/g },
    { kind: 'block', regex: /(?:DeferredRegister\.Blocks|DeferredBlock<|RegistryObject<\s*Block|BLOCKS\.register)\b[\s\S]{0,160}?"([a-z0-9_/-]+)"/g },
    { kind: 'item', regex: /(?:DeferredRegister\.Items|DeferredItem<|RegistryObject<\s*Item|ITEMS\.register)\b[\s\S]{0,160}?"([a-z0-9_/-]+)"/g },
    { kind: 'block', regex: /(?:BlockItem\s*\(\s*[A-Z0-9_]+\s*,[\s\S]{0,80}?"([a-z0-9_/-]+)"|new\s+Block\s*\([\s\S]{0,120}?"([a-z0-9_/-]+)")/g },
  ];

  for (const rule of rules) {
    let match;
    while ((match = rule.regex.exec(content)) !== null) {
      const id = sanitizeTextureId(match.slice(1).find(Boolean));
      if (id) {
        targets.set(`${rule.kind}:${id}`, { kind: rule.kind, id });
      }
    }
  }
}

function collectTargetsFromResources(targets, filePath, content, modId) {
  const blockModel = filePath.match(new RegExp(`^src/main/resources/assets/${escapeRegExp(modId)}/models/block/([a-z0-9_/-]+)\\.json$`, 'i'));
  if (blockModel) {
    const id = sanitizeTextureId(blockModel[1]);
    if (id) targets.set(`block:${id}`, { kind: 'block', id });
  }

  const itemModel = filePath.match(new RegExp(`^src/main/resources/assets/${escapeRegExp(modId)}/models/item/([a-z0-9_/-]+)\\.json$`, 'i'));
  if (itemModel) {
    const id = sanitizeTextureId(itemModel[1]);
    if (id) targets.set(`item:${id}`, { kind: 'item', id });
  }

  for (const match of content.matchAll(/"(?:all|top|bottom|side|end|particle|north|south|east|west|up|down)"\s*:\s*"[^"]*?:block\/([a-z0-9_/-]+)"/g)) {
    const id = sanitizeTextureId(match[1]);
    if (id) targets.set(`block:${id}`, { kind: 'block', id });
  }

  for (const match of content.matchAll(/"layer\d+"\s*:\s*"[^"]*?:item\/([a-z0-9_/-]+)"/g)) {
    const id = sanitizeTextureId(match[1]);
    if (id) targets.set(`item:${id}`, { kind: 'item', id });
  }
}

function inferFallbackKind(loader, entries) {
  if (!['fabric', 'forge', 'neoforge'].includes(String(loader || '').toLowerCase())) {
    return null;
  }
  const blob = entries.map(([, file]) => file.content).join('\n');
  if (/\bBlock\b/.test(blob)) return 'block';
  if (/\bItem\b/.test(blob)) return 'item';
  return null;
}

async function generateTextureImage({ apiKey, prompt }) {
  const model = process.env.MISTRAL_TEXTURE_MODEL || DEFAULT_TEXTURE_MODEL;
  const cacheKey = `${apiKey}:${model}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const agentId = await ensureTextureAgent({ apiKey, model, cacheKey });
      const conversation = await mistralJson('https://api.mistral.ai/v1/conversations', {
        apiKey,
        method: 'POST',
        body: {
          agent_id: agentId,
          inputs: prompt,
          stream: false,
          store: false,
        },
      });

      const fileId = findFirstFileId(conversation);
      if (!fileId) {
        throw new Error('Texture generation did not return an image file id.');
      }

      return await downloadTextureFile(apiKey, fileId);
    } catch (error) {
      agentCache.delete(cacheKey);
      if (attempt === 1) {
        throw error;
      }
    }
  }

  throw new Error('Texture generation failed unexpectedly.');
}

async function ensureTextureAgent({ apiKey, model, cacheKey }) {
  const cached = agentCache.get(cacheKey);
  if (cached) return cached;

  const response = await mistralJson('https://api.mistral.ai/v1/agents', {
    apiKey,
    method: 'POST',
    body: {
      model,
      name: 'Texture Generation Agent',
      description: 'Temporary agent for Minecraft texture generation.',
      instructions: 'Use the image generation tool to create the requested texture image.',
      tools: [{ type: 'image_generation' }],
      completion_args: { temperature: 0.3, top_p: 0.95 },
    },
  });

  const agentId = response?.id;
  if (!agentId) {
    throw new Error('Mistral did not return an agent ID.');
  }

  agentCache.set(cacheKey, agentId);
  return agentId;
}

async function downloadTextureFile(apiKey, fileId) {
  const response = await fetch(`https://api.mistral.ai/v1/files/${encodeURIComponent(fileId)}/content`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'image/png,application/octet-stream',
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Could not download generated texture (HTTP ${response.status}).`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function mistralJson(url, { apiKey, method = 'GET', body }) {
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload?.message || payload?.error?.message || payload?.error || text || `Mistral request failed with HTTP ${response.status}.`);
  }

  return payload;
}

function applyTextureFiles(files, modId, target, imageBytes) {
  files[getTexturePath(modId, target)] = {
    encoding: 'base64',
    content: Buffer.from(imageBytes).toString('base64'),
  };

  if (target.kind === 'item') {
    files[`src/main/resources/assets/${modId}/models/item/${target.id}.json`] = {
      encoding: 'utf8',
      content: JSON.stringify({
        parent: 'minecraft:item/generated',
        textures: { layer0: `${modId}:item/${target.id}` },
      }, null, 2),
    };
  } else {
    files[`src/main/resources/assets/${modId}/blockstates/${target.id}.json`] = {
      encoding: 'utf8',
      content: JSON.stringify({
        variants: {
          '': { model: `${modId}:block/${target.id}` },
        },
      }, null, 2),
    };
    files[`src/main/resources/assets/${modId}/models/block/${target.id}.json`] = {
      encoding: 'utf8',
      content: JSON.stringify({
        parent: 'minecraft:block/cube_all',
        textures: { all: `${modId}:block/${target.id}` },
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
  const existing = normalizeTextFile(files[langPath]);
  let json = {};
  if (existing) {
    try {
      json = JSON.parse(existing.content || '{}');
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

function getTexturePath(modId, target) {
  return `src/main/resources/assets/${modId}/textures/${target.kind === 'block' ? 'block' : 'item'}/${target.id}.png`;
}

function buildTexturePrompt({ loader, version, modName, modId, target, latestUserRequest }) {
  const kindText = target.kind === 'block' ? 'block texture' : 'item icon texture';
  const usageHint = target.kind === 'block'
    ? 'Create a seamless square block texture suitable for a simple cube block model.'
    : 'Create a centered item sprite suitable for a standard generated item model with transparency.';

  return [
    `Generate one Minecraft-inspired pixel art ${kindText}.`,
    `Mod name: ${modName}. Mod id: ${modId}. Loader: ${loader}. Minecraft version: ${version}.`,
    `Asset id: ${target.id}.`,
    latestUserRequest ? `Original user request: ${latestUserRequest}` : '',
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

function extractLatestUserRequest(conversation) {
  const items = Array.isArray(conversation) ? [...conversation].reverse() : [];
  for (const item of items) {
    if (item?.role !== 'user') continue;
    const content = String(item.content || '').trim();
    if (content) return content;
  }
  return '';
}

function findFirstFileId(value) {
  const queue = [value];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);

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

function normalizeTextFile(file) {
  if (typeof file === 'string') {
    return { encoding: 'utf8', content: file };
  }
  if (!file || file.encoding === 'base64' || typeof file.content !== 'string') {
    return null;
  }
  return { encoding: 'utf8', content: file.content };
}

function normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function sanitizeTextureId(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/^.*:/, '')
    .replace(/[^a-z0-9_/-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || null;
}

function safeModId(modName) {
  const cleaned = String(modName || 'minecraftmod')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'minecraftmod';
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
