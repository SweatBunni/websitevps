import { executeBuildJob } from './build-common.mjs';
import { getJson, getLatestStatus, putBytes, putJson, putStatus, putText } from './build-store.mjs';
import { getDeepBuildResearch } from './research-metadata.mjs';

const STATUS_RETRY_ATTEMPTS = 10;
const STATUS_RETRY_DELAY_MS = 1000;

export async function runStoredBuildJob(jobId) {
  const input = await retry(() => getJson(jobId, 'input.json'));
  if (!input) {
    throw new Error('Build job input was not found.');
  }
  return runBuildJobInput(jobId, input);
}

export async function runBuildJobInput(jobId, input) {
  if (!input) {
    throw new Error('Build job input was not provided.');
  }

  const existing = await retry(() => getLatestStatus(jobId));
  if (isFinalStatus(existing?.status)) {
    return existing;
  }

  const startedAt = new Date().toISOString();
  await writeStatus(jobId, existing, {
    jobId,
    status: 'running',
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    attempts: existing?.attempts || [],
    createdAt: input.createdAt,
    startedAt,
    workerStartedAt: startedAt,
    updatedAt: startedAt,
    activityLog: appendActivity([], 'Worker started and is preparing the build.'),
    provider: 'vercel',
  });

  try {
    const researchBundle = await runResearchPhase(jobId, input, startedAt, existing);
    const result = await runBuildPhase(jobId, input, startedAt, researchBundle);

    await putJson(jobId, 'files.json', result.files);
    if (result.buildLogTail) {
      await putText(jobId, 'build.log', result.buildLogTail);
    }

    if (result.success) {
      await putBytes(jobId, 'artifact.jar', result.jarBuffer, 'application/java-archive');
      return finalizeSuccess(jobId, input, startedAt, result);
    }

    return finalizeFailure(jobId, input, startedAt, result);
  } catch (error) {
    return finalizeWorkerFailure(jobId, input, startedAt, error);
  }
}

async function runResearchPhase(jobId, input, startedAt, existing) {
  await appendStatusActivity(jobId, existing, input, startedAt, `Starting deep official-source research for ${input.loader} ${input.version}.`);
  const researchBundle = await getDeepBuildResearch(input.loader, input.version, { timeBudgetMs: 115000 });
  await appendStatusActivity(jobId, existing, input, startedAt, researchBundle?.summary || `Completed deep official-source research for ${input.loader} ${input.version}.`, {
    buildResearch: researchBundle,
  });
  return researchBundle;
}

async function runBuildPhase(jobId, input, startedAt, researchBundle) {
  return executeBuildJob({
    apiKey: process.env.OPENROUTER_API_KEY,
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    files: input.files,
    conversation: input.conversation || [],
    researchBundle,
    onActivity: async ({ message, buildResearch }) => {
      const latest = await getLatestStatus(jobId);
      await writeStatus(jobId, latest, {
        ...(latest || {}),
        jobId,
        status: 'running',
        loader: input.loader,
        version: input.version,
        modName: input.modName,
        attempts: latest?.attempts || [],
        createdAt: input.createdAt,
        startedAt,
        updatedAt: new Date().toISOString(),
        buildResearch: buildResearch || latest?.buildResearch || null,
        activityLog: appendActivity(latest?.activityLog, message),
        provider: 'vercel',
      });
    },
    onBuildStart: async ({ attemptNumber }) => {
      const latest = await getLatestStatus(jobId);
      await writeStatus(jobId, latest, {
        ...(latest || {}),
        jobId,
        status: 'running',
        loader: input.loader,
        version: input.version,
        modName: input.modName,
        attempts: latest?.attempts || [],
        createdAt: input.createdAt,
        startedAt,
        updatedAt: new Date().toISOString(),
        buildLogTail: latest?.buildLogTail || '',
        activityLog: appendActivity(latest?.activityLog, `Starting Gradle attempt ${attemptNumber}.`),
        currentAttempt: attemptNumber,
        provider: 'vercel',
      });
    },
    onAttempt: async ({ attempts }) => {
      const latest = await getLatestStatus(jobId);
      const latestAttempt = attempts[attempts.length - 1];
      await writeStatus(jobId, latest, {
        ...(latest || {}),
        jobId,
        status: 'running',
        loader: input.loader,
        version: input.version,
        modName: input.modName,
        attempts,
        createdAt: input.createdAt,
        startedAt,
        updatedAt: new Date().toISOString(),
        buildLogTail: latestAttempt?.logTail || '',
        activityLog: appendActivity(latest?.activityLog, latestAttempt?.fixSummary ? `Applied AI repair: ${latestAttempt.fixSummary}` : `Completed attempt ${attempts.length}.`),
        provider: 'vercel',
      });
    },
  });
}

