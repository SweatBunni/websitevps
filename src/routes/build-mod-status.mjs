/**
 * routes/build-mod-status.mjs — GET /api/build-mod-status?jobId=…
 * Returns the latest status object for a queued / running / completed build job.
 */

import { getLatestStatus } from '../lib/store.mjs';
import { getSearchParam, jsonResponse, methodNotAllowed } from '../lib/http-utils.mjs';

const STATUS_TIMEOUT_MS = 5_000;

export default async function handleBuildModStatus(request) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);

  const jobId = getSearchParam(request, 'jobId');
  if (!jobId) {
    return jsonResponse({ message: 'jobId is required.' }, { status: 400 });
  }

  try {
    const status = await withTimeout(getLatestStatus(jobId), STATUS_TIMEOUT_MS);
    return jsonResponse(status ?? queuedFallback(jobId));
  } catch (error) {
    return jsonResponse({
      ...queuedFallback(jobId),
      message: error?.message || 'Unexpected build status error.',
    });
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), ms));
  return Promise.race([promise, timeout]);
}

function queuedFallback(jobId) {
  const now = new Date().toISOString();
  return {
    jobId,
    status: 'queued',
    attempts: [],
    activityLog: [{ time: now, message: 'Waiting for build status…' }],
    updatedAt: now,
    message: 'Waiting for build status…',
  };
}
