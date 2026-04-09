import fs from 'node:fs/promises';
import path from 'node:path';
import { get, head, list, put } from '@vercel/blob';

const STORE_PREFIX = 'mod-build-jobs';
const STORE_MODE = resolveStoreMode();
const BLOB_ACCESS = process.env.BLOB_STORE_ACCESS === 'private' ? 'private' : 'public';
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const FILESYSTEM_ROOT = path.resolve(process.env.BUILD_STORE_DIR || path.join(process.cwd(), '.data', 'build-jobs'));

export function hasBlobToken() {
  return STORE_MODE === 'filesystem' || Boolean(BLOB_TOKEN);
}

export function getBlobAccess() {
  return STORE_MODE === 'filesystem' ? 'filesystem' : BLOB_ACCESS;
}

export async function putJson(jobId, fileName, value) {
  await writeValue(jobId, fileName, JSON.stringify(value), 'application/json; charset=utf-8');
}

export async function putText(jobId, fileName, value, contentType = 'text/plain; charset=utf-8') {
  await writeValue(jobId, fileName, String(value ?? ''), contentType);
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
  const stamp = formatStatusStamp(value?.updatedAt || new Date().toISOString());
  const suffix = Math.random().toString(36).slice(2, 8);
  const body = JSON.stringify(value);

  if (STORE_MODE === 'filesystem') {
    await writeFilesystemValue(jobId, `status/${stamp}-${suffix}.json`, body);
    await writeFilesystemValue(jobId, 'status/latest.json', body);
    return;
  }

  await put(blobPath(jobId, `status/${stamp}-${suffix}.json`), body, buildBlobWriteOptions('application/json; charset=utf-8', 60));
  await put(blobPath(jobId, 'status/latest.json'), body, buildBlobWriteOptions('application/json; charset=utf-8', 0));
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
    const blob = await get(blobPath(jobId, fileName), { access: BLOB_ACCESS, token: BLOB_TOKEN });
    if (!blob) return null;
    const response = await fetch(blob.url, { headers: buildBlobReadHeaders(), cache: 'no-store' });
    if (!response.ok) return null;
    return await response.text();
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
      const targetPath = filesystemPath(jobId, fileName);
      return {
        buffer: await fs.readFile(targetPath),
        metadata: await fs.stat(targetPath),
        response: null,
      };
    } catch {
      return null;
    }
  }

  try {
    const blob = await get(blobPath(jobId, fileName), { access: BLOB_ACCESS, token: BLOB_TOKEN });
    if (!blob) return null;
    const response = await fetch(blob.url, { headers: buildBlobReadHeaders(), cache: 'no-store' });
    if (!response.ok) return null;
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      metadata: blob,
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
  const latest = await getJson(jobId, 'status/latest.json');
  if (latest) return latest;

  if (STORE_MODE === 'filesystem') {
    return readLatestFilesystemStatus(jobId);
  }

  try {
    const result = await list({
      prefix: blobPath(jobId, 'status/'),
      token: BLOB_TOKEN,
    });
    const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
    const latestBlob = blobs
      .filter(blob => blob.pathname.endsWith('.json') && !blob.pathname.endsWith('/latest.json'))
      .sort(compareBlobStatus)
      [0];
    if (!latestBlob) return null;

    const response = await fetch(latestBlob.url, { headers: buildBlobReadHeaders(), cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function blobPath(jobId, fileName) {
  return `${STORE_PREFIX}/${jobId}/${fileName}`;
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

async function writeValue(jobId, fileName, value, contentType) {
  if (STORE_MODE === 'filesystem') {
    await writeFilesystemValue(jobId, fileName, value);
    return;
  }

  await put(blobPath(jobId, fileName), value, buildBlobWriteOptions(contentType, 0));
}

async function writeFilesystemValue(jobId, fileName, value) {
  const targetPath = filesystemPath(jobId, fileName);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, value);
}

function buildBlobWriteOptions(contentType, cacheControlMaxAge) {
  return {
    access: BLOB_ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
    cacheControlMaxAge,
    token: BLOB_TOKEN,
  };
}

function buildBlobReadHeaders() {
  return BLOB_ACCESS === 'private' && BLOB_TOKEN
    ? { Authorization: `Bearer ${BLOB_TOKEN}` }
    : {};
}

function formatStatusStamp(value) {
  return String(value)
    .replace(/[^0-9A-Za-z]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function readLatestFilesystemStatus(jobId) {
  try {
    const statusDirectory = filesystemPath(jobId, 'status');
    const entries = await fs.readdir(statusDirectory, { withFileTypes: true });
    const latestFileName = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'latest.json')
      .map(entry => entry.name)
      .sort()
      .pop();

    if (!latestFileName) return null;

    const text = await fs.readFile(path.join(statusDirectory, latestFileName), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function compareBlobStatus(left, right) {
  const leftTime = Date.parse(left.uploadedAt || left.pathname || '') || 0;
  const rightTime = Date.parse(right.uploadedAt || right.pathname || '') || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(right.pathname || '').localeCompare(String(left.pathname || ''));
}
