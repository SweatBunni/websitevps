import { getLatestStatus } from './_lib/build-store.mjs';

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
    if (request.method !== 'GET') {
      return json({ message: 'Method not allowed.' }, { status: 405 });
    }

    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId') || '';
    if (!jobId) {
      return json({ message: 'jobId is required.' }, { status: 400 });
    }

    const status = await getLatestStatusWithTimeout(jobId, 4000);
    if (!status) {
      return json(fallbackQueuedStatus(jobId));
    }

    return json(status);
  } catch (error) {
    return json({
      ...fallbackQueuedStatus(new URL(request.url).searchParams.get('jobId') || ''),
      message: error?.message || 'Unexpected build status error.',
    });
  }
}

async function getLatestStatusWithTimeout(jobId, timeoutMs) {
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), timeoutMs));
  return Promise.race([getLatestStatus(jobId), timeout]);
}

function fallbackQueuedStatus(jobId) {
  return {
    jobId,
    status: 'queued',
    attempts: [],
    updatedAt: new Date().toISOString(),
    provider: 'vercel',
    message: 'Waiting for build status...',
  };
}
