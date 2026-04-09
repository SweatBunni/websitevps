import crypto from 'node:crypto';
import { sanitizeFiles } from './_lib/sanitize-files.mjs';
import { putJson, putStatus, getBlobAccess, hasBlobToken } from './_lib/build-store.mjs';
import { getMissingProjectFiles } from './_lib/build-contract.mjs';
import { jsonResponse, methodNotAllowed, parseJsonRequest } from './_lib/http-utils.mjs';

export default async function handler(request) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  if (!hasBlobToken()) {
    return jsonResponse({
      message: 'Server is missing BLOB_READ_WRITE_TOKEN. Add Vercel Blob storage to this project.',
    }, { status: 500 });
  }

  const parsed = await parseJsonRequest(request);
  if (!parsed.ok) {
    return parsed.response;
  }

  const payload = parsed.value || {};
  const loader = typeof payload.loader === 'string' ? payload.loader : '';
  const version = typeof payload.version === 'string' ? payload.version : '';
  const modName = typeof payload.modName === 'string' ? payload.modName : 'MinecraftMod';
  const conversation = Array.isArray(payload.conversation) ? payload.conversation : [];

  if (!loader || !version || !payload.files || typeof payload.files !== 'object') {
    return jsonResponse({ message: 'loader, version, and a files object are required.' }, { status: 400 });
  }

  let files;
  try {
    files = sanitizeFiles(payload.files);
  } catch (error) {
    return jsonResponse({ message: error.message }, { status: 400 });
  }

  const missingFiles = getMissingProjectFiles(loader, files);
  if (missingFiles.length) {
    return jsonResponse({
      message: `The AI response did not include the required project files for ${loader} ${version}: ${missingFiles.join(', ')}`,
      missingFiles,
    }, { status: 400 });
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
      activityLog: [{ time: now, message: 'Build job queued and waiting for worker pickup.' }],
      createdAt: now,
      updatedAt: now,
      provider: 'vercel',
    });
  } catch (error) {
    return jsonResponse({
      message: `Blob storage write failed (${getBlobAccess()} store mode): ${error.message || 'unknown error'}`,
    }, { status: 500 });
  }

  return jsonResponse({
    jobId,
    status: 'queued',
    provider: 'vercel',
  }, { status: 202 });
}
