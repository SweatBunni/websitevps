import {
  CACHE_TTL_MS,
  COMMUNITY_RESEARCH_SOURCES,
  FALLBACK_VERSIONS,
  FABRIC_BUILD_FALLBACK,
  FABRIC_YARN_FALLBACKS,
  FORGE_BUILD_FALLBACK,
  MAX_AUTONOMOUS_SEARCH_RESULTS,
  MAX_RESEARCH_SNIPPET_CHARS,
  NEOFORGE_BUILD_FALLBACK,
  OFFICIAL_DOC_SOURCES,
  RESEARCH_REQUEST_TIMEOUT_MS,
  SOURCES,
} from './research-sources.mjs';

const cache = new Map();

export async function getLoaderVersions(loader) {
  const normalized = normalizeLoader(loader);
  const cacheKey = `versions:${normalized}`;
  return withCache(cacheKey, async () => {
    const officialSources = [];
    let versions = [...(FALLBACK_VERSIONS[normalized] || [])];

    if (normalized === 'fabric') {
      const rows = await fetchJsonSafe(SOURCES.fabricGameVersions);
      if (Array.isArray(rows) && rows.length) {
        officialSources.push(SOURCES.fabricGameVersions);
        versions = uniqueStrings(rows.map(row => row?.version));
      }
    }

    if (normalized === 'forge') {
      const xml = await fetchTextSafe(SOURCES.forgeMetadata);
      const parsed = extractVersionList(xml)
        .map(value => String(value).split('-')[0])
        .filter(Boolean);
      if (parsed.length) {
        officialSources.push(SOURCES.forgeMetadata);
        versions = uniqueStrings(parsed);
      }
    }

    if (normalized === 'neoforge') {
      const xml = await fetchTextSafe(SOURCES.neoforgeMetadata);
      const parsed = extractVersionList(xml)
        .map(value => String(value).split('-')[0])
        .filter(Boolean);
      if (parsed.length) {
        officialSources.push(SOURCES.neoforgeMetadata);
        versions = uniqueStrings(parsed);
      }
    }

    return {
      loader: normalized,
      versions: versions.length ? versions : [...(FALLBACK_VERSIONS[normalized] || [])],
      sources: officialSources,
      cachedAt: new Date().toISOString(),
    };
  });
}

export async function getBuildResearch(loader, version) {
  const normalized = normalizeLoader(loader);
  const targetVersion = String(version || '').trim();
  const cacheKey = `build:${normalized}:${targetVersion}`;
  return withCache(cacheKey, async () => {
    const build = normalized === 'fabric'
      ? await resolveFabricBuild(targetVersion)
      : normalized === 'forge'
      ? await resolveForgeBuild(targetVersion)
      : await resolveNeoForgeBuild(targetVersion);

    return {
      loader: normalized,
      version: targetVersion,
      build: build.value,
      sources: build.sources,
      evidence: [],
      summary: build.summary,
      cachedAt: new Date().toISOString(),
    };
  });
}

export async function getDeepBuildResearch(loader, version, options = {}) {
  const normalized = normalizeLoader(loader);
  const targetVersion = String(version || '').trim();
  const cacheKey = `deep:${normalized}:${targetVersion}`;
  return withCache(cacheKey, async () => {
    const base = await getBuildResearch(normalized, targetVersion);
    const evidence = await collectEvidence(normalized, targetVersion, options);
    const officialCount = evidence.filter(item => item?.tier !== 'community' && item?.status === 'ok').length;
    const communityCount = evidence.filter(item => item?.tier === 'community' && item?.status === 'ok').length;

    return {
      ...base,
      evidence,
      summary: `Deep research scanned ${officialCount} official and ${communityCount} community ${normalized} sources for ${targetVersion}. ${buildSummaryLine(base.build)}`,
      cachedAt: new Date().toISOString(),
    };
  });
}

