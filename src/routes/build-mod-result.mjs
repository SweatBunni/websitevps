/**
 * routes/build-mod-result.mjs — GET /api/build-mod-result?jobId=…&kind=files|log|jar
 * Retrieves build output artefacts from the filesystem store.
 */

import { getBytes, getJson, getLatestStatus, getText } from '../lib/store.mjs';
import { getSearchParam, jsonResponse, methodNotAllowed, textResponse } from '../lib/http-utils.mjs';

export default async function handleBuildModResult(request) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);

  const jobId = getSearchParam(request, 'jobId');
  const kind  = getSearchParam(request, 'kind');

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
      return jsonResponse({ message: 'Built JAR not found for this job.' }, { status: 404 });
    }

    const status = await getLatestStatus(jobId);
    const fileName = status?.jarFileName || 'mod.jar';

    return new Response(artifact.buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/java-archive',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return jsonResponse({ message: `Unsupported result kind: ${kind}` }, { status: 400 });
}
