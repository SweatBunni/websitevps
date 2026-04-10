/**
 * http-utils.mjs — lean HTTP helpers for VPS route handlers.
 */

// ─── response factories ───────────────────────────────────────────────────────

export function jsonResponse(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export function textResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export function methodNotAllowed(allowed = ['GET']) {
  return new Response(JSON.stringify({ message: 'Method not allowed.' }), {
    status: 405,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Allow: allowed.join(', '),
    },
  });
}

export function notFoundResponse(message = 'Not found.') {
  return jsonResponse({ message }, { status: 404 });
}

// ─── request helpers ──────────────────────────────────────────────────────────

/**
 * Parse the JSON body of a request.
 * Returns { ok: true, value } or { ok: false, response }.
 */
export async function parseJsonRequest(request) {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json') && !contentType.includes('text/')) {
      // Be lenient — still try to parse
    }
    const text = await request.text();
    if (!text.trim()) {
      return { ok: false, response: jsonResponse({ message: 'Request body is empty.' }, { status: 400 }) };
    }
    const value = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      response: jsonResponse({ message: 'Invalid JSON in request body.' }, { status: 400 }),
    };
  }
}

/**
 * Get a query-string parameter from a Request.
 * @param {Request} request
 * @param {string} name
 * @returns {string | null}
 */
export function getSearchParam(request, name) {
  try {
    const url = new URL(request.url);
    return url.searchParams.get(name);
  } catch {
    return null;
  }
}
