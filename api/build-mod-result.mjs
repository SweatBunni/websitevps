import { getBytes, getJson, getLatestStatus, getText } from './_lib/build-store.mjs';
import { getSearchParam, jsonResponse, methodNotAllowed, textResponse } from './_lib/http-utils.mjs';

export default async function handler(request) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  const jobId = getSearchParam(request, 'jobId');
  const kind = getSearchParam(request, 'kind');
  if (!jobId || !kind) {
    return jsonResponse({ message: 'jobId and kind are required.' }, { status: 400 });
  }

  if (kind === 'files') {
    const files = await getJson(jobId, 'files.json');
    return files
      ? jsonResponse({ files })
      : jsonResponse({ message: 'Build files not found for this job.' }, { status: 404 });
  }

  if (kind === 'log') {
    const logText = await getText(jobId, 'build.log');
    return logText !== null
      ? textResponse(logText)
      : jsonResponse({ message: 'Build log not found for this job.' }, { status: 404 });
  }

  if (kind === 'jar') {
    const artifact = await getBytes(jobId, 'artifact.jar');
    if (!artifact) {
      return jsonResponse({ message: 'Built jar not found for this job.' }, { status: 404 });
    }

    const status = await getLatestStatus(jobId);
    return new Response(artifact.buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/java-archive',
        'Content-Disposition': `attachment; filename="${status?.jarFileName || 'mod.jar'}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return jsonResponse({ message: `Unsupported result kind: ${kind}` }, { status: 400 });
}