export async function getAutonomousRepairResearch(loader, version, options = {}) {
  const normalized = normalizeLoader(loader);
  const targetVersion = String(version || '').trim();
  const query = buildAutonomousQuery(normalized, targetVersion, options);
  const cacheKey = `repair:${normalized}:${targetVersion}:${query}`;

  return withCache(cacheKey, async () => {
    const curatedSources = await collectAutonomousSources(normalized, query, options);
    return {
      loader: normalized,
      version: targetVersion,
      query,
      summary: `Autonomous repair research gathered ${curatedSources.length} source snippets for ${normalized} ${targetVersion}.`,
      errorText: String(options.errorText || ''),
      sources: curatedSources,
      cachedAt: new Date().toISOString(),
    };
  });
}

async function resolveFabricBuild(version) {
  const sources = [];
  const value = { ...FABRIC_BUILD_FALLBACK };

  const yarnRows = await fetchJsonSafe(SOURCES.fabricYarnVersions(version));
  if (Array.isArray(yarnRows) && yarnRows.length) {
    sources.push(SOURCES.fabricYarnVersions(version));
    value.yarnVersion = firstStableValue(yarnRows.map(row => row?.version)) || FABRIC_YARN_FALLBACKS[version] || value.yarnVersion;
  } else if (FABRIC_YARN_FALLBACKS[version]) {
    value.yarnVersion = FABRIC_YARN_FALLBACKS[version];
  }

  const loaderRows = await fetchJsonSafe(`${SOURCES.fabricLoaderVersions}/${encodeURIComponent(version)}`);
  if (Array.isArray(loaderRows) && loaderRows.length) {
    sources.push(`${SOURCES.fabricLoaderVersions}/${encodeURIComponent(version)}`);
    value.loaderVersion = firstStableValue(loaderRows.map(row => row?.loader?.version)) || value.loaderVersion;
  } else {
    const allRows = await fetchJsonSafe(SOURCES.fabricLoaderVersions);
    if (Array.isArray(allRows) && allRows.length) {
      sources.push(SOURCES.fabricLoaderVersions);
      value.loaderVersion = firstStableValue(allRows.map(row => row?.loader?.version)) || value.loaderVersion;
    }
  }

  const fabricApiMetadata = await fetchTextSafe(SOURCES.fabricApiMetadata);
  const apiVersions = extractVersionList(fabricApiMetadata).filter(candidate => candidate.endsWith(`+${version}`));
  if (apiVersions.length) {
    sources.push(SOURCES.fabricApiMetadata);
    value.fabricApiVersion = apiVersions.at(-1);
  }

  const loomMetadata = await fetchTextSafe(SOURCES.fabricLoomPluginMetadata);
  const loomVersions = extractVersionList(loomMetadata);
  if (loomVersions.length) {
    sources.push(SOURCES.fabricLoomPluginMetadata);
    value.loomVersion = loomVersions.at(-1);
  }

  const gradleVersions = await fetchJsonSafe(SOURCES.gradleVersions);
  const stableGradle = pickGradleVersion(gradleVersions, version, 'fabric');
  if (stableGradle) {
    sources.push(SOURCES.gradleVersions);
    value.gradleVersion = stableGradle;
  }

  return {
    value,
    sources: uniqueStrings(sources),
    summary: `Researched official build metadata for fabric ${version}. ${buildSummaryLine(value)}`,
  };
}

