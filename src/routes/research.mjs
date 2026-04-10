/**
 * routes/research.mjs — GET /api/research
 * Returns live Minecraft loader version lists and per-version build metadata.
 */

import { getBuildResearch, getDeepBuildResearch, getLoaderVersions } from '../lib/research-metadata.mjs';
import { getSearchParam, jsonResponse, methodNotAllowed } from '../lib/http-utils.mjs';

export default async function handleResearch(request) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);

  const kind    = getSearchParam(request, 'kind') || 'versions';
  const loader  = getSearchParam(request, 'loader');
  const version = getSearchParam(request, 'version');

  try {
    if (kind === 'versions') {
      const [fabric, forge, neoforge] = await Promise.all([
        getLoaderVersions('fabric'),
        getLoaderVersions('forge'),
        getLoaderVersions('neoforge'),
      ]);

      return jsonResponse({
        kind,
        versions: {
          fabric:   fabric.versions,
          forge:    forge.versions,
          neoforge: neoforge.versions,
        },
        sources: [
          ...new Set([
            ...(fabric.sources   || []),
            ...(forge.sources    || []),
            ...(neoforge.sources || []),
          ]),
        ],
      });
    }

    if (kind === 'build') {
      if (!loader || !version) {
        return jsonResponse(
          { message: 'loader and version are required for build research.' },
          { status: 400 },
        );
      }

      const result = getSearchParam(request, 'deep') === '1'
        ? await getDeepBuildResearch(loader, version)
        : await getBuildResearch(loader, version);

      return jsonResponse(result);
    }

    return jsonResponse({ message: `Unsupported research kind: ${kind}` }, { status: 400 });
  } catch (error) {
    return jsonResponse(
      { message: error?.message || 'Research lookup failed.' },
      { status: 500 },
    );
  }
}
