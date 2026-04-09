import { getLatestStatus, putJson, putStatus, putText } from './_lib/build-store.mjs';
import { sanitizeFiles } from './_lib/sanitize-files.mjs';
import { runBuildJobInput, runStoredBuildJob } from './_lib/build-job-runner.mjs';
import { scheduleBackgroundTask } from './_lib/runtime-utils.mjs';

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
  try {
    if (request.method !== 'POST' && request.method !== 'GET') {
      return json({ message: 'Method not allowed.' }, { status: 405 });
    }

    let jobId = '';
    let directInput = null;
    if (request.method === 'POST') {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ message: 'Invalid JSON body.' }, { status: 400 });
      }
      jobId = typeof payload.jobId === 'string' ? payload.jobId : '';
      if (payload && typeof payload === 'object' && payload.files && typeof payload.files === 'object') {
        try {
          directInput = {
            jobId,
            loader: typeof payload.loader === 'string' ? payload.loader : '',
            version: typeof payload.version === 'string' ? payload.version : '',
            modName: typeof payload.modName === 'string' ? payload.modName : 'MinecraftMod',
            conversation: Array.isArray(payload.conversation) ? payload.conversation : [],
            files: sanitizeFiles(payload.files),
            createdAt: typeof payload.createdAt === 'string' && payload.createdAt ? payload.createdAt : new Date().toISOString(),
          };
        } catch (error) {
          return json({ message: error.message || 'Invalid build worker files payload.' }, { status: 400 });
        }
      }
    } else {
      const { searchParams } = new URL(request.url);
      jobId = searchParams.get('jobId') || '';
    }

    if (!jobId) {
      return json({ message: 'jobId is required.' }, { status: 400 });
    }

    let status = await getLatestStatusWithRetry(jobId, directInput ? 2 : 10, directInput ? 300 : 1000);
    if (!status && directInput) {
      status = await bootstrapDirectJob(jobId, directInput);
    }
    if (!status) {
      return json({ message: 'Build job not found.' }, { status: 404 });
    }

    if (status.status === 'completed' || status.status === 'failed') {
      return json({ jobId, status: status.status, message: 'Build job already finished.' });
    }

    if (shouldUseVercelSourceOnlyMode() && directInput) {
      const completedAt = new Date().toISOString();
      const message = 'Vercel deployments cannot reliably run this Gradle JAR build within function time limits. Download the generated sources instead, or move builds to a dedicated backend.';
      await putJson(jobId, 'files.json', directInput.files);
      await putText(jobId, 'build.log', message);
      await putStatus(jobId, {
        ...(status || {}),
        jobId,
        status: 'failed',
        loader: directInput.loader,
        version: directInput.version,
        modName: directInput.modName,
        attempts: status?.attempts || [],
        message,
        buildLogTail: message,
        createdAt: directInput.createdAt,
        completedAt,
        updatedAt: completedAt,
        provider: 'vercel',
      });
      return json({ jobId, status: 'failed', message }, { status: 200 });
    }

    scheduleBackgroundTask(runWorkerJob(jobId, directInput, status));

    return json({
      jobId,
      status: 'started',
      message: 'Build worker accepted.',
    }, { status: 202 });
  } catch (error) {
    return json({ message: error?.message || 'Unexpected build worker error.' }, { status: 500 });
  }
}

async function getLatestStatusWithRetry(jobId, attempts = 10, delayMs = 1000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const s = await getLatestStatus(jobId);
    if (s) return s;
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return null;
}

async function bootstrapDirectJob(jobId, input) {
  const now = new Date().toISOString();
  const status = {
    jobId,
    status: 'queued',
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    attempts: [],
    createdAt: input.createdAt || now,
    updatedAt: now,
    provider: 'vercel',
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
