const NO_STORE_HEADER = { 'Cache-Control': 'no-store' };

export function jsonResponse(payload, init = {}) {
  return Response.json(payload, buildInit(init));
}

export function textResponse(text, init = {}) {
  return new Response(String(text ?? ''), buildInit({
    ...init,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...(init.headers || {}),
    },
  }));
}

export function errorResponse(message, status = 500, extra = {}) {
  return jsonResponse({ message, ...extra }, { status });
}

export function methodNotAllowed(message = 'Method not allowed.') {
  return errorResponse(message, 405);
}

export async function parseJsonRequest(request) {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: errorResponse('Invalid JSON body.', 400) };
  }
}

export function getRequestUrl(request) {
  return new URL(request.url);
}

export function getSearchParam(request, key, fallback = '') {
  return getRequestUrl(request).searchParams.get(key) || fallback;
}

function buildInit(init) {
  return {
    status: init.status || 200,
    headers: {
      ...NO_STORE_HEADER,
      ...(init.headers || {}),
    },
  };
}
