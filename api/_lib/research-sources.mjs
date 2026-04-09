export const CACHE_TTL_MS = 30 * 60 * 1000;
export const DEEP_RESEARCH_BUDGET_MS = 115 * 1000;
export const RESEARCH_REQUEST_TIMEOUT_MS = 12 * 1000;
export const MAX_RESEARCH_SNIPPET_CHARS = 1200;
export const MAX_AUTONOMOUS_SEARCH_RESULTS = 8;

export const FALLBACK_VERSIONS = {
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

export const FABRIC_BUILD_FALLBACK = {
  loomVersion: '1.14.10',
  loaderVersion: '0.18.2',
  fabricApiVersion: null,
  mappingMode: 'yarn',
  yarnVersion: null,
  gradleVersion: '9.3.0',
};

export const FABRIC_YARN_FALLBACKS = {
  '1.21.11': '1.21.11+build.4',
  '1.21.10': '1.21.10+build.3',
  '1.21.4': '1.21.4+build.8',
  '1.21.2': '1.21.2+build.1',
  '1.21.1': '1.21.1+build.3',
  '1.21': '1.21+build.9',
};

export const FORGE_BUILD_FALLBACK = {
  forgeGradleVersion: '6.0.38',
  toolchainResolverVersion: '0.9.0',
  gradleVersion: '8.12.1',
  forgeVersion: '52.1.14',
  loaderVersion: '[52,)',
};

export const NEOFORGE_BUILD_FALLBACK = {
  userdevVersion: '7.0.120',
  gradleVersion: '8.12.1',
  neoforgeVersion: '21.1.107',
  loaderVersion: '[1,)',
};

export const SOURCES = {
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

export const OFFICIAL_DOC_SOURCES = {
  fabric: [
    { key: 'fabricDocsSetup', url: 'https://docs.fabricmc.net/develop/getting-started/setting-up-a-development-environment', kind: 'text', title: 'Fabric docs: setup' },
    { key: 'fabricDocsBlocks', url: 'https://docs.fabricmc.net/develop/blocks/first-block', kind: 'text', title: 'Fabric docs: blocks' },
    { key: 'fabricDocsItems', url: 'https://docs.fabricmc.net/develop/items/first-item', kind: 'text', title: 'Fabric docs: items' },
  ],
  forge: [
    { key: 'forgeDocsGettingStarted', url: 'https://docs.minecraftforge.net/en/latest/gettingstarted/', kind: 'text', title: 'Forge docs: getting started' },
    { key: 'forgeDocsBlocks', url: 'https://docs.minecraftforge.net/en/latest/blocks/', kind: 'text', title: 'Forge docs: blocks' },
    { key: 'forgeDocsEvents', url: 'https://docs.minecraftforge.net/en/latest/concepts/events/', kind: 'text', title: 'Forge docs: events' },
  ],
  neoforge: [
    { key: 'neoforgeDocsGettingStarted', url: 'https://docs.neoforged.net/docs/gettingstarted/', kind: 'text', title: 'NeoForge docs: getting started' },
    { key: 'neoforgeDocsBlocks', url: 'https://docs.neoforged.net/docs/blocks/', kind: 'text', title: 'NeoForge docs: blocks' },
    { key: 'neoforgeDocsEvents', url: 'https://docs.neoforged.net/docs/concepts/events/', kind: 'text', title: 'NeoForge docs: events' },
  ],
};

export const COMMUNITY_RESEARCH_SOURCES = {
  fabric: [
    { key: 'fabricGithubDiscussions', url: 'https://github.com/FabricMC/fabric/discussions', kind: 'text', title: 'Fabric GitHub discussions', tier: 'community' },
    { key: 'fabricLoomIssues', url: 'https://github.com/FabricMC/fabric-loom/issues', kind: 'text', title: 'Fabric Loom issues', tier: 'community' },
    { key: 'fabricYarnJavadocs', url: 'https://maven.fabricmc.net/docs/yarn-1.21.11+build.4/index.html', kind: 'text', title: 'Yarn Javadocs', tier: 'community' },
    { key: 'spongeMixinWiki', url: 'https://github.com/SpongePowered/Mixin/wiki', kind: 'text', title: 'Mixin wiki', tier: 'community' },
    { key: 'modrinthDocs', url: 'https://docs.modrinth.com', kind: 'text', title: 'Modrinth docs', tier: 'community' },
  ],
  forge: [
    { key: 'forgeForums', url: 'https://forums.minecraftforge.net/', kind: 'text', title: 'Forge forums', tier: 'community' },
    { key: 'forgeGithubIssues', url: 'https://github.com/MinecraftForge/MinecraftForge/issues', kind: 'text', title: 'Forge GitHub issues', tier: 'community' },
    { key: 'mixinWiki', url: 'https://github.com/SpongePowered/Mixin/wiki', kind: 'text', title: 'Mixin wiki', tier: 'community' },
    { key: 'modrinthDocs', url: 'https://docs.modrinth.com', kind: 'text', title: 'Modrinth docs', tier: 'community' },
    { key: 'forgeCommunityWiki', url: 'https://forge.gemwire.uk/wiki/Main_Page', kind: 'text', title: 'Forge community wiki', tier: 'community' },
  ],
  neoforge: [
    { key: 'neoforgeGithubIssues', url: 'https://github.com/neoforged/NeoForge/issues', kind: 'text', title: 'NeoForge GitHub issues', tier: 'community' },
    { key: 'neoforgedDiscordLanding', url: 'https://neoforged.net/', kind: 'text', title: 'NeoForged community landing', tier: 'community' },
    { key: 'mixinWiki', url: 'https://github.com/SpongePowered/Mixin/wiki', kind: 'text', title: 'Mixin wiki', tier: 'community' },
    { key: 'modrinthDocs', url: 'https://docs.modrinth.com', kind: 'text', title: 'Modrinth docs', tier: 'community' },
    { key: 'gradleForums', url: 'https://discuss.gradle.org/', kind: 'text', title: 'Gradle forums', tier: 'community' },
  ],
};
