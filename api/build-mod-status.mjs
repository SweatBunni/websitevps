import { getLatestStatus } from './_lib/build-store.mjs';
import { getSearchParam, jsonResponse, methodNotAllowed } from './_lib/http-utils.mjs';

const STATUS_TIMEOUT_MS = 4000;

export default async function handler(request) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  const jobId = getSearchParam(request, 'jobId');
  if (!jobId) {
    return jsonResponse({ message: 'jobId is required.' }, { status: 400 });
  }

  try {
    const status = await getLatestStatusWithTimeout(jobId, STATUS_TIMEOUT_MS);
    return jsonResponse(status || createQueuedFallback(jobId));
  } catch (error) {
    return jsonResponse({
      ...createQueuedFallback(jobId),
      message: error?.message || 'Unexpected build status error.',
    });
  }
}

async function getLatestStatusWithTimeout(jobId, timeoutMs) {
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), timeoutMs));
  return Promise.race([getLatestStatus(jobId), timeout]);
}

function createQueuedFallback(jobId) {
  const now = new Date().toISOString();
  return {
    jobId,
    status: 'queued',
    attempts: [],
    activityLog: [{ time: now, message: 'Waiting for build status...' }],
    updatedAt: now,
    provider: 'vercel',
    message: 'Waiting for build status...',
  };
}
