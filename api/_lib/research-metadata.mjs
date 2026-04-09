const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

const FALLBACK_VERSIONS = {
  fabric: [
    '1.21.11', '1.21.10', '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21',
    '1.20.6', '1.20.4', '1.20.2', '1.20.1',
    '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19',
    '1.18.2', '1.18.1', '1.18',
    '1.17.1',
    '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1',
  ],
  forge: [
    '1.21.11', '1.21.10', '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21',
    '1.20.6', '1.20.4', '1.20.2', '1.20.1',
    '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19',
    '1.18.2', '1.18.1', '1.18',
    '1.17.1',
    '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1',
    '1.15.2', '1.15.1', '1.15',
    '1.14.4',
    '1.12.2',
  ],
};

const FABRIC_BUILD_FALLBACK = {
  loomVersion: '1.14.10',
  loaderVersion: '0.18.2',
  fabricApiVersion: null,
  mappingMode: 'official',
  yarnVersion: null,
  gradleVersion: '9.3.0',
};

const FORGE_BUILD_FALLBACK = {
  forgeGradleVersion: '6.0.38',
  toolchainResolverVersion: '0.9.0',
  gradleVersion: '8.12.1',
  forgeVersion: '52.1.14',
  loaderVersion: '[52,)',
};

const SOURCES = {
  fabricGameVersions: 'https://meta.fabricmc.net/v2/versions/game',
  fabricLoaderVersions: 'https://meta.fabricmc.net/v2/versions/loader',
  fabricYarnVersions: version => `https://meta.fabricmc.net/v2/versions/yarn/${encodeURIComponent(version)}`,
  fabricLoaderMetadata: 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/maven-metadata.xml',
  fabricApiMetadata: 'https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml',
  fabricLoomPluginMetadata: 'https://plugins.gradle.org/m2/net/fabricmc/fabric-loom/net.fabricmc.fabric-loom.gradle.plugin/maven-metadata.xml',
  forgePromotions: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
  forgeMetadata: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
  forgeGradlePluginMetadata: 'https://plugins.gradle.org/m2/net/minecraftforge/gradle/net.minecraftforge.gradle.gradle.plugin/maven-metadata.xml',
  foojayResolverMetadata: 'https://plugins.gradle.org/m2/org/gradle/toolchains/foojay-resolver-convention/org.gradle.toolchains.foojay-resolver-convention.gradle.plugin/maven-metadata.xml',
  gradleVersions: 'https://services.gradle.org/versions/all',
};

export async function getLoaderVersions(loader) {
  return withCache(`loader-versions:${loader}`, async () => {
    if (loader === 'fabric') {
      const versions = await fetchFabricVersions();
      return { loader, versions, sources: [SOURCES.fabricGameVersions] };
    }
    if (loader === 'forge') {
      const versions = await fetchForgeVersions();
      return { loader, versions, sources: [SOURCES.forgePromotions, SOURCES.forgeMetadata] };
    }
    return { loader, versions: [], sources: [] };
  });
}

export async function getBuildResearch(loader, version) {
  return withCache(`build:${loader}:${version}`, async () => {
    if (loader === 'fabric') {
      const build = await fetchFabricBuildResearch(version);
      return {
        loader,
        version,
        build,
        sources: [
          SOURCES.fabricLoaderVersions,
          SOURCES.fabricYarnVersions(version),
          SOURCES.fabricLoaderMetadata,
          SOURCES.fabricApiMetadata,
          SOURCES.fabricLoomPluginMetadata,
          SOURCES.gradleVersions,
        ],
      };
    }
    if (loader === 'forge') {
      const build = await fetchForgeBuildResearch(version);
      return {
        loader,
        version,
        build,
        sources: [
          SOURCES.forgePromotions,
          SOURCES.forgeMetadata,
          SOURCES.forgeGradlePluginMetadata,
          SOURCES.foojayResolverMetadata,
          SOURCES.gradleVersions,
        ],
      };
    }
    return { loader, version, build: null, sources: [] };
  });
}

async function fetchFabricVersions() {
  try {
    const data = await fetchJson(SOURCES.fabricGameVersions);
    const versions = uniqueSortedVersions(
      data
        .filter(entry => entry && typeof entry.version === 'string')
        .filter(entry => entry.stable !== false && entry.snapshot !== true)
        .map(entry => entry.version),
    );
    return versions.length ? versions : FALLBACK_VERSIONS.fabric;
  } catch {
    return FALLBACK_VERSIONS.fabric;
  }
}

async function fetchForgeVersions() {
  try {
    const promos = await fetchJson(SOURCES.forgePromotions);
    const versions = uniqueSortedVersions(
      Object.keys(promos?.promos || {})
        .map(key => key.match(/^(.+?)-(?:latest|recommended)$/)?.[1])
        .filter(Boolean),
    );
    return versions.length ? versions : FALLBACK_VERSIONS.forge;
  } catch {
    return FALLBACK_VERSIONS.forge;
  }
}

