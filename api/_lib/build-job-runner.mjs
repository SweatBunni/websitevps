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
      createdAt: input.createdAt,
      startedAt,
      completedAt: failedAt,
      updatedAt: failedAt,
      provider: 'vercel',
    });
    return { status: 'failed' };
  }
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
