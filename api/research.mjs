import { getBuildResearch, getDeepBuildResearch, getLoaderVersions } from './_lib/research-metadata.mjs';

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export default async function handler(request) {
  if (request.method !== 'GET') {
    return json({ message: 'Method not allowed.' }, 405);
  }

  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') || 'versions';
  const loader = url.searchParams.get('loader') || '';
  const version = url.searchParams.get('version') || '';

  try {
    if (kind === 'versions') {
      const fabric = await getLoaderVersions('fabric');
      const forge = await getLoaderVersions('forge');
      const neoforge = await getLoaderVersions('neoforge');
      return json({
        kind,
        versions: {
          fabric: fabric.versions,
          forge: forge.versions,
          neoforge: neoforge.versions,
        },
        sources: [...new Set([...(fabric.sources || []), ...(forge.sources || []), ...(neoforge.sources || [])])],
      });
    }

    if (kind === 'build') {
      if (!loader || !version) {
        return json({ message: 'loader and version are required for build research.' }, 400);
      }
      const deep = url.searchParams.get('deep');
      const result = deep === '1'
        ? await getDeepBuildResearch(loader, version)
        : await getBuildResearch(loader, version);
      return json(result);
    }

    return json({ message: 'Unsupported research kind.' }, 400);
  } catch (error) {
    return json({ message: error?.message || 'Research lookup failed.' }, 500);
  }
}
