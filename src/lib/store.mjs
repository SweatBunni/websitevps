/**
 * store.mjs — filesystem-only job store for VPS deployments.
 * Replaces the old build-store.mjs which depended on @vercel/blob / @netlify/blobs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const STORE_ROOT = path.resolve(
  process.env.BUILD_STORE_DIR || path.join(process.cwd(), '.data', 'build-jobs'),
);

// ─── write helpers ────────────────────────────────────────────────────────────

export async function putJson(jobId, fileName, value) {
  await _write(jobId, fileName, JSON.stringify(value));
}

export async function putText(jobId, fileName, value) {
  await _write(jobId, fileName, String(value ?? ''));
}

export async function putBytes(jobId, fileName, value) {
  await _write(jobId, fileName, value);
}

export async function putStatus(jobId, value) {
  const body = JSON.stringify(value);
  const stamp = _stamp(value?.updatedAt);
  const suffix = Math.random().toString(36).slice(2, 8);
  await _write(jobId, `status/${stamp}-${suffix}.json`, body);
  await _write(jobId, 'status/latest.json', body);
}

// ─── read helpers ─────────────────────────────────────────────────────────────

export async function getText(jobId, fileName) {
  try {
    return await fs.readFile(_path(jobId, fileName), 'utf8');
  } catch {
    return null;
  }
}

export async function getJson(jobId, fileName) {
  const text = await getText(jobId, fileName);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export async function getBytes(jobId, fileName) {
  try {
    const target = _path(jobId, fileName);
    const [buffer, stats] = await Promise.all([fs.readFile(target), fs.stat(target)]);
    return { buffer, metadata: stats, response: null };
  } catch {
    return null;
  }
}

export async function getBlobMetadata(jobId, fileName) {
  try {
    return await fs.stat(_path(jobId, fileName));
  } catch {
    return null;
  }
}

export async function getLatestStatus(jobId) {
  // Fast path — pre-written latest pointer
  const latest = await getJson(jobId, 'status/latest.json');
  if (latest) return latest;

  // Fallback — scan status directory and pick the newest file
  try {
    const dir = _path(jobId, 'status');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const name = entries
      .filter(e => e.isFile() && e.name.endsWith('.json') && e.name !== 'latest.json')
      .map(e => e.name)
      .sort()
      .pop();
    if (!name) return null;
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─── compat shim so old callers of hasBlobToken() keep working ───────────────
export function hasBlobToken() { return true; }
export function getBlobAccess() { return 'filesystem'; }

// ─── internal ─────────────────────────────────────────────────────────────────

function _path(jobId, fileName) {
  return path.join(STORE_ROOT, jobId, ...fileName.split('/'));
}

async function _write(jobId, fileName, value) {
  const target = _path(jobId, fileName);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
}

function _stamp(iso) {
  return String(iso || new Date().toISOString())
    .replace(/[^0-9A-Za-z]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