async function resolveForgeBuild(version) {
  const sources = [];
  const value = { ...FORGE_BUILD_FALLBACK };

  const promotions = await fetchJsonSafe(SOURCES.forgePromotions);
  const promos = promotions?.promos && typeof promotions.promos === 'object' ? promotions.promos : null;
  if (promos) {
    sources.push(SOURCES.forgePromotions);
    value.forgeVersion = promos[`${version}-recommended`] || promos[`${version}-latest`] || value.forgeVersion;
  }

  const pluginMetadata = await fetchTextSafe(SOURCES.forgeGradlePluginMetadata);
  const pluginVersions = extractVersionList(pluginMetadata);
  if (pluginVersions.length) {
    sources.push(SOURCES.forgeGradlePluginMetadata);
    value.forgeGradleVersion = pluginVersions.at(-1);
  }

  const resolverMetadata = await fetchTextSafe(SOURCES.foojayResolverMetadata);
  const resolverVersions = extractVersionList(resolverMetadata);
  if (resolverVersions.length) {
    sources.push(SOURCES.foojayResolverMetadata);
    value.toolchainResolverVersion = resolverVersions.at(-1);
  }

  const gradleVersions = await fetchJsonSafe(SOURCES.gradleVersions);
  const stableGradle = pickGradleVersion(gradleVersions, version, 'forge');
  if (stableGradle) {
    sources.push(SOURCES.gradleVersions);
    value.gradleVersion = stableGradle;
  }

  return {
    value,
    sources: uniqueStrings(sources),
    summary: `Researched official build metadata for forge ${version}. ${buildSummaryLine(value)}`,
  };
}

async function resolveNeoForgeBuild(version) {
  const sources = [];
  const value = { ...NEOFORGE_BUILD_FALLBACK };

  const metadata = await fetchTextSafe(SOURCES.neoforgeMetadata);
  const neoforgeVersions = extractVersionList(metadata).filter(candidate => candidate.startsWith(versionToNeoForgePrefix(version)));
  if (neoforgeVersions.length) {
    sources.push(SOURCES.neoforgeMetadata);
    value.neoforgeVersion = neoforgeVersions.at(-1);
  }

  const userdevMetadata = await fetchTextSafe(SOURCES.neoforgeUserdevMetadata);
  const userdevVersions = extractVersionList(userdevMetadata);
  if (userdevVersions.length) {
    sources.push(SOURCES.neoforgeUserdevMetadata);
    value.userdevVersion = userdevVersions.at(-1);
  }

  const gradleVersions = await fetchJsonSafe(SOURCES.gradleVersions);
  const stableGradle = pickGradleVersion(gradleVersions, version, 'neoforge');
  if (stableGradle) {
    sources.push(SOURCES.gradleVersions);
    value.gradleVersion = stableGradle;
  }

  return {
    value,
    sources: uniqueStrings(sources),
    summary: `Researched official build metadata for neoforge ${version}. ${buildSummaryLine(value)}`,
  };
}

async function collectEvidence(loader, version, options = {}) {
  const official = OFFICIAL_DOC_SOURCES[loader] || [];
  const community = COMMUNITY_RESEARCH_SOURCES[loader] || [];
  const limit = Number(options.maxSources || official.length + community.length);
  const selected = [...official, ...community].slice(0, Math.max(0, limit));

  const results = await Promise.all(selected.map(async source => {
    const text = await fetchTextSafe(source.url);
    const snippet = summarizeText(text, `${loader} ${version}`);
    return {
      key: source.key,
      title: source.title,
      url: source.url,
      tier: source.tier || 'official',
      status: snippet ? 'ok' : 'unavailable',
      snippet,
    };
  }));

  return results.filter(Boolean);
}

async function collectAutonomousSources(loader, query, options = {}) {
  const errorTerms = extractErrorTerms(String(options.errorText || ''));
  const selected = [...(OFFICIAL_DOC_SOURCES[loader] || []), ...(COMMUNITY_RESEARCH_SOURCES[loader] || [])];
  const evidence = await Promise.all(selected.map(async source => {
    const text = await fetchTextSafe(source.url);
    const snippet = summarizeText(text, errorTerms || query);
    return {
      title: source.title,
      url: source.url,
      tier: source.tier || 'official',
      snippet,
    };
  }));

  return evidence
    .filter(source => source.snippet)
    .slice(0, MAX_AUTONOMOUS_SEARCH_RESULTS);
}

function normalizeLoader(loader) {
  const value = String(loader || '').trim().toLowerCase();
  if (value === 'fabric' || value === 'forge' || value === 'neoforge') {
    return value;
  }
  throw new Error(`Unsupported loader: ${loader}`);
}

