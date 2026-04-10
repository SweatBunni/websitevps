/**
 * routes/build-mod.mjs — POST /api/build-mod
 * Validates the payload, creates a job entry in the filesystem store, and
 * returns a jobId so the client can poll for status.
 */

import crypto from 'node:crypto';
import { sanitizeFiles } from '../lib/sanitize-files.mjs';
import { putJson, putStatus } from '../lib/store.mjs';
import { getMissingProjectFiles } from '../lib/build-contract.mjs';
import { jsonResponse, methodNotAllowed, parseJsonRequest } from '../lib/http-utils.mjs';

export default async function handleBuildMod(request) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);

  const parsed = await parseJsonRequest(request);
  if (!parsed.ok) return parsed.response;

  const payload = parsed.value || {};
  const loader   = typeof payload.loader   === 'string' ? payload.loader   : '';
  const version  = typeof payload.version  === 'string' ? payload.version  : '';
  const modName  = typeof payload.modName  === 'string' ? payload.modName  : 'MinecraftMod';
  const conversation = Array.isArray(payload.conversation) ? payload.conversation : [];

  if (!loader || !version || !payload.files || typeof payload.files !== 'object') {
    return jsonResponse(
      { message: 'loader, version, and a files object are required.' },
      { status: 400 },
    );
  }

  let files;
  try {
    files = sanitizeFiles(payload.files);
  } catch (error) {
    return jsonResponse({ message: error.message }, { status: 400 });
  }

  const missingFiles = getMissingProjectFiles(loader, files);
  if (missingFiles.length) {
    return jsonResponse(
      {
        message: `The AI response did not include required project files for ${loader} ${version}: ${missingFiles.join(', ')}`,
        missingFiles,
      },
      { status: 400 },
    );
  }

  const jobId = crypto.randomUUID();
  const now   = new Date().toISOString();

  const input = { jobId, loader, version, modName, conversation, files, createdAt: now };

  try {
    await putJson(jobId, 'input.json', input);
    await putStatus(jobId, {
      jobId,
      status:     'queued',
      loader,
      version,
      modName,
      attempts:   [],
      activityLog: [{ time: now, message: 'Build job queued and waiting for worker pickup.' }],
      createdAt:  now,
      updatedAt:  now,
    });
  } catch (error) {
    return jsonResponse(
      { message: `Job store write failed: ${error.message || 'unknown error'}` },
      { status: 500 },
    );
  }

  return jsonResponse({ jobId, status: 'queued' }, { status: 202 });
}
