const CACHE_TTL_MS = 30 * 60 * 1000;
const DEEP_RESEARCH_BUDGET_MS = 115 * 1000;
const RESEARCH_REQUEST_TIMEOUT_MS = 12 * 1000;
const MAX_RESEARCH_SNIPPET_CHARS = 1200;
const MAX_AUTONOMOUS_SEARCH_RESULTS = 8;
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
  neoforge: [
    '1.21.11', '1.21.10', '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21',
    '1.20.6', '1.20.4', '1.20.2', '1.20.1',
  ],
};

const FABRIC_BUILD_FALLBACK = {
  loomVersion: '1.14.10',
  loaderVersion: '0.18.2',
  fabricApiVersion: null,
  mappingMode: 'yarn',
  yarnVersion: null,
  gradleVersion: '9.3.0',
};

const FABRIC_YARN_FALLBACKS = {
  '1.21.11': '1.21.11+build.4',
  '1.21.10': '1.21.10+build.3',
  '1.21.4': '1.21.4+build.8',
  '1.21.2': '1.21.2+build.1',
  '1.21.1': '1.21.1+build.3',
  '1.21': '1.21+build.9',
};

const FORGE_BUILD_FALLBACK = {
  forgeGradleVersion: '6.0.38',
  toolchainResolverVersion: '0.9.0',
  gradleVersion: '8.12.1',
  forgeVersion: '52.1.14',
  loaderVersion: '[52,)',
};

const NEOFORGE_BUILD_FALLBACK = {
  userdevVersion: '7.0.120',
  gradleVersion: '8.12.1',
  neoforgeVersion: '21.1.107',
  loaderVersion: '[1,)',
};

const SOURCES = {
  fabricGameVersions: 'https://meta.fabricmc.net/v2/versions/game',
  fabricLoaderVersions: 'https://meta.fabricmc.net/v2/versions/loader',
  fabricYarnVersions: version => `https://meta.fabricmc.net/v2/versions/yarn/${encodeURIComponent(version)}`,
  fabricYarnMetadata: 'https://maven.fabricmc.net/net/fabricmc/yarn/maven-metadata.xml',
  fabricLoaderMetadata: 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/maven-metadata.xml',
  fabricApiMetadata: 'https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml',
  fabricLoomPluginMetadata: 'https://plugins.gradle.org/m2/net/fabricmc/fabric-loom/net.fabricmc.fabric-loom.gradle.plugin/maven-metadata.xml',
  forgePromotions: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
  forgeMetadata: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
  forgeGradlePluginMetadata: 'https://plugins.gradle.org/m2/net/minecraftforge/gradle/net.minecraftforge.gradle.gradle.plugin/maven-metadata.xml',
  neoforgeMetadata: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
  neoforgeUserdevMetadata: 'https://maven.neoforged.net/releases/net/neoforged/gradle/userdev/net.neoforged.gradle.userdev.gradle.plugin/maven-metadata.xml',
  foojayResolverMetadata: 'https://plugins.gradle.org/m2/org/gradle/toolchains/foojay-resolver-convention/org.gradle.toolchains.foojay-resolver-convention.gradle.plugin/maven-metadata.xml',
  gradleVersions: 'https://services.gradle.org/versions/all',
};

const OFFICIAL_DOC_SOURCES = {
  fabric: [
    {
      key: 'fabricDocsSetup',
      url: 'https://docs.fabricmc.net/develop/getting-started/setting-up-a-development-environment',
      kind: 'text',
      title: 'Fabric docs: setup',
    },
    {
      key: 'fabricDocsBlocks',
      url: 'https://docs.fabricmc.net/develop/blocks/first-block',
      kind: 'text',
      title: 'Fabric docs: blocks',
    },
    {
      key: 'fabricDocsItems',
      url: 'https://docs.fabricmc.net/develop/items/first-item',
      kind: 'text',
      title: 'Fabric docs: items',
    },
  ],
  forge: [
    {
      key: 'forgeDocsGettingStarted',
      url: 'https://docs.minecraftforge.net/en/latest/gettingstarted/',
      kind: 'text',
      title: 'Forge docs: getting started',
    },
    {
      key: 'forgeDocsBlocks',
      url: 'https://docs.minecraftforge.net/en/latest/blocks/',
      kind: 'text',
      title: 'Forge docs: blocks',
    },
    {
      key: 'forgeDocsEvents',
      url: 'https://docs.minecraftforge.net/en/latest/concepts/events/',
      kind: 'text',
      title: 'Forge docs: events',
    },
  ],
  neoforge: [
    {
      key: 'neoforgeDocsGettingStarted',
      url: 'https://docs.neoforged.net/docs/gettingstarted/',
      kind: 'text',
      title: 'NeoForge docs: getting started',
    },
    {
      key: 'neoforgeDocsBlocks',
      url: 'https://docs.neoforged.net/docs/blocks/',
      kind: 'text',
      title: 'NeoForge docs: blocks',
    },
    {
      key: 'neoforgeDocsEvents',
      url: 'https://docs.neoforged.net/docs/concepts/events/',
      kind: 'text',
      title: 'NeoForge docs: events',
    },
  ],
};