async function finalizeSuccess(jobId, input, startedAt, result) {
  const completedAt = new Date().toISOString();
  await putStatus(jobId, {
    jobId,
    status: 'completed',
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    attempts: result.attempts,
    jarFileName: result.jarFileName,
    buildLogTail: result.buildLogTail || '',
    activityLog: appendActivity((await getLatestStatus(jobId))?.activityLog, 'Build completed successfully and the JAR is ready.'),
    createdAt: input.createdAt,
    startedAt,
    completedAt,
    updatedAt: completedAt,
    provider: 'vercel',
  });
  return { status: 'completed' };
}

async function finalizeFailure(jobId, input, startedAt, result) {
  const failedAt = new Date().toISOString();
  await putStatus(jobId, {
    jobId,
    status: 'failed',
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    attempts: result.attempts,
    message: result.message || 'Build failed.',
    buildLogTail: result.buildLogTail || '',
    activityLog: appendActivity((await getLatestStatus(jobId))?.activityLog, `Build failed: ${result.message || 'unknown error'}`),
    createdAt: input.createdAt,
    startedAt,
    completedAt: failedAt,
    updatedAt: failedAt,
    provider: 'vercel',
  });
  return { status: 'failed' };
}

async function finalizeWorkerFailure(jobId, input, startedAt, error) {
  const failedAt = new Date().toISOString();
  await putStatus(jobId, {
    jobId,
    status: 'failed',
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    attempts: [],
    message: error.message || 'Background build worker failed unexpectedly.',
    activityLog: appendActivity((await getLatestStatus(jobId))?.activityLog, `Worker error: ${error.message || 'unexpected failure'}`),
    createdAt: input.createdAt,
    startedAt,
    completedAt: failedAt,
    updatedAt: failedAt,
    provider: 'vercel',
  });
  return { status: 'failed' };
}

async function appendStatusActivity(jobId, existing, input, startedAt, message, extra = {}) {
  const latest = await getLatestStatus(jobId);
  await writeStatus(jobId, latest, {
    ...(latest || {}),
    jobId,
    status: 'running',
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    attempts: existing?.attempts || [],
    createdAt: input.createdAt,
    startedAt,
    updatedAt: new Date().toISOString(),
    activityLog: appendActivity(latest?.activityLog, message),
    provider: 'vercel',
    ...extra,
  });
}

async function writeStatus(jobId, current, next) {
  await putStatus(jobId, {
    ...(current || {}),
    ...next,
  });
}

function appendActivity(existing, message) {
  const next = Array.isArray(existing) ? existing.slice(-39) : [];
  if (message) {
    next.push({ time: new Date().toISOString(), message: String(message) });
  }
  return next;
}

async function retry(factory, attempts = STATUS_RETRY_ATTEMPTS, delayMs = STATUS_RETRY_DELAY_MS) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const value = await factory();
    if (value) return value;
    if (attempt < attempts) {
      await delay(delayMs);
    }
  }
  return null;
}

function isFinalStatus(status) {
  return status === 'completed' || status === 'failed';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
