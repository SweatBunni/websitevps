import crypto from 'node:crypto';
import { sanitizeFiles } from './_lib/sanitize-files.mjs';
import { putJson, putStatus, getBlobAccess, hasBlobToken } from './_lib/build-store.mjs';

function json(body, init = {}) {
  return Response.json(body, {
    status: init.status || 200,
    headers: {
      'Cache-Control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ message: 'Method not allowed.' }, { status: 405 });
  }

  if (!hasBlobToken()) {
    return json({
      message: 'Server is missing BLOB_READ_WRITE_TOKEN. Add Vercel Blob storage to this project.',
    }, { status: 500 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ message: 'Invalid JSON body.' }, { status: 400 });
  }

  const loader = typeof payload.loader === 'string' ? payload.loader : '';
  const version = typeof payload.version === 'string' ? payload.version : '';
  const modName = typeof payload.modName === 'string' ? payload.modName : 'MinecraftMod';
  const conversation = Array.isArray(payload.conversation) ? payload.conversation : [];

  if (!loader || !version || !payload.files || typeof payload.files !== 'object') {
    return json({ message: 'loader, version, and a files object are required.' }, { status: 400 });
  }

  let files;
  try {
    files = sanitizeFiles(payload.files);
  } catch (error) {
    return json({ message: error.message }, { status: 400 });
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const input = {
    jobId,
    loader,
    version,
    modName,
    conversation,
    files,
    createdAt: now,
  };

  try {
    await putJson(jobId, 'input.json', input);
    await putStatus(jobId, {
      jobId,
      status: 'queued',
      loader,
      version,
      modName,
      attempts: [],
      createdAt: now,
      updatedAt: now,
      provider: 'vercel',
    });
  } catch (error) {
    return json({
      message: `Blob storage write failed (${getBlobAccess()} store mode): ${error.message || 'unknown error'}`,
    }, { status: 500 });
  }
  return json({
    jobId,
    status: 'queued',
    provider: 'vercel',
  }, { status: 202 });
}