const COMMUNITY_RESEARCH_SOURCES = {
  fabric: [
    {
      key: 'fabricGithubDiscussions',
      url: 'https://github.com/orgs/FabricMC/discussions',
      kind: 'text',
      title: 'FabricMC GitHub discussions',
      tier: 'community',
    },
    {
      key: 'fabricLoomIssues',
      url: 'https://github.com/FabricMC/fabric-loom/issues',
      kind: 'text',
      title: 'Fabric Loom issues',
      tier: 'community',
    },
    {
      key: 'yarnJavadocs',
      url: 'https://maven.fabricmc.net/docs/yarn-1.21.1+build.3/index.html',
      kind: 'text',
      title: 'Yarn Javadocs index',
      tier: 'community',
    },
    {
      key: 'mixinWiki',
      url: 'https://github.com/SpongePowered/Mixin/wiki',
      kind: 'text',
      title: 'Mixin wiki',
      tier: 'community',
    },
    {
      key: 'modrinthDocs',
      url: 'https://docs.modrinth.com/',
      kind: 'text',
      title: 'Modrinth docs',
      tier: 'community',
    },
  ],
  forge: [
    {
      key: 'forgeForums',
      url: 'https://forums.minecraftforge.net/',
      kind: 'text',
      title: 'Forge forums',
      tier: 'community',
    },
    {
      key: 'forgeGithubIssues',
      url: 'https://github.com/MinecraftForge/MinecraftForge/issues',
      kind: 'text',
      title: 'MinecraftForge issues',
      tier: 'community',
    },
    {
      key: 'mixinWikiForge',
      url: 'https://github.com/SpongePowered/Mixin/wiki',
      kind: 'text',
      title: 'Mixin wiki',
      tier: 'community',
    },
    {
      key: 'modrinthDocsForge',
      url: 'https://docs.modrinth.com/',
      kind: 'text',
      title: 'Modrinth docs',
      tier: 'community',
    },
  ],
  neoforge: [
    {
      key: 'neoforgeGithubIssues',
      url: 'https://github.com/neoforged/NeoForge/issues',
      kind: 'text',
      title: 'NeoForge issues',
      tier: 'community',
    },
    {
      key: 'neoforgeGithubDiscussions',
      url: 'https://github.com/orgs/neoforged/discussions',
      kind: 'text',
      title: 'NeoForged discussions',
      tier: 'community',
    },
    {
      key: 'mixinWikiNeoForge',
      url: 'https://github.com/SpongePowered/Mixin/wiki',
      kind: 'text',
      title: 'Mixin wiki',
      tier: 'community',
    },
    {
      key: 'modrinthDocsNeoForge',
      url: 'https://docs.modrinth.com/',
      kind: 'text',
      title: 'Modrinth docs',
      tier: 'community',
    },
  ],
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
    if (loader === 'neoforge') {
      const versions = await fetchNeoForgeVersions();
      return { loader, versions, sources: [SOURCES.neoforgeMetadata] };
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
          SOURCES.fabricYarnMetadata,
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
    if (loader === 'neoforge') {
      const build = await fetchNeoForgeBuildResearch(version);
      return {
        loader,
        version,
        build,
        sources: [
          SOURCES.neoforgeMetadata,
          SOURCES.neoforgeUserdevMetadata,
          SOURCES.gradleVersions,
        ],
      };
    }
    return { loader, version, build: null, sources: [] };
  });
}

