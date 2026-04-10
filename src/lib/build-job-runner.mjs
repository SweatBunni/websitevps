import { executeBuildJob } from './build-common.mjs';
import { getJson, getLatestStatus, putBytes, putJson, putStatus, putText } from './store.mjs';
import { getDeepBuildResearch } from './research-metadata.mjs';
import { sleep } from './runtime-utils.mjs';

const STATUS_READ_RETRIES = 10;
const STATUS_READ_DELAY_MS = 1000;
const MAX_ACTIVITY_ENTRIES = 40;

export async function runStoredBuildJob(jobId) {
  const input = await retryRead(() => getJson(jobId, 'input.json'));
  if (!input) {
    throw new Error('Build job input was not found.');
  }
  return runBuildJobInput(jobId, input);
}

export async function runBuildJobInput(jobId, input) {
  if (!input) {
    throw new Error('Build job input was not provided.');
  }

  const currentStatus = await retryRead(() => getLatestStatus(jobId));
  if (isFinalStatus(currentStatus?.status)) {
    return currentStatus;
  }

  const startedAt = new Date().toISOString();
  await writeJobStatus(jobId, {
    ...(currentStatus || {}),
    jobId,
    status: 'running',
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    attempts: currentStatus?.attempts || [],
    activityLog: appendActivity([], 'Worker started and is preparing the build.'),
    createdAt: input.createdAt,
    startedAt,
    workerStartedAt: startedAt,
    updatedAt: startedAt,
    provider: 'vps',
  });

  try {
    const researchBundle = await runResearchStep(jobId, input, startedAt);
    const buildResult = await runBuildStep(jobId, input, startedAt, researchBundle);
    await persistBuildOutputs(jobId, buildResult);

    return buildResult.success
      ? finalizeCompletedJob(jobId, input, startedAt, buildResult)
      : finalizeFailedJob(jobId, input, startedAt, buildResult);
  } catch (error) {
    return finalizeWorkerError(jobId, input, startedAt, error);
  }
}

async function runResearchStep(jobId, input, startedAt) {
  await appendJobActivity(jobId, input, startedAt, `Starting deep official-source research for ${input.loader} ${input.version}.`);
  const researchBundle = await getDeepBuildResearch(input.loader, input.version, { timeBudgetMs: 115000 });
  await appendJobActivity(
    jobId,
    input,
    startedAt,
    researchBundle?.summary || `Completed deep official-source research for ${input.loader} ${input.version}.`,
    { buildResearch: researchBundle },
  );
  return researchBundle;
}

async function runBuildStep(jobId, input, startedAt, researchBundle) {
  return executeBuildJob({
    apiKey: process.env.OPENROUTER_API_KEY,
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    files: input.files,
    conversation: input.conversation || [],
    researchBundle,
    onActivity: async ({ message, buildResearch }) => {
      await updateRunningStatus(jobId, input, startedAt, latest => ({
        ...latest,
        buildResearch: buildResearch || latest?.buildResearch || null,
        activityLog: appendActivity(latest?.activityLog, message),
      }));
    },
    onBuildStart: async ({ attemptNumber }) => {
      await updateRunningStatus(jobId, input, startedAt, latest => ({
        ...latest,
        currentAttempt: attemptNumber,
        activityLog: appendActivity(latest?.activityLog, `Starting Gradle attempt ${attemptNumber}.`),
      }));
    },
    onAttempt: async ({ attempts }) => {
      const latestAttempt = attempts[attempts.length - 1];
      await updateRunningStatus(jobId, input, startedAt, latest => ({
        ...latest,
        attempts,
        buildLogTail: latestAttempt?.logTail || '',
        activityLog: appendActivity(
          latest?.activityLog,
          latestAttempt?.fixSummary ? `Applied AI repair: ${latestAttempt.fixSummary}` : `Completed attempt ${attempts.length}.`,
        ),
      }));
    },
  });
}

async function persistBuildOutputs(jobId, buildResult) {
  await putJson(jobId, 'files.json', buildResult.files);
  if (buildResult.buildLogTail) {
    await putText(jobId, 'build.log', buildResult.buildLogTail);
  }
  if (buildResult.success) {
    await putBytes(jobId, 'artifact.jar', buildResult.jarBuffer, 'application/java-archive');
  }
}

async function finalizeCompletedJob(jobId, input, startedAt, buildResult) {
  const completedAt = new Date().toISOString();
  await writeJobStatus(jobId, {
    ...(await getLatestStatus(jobId)),
    jobId,
    status: 'completed',
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    attempts: buildResult.attempts,
    jarFileName: buildResult.jarFileName,
    buildLogTail: buildResult.buildLogTail || '',
    activityLog: appendActivity((await getLatestStatus(jobId))?.activityLog, 'Build completed successfully and the JAR is ready.'),
    createdAt: input.createdAt,
    startedAt,
    completedAt,
    updatedAt: completedAt,
    provider: 'vps',
  });
  return { status: 'completed' };
}

async function finalizeFailedJob(jobId, input, startedAt, buildResult) {
  const failedAt = new Date().toISOString();
  await writeJobStatus(jobId, {
    ...(await getLatestStatus(jobId)),
    jobId,
    status: 'failed',
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    attempts: buildResult.attempts,
    message: buildResult.message || 'Build failed.',
    buildLogTail: buildResult.buildLogTail || '',
    activityLog: appendActivity((await getLatestStatus(jobId))?.activityLog, `Build failed: ${buildResult.message || 'unknown error'}`),
    createdAt: input.createdAt,
    startedAt,
    completedAt: failedAt,
    updatedAt: failedAt,
    provider: 'vps',
  });
  return { status: 'failed' };
}

async function finalizeWorkerError(jobId, input, startedAt, error) {
  const failedAt = new Date().toISOString();
  await writeJobStatus(jobId, {
    ...(await getLatestStatus(jobId)),
    jobId,
    status: 'failed',
    loader: input.loader,
    version: input.version,
    modName: input.modName,
    attempts: [],
    message: error?.message || 'Background build worker failed unexpectedly.',
    activityLog: appendActivity((await getLatestStatus(jobId))?.activityLog, `Worker error: ${error?.message || 'unexpected failure'}`),
    createdAt: input.createdAt,
    startedAt,
    completedAt: failedAt,
    updatedAt: failedAt,
    provider: 'vps',
  });
  return { status: 'failed' };
}

async function appendJobActivity(jobId, input, startedAt, message, extra = {}) {
  await updateRunningStatus(jobId, input, startedAt, latest => ({
    ...latest,
    ...extra,
    activityLog: appendActivity(latest?.activityLog, message),
  }));
}

async function updateRunningStatus(jobId, input, startedAt, mapper) {
  const latest = await getLatestStatus(jobId);
  const mapped = mapper(latest || {});
  await writeJobStatus(jobId, {
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
    provider: 'vps',
    ...mapped,
  });
}

async function writeJobStatus(jobId, status) {
  await putStatus(jobId, { ...status, jobId });
}

function appendActivity(existing, message) {
  const entries = Array.isArray(existing) ? existing.slice(-(MAX_ACTIVITY_ENTRIES - 1)) : [];
  if (message) {
    entries.push({ time: new Date().toISOString(), message: String(message) });
  }
  return entries;
}

async function retryRead(factory, attempts = STATUS_READ_RETRIES, delayMs = STATUS_READ_DELAY_MS) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const value = await factory();
    if (value) return value;
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }
  return null;
}

function isFinalStatus(status) {
  return status === 'completed' || status === 'failed';
}
