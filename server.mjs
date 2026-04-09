import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebRequest, loadDotEnv, notFoundResponse, requestOrigin, sendNodeResponse, serveStaticRequest } from './api/_lib/server-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOT_INDEX = path.join(__dirname, 'index.html');

const API_ROUTES = new Map([
  ['/api/chat', (await import('./api/chat.mjs')).default],
  ['/api/build-mod', (await import('./api/build-mod.mjs')).default],
  ['/api/build-mod-worker', (await import('./api/build-mod-worker.mjs')).default],
  ['/api/build-mod-status', (await import('./api/build-mod-status.mjs')).default],
  ['/api/build-mod-result', (await import('./api/build-mod-result.mjs')).default],
  ['/api/research', (await import('./api/research.mjs')).default],
]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', requestOrigin(req, PORT));
    const handler = API_ROUTES.get(url.pathname);

    if (handler) {
      const request = createWebRequest(req, url);
      const response = await handler(request);
      await sendNodeResponse(res, response);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      await sendNodeResponse(res, notFoundResponse());
      return;
    }

    await serveStaticRequest({
      pathname: url.pathname,
      res,
      publicDir: PUBLIC_DIR,
      rootDir: __dirname,
      rootIndexPath: ROOT_INDEX,
    });
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