export async function getDeepBuildResearch(loader, version, options = {}) {
  const timeBudgetMs = Number(options.timeBudgetMs) > 0
    ? Number(options.timeBudgetMs)
    : DEEP_RESEARCH_BUDGET_MS;
  const includeCommunity = options.includeCommunity !== false;
  const cacheKey = `deep-build:${loader}:${version}:${timeBudgetMs}`;
  return withCache(cacheKey, async () => {
    const startedAt = Date.now();
    const baseResearch = await getBuildResearch(loader, version);
    const coreSources = buildCoreResearchSources(loader, version);
    const docSources = OFFICIAL_DOC_SOURCES[loader] || [];
    const communitySources = includeCommunity ? (COMMUNITY_RESEARCH_SOURCES[loader] || []) : [];
    const allSources = [...coreSources, ...docSources, ...communitySources];
    const evidence = await fetchDeepResearchEvidence(allSources, timeBudgetMs);
    const completedAt = Date.now();
    return {
      loader,
      version,
      build: baseResearch?.build || null,
      sources: [...new Set([...(baseResearch?.sources || []), ...allSources.map(source => source.url)])],
      evidence,
      researchWindowMs: timeBudgetMs,
      completedInMs: completedAt - startedAt,
      completedAt: new Date(completedAt).toISOString(),
      summary: summarizeResearch(loader, version, baseResearch?.build, evidence, completedAt - startedAt),
    };
  });
}

