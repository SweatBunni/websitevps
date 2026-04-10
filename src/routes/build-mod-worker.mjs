/**
 * routes/build-mod-worker.mjs — POST /api/build-mod-worker
 *
 * Accepts the full build payload (same shape as build-mod but including files),
 * bootstraps the job in the store if needed, then kicks off the Gradle build
 * as a background task so the HTTP response returns immediately.
 */

import { sanitizeFiles } from '../lib/sanitize-files.mjs';
import { getLatestStatus, putJson, putStatus, putText } from '../lib/store.mjs';
import { runBuildJobInput, runStoredBuildJob } from '../lib/build-job-runner.mjs';
import { scheduleBackgroundTask, sleep } from '../lib/runtime-utils.mjs';
import { getSearchParam, jsonResponse, methodNotAllowed, parseJsonRequest } from '../lib/http-utils.mjs';

export default async function handleBuildModWorker(request) {
  try {
    if (request.method !== 'POST' && request.method !== 'GET') {
      return methodNotAllowed(['GET', 'POST']);
    }

    const resolved = request.method === 'POST'
      ? await resolvePostRequest(request)
      : { jobId: getSearchParam(request, 'jobId'), directInput: null };

    if (resolved.response) return resolved.response;

    const { jobId, directInput } = resolved;
    if (!jobId) {
      return jsonResponse({ message: 'jobId is required.' }, { status: 400 });
    }

    // Wait briefly for the store to reflect the queued entry
    let status = await waitForStatus(jobId, directInput ? 2 : 10, directInput ? 300 : 800);

    if (!status && directInput) {
      status = await bootstrapStatus(jobId, directInput);
    }

    if (!status) {
      return jsonResponse({ message: 'Build job not found.' }, { status: 404 });
    }

    if (status.status === 'completed' || status.status === 'failed') {
      return jsonResponse({ jobId, status: status.status, message: 'Build job already finished.' });
    }

    scheduleBackgroundTask(runWorkerJob(jobId, directInput, status));
    return jsonResponse({ jobId, status: 'started', message: 'Build worker accepted.' }, { status: 202 });

  } catch (error) {
    return jsonResponse(
      { message: error?.message || 'Unexpected build worker error.' },
      { status: 500 },
    );
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function resolvePostRequest(request) {
  const parsed = await parseJsonRequest(request);
  if (!parsed.ok) return { response: parsed.response };

  const payload = parsed.value || {};
  const jobId   = typeof payload.jobId === 'string' ? payload.jobId : '';

  if (!payload.files || typeof payload.files !== 'object') {
    return { jobId, directInput: null };
  }

  try {
    return {
      jobId,
      directInput: {
        jobId,
        loader:       typeof payload.loader   === 'string' ? payload.loader   : '',
        version:      typeof payload.version  === 'string' ? payload.version  : '',
        modName:      typeof payload.modName  === 'string' ? payload.modName  : 'MinecraftMod',
        conversation: Array.isArray(payload.conversation)  ? payload.conversation : [],
        files:        sanitizeFiles(payload.files),
        createdAt:    typeof payload.createdAt === 'string' && payload.createdAt
                        ? payload.createdAt
                        : new Date().toISOString(),
      },
    };
  } catch (error) {
    return {
      response: jsonResponse(
        { message: error.message || 'Invalid build worker files payload.' },
        { status: 400 },
      ),
    };
  }
}

async function waitForStatus(jobId, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    const s = await getLatestStatus(jobId);
    if (s) return s;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return null;
}

async function bootstrapStatus(jobId, input) {
  const now = new Date().toISOString();
  const status = {
    jobId,
    status: 'queued',
    loader:  input.loader,
    version: input.version,
    modName: input.modName,
    attempts:    [],
    activityLog: [{ time: now, message: 'Worker accepted the job and is preparing to start.' }],
    createdAt:  input.createdAt || now,
    updatedAt:  now,
  };
  await putStatus(jobId, status);
  return status;
}

async function runWorkerJob(jobId, directInput, status) {
  try {
    await (directInput ? runBuildJobInput(jobId, directInput) : runStoredBuildJob(jobId));
  } catch (error) {
    const failedAt = new Date().toISOString();
    await putStatus(jobId, {
      ...(status || {}),
      jobId,
      status:      'failed',
      attempts:    status?.attempts || [],
      message:     error.message || 'Build worker crashed before the build could start.',
      completedAt: failedAt,
      updatedAt:   failedAt,
    }).catch(() => {});
  }
}
