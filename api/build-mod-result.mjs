import { getBytes, getJson, getLatestStatus, getText } from './_lib/build-store.mjs';

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
  if (request.method !== 'GET') {
    return json({ message: 'Method not allowed.' }, { status: 405 });
  }

  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get('jobId') || '';
  const kind = searchParams.get('kind') || '';

  if (!jobId || !kind) {
    return json({ message: 'jobId and kind are required.' }, { status: 400 });
  }

  if (kind === 'files') {
    const files = await getJson(jobId, 'files.json');
    if (!files) {
      return json({ message: 'Build files not found for this job.' }, { status: 404 });
    }
    return json({ files });
  }

  if (kind === 'log') {
    const logText = await getText(jobId, 'build.log');
    if (logText === null) {
      return json({ message: 'Build log not found for this job.' }, { status: 404 });
    }
    return new Response(logText, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  if (kind === 'jar') {
    const artifact = await getBytes(jobId, 'artifact.jar');
    const status = await getLatestStatus(jobId);
    if (!artifact) {
      return json({ message: 'Built jar not found for this job.' }, { status: 404 });
    }

    return new Response(artifact.buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/java-archive',
        'Content-Disposition': `attachment; filename="${status?.jarFileName || 'mod.jar'}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return json({ message: `Unsupported result kind: ${kind}` }, { status: 400 });
}
