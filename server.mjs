/**
 * server.mjs — CodexMC VPS server
 *
 * Pure Node.js HTTP server. No Vercel, no Netlify, no serverless runtime.
 * Serves static files from ./public, routes /api/* to handler modules,
 * and correctly serves app.html for the /app route so the landing-page
 * CTA buttons work.
 *
 * Usage:
 *   node server.mjs
 *
 * Env vars (put in .env):
 *   PORT                  — listen port (default 3000)
 *   HOST                  — bind address (default 0.0.0.0)
 *   OPENROUTER_API_KEY    — required for AI chat
 *   BUILD_STORE_DIR       — override filesystem job-store path (default .data/build-jobs)
 */

import http      from 'node:http';
import fs        from 'node:fs';
import fsp       from 'node:fs/promises';
import path      from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── load .env before anything else ──────────────────────────────────────────
loadDotEnv(path.join(__dirname, '.env'));

const PORT       = Number(process.env.PORT || 3000);
const HOST       = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ─── lazy-load route handlers (top-level await would force ESM top-of-file) ──
const ROUTES = new Map([
  ['/api/chat',             () => import('./src/routes/chat.mjs')],
  ['/api/research',         () => import('./src/routes/research.mjs')],
  ['/api/build-mod',        () => import('./src/routes/build-mod.mjs')],
  ['/api/build-mod-worker', () => import('./src/routes/build-mod-worker.mjs')],
  ['/api/build-mod-status', () => import('./src/routes/build-mod-status.mjs')],
  ['/api/build-mod-result', () => import('./src/routes/build-mod-result.mjs')],
]);

// Cache of loaded handlers
const handlerCache = new Map();

async function getHandler(pathname) {
  if (handlerCache.has(pathname)) return handlerCache.get(pathname);
  const loader = ROUTES.get(pathname);
  if (!loader) return null;
  const mod = await loader();
  handlerCache.set(pathname, mod.default);
  return mod.default;
}

// ─── MIME types ───────────────────────────────────────────────────────────────
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js',   'application/javascript; charset=utf-8'],
  ['.mjs',  'application/javascript; charset=utf-8'],
  ['.css',  'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg',  'image/svg+xml'],
  ['.png',  'image/png'],
  ['.jpg',  'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico',  'image/x-icon'],
  ['.txt',  'text/plain; charset=utf-8'],
  ['.zip',  'application/zip'],
  ['.jar',  'application/java-archive'],
]);

// ─── request → web Request adapter ───────────────────────────────────────────
function toWebRequest(nodeReq, url) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (Array.isArray(v)) v.forEach(item => headers.append(k, item));
    else if (v != null)   headers.set(k, v);
  }

  const init = { method: nodeReq.method || 'GET', headers };
  const method = String(init.method).toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    init.body   = Readable.toWeb(nodeReq);
    init.duplex = 'half';
  }
  return new Request(url.href, init);
}

// ─── web Response → node response adapter ────────────────────────────────────
async function sendWebResponse(nodeRes, webRes) {
  nodeRes.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => nodeRes.setHeader(key, value));

  if (!webRes.body) { nodeRes.end(); return; }

  const bodyStream = Readable.fromWeb(webRes.body);
  await new Promise((resolve, reject) => {
    bodyStream.on('error', reject);
    nodeRes.on('error', reject);
    nodeRes.on('close', resolve);
    bodyStream.pipe(nodeRes);
  });
}

// ─── static file server ───────────────────────────────────────────────────────
function safeRelPath(pathname) {
  const decoded = decodeURIComponent(String(pathname || '/'));
  const trimmed = decoded.replace(/^\/+/, '');
  if (!trimmed) return '';
  const normalized = path.normalize(trimmed).replace(/^(\.\.(\/|\\|$))+/, '');
  return normalized.startsWith('..') ? '' : normalized;
}

async function serveStatic(pathname, res) {
  const rel = safeRelPath(pathname);

  if (rel) {
    const candidate = path.join(PUBLIC_DIR, rel);
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) {
        const ext  = path.extname(candidate).toLowerCase();
        const mime = MIME.get(ext) || 'application/octet-stream';
        res.statusCode = 200;
        res.setHeader('Content-Type', mime);
        res.end(await fsp.readFile(candidate));
        return;
      }
    } catch { /* not found — fall through */ }
  }

  // SPA fallback — always serve index.html (the landing page)
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(await fsp.readFile(path.join(PUBLIC_DIR, 'index.html')));
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Add CORS headers for development convenience
  res.setHeader('X-Powered-By', 'CodexMC');

  try {
    const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || `127.0.0.1:${PORT}`}`;
    const url    = new URL(req.url || '/', origin);
    const { pathname } = url;

    // ── /app  →  serve app.html  (FIXES the broken CTA buttons) ─────────────
    if (pathname === '/app' || pathname === '/app/') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(await fsp.readFile(path.join(PUBLIC_DIR, 'app.html')));
      return;
    }

    // ── API routes ────────────────────────────────────────────────────────────
    const handler = await getHandler(pathname);
    if (handler) {
      const webReq = toWebRequest(req, url);
      const webRes = await handler(webReq);
      await sendWebResponse(res, webRes);
      return;
    }

    // Unknown /api/* path → 404 JSON
    if (pathname.startsWith('/api/')) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ message: 'API route not found.' }));
      return;
    }

    // Static files / SPA fallback
    await serveStatic(pathname, res);

  } catch (error) {
    console.error('[codexmc] request error:', error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Internal Server Error');
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[codexmc] ✓ listening on http://${HOST}:${PORT}`);
  console.log(`[codexmc]   public dir : ${PUBLIC_DIR}`);
  console.log(`[codexmc]   store root : ${process.env.BUILD_STORE_DIR || '.data/build-jobs'}`);
});

server.on('error', err => {
  console.error('[codexmc] server error:', err);
  process.exit(1);
});

// ─── .env loader ─────────────────────────────────────────────────────────────
function loadDotEnv(envPath) {
  let raw = '';
  try { raw = fs.readFileSync(envPath, 'utf8'); } catch { return; }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const sep = trimmed.indexOf('=');
    if (sep <= 0) continue;

    const key = trimmed.slice(0, sep).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    let value = trimmed.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
