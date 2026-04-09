import { getLatestStatus, putJson, putStatus, putText } from './_lib/build-store.mjs';
import { sanitizeFiles } from './_lib/sanitize-files.mjs';
import { runBuildJobInput, runStoredBuildJob } from './_lib/build-job-runner.mjs';
import { scheduleBackgroundTask } from './_lib/runtime-utils.mjs';
import { getSearchParam, jsonResponse, methodNotAllowed, parseJsonRequest } from './_lib/http-utils.mjs';

export default async function handler(request) {
  try {
    if (request.method !== 'POST' && request.method !== 'GET') {
      return methodNotAllowed();
    }

    const resolved = request.method === 'POST'
      ? await resolvePostRequest(request)
      : { jobId: getSearchParam(request, 'jobId'), directInput: null };

    if (resolved.response) {
      return resolved.response;
    }

    const { jobId, directInput } = resolved;
    if (!jobId) {
      return jsonResponse({ message: 'jobId is required.' }, { status: 400 });
    }

    let status = await getLatestStatusWithRetry(jobId, directInput ? 2 : 10, directInput ? 300 : 1000);
    if (!status && directInput) {
      status = await createDirectBootstrapStatus(jobId, directInput);
    }
    if (!status) {
      return jsonResponse({ message: 'Build job not found.' }, { status: 404 });
    }

    if (status.status === 'completed' || status.status === 'failed') {
      return jsonResponse({ jobId, status: status.status, message: 'Build job already finished.' });
    }

    if (shouldUseVercelSourceOnlyMode() && directInput) {
      const sourceOnlyMessage = 'Vercel deployments cannot reliably run this Gradle JAR build within function time limits. Download the generated sources instead, or move builds to a dedicated backend.';
      await markSourceOnlyFailure(jobId, directInput, status, sourceOnlyMessage);
      return jsonResponse({ jobId, status: 'failed', message: sourceOnlyMessage });
    }

    scheduleBackgroundTask(runWorkerJob(jobId, directInput, status));
    return jsonResponse({ jobId, status: 'started', message: 'Build worker accepted.' }, { status: 202 });
  } catch (error) {
    return jsonResponse({ message: error?.message || 'Unexpected build worker error.' }, { status: 500 });
  }
}

async function resolvePostRequest(request) {
  const parsed = await parseJsonRequest(request);
  if (!parsed.ok) {
    return { response: parsed.response };
  }

  const payload = parsed.value || {};
  const jobId = typeof payload.jobId === 'string' ? payload.jobId : '';
  if (!payload || typeof payload !== 'object' || !payload.files || typeof payload.files !== 'object') {
    return { jobId, directInput: null };
  }

  try {
    return {
      jobId,
      directInput: {
        jobId,
        loader: typeof payload.loader === 'string' ? payload.loader : '',
        version: typeof payload.version === 'string' ? payload.version : '',
        modName: typeof payload.modName === 'string' ? payload.modName : 'MinecraftMod',
        conversation: Array.isArray(payload.conversation) ? payload.conversation : [],
        files: sanitizeFiles(payload.files),
        createdAt: typeof payload.createdAt === 'string' && payload.createdAt ? payload.createdAt : new Date().toISOString(),
      },
    };
  } catch (error) {
    return {
      response: jsonResponse({ message: error.message || 'Invalid build worker files payload.' }, { status: 400 }),
    };
  }
}

async function getLatestStatusWithRetry(jobId, attempts = 10, delayMs = 1000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const status = await getLatestStatus(jobId);
    if (status) return status;
    if (attempt < attempts) {
      await delay(delayMs);
    }
  }
  return null;
}

async function createDirectBootstrapStatus(jobId, input) {
  const now = new Date().toISOString();
  const status = {
    jobId,
    status: 'queued',
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    attempts: [],
    activityLog: [{ time: now, message: 'Worker accepted the job and is preparing to start.' }],
    createdAt: input.createdAt || now,
    updatedAt: now,
    provider: 'vercel',
  };
  await putStatus(jobId, status);
  return status;
}

async function markSourceOnlyFailure(jobId, input, status, message) {
  const completedAt = new Date().toISOString();
  await putJson(jobId, 'files.json', input.files);
  await putText(jobId, 'build.log', message);
  await putStatus(jobId, {
    ...(status || {}),
    jobId,
    status: 'failed',
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    attempts: status?.attempts || [],
    message,
    buildLogTail: message,
    createdAt: input.createdAt,
    completedAt,
    updatedAt: completedAt,
    provider: 'vercel',
  });
}

async function runWorkerJob(jobId, directInput, status) {
  try {
    await (directInput ? runBuildJobInput(jobId, directInput) : runStoredBuildJob(jobId));
  } catch (error) {
    const failedAt = new Date().toISOString();
    await putStatus(jobId, {
      ...(status || {}),
      jobId,
      status: 'failed',
      attempts: status?.attempts || [],
      message: error.message || 'Build worker failed before the build could start.',
      completedAt: failedAt,
      updatedAt: failedAt,
      provider: 'vercel',
    }).catch(() => {});
  }
}

function shouldUseVercelSourceOnlyMode() {
  if (String(process.env.ENABLE_VERCEL_JAR_BUILD || '').toLowerCase() === 'true') {
    return false;
  }
  return Boolean(process.env.VERCEL) && process.env.VERCEL_ENV !== 'development';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
