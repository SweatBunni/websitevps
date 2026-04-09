export function jsonResponse(body, init = {}) {
  return Response.json(body, {
    status: init.status || 200,
    headers: {
      'Cache-Control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

export function textResponse(text, init = {}) {
  return new Response(String(text || ''), {
    status: init.status || 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

export function methodNotAllowed() {
  return jsonResponse({ message: 'Method not allowed.' }, { status: 405 });
}

export async function parseJsonRequest(request) {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 }) };
  }
}

export function getUrl(request) {
  return new URL(request.url);
}

export function getSearchParam(request, key) {
  return getUrl(request).searchParams.get(key) || '';
}