export async function getAutonomousRepairResearch(loader, version, options = {}) {
  const errorText = compactSearchText(options.errorText || options.failureSignature || '', 1200);
  const promptText = compactSearchText(options.prompt || '', 500);
  const query = buildAutonomousQuery(loader, version, errorText, promptText);
  const cacheKey = `auto-research:${loader}:${version}:${query}`;
  return withCache(cacheKey, async () => {
    const searchResults = await searchWebForRepairContext(query, loader);
    const fetchedSources = await fetchDeepResearchEvidence(searchResults, Number(options.timeBudgetMs) || 45000);
    const rankedSources = rankAutonomousSources(fetchedSources, loader, version, errorText);
    return {
      loader,
      version,
      query,
      errorText,
      sources: rankedSources,
      summary: summarizeAutonomousResearch(loader, version, rankedSources, query),
      completedAt: new Date().toISOString(),
    };
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

async function fetchNeoForgeVersions() {
  try {
    const metadata = await fetchText(SOURCES.neoforgeMetadata);
    const versions = uniqueSortedVersions(
      parseMavenVersions(metadata)
        .map(mapNeoForgeArtifactToMinecraftVersion)
        .filter(Boolean),
    );
    return versions.length ? versions : FALLBACK_VERSIONS.neoforge;
  } catch {
    return FALLBACK_VERSIONS.neoforge;
  }
}

async function fetchFabricBuildResearch(version) {
  const [loaderMetadataXml, apiMetadataXml, loomMetadataXml, yarnEntries, yarnMetadataXml, gradleVersions] = await Promise.all([
    safeFetchText(SOURCES.fabricLoaderMetadata),
    safeFetchText(SOURCES.fabricApiMetadata),
    safeFetchText(SOURCES.fabricLoomPluginMetadata),
    safeFetchJson(SOURCES.fabricYarnVersions(version)),
    safeFetchText(SOURCES.fabricYarnMetadata),
    safeFetchJson(SOURCES.gradleVersions),
  ]);

  const loaderVersions = parseMavenVersions(loaderMetadataXml);
  const apiVersions = parseMavenVersions(apiMetadataXml);
  const loomVersions = parseMavenVersions(loomMetadataXml);

  const loaderVersion = pickLatestStable(loaderVersions) || FABRIC_BUILD_FALLBACK.loaderVersion;
  const fabricApiVersion = pickLatestFabricApiVersion(apiVersions, version);
  const loomVersion = pickLatestStable(loomVersions) || FABRIC_BUILD_FALLBACK.loomVersion;
  const yarnVersion = pickLatestYarnVersion(yarnEntries, version, parseMavenVersions(yarnMetadataXml));
  const resolvedYarnVersion = yarnVersion || getFabricYarnFallback(version);
  const mappingMode = /^26\./.test(String(version || ''))
    ? 'none'
    : (resolvedYarnVersion ? 'yarn' : FABRIC_BUILD_FALLBACK.mappingMode);
  const gradleVersion = pickGradleVersion(gradleVersions, { major: 9 }) || FABRIC_BUILD_FALLBACK.gradleVersion;

  return {
    ...FABRIC_BUILD_FALLBACK,
    loaderVersion,
    fabricApiVersion: fabricApiVersion || null,
    loomVersion,
    mappingMode,
    yarnVersion: resolvedYarnVersion || null,
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

async function fetchNeoForgeBuildResearch(version) {
  const [neoforgeXml, userdevXml, gradleVersions] = await Promise.all([
    safeFetchText(SOURCES.neoforgeMetadata),
    safeFetchText(SOURCES.neoforgeUserdevMetadata),
    safeFetchJson(SOURCES.gradleVersions),
  ]);

  const neoforgeVersion = pickLatestNeoForgeForGame(parseMavenVersions(neoforgeXml), version)
    || NEOFORGE_BUILD_FALLBACK.neoforgeVersion;
  const userdevVersion = pickLatestStable(parseMavenVersions(userdevXml))
    || NEOFORGE_BUILD_FALLBACK.userdevVersion;
  const gradleVersion = pickGradleVersion(gradleVersions, { major: 8, minMinor: 5 })
    || NEOFORGE_BUILD_FALLBACK.gradleVersion;

  return {
    ...NEOFORGE_BUILD_FALLBACK,
    neoforgeVersion,
    userdevVersion,
    gradleVersion,
    loaderVersion: '[1,)',
  };
}

function buildCoreResearchSources(loader, version) {
  if (loader === 'fabric') {
    return [
      { key: 'fabricLoaderVersions', url: SOURCES.fabricLoaderVersions, kind: 'json', title: 'Fabric Meta loader versions', tier: 'official' },
      { key: 'fabricLoaderMetadata', url: SOURCES.fabricLoaderMetadata, kind: 'xml', title: 'Fabric loader Maven metadata', tier: 'official' },
      { key: 'fabricYarnVersions', url: SOURCES.fabricYarnVersions(version), kind: 'json', title: 'Fabric Meta Yarn versions', tier: 'official' },
      { key: 'fabricYarnMetadata', url: SOURCES.fabricYarnMetadata, kind: 'xml', title: 'Fabric Yarn Maven metadata', tier: 'official' },
      { key: 'fabricApiMetadata', url: SOURCES.fabricApiMetadata, kind: 'xml', title: 'Fabric API Maven metadata', tier: 'official' },
      { key: 'fabricLoomPluginMetadata', url: SOURCES.fabricLoomPluginMetadata, kind: 'xml', title: 'Fabric Loom plugin metadata', tier: 'official' },
      { key: 'gradleVersions', url: SOURCES.gradleVersions, kind: 'json', title: 'Gradle versions', tier: 'official' },
    ];
  }
  if (loader === 'forge') {
    return [
      { key: 'forgePromotions', url: SOURCES.forgePromotions, kind: 'json', title: 'Forge promotions', tier: 'official' },
      { key: 'forgeMetadata', url: SOURCES.forgeMetadata, kind: 'xml', title: 'Forge Maven metadata', tier: 'official' },
      { key: 'forgeGradlePluginMetadata', url: SOURCES.forgeGradlePluginMetadata, kind: 'xml', title: 'ForgeGradle plugin metadata', tier: 'official' },
      { key: 'foojayResolverMetadata', url: SOURCES.foojayResolverMetadata, kind: 'xml', title: 'Foojay resolver metadata', tier: 'official' },
      { key: 'gradleVersions', url: SOURCES.gradleVersions, kind: 'json', title: 'Gradle versions', tier: 'official' },
    ];
  }
  if (loader === 'neoforge') {
    return [
      { key: 'neoforgeMetadata', url: SOURCES.neoforgeMetadata, kind: 'xml', title: 'NeoForge Maven metadata', tier: 'official' },
      { key: 'neoforgeUserdevMetadata', url: SOURCES.neoforgeUserdevMetadata, kind: 'xml', title: 'NeoForge userdev plugin metadata', tier: 'official' },
      { key: 'gradleVersions', url: SOURCES.gradleVersions, kind: 'json', title: 'Gradle versions', tier: 'official' },
    ];
  }
  return [];
}

async function fetchDeepResearchEvidence(sources, timeBudgetMs) {
  const deadline = Date.now() + Math.max(1000, timeBudgetMs);
  const tasks = (sources || []).map(source => fetchResearchSource(source, deadline));
  const settled = await Promise.allSettled(tasks);
  return settled
    .map(result => result.status === 'fulfilled' ? result.value : null)
    .filter(Boolean);
}

async function searchWebForRepairContext(query, loader) {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchTextWithTimeout(searchUrl, RESEARCH_REQUEST_TIMEOUT_MS, 'text/html,*/*');
  const results = parseDuckDuckGoResults(html)
    .map(result => ({
      ...result,
      tier: classifyResearchTier(result.url, loader),
      kind: 'text',
    }))
    .filter(result => Boolean(result.url))
    .slice(0, MAX_AUTONOMOUS_SEARCH_RESULTS);
  return results.length ? results : buildCoreResearchSources(loader, '').slice(0, 4);
}

function parseDuckDuckGoResults(html) {
  const text = String(html || '');
  const matches = [...text.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  return matches.map(match => ({
    url: decodeDuckDuckGoUrl(match[1]),
    title: stripHtml(match[2]) || decodeDuckDuckGoUrl(match[1]),
  }));
}

function decodeDuckDuckGoUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'https://html.duckduckgo.com');
    if (parsed.hostname.includes('duckduckgo.com') && parsed.searchParams.get('uddg')) {
      return decodeURIComponent(parsed.searchParams.get('uddg'));
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

function classifyResearchTier(url, loader) {
  const host = safeHostname(url);
  if (!host) return 'community';
  if (
    host.includes('fabricmc.net')
    || host.includes('maven.fabricmc.net')
    || host.includes('docs.fabricmc.net')
    || host.includes('minecraftforge.net')
    || host.includes('files.minecraftforge.net')
    || host.includes('maven.minecraftforge.net')
    || host.includes('docs.minecraftforge.net')
    || host.includes('neoforged.net')
    || host.includes('maven.neoforged.net')
    || host.includes('docs.neoforged.net')
    || host.includes('plugins.gradle.org')
    || host.includes('services.gradle.org')
  ) {
    return 'official';
  }
  if (host.includes('github.com') || host.includes('forums.minecraftforge.net') || host.includes('modrinth.com') || host.includes('stackoverflow.com') || host.includes('reddit.com')) {
    return 'community';
  }
  return loader === 'fabric' || loader === 'forge' || loader === 'neoforge' ? 'post' : 'community';
}

function rankAutonomousSources(sources, loader, version, errorText) {
  return (sources || [])
    .filter(item => item && item.status === 'ok' && item.snippet)
    .map(item => ({
      ...item,
      score: scoreAutonomousSource(item, loader, version, errorText),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function scoreAutonomousSource(source, loader, version, errorText) {
  let score = source.tier === 'official' ? 100 : source.tier === 'community' ? 60 : 40;
  const haystack = `${source.title || ''} ${source.snippet || ''} ${source.url || ''}`.toLowerCase();
  if (haystack.includes(String(version || '').toLowerCase())) score += 25;
  if (haystack.includes(String(loader || '').toLowerCase())) score += 20;
  tokenize(errorText).forEach(token => {
    if (haystack.includes(token)) score += 4;
  });
  return score;
}

function summarizeAutonomousResearch(loader, version, sources, query) {
  const official = (sources || []).filter(source => source.tier === 'official').length;
  const community = (sources || []).filter(source => source.tier === 'community').length;
  const posts = (sources || []).filter(source => source.tier === 'post').length;
  return `Autonomous repair research searched online for ${loader} ${version} using "${query}" and kept ${official} official, ${community} community, and ${posts} post/forum sources.`;
}

function buildAutonomousQuery(loader, version, errorText, promptText) {
  const errorKeywords = tokenizeSearchText(errorText).slice(0, 12).join(' ');
  const promptKeywords = tokenizeSearchText(promptText).slice(0, 6).join(' ');
  return [loader, version, errorKeywords, promptKeywords, 'modding fix']
    .filter(Boolean)
    .join(' ')
    .trim();
}

function tokenizeSearchText(text) {
  return [...new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9_+.:-]+/)
      .filter(token => token.length >= 3)
  )];
}

function compactSearchText(text, maxChars) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeHostname(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function fetchResearchSource(source, deadlineMs) {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 250) {
    return {
      url: source.url,
      title: source.title || source.url,
      kind: source.kind || 'text',
      tier: source.tier || 'official',
      status: 'skipped',
      snippet: '',
    };
  }

  const timeoutMs = Math.min(RESEARCH_REQUEST_TIMEOUT_MS, remainingMs);
  try {
    const text = await fetchTextWithTimeout(source.url, timeoutMs, source.kind === 'json' ? 'application/json' : 'text/html,application/xml,text/xml,text/plain,*/*');
    return {
      url: source.url,
      title: source.title || source.url,
      kind: source.kind || 'text',
      tier: source.tier || 'official',
      status: 'ok',
      snippet: summarizeFetchedText(text, source.kind),
    };
  } catch (error) {
    return {
      url: source.url,
      title: source.title || source.url,
      kind: source.kind || 'text',
      tier: source.tier || 'official',
      status: 'error',
      snippet: String(error?.message || 'Fetch failed.'),
    };
  }
}

async function fetchTextWithTimeout(url, timeoutMs, acceptHeader) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: acceptHeader },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function summarizeFetchedText(text, kind) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (kind === 'json') {
    try {
      const parsed = JSON.parse(raw);
      return limitSnippet(JSON.stringify(parsed).replace(/\s+/g, ' '));
    } catch {
      return limitSnippet(raw.replace(/\s+/g, ' '));
    }
  }
  if (kind === 'xml') {
    return limitSnippet(raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  }
  return limitSnippet(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  );
}

function limitSnippet(text) {
  return String(text || '').slice(0, MAX_RESEARCH_SNIPPET_CHARS);
}

function summarizeResearch(loader, version, build, evidence, completedInMs) {
  const successful = (evidence || []).filter(item => item.status === 'ok');
  const officialCount = successful.filter(item => item.tier !== 'community').length;
  const communityCount = successful.filter(item => item.tier === 'community').length;
  const buildBits = [];
  if (build?.gradleVersion) buildBits.push(`Gradle ${build.gradleVersion}`);
  if (build?.loomVersion) buildBits.push(`Loom ${build.loomVersion}`);
  if (build?.loaderVersion) buildBits.push(`loader ${build.loaderVersion}`);
  if (build?.yarnVersion) buildBits.push(`Yarn ${build.yarnVersion}`);
  if (build?.forgeVersion) buildBits.push(`Forge ${build.forgeVersion}`);
  if (build?.neoforgeVersion) buildBits.push(`NeoForge ${build.neoforgeVersion}`);
  return `Deep research scanned ${officialCount} official and ${communityCount} community ${loader} sources for ${version} in ${Math.max(1, Math.round(completedInMs / 1000))}s.${buildBits.length ? ` Key versions: ${buildBits.join(', ')}.` : ''}`;
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
    (versions || []).filter(version => isFabricApiVersionForMinecraft(version, minecraftVersion) && String(version).includes(exactSuffix)),
  );
  return matching[0] || null;
}

function isFabricApiVersionForMinecraft(version, minecraftVersion) {
  const normalizedVersion = String(version || '').trim();
  const normalizedMinecraft = String(minecraftVersion || '').trim();
  if (!normalizedVersion || !normalizedMinecraft) return false;
  return normalizedVersion.endsWith(`+${normalizedMinecraft}`);
}

function pickLatestYarnVersion(entries, minecraftVersion, metadataVersions = []) {
  const apiVersions = (entries || [])
    .filter(entry => entry && typeof entry.version === 'string')
    .filter(entry => entry.stable !== false)
    .map(entry => entry.version);
  const versions = uniqueSortedVersions(
    [...apiVersions, ...(metadataVersions || [])]
      .filter(version => String(version).startsWith(`${minecraftVersion}+build.`))
      .filter(version => /^\d+\.\d+(?:\.\d+)?\+build\.\d+$/.test(String(version))),
  );
  return versions[0] || null;
}

function getFabricYarnFallback(minecraftVersion) {
  return FABRIC_YARN_FALLBACKS[String(minecraftVersion || '')] || null;
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
      .filter(version => !/milestone|rc|preview|beta|alpha|snapshot/i.test(String(version)))
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

function mapNeoForgeArtifactToMinecraftVersion(version) {
  const value = String(version || '');
  if (/alpha|beta|snapshot|pre|rc/i.test(value)) return null;
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const branch = Number(match[1]);
  const minor = Number(match[2]);
  if (branch === 21) {
    return minor === 0 ? '1.21' : `1.21.${minor}`;
  }
  if (branch === 20) {
    return minor === 1 ? '1.20.1' : `1.20.${minor}`;
  }
  return null;
}

function pickLatestNeoForgeForGame(versions, minecraftVersion) {
  const matches = uniqueSortedVersions(
    (versions || []).filter(version => mapNeoForgeArtifactToMinecraftVersion(version) === minecraftVersion),
  );
  return matches[0] || null;
}