async function fetchFabricBuildResearch(version) {
  const [loaderMetadataXml, apiMetadataXml, loomMetadataXml, yarnEntries, gradleVersions] = await Promise.all([
    safeFetchText(SOURCES.fabricLoaderMetadata),
    safeFetchText(SOURCES.fabricApiMetadata),
    safeFetchText(SOURCES.fabricLoomPluginMetadata),
    safeFetchJson(SOURCES.fabricYarnVersions(version)),
    safeFetchJson(SOURCES.gradleVersions),
  ]);

  const loaderVersions = parseMavenVersions(loaderMetadataXml);
  const apiVersions = parseMavenVersions(apiMetadataXml);
  const loomVersions = parseMavenVersions(loomMetadataXml);

  const loaderVersion = pickLatestStable(loaderVersions) || FABRIC_BUILD_FALLBACK.loaderVersion;
  const fabricApiVersion = pickLatestFabricApiVersion(apiVersions, version);
  const loomVersion = pickLatestStable(loomVersions) || FABRIC_BUILD_FALLBACK.loomVersion;
  const yarnVersion = pickLatestYarnVersion(yarnEntries, version);
  const mappingMode = /^26\./.test(String(version || ''))
    ? 'none'
    : (yarnVersion ? 'yarn' : FABRIC_BUILD_FALLBACK.mappingMode);
  const gradleVersion = pickGradleVersion(gradleVersions, { major: 9 }) || FABRIC_BUILD_FALLBACK.gradleVersion;

  return {
    ...FABRIC_BUILD_FALLBACK,
    loaderVersion,
    fabricApiVersion: fabricApiVersion || null,
    loomVersion,
    mappingMode,
    yarnVersion: yarnVersion || null,
    gradleVersion,
  };
}

async function fetchForgeBuildResearch(version) {
  const [promotionsJson, forgeMetadataXml, forgeGradleXml, foojayXml, gradleVersions] = await Promise.all([
    safeFetchJson(SOURCES.forgePromotions),
    safeFetchText(SOURCES.forgeMetadata),
    safeFetchText(SOURCES.forgeGradlePluginMetadata),
    safeFetchText(SOURCES.foojayResolverMetadata),
    safeFetchJson(SOURCES.gradleVersions),
  ]);

  const promotions = promotionsJson?.promos || {};
  const forgeVersion = promotions[`${version}-recommended`]
    || promotions[`${version}-latest`]
    || pickLatestForgeForGame(parseMavenVersions(forgeMetadataXml), version)
    || FORGE_BUILD_FALLBACK.forgeVersion;
  const forgeGradleVersion = pickLatestMatchingMajor(parseMavenVersions(forgeGradleXml), 6)
    || FORGE_BUILD_FALLBACK.forgeGradleVersion;
  const toolchainResolverVersion = pickLatestStable(parseMavenVersions(foojayXml))
    || FORGE_BUILD_FALLBACK.toolchainResolverVersion;
  const gradleVersion = pickGradleVersion(gradleVersions, { major: 8, minMinor: 5 })
    || FORGE_BUILD_FALLBACK.gradleVersion;
  const loaderMajor = Number(String(forgeVersion).split('.')[0]) || 52;

  return {
    ...FORGE_BUILD_FALLBACK,
    forgeVersion,
    forgeGradleVersion,
    toolchainResolverVersion,
    gradleVersion,
    loaderVersion: `[${loaderMajor},)`,
  };
}

async function withCache(key, factory) {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && (now - cached.time) < CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await factory();
  cache.set(key, { time: now, value });
  return value;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/xml,text/xml,text/plain,*/*' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

async function safeFetchJson(url) {
  try {
    return await fetchJson(url);
  } catch {
    return null;
  }
}

async function safeFetchText(url) {
  try {
    return await fetchText(url);
  } catch {
    return '';
  }
}

function parseMavenVersions(xml) {
  if (!xml) return [];
  const matches = [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)];
  return uniqueSortedVersions(matches.map(match => match[1]));
}

function pickLatestStable(versions) {
  return uniqueSortedVersions(
    (versions || []).filter(version => !/snapshot|rc|beta|alpha|milestone/i.test(String(version))),
  )[0] || null;
}

function pickLatestMatchingMajor(versions, major) {
  return uniqueSortedVersions(
    (versions || []).filter(version => {
      const parsed = parseVersionParts(version);
      return parsed[0] === major && !/snapshot|rc|beta|alpha|milestone/i.test(String(version));
    }),
  )[0] || null;
}

function pickLatestFabricApiVersion(versions, minecraftVersion) {
  const exactSuffix = `+${minecraftVersion}`;
  const matching = uniqueSortedVersions(
    (versions || []).filter(version => String(version).includes(exactSuffix)),
  );
  return matching[0] || null;
}

function pickLatestYarnVersion(entries, minecraftVersion) {
  const versions = uniqueSortedVersions(
    (entries || [])
      .filter(entry => entry && typeof entry.version === 'string')
      .filter(entry => entry.stable !== false)
      .map(entry => entry.version)
      .filter(version => String(version).startsWith(`${minecraftVersion}+build.`)),
  );
  return versions[0] || null;
}

function pickLatestForgeForGame(versions, minecraftVersion) {
  const matches = uniqueSortedVersions(
    (versions || []).filter(version => String(version).startsWith(`${minecraftVersion}-`)),
  );
  return matches[0] ? String(matches[0]).slice(minecraftVersion.length + 1) : null;
}

function pickGradleVersion(entries, options = {}) {
  const versions = uniqueSortedVersions(
    (entries || [])
      .filter(entry => entry && typeof entry.version === 'string')
      .filter(entry => entry.snapshot !== true && entry.nightly !== true && entry.releaseNightly !== true && entry.broken !== true)
      .map(entry => entry.version)
      .filter(version => {
        const parsed = parseVersionParts(version);
        if (!parsed.length) return false;
        if (options.major != null && parsed[0] !== options.major) return false;
        if (options.minMinor != null && (parsed[1] || 0) < options.minMinor) return false;
        return true;
      }),
  );
  return versions[0] || null;
}

function uniqueSortedVersions(versions) {
  return [...new Set((versions || []).filter(Boolean).map(value => String(value).trim()).filter(Boolean))]
    .sort(compareVersionsDesc);
}

function compareVersionsDesc(left, right) {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (b[index] || 0) - (a[index] || 0);
    if (delta !== 0) return delta;
  }
  return String(right).localeCompare(String(left));
}

function parseVersionParts(version) {
  return String(version || '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
}
