import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const STATIC_MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.zip', 'application/zip'],
  ['.jar', 'application/java-archive'],
]);

export function loadDotEnv(envPath) {
  let rawText = '';
  try {
    rawText = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }

  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function createWebRequest(nodeRequest, url) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeRequest.headers)) {
    if (Array.isArray(value)) {
      value.forEach(item => headers.append(key, item));
      continue;
    }
    if (value != null) {
      headers.set(key, value);
    }
  }

  const init = {
    method: nodeRequest.method || 'GET',
    headers,
  };

  if (!['GET', 'HEAD'].includes(String(init.method).toUpperCase())) {
    init.body = Readable.toWeb(nodeRequest);
    init.duplex = 'half';
  }

  return new Request(url, init);
}

export async function sendNodeResponse(nodeResponse, response) {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, key) => {
    nodeResponse.setHeader(key, value);
  });

  if (!response.body) {
    nodeResponse.end();
    return;
  }

  const bodyStream = Readable.fromWeb(response.body);
  await new Promise((resolve, reject) => {
    bodyStream.on('error', reject);
    nodeResponse.on('error', reject);
    nodeResponse.on('close', resolve);
    bodyStream.pipe(nodeResponse);
  });
}

export async function serveStaticRequest({ pathname, res, publicDir, rootDir, rootIndexPath }) {
  const normalizedPath = normalizeStaticPath(pathname);
  const candidates = normalizedPath
    ? [path.join(publicDir, normalizedPath), path.join(rootDir, normalizedPath)]
    : [];

  for (const filePath of candidates) {
    const file = await readStaticFile(filePath);
    if (!file) continue;

    res.statusCode = 200;
    res.setHeader('Content-Type', STATIC_MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream');
    res.end(file);
    return;
  }

  const indexPath = await resolveIndexPath(publicDir, rootIndexPath);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(await fsp.readFile(indexPath));
}

export function requestOrigin(req, fallbackPort) {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `127.0.0.1:${fallbackPort}`;
  return `${protocol}://${host}`;
}

export function notFoundResponse() {
  return new Response(JSON.stringify({ message: 'Not found.' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function resolveIndexPath(publicDir, rootIndexPath) {
  const publicIndexPath = path.join(publicDir, 'index.html');
  return await fileExists(publicIndexPath) ? publicIndexPath : rootIndexPath;
}

async function readStaticFile(filePath) {
  try {
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) return null;
    return await fsp.readFile(filePath);
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeStaticPath(pathname) {
  const decoded = decodeURIComponent(String(pathname || '/'));
  const trimmed = decoded.replace(/^\/+/, '');
  if (!trimmed) return '';

  const normalized = path.normalize(trimmed).replace(/^(\.\.(\/|\\|$))+/, '');
  return normalized.startsWith('..') ? '' : normalized;
}
