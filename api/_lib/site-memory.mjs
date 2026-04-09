import fs from 'node:fs/promises';
import path from 'node:path';

const MEMORY_ROOT = path.resolve(process.env.MEMORY_STORE_DIR || path.join(process.cwd(), '.data', 'site-memory'));
const MEMORY_FILE = path.join(MEMORY_ROOT, 'entries.jsonl');
const MAX_ENTRIES = Number(process.env.SITE_MEMORY_MAX_ENTRIES || 1500);

export async function rememberChatInteraction({ loader, version, prompt, response, model }) {
  const cleanPrompt = compactText(prompt, 2500);
  if (!cleanPrompt) return;
  await appendEntry({
    type: 'chat',
    loader: loader || '',
    version: version || '',
    prompt: cleanPrompt,
    response: compactText(response, 2500),
    model: model || '',
    summary: compactText(`${cleanPrompt}\n${response || ''}`, 400),
    createdAt: new Date().toISOString(),
  });
}

export async function rememberBuildOutcome({ loader, version, modName, prompt, success, failureSignature, fixSummary, changedFiles, buildLog }) {
  await appendEntry({
    type: 'build',
    loader: loader || '',
    version: version || '',
    modName: modName || '',
    prompt: compactText(prompt, 1800),
    success: Boolean(success),
    failureSignature: compactText(failureSignature, 1200),
    fixSummary: compactText(fixSummary, 500),
    changedFiles: Array.isArray(changedFiles) ? changedFiles.slice(0, 10) : [],
    buildLog: compactText(buildLog, 2500),
    summary: compactText([failureSignature, fixSummary].filter(Boolean).join(' | '), 400),
    createdAt: new Date().toISOString(),
  });
}

export async function retrieveRelevantMemories({ query, loader = '', version = '', type = '', limit = 4 }) {
  const cleanQuery = compactText(query, 3000);
  if (!cleanQuery) return [];

  const entries = await readEntries();
  if (!entries.length) return [];

  const scored = entries
    .filter(entry => !type || entry.type === type)
    .map(entry => ({ entry, score: scoreEntry(entry, cleanQuery, loader, version) }))
    .filter(item => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(b.entry.createdAt || '').localeCompare(String(a.entry.createdAt || ''));
    })
    .slice(0, limit);

  return scored.map(({ entry }) => formatMemory(entry));
}

async function appendEntry(entry) {
  try {
    await fs.mkdir(MEMORY_ROOT, { recursive: true });
    await fs.appendFile(MEMORY_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
    await trimEntries();
  } catch {}
}

async function trimEntries() {
  try {
    const entries = await readEntries();
    if (entries.length <= MAX_ENTRIES) return;
    const trimmed = entries.slice(entries.length - MAX_ENTRIES);
    await fs.writeFile(MEMORY_FILE, trimmed.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  } catch {}
}

async function readEntries() {
  try {
    const text = await fs.readFile(MEMORY_FILE, 'utf8');
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function scoreEntry(entry, query, loader, version) {
  const entryTokens = tokenize([
    entry.prompt,
    entry.response,
    entry.failureSignature,
    entry.fixSummary,
    entry.summary,
    entry.modName,
    entry.buildLog,
  ].filter(Boolean).join(' '));
  if (!entryTokens.size) return 0;

  const queryTokens = tokenize(query);
  let score = 0;
  for (const token of queryTokens) {
    if (entryTokens.has(token)) score += 3;
  }
  if (loader && entry.loader === loader) score += 6;
  if (version && entry.version === version) score += 5;
  if (entry.success) score += 2;
  if (entry.fixSummary) score += 1;
  return score;
}

function formatMemory(entry) {
  if (entry.type === 'build') {
    return {
      type: entry.type,
      loader: entry.loader,
      version: entry.version,
      createdAt: entry.createdAt,
      text: compactText(
        `Prior build memory for ${entry.loader} ${entry.version}${entry.modName ? ` (${entry.modName})` : ''}: `
        + `${entry.failureSignature || 'no failure signature'}`
        + `${entry.fixSummary ? ` Fix tried: ${entry.fixSummary}.` : ''}`
        + `${entry.changedFiles?.length ? ` Changed files: ${entry.changedFiles.join(', ')}.` : ''}`,
        500,
      ),
    };
  }

  return {
    type: entry.type,
    loader: entry.loader,
    version: entry.version,
    createdAt: entry.createdAt,
    text: compactText(
      `Prior chat memory for ${entry.loader} ${entry.version}: Prompt: ${entry.prompt || ''} Response summary: ${entry.summary || entry.response || ''}`,
      500,
    ),
  };
}

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(token => token.length >= 3 && !STOP_WORDS.has(token)),
  );
}

function compactText(text, maxChars) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'you', 'your', 'mod', 'build', 'java',
  'fabric', 'forge', 'item', 'block', 'minecraft', 'code', 'file', 'files', 'into', 'have', 'has', 'had',
]);
