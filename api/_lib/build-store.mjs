import fs from 'node:fs/promises';
import path from 'node:path';
import { put, head, get, list } from '@vercel/blob';

const STORE_PREFIX = 'mod-build-jobs';
const BLOB_ACCESS = process.env.BLOB_STORE_ACCESS === 'private' ? 'private' : 'public';
const HARDCODED_BLOB_TOKEN = 'vercel_blob_rw_tEgsM9dmjIFAglxs_MPuvPzWupIRoFSJlBsz73vpoujgOGr';
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || HARDCODED_BLOB_TOKEN;
const STORE_MODE = resolveStoreMode();
const FILESYSTEM_ROOT = path.resolve(process.env.BUILD_STORE_DIR || path.join(process.cwd(), '.data', 'build-jobs'));

export function blobPath(jobId, fileName) {
  return `${STORE_PREFIX}/${jobId}/${fileName}`;
}

function statusPrefix(jobId) {
  return `${STORE_PREFIX}/${jobId}/status/`;
}

function latestStatusPath(jobId) {
  return `${statusPrefix(jobId)}latest.json`;
}

export async function putJson(jobId, fileName, value) {
  if (STORE_MODE === 'filesystem') {
    await writeFilesystemValue(jobId, fileName, JSON.stringify(value));
    return;
  }

  await put(blobPath(jobId, fileName), JSON.stringify(value), {
    access: BLOB_ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 0,
    token: BLOB_TOKEN,
  });
}

export async function putText(jobId, fileName, value, contentType = 'text/plain; charset=utf-8') {
  if (STORE_MODE === 'filesystem') {
    await writeFilesystemValue(jobId, fileName, String(value || ''));
    return;
  }

  await put(blobPath(jobId, fileName), String(value || ''), {
    access: BLOB_ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
    cacheControlMaxAge: 0,
    token: BLOB_TOKEN,
  });
}

export async function putBytes(jobId, fileName, value, contentType, cacheControlMaxAge = 0) {
  if (STORE_MODE === 'filesystem') {
    await writeFilesystemValue(jobId, fileName, value);
    return;
  }

  await put(blobPath(jobId, fileName), value, {
    access: BLOB_ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
    cacheControlMaxAge,
    token: BLOB_TOKEN,
  });
}

export async function putStatus(jobId, value) {
  const stamp = String(value?.updatedAt || new Date().toISOString())
    .replace(/[^0-9A-Za-z]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = Math.random().toString(36).slice(2, 8);
  const pathname = `${statusPrefix(jobId)}${stamp}-${suffix}.json`;
  const body = JSON.stringify(value);

  if (STORE_MODE === 'filesystem') {
    await writeFilesystemValue(jobId, `status/${stamp}-${suffix}.json`, body);
    await writeFilesystemValue(jobId, 'status/latest.json', body);
    return;
  }

  await put(pathname, body, {
    access: BLOB_ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 60,
    token: BLOB_TOKEN,
  });

  await put(latestStatusPath(jobId), body, {
    access: BLOB_ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 0,
    token: BLOB_TOKEN,
  });
}

export async function getText(jobId, fileName) {
  if (STORE_MODE === 'filesystem') {
    try {
      return await fs.readFile(filesystemPath(jobId, fileName), 'utf8');
    } catch {
      return null;
    }
  }

  try {
    const result = await get(blobPath(jobId, fileName), {
      access: BLOB_ACCESS,
      token: BLOB_TOKEN,
    });
    if (!result) return null;
    const response = await fetch(result.url, {
      headers: authHeaders(),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return response.text();
  } catch {
    return null;
  }
}

export async function getJson(jobId, fileName) {
  const text = await getText(jobId, fileName);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function getBytes(jobId, fileName) {
  if (STORE_MODE === 'filesystem') {
    try {
      const filePath = filesystemPath(jobId, fileName);
      return {
        buffer: await fs.readFile(filePath),
        metadata: await fs.stat(filePath),
        response: null,
      };
    } catch {
      return null;
    }
  }

  try {
    const result = await get(blobPath(jobId, fileName), {
      access: BLOB_ACCESS,
      token: BLOB_TOKEN,
    });
    if (!result) return null;
    const response = await fetch(result.url, {
      headers: authHeaders(),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      metadata: result,
      response,
    };
  } catch {
    return null;
  }
}

export async function getBlobMetadata(jobId, fileName) {
  if (STORE_MODE === 'filesystem') {
    try {
      return await fs.stat(filesystemPath(jobId, fileName));
    } catch {
      return null;
    }
  }

  try {
    return await head(blobPath(jobId, fileName), { token: BLOB_TOKEN });
  } catch {
    return null;
  }
}

export async function getLatestStatus(jobId) {
  try {
    const latestText = await getText(jobId, 'status/latest.json');
    if (latestText) {
      try {
        return JSON.parse(latestText);
      } catch {
        // Fall through to timestamped-status discovery below.
      }
    }

    if (STORE_MODE === 'filesystem') {
      const dir = filesystemPath(jobId, 'status');
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      const latest = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'latest.json')
        .map(entry => entry.name)
        .sort()
        .pop();
      if (!latest) return null;
      const text = await fs.readFile(path.join(dir, latest), 'utf8').catch(() => '');
      return text ? JSON.parse(text) : null;
    }

    const result = await list({
      prefix: statusPrefix(jobId),
      token: BLOB_TOKEN,
    });

    const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
    if (blobs.length === 0) {
      return null;
    }

    const latest = blobs
      .slice()
      .sort((a, b) => {
        const aTime = Date.parse(a.uploadedAt || a.pathname || '') || 0;
        const bTime = Date.parse(b.uploadedAt || b.pathname || '') || 0;
        if (aTime !== bTime) return bTime - aTime;
        return String(b.pathname || '').localeCompare(String(a.pathname || ''));
      })[0];

    const response = await fetch(latest.url, {
      headers: authHeaders(),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export function getBlobAccess() {
  return STORE_MODE === 'filesystem' ? 'filesystem' : BLOB_ACCESS;
}

export function hasBlobToken() {
  return STORE_MODE === 'filesystem' || Boolean(BLOB_TOKEN);
}

function authHeaders() {
  return BLOB_ACCESS === 'private' && BLOB_TOKEN
    ? { Authorization: `Bearer ${BLOB_TOKEN}` }
    : {};
}

function resolveStoreMode() {
  const requested = String(process.env.BUILD_STORE_MODE || '').toLowerCase();
  if (requested === 'filesystem' || requested === 'local') return 'filesystem';
  if (requested === 'blob' || requested === 'vercel-blob') return 'blob';
  return process.env.VERCEL ? 'blob' : 'filesystem';
}

function filesystemPath(jobId, fileName) {
  return path.join(FILESYSTEM_ROOT, ...blobPath(jobId, fileName).split('/'));
}

async function writeFilesystemValue(jobId, fileName, value) {
  const target = filesystemPath(jobId, fileName);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
}