function buildAutonomousQuery(loader, version, options = {}) {
  const terms = [
    loader,
    version,
    extractErrorTerms(String(options.errorText || '')),
    String(options.prompt || '').trim(),
  ].filter(Boolean);
  return terms.join(' ').replace(/\s+/g, ' ').trim();
}

function buildSummaryLine(build) {
  if (!build || typeof build !== 'object') return 'No build metadata found.';
  const pairs = [];
  if (build.gradleVersion) pairs.push(`Gradle ${build.gradleVersion}`);
  if (build.loomVersion) pairs.push(`Loom ${build.loomVersion}`);
  if (build.loaderVersion) pairs.push(`loader ${build.loaderVersion}`);
  if (build.yarnVersion) pairs.push(`Yarn ${build.yarnVersion}`);
  if (build.fabricApiVersion) pairs.push(`Fabric API ${build.fabricApiVersion}`);
  if (build.forgeVersion) pairs.push(`Forge ${build.forgeVersion}`);
  if (build.neoforgeVersion) pairs.push(`NeoForge ${build.neoforgeVersion}`);
  return pairs.length ? `Key versions: ${pairs.join(', ')}.` : 'No key versions found.';
}

function versionToNeoForgePrefix(version) {
  const match = String(version || '').match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!match) return '';
  const minor = Number(match[1]);
  return minor >= 20 ? `21.${Math.max(0, minor - 20)}` : '';
}

function firstStableValue(values) {
  const filtered = values
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter(value => !/snapshot/i.test(value));
  return filtered.at(-1) || '';
}

function pickGradleVersion(rows, version, loader) {
  if (!Array.isArray(rows) || !rows.length) {
    return loader === 'fabric' ? FABRIC_BUILD_FALLBACK.gradleVersion : loader === 'forge' ? FORGE_BUILD_FALLBACK.gradleVersion : NEOFORGE_BUILD_FALLBACK.gradleVersion;
  }
  const stableRows = rows
    .filter(row => row && row.version && row.snapshot !== true && row.broken !== true)
    .map(row => String(row.version));
  const preferred = stableRows.find(value => value.startsWith('9.')) || stableRows.find(value => value.startsWith('8.'));
  if (preferred) return preferred;
  return loader === 'fabric'
    ? FABRIC_BUILD_FALLBACK.gradleVersion
    : loader === 'forge'
    ? FORGE_BUILD_FALLBACK.gradleVersion
    : NEOFORGE_BUILD_FALLBACK.gradleVersion;
}

function summarizeText(text, query) {
  const compact = String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return '';

  const needleTerms = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9.+_-]+/i)
    .filter(term => term.length >= 3);

  if (!needleTerms.length) {
    return compact.slice(0, MAX_RESEARCH_SNIPPET_CHARS);
  }

  const lower = compact.toLowerCase();
  const index = needleTerms.reduce((best, term) => {
    const found = lower.indexOf(term);
    if (found === -1) return best;
    return best === -1 ? found : Math.min(best, found);
  }, -1);

  if (index === -1) {
    return compact.slice(0, MAX_RESEARCH_SNIPPET_CHARS);
  }

  const start = Math.max(0, index - 180);
  return compact.slice(start, start + MAX_RESEARCH_SNIPPET_CHARS);
}

function extractErrorTerms(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const best = lines.find(line => /error|exception|failed|cannot|could not|plugin|dependency/i.test(line)) || lines[0] || '';
  return best.slice(0, 300);
}

function extractVersionList(xmlText) {
  const text = String(xmlText || '');
  const matches = text.match(/<version>([^<]+)<\/version>/g) || [];
  return matches
    .map(match => match.replace(/^<version>|<\/version>$/g, '').trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

async function withCache(key, loader) {
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    return existing.value;
  }
  const value = await loader();
  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return value;
}

async function fetchJsonSafe(url) {
  const text = await fetchTextSafe(url);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchTextSafe(url) {
  if (!url) return '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEARCH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'CodexMC/1.0 research fetcher',
        Accept: 'application/json, text/plain, text/html, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
      signal: controller.signal,
    });
    if (!response.ok) return '';
    return await response.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}
