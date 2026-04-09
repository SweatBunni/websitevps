import { executeBuildJob } from './build-common.mjs';
import { getJson, getLatestStatus, putBytes, putJson, putStatus, putText } from './build-store.mjs';
import { enrichProjectWithGeneratedTextures } from './texture-generation.mjs';

export async function runStoredBuildJob(jobId) {
  const input = await getJsonWithRetry(jobId, 'input.json');
  if (!input) {
    throw new Error('Build job input was not found.');
  }

  return runBuildJobInput(jobId, input);
}

export async function runBuildJobInput(jobId, input) {
  if (!input) {
    throw new Error('Build job input was not provided.');
  }

  const existing = await getLatestStatusWithRetry(jobId);
  if (existing?.status === 'completed' || existing?.status === 'failed') {
    return existing;
  }

  const startedAt = new Date().toISOString();
  await putStatus(jobId, {
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
    const textureResult = await enrichProjectWithGeneratedTextures({
      apiKey: process.env.MISTRAL_API_KEY,
      loader: input.loader,
      version: input.version,
      modName: input.modName,
      files: input.files,
      conversation: input.conversation || [],
    });

    if (textureResult.generatedTextures.length || textureResult.textureWarnings.length) {
      const latest = await getLatestStatus(jobId);
      await putStatus(jobId, {
        ...(latest || {}),
        jobId,
        status: 'running',
        loader: input.loader,
        version: input.version,
        modName: input.modName,
        attempts: existing?.attempts || [],
        generatedTextures: textureResult.generatedTextures,
        textureWarnings: textureResult.textureWarnings,
        createdAt: input.createdAt,
        startedAt,
        updatedAt: new Date().toISOString(),
        activityLog: appendActivity(
          latest?.activityLog,
          textureResult.generatedTextures.length
            ? `Generated ${textureResult.generatedTextures.length} texture asset(s).`
            : `Texture generation finished with ${textureResult.textureWarnings.length} warning(s) and no new textures.`,
        ),
        provider: 'vercel',
      });
    }

    const result = await executeBuildJob({
      apiKey: process.env.MISTRAL_API_KEY,
      loader: input.loader,
      version: input.version,
      modName: input.modName,
      files: input.files,
      conversation: input.conversation || [],
      onActivity: async ({ message, buildResearch }) => {
        const latest = await getLatestStatus(jobId);
        await putStatus(jobId, {
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
        await putStatus(jobId, {
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
        await putStatus(jobId, {
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
          buildLogTail: attempts[attempts.length - 1]?.logTail || '',
          activityLog: appendActivity(latest?.activityLog, attempts[attempts.length - 1]?.fixSummary ? `Applied AI repair: ${attempts[attempts.length - 1].fixSummary}` : `Completed attempt ${attempts.length}.`),
          provider: 'vercel',
        });
      },
    });

    await putJson(jobId, 'files.json', result.files);
    if (result.buildLogTail) {
      await putText(jobId, 'build.log', result.buildLogTail);
    }

    if (result.success) {
      await putBytes(jobId, 'artifact.jar', result.jarBuffer, 'application/java-archive');
      const completedAt = new Date().toISOString();
      await putStatus(jobId, {
        jobId,
        status: 'completed',
        loader: input.loader,
        version: input.version,
        modName: input.modName,
        attempts: result.attempts,
        generatedTextures: textureResult.generatedTextures,
        textureWarnings: textureResult.textureWarnings,
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

    const failedAt = new Date().toISOString();
    await putStatus(jobId, {
      jobId,
      status: 'failed',
      loader: input.loader,
      version: input.version,
      modName: input.modName,
      attempts: result.attempts,
      generatedTextures: textureResult.generatedTextures,
      textureWarnings: textureResult.textureWarnings,
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
  } catch (error) {
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
}

function appendActivity(existing, message) {
  const next = Array.isArray(existing) ? existing.slice(-39) : [];
  if (!message) return next;
  next.push({
    time: new Date().toISOString(),
    message: String(message),
  });
  return next;
}

async function getJsonWithRetry(jobId, fileName, attempts = 10, delayMs = 1000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const value = await getJson(jobId, fileName);
    if (value) {
      return value;
    }
    if (attempt < attempts) {
      await delay(delayMs);
    }
  }
  return null;
}

async function getLatestStatusWithRetry(jobId, attempts = 10, delayMs = 1000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const value = await getLatestStatus(jobId);
    if (value) {
      return value;
    }
    if (attempt < attempts) {
      await delay(delayMs);
    }
  }
  return null;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
