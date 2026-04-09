
import http from 'node:http';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(__dirname, '.env'));

const { default: chatHandler } = await import('./api/chat.mjs');
const { default: buildModHandler } = await import('./api/build-mod.mjs');
const { default: buildWorkerHandler } = await import('./api/build-mod-worker.mjs');
const { default: buildStatusHandler } = await import('./api/build-mod-status.mjs');
const { default: buildResultHandler } = await import('./api/build-mod-result.mjs');
const { default: researchHandler } = await import('./api/research.mjs');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOT_INDEX = path.join(__dirname, 'index.html');
const PUBLIC_INDEX = path.join(PUBLIC_DIR, 'index.html');

const API_ROUTES = new Map([
  ['/api/chat', chatHandler],
  ['/api/build-mod', buildModHandler],
  ['/api/build-mod-worker', buildWorkerHandler],
  ['/api/build-mod-status', buildStatusHandler],
  ['/api/build-mod-result', buildResultHandler],
  ['/api/research', researchHandler],
]);

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', requestOrigin(req));
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      const handler = API_ROUTES.get(pathname);
      if (!handler) {
        await sendNodeResponse(res, new Response(JSON.stringify({ message: 'Not found.' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }));
        return;
      }

      const request = createWebRequest(req, url);
      const response = await handler(request);
      await sendNodeResponse(res, response);
      return;
    }

    await serveStaticRequest(pathname, res);
  } catch (error) {
    console.error('[codexmc] request failed:', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Internal Server Error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[codexmc] listening on http://${HOST}:${PORT}`);
});

function loadDotEnv(envPath) {
  let raw = '';
  try {
    raw = syncFs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function createWebRequest(req, url) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value != null) {
      headers.set(key, value);
    }
  }

  const hasBody = !['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase());
  const init = {
    method: req.method || 'GET',
    headers,
  };

  if (hasBody) {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }

  return new Request(url, init);
}

async function sendNodeResponse(res, response) {
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

async function serveStaticRequest(pathname, res) {
  const cleanPath = normalizePathname(pathname);
  const candidates = [];

  if (cleanPath) {
    candidates.push(path.join(PUBLIC_DIR, cleanPath));
    candidates.push(path.join(__dirname, cleanPath));
  }

  for (const candidate of candidates) {
    const file = await tryReadFile(candidate);
    if (!file) continue;
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_TYPES.get(path.extname(candidate).toLowerCase()) || 'application/octet-stream');
    res.end(file);
    return;
  }

  const fallback = await resolveIndexFile();
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(await fs.readFile(fallback));
}

async function resolveIndexFile() {
  if (await fileExists(PUBLIC_INDEX)) return PUBLIC_INDEX;
  return ROOT_INDEX;
}

async function tryReadFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
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
  if (!trimmed) return '';
  const normalized = path.normalize(trimmed).replace(/^(\.\.(\/|\\|$))+/, '');
  if (normalized.startsWith('..')) return '';
  return normalized;
}

function requestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}
