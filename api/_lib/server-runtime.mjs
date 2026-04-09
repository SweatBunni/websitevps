import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

const MIME_TYPES = new Map([
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
  let raw = '';
  try {
    raw = syncFs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function createWebRequest(req, url) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      value.forEach(item => headers.append(key, item));
    } else if (value != null) {
      headers.set(key, value);
    }
  }

  const init = {
    method: req.method || 'GET',
    headers,
  };

  if (!['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())) {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }

  return new Request(url, init);
}

export async function sendNodeResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const stream = Readable.fromWeb(response.body);
  await new Promise((resolve, reject) => {
    stream.on('error', reject);
    res.on('error', reject);
    res.on('close', resolve);
    stream.pipe(res);
  });
}

export async function serveStaticRequest({
  pathname,
  res,
  publicDir,
  rootDir,
  rootIndexPath,
}) {
  const cleanPath = normalizePathname(pathname);
  const candidates = cleanPath
    ? [path.join(publicDir, cleanPath), path.join(rootDir, cleanPath)]
    : [];

  for (const candidate of candidates) {
    const file = await tryReadFile(candidate);
    if (!file) {
      continue;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_TYPES.get(path.extname(candidate).toLowerCase()) || 'application/octet-stream');
    res.end(file);
    return;
  }

  const fallbackIndex = await resolveIndexFile(publicDir, rootIndexPath);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(await fs.readFile(fallbackIndex));
}

export function requestOrigin(req, fallbackPort) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `127.0.0.1:${fallbackPort}`;
  return `${proto}://${host}`;
}

export function notFoundResponse() {
  return new Response(JSON.stringify({ message: 'Not found.' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function resolveIndexFile(publicDir, rootIndexPath) {
  const publicIndexPath = path.join(publicDir, 'index.html');
  return await fileExists(publicIndexPath) ? publicIndexPath : rootIndexPath;
}

async function tryReadFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizePathname(pathname) {
  const decoded = decodeURIComponent(String(pathname || '/'));
  const trimmed = decoded.replace(/^\/+/, '');
  if (!trimmed) {
    return '';
  }

  const normalized = path.normalize(trimmed).replace(/^(\.\.(\/|\\|$))+/, '');
  return normalized.startsWith('..') ? '' : normalized;
}
