import { normalizeFileData } from './build-file-utils.mjs';

const LOOM_SAFE_VERSION = '1.7.4';

export async function normalizeGeneratedFiles(files, loader, version, researchedBuild = null) {
  const changedFiles = [];
  const needsFabricApi = loader === 'fabric' ? projectUsesFabricApi(files) : false;

  if (loader === 'fabric') {
    const settingsKey = Object.keys(files).find(key => key.replace(/\\/g, '/') === 'settings.gradle') || 'settings.gradle';
    const existing = files[settingsKey] ? normalizeFileData(files[settingsKey]).content : '';
    const cleaned = normalizeFabricSettingsGradle(existing);
    if (!files[settingsKey] || cleaned !== existing) {
      files[settingsKey] = { encoding: 'utf8', content: cleaned };
      changedFiles.push(settingsKey);
    }
  }

  const wrapperPropsKey = Object.keys(files).find(
    key => key.replace(/\\/g, '/') === 'gradle/wrapper/gradle-wrapper.properties',
  );
  if (wrapperPropsKey) {
    const normalized = normalizeFileData(files[wrapperPropsKey]);
    const upgraded = normalizeGradleWrapper(normalized.content, loader, researchedBuild);
    if (upgraded !== normalized.content) {
      files[wrapperPropsKey] = { encoding: 'utf8', content: upgraded };
      changedFiles.push(wrapperPropsKey);
    }
  }

  if (loader === 'fabric' && files['build.gradle']) {
    const normalized = normalizeFileData(files['build.gradle']);
    const loomFixed = normalizeFabricLoomPluginVersion(normalized.content);
    const cleaned = normalizeFabricBuildGradle(
      stripUnsupportedFabricLoomSettings(loomFixed, version),
      version,
      researchedBuild,
      needsFabricApi,
    );
    if (cleaned !== normalized.content) {
      files['build.gradle'] = { encoding: 'utf8', content: cleaned };
      changedFiles.push('build.gradle');
    }
  }

  if (loader === 'fabric' && files['gradle.properties']) {
    const normalized = normalizeFileData(files['gradle.properties']);
    const cleaned = normalizeFabricGradleProperties(normalized.content, version, researchedBuild, needsFabricApi);
    if (cleaned !== normalized.content) {
      files['gradle.properties'] = { encoding: 'utf8', content: cleaned };
      changedFiles.push('gradle.properties');
    }
  }

  if (loader === 'fabric') {
    for (const candidate of ['fabric.mod.json', 'src/main/resources/fabric.mod.json']) {
      if (!files[candidate]) {
        continue;
      }
      const normalized = normalizeFileData(files[candidate]);
      const cleaned = normalizeFabricModJson(normalized.content, needsFabricApi);
      if (cleaned !== normalized.content) {
        files[candidate] = { encoding: 'utf8', content: cleaned };
        changedFiles.push(candidate);
      }
    }
  }

  if ((loader === 'paper' || loader === 'spigot') && files['build.gradle']) {
    const normalized = normalizeFileData(files['build.gradle']);
    const cleaned = normalizePluginBuildGradle(normalized.content, loader, version);
    if (cleaned !== normalized.content) {
      files['build.gradle'] = { encoding: 'utf8', content: cleaned };
      changedFiles.push('build.gradle');
    }
  }

  if (loader === 'neoforge' && files['build.gradle']) {
    const normalized = normalizeFileData(files['build.gradle']);
    const cleaned = normalizeNeoForgeBuildGradle(normalized.content, researchedBuild);
    if (cleaned !== normalized.content) {
      files['build.gradle'] = { encoding: 'utf8', content: cleaned };
      changedFiles.push('build.gradle');
    }
  }

  if (loader === 'fabric') {
    rewriteJavaSources(files, changedFiles, content => normalizeFabricJavaSource(content, version));
  }

  if (loader === 'forge') {
    rewriteJavaSources(files, changedFiles, content => normalizeForgeJavaSource(content, version));
  }

  return [...new Set(changedFiles)];
}

function rewriteJavaSources(files, changedFiles, transform) {
  for (const [relativePath, file] of Object.entries(files)) {
    if (!/\.java$/i.test(relativePath)) {
      continue;
    }
    const normalized = normalizeFileData(file);
    if (normalized.encoding !== 'utf8') {
      continue;
    }
    const cleaned = transform(normalized.content);
    if (cleaned !== normalized.content) {
      files[relativePath] = { encoding: 'utf8', content: cleaned };
      changedFiles.push(relativePath);
    }
  }
}

function normalizeGradleWrapper(content, loader, researchedBuild = null) {
  let next = String(content || '');
  const version = researchedBuild?.gradleVersion
    || (loader === 'fabric' ? '9.4.1' : '8.12.1');
  next = next.replace(
    /^distributionUrl=.*$/m,
    `distributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-bin.zip`,
  );
  return next;
}

function normalizeFabricLoomPluginVersion(content) {
  return String(content || '').replace(
    /(id\s*[\("'](?:fabric-loom|net\.fabricmc\.fabric-loom)[\)"']\s+version\s+[\("'])([^"'\s)]+)([\)"'])/g,
    (match, prefix, version, suffix) => {
      if (/-SNAPSHOT/i.test(version)) {
        return `${prefix}${LOOM_SAFE_VERSION}${suffix}`;
      }
      const [major = 0, minor = 0] = String(version).split('.').map(Number);
      return major < 1 || (major === 1 && minor < 7)
        ? `${prefix}${LOOM_SAFE_VERSION}${suffix}`
        : match;
    },
  );
}

function stripUnsupportedFabricLoomSettings(content, version) {
  let next = String(content || '');
  next = next.replace(/^\s*refreshVersions\s*=\s*.*(?:\r?\n|$)/gm, '');
  next = next.replace(/^\s*loom\.refreshVersions\s*=\s*.*(?:\r?\n|$)/gm, '');
  next = next.replace(/^\s*refreshVersions\s*\(.*\)\s*(?:\r?\n|$)/gm, '');
  next = next.replace(/loom\s*\{\s*\}/g, '');
  if (isFabricNonObfuscatedVersion(version)) {
    next = next.replace(/^\s*mappings\s+loom\.officialMojangMappings\(\)\s*(?:\r?\n|$)/gm, '');
    next = next.replace(/^\s*mappings\s+"net\.fabricmc:yarn:[^"\r\n]+"\s*(?:\r?\n|$)/gm, '');
  }
  return next.replace(/\n{3,}/g, '\n\n').trimEnd();
}

function normalizeFabricBuildGradle(content, version, researchedBuild = null, needsFabricApi = false) {
  let next = String(content || '');
  const mappingMode = getNormalizedFabricMappingMode(version, researchedBuild);

  next = next.replace(/id\s+'net\.fabricmc\.fabric-loom-remap'/g, "id 'net.fabricmc.fabric-loom'");
  next = next.replace(/id\s+'fabric-loom'/g, "id 'net.fabricmc.fabric-loom'");
  next = next.replace(/\bid\s+"net\.fabricmc\.fabric-loom-remap"/g, 'id "net.fabricmc.fabric-loom"');
  next = next.replace(/\bid\s+"fabric-loom"/g, 'id "net.fabricmc.fabric-loom"');
  next = next.replace(/\bfabricLoader\s*\(\s*(["'][^"']+["'])\s*\)/g, 'implementation $1');
  next = next.replace(/\bfabricApi\s*\(\s*(["'][^"']+["'])\s*\)/g, 'implementation $1');
  next = next.replace(/\byarnMappings\s*\(\s*(["'][^"']+["'])\s*\)/g, 'mappings $1');
  next = next.replace(/\bofficialMappings\s*\(\s*\)/g, 'mappings loom.officialMojangMappings()');
  next = next.replace(/^\s*mappings\s+"net\.fabricmc:yarn:[^"\r\n]*"\s*(?:\r?\n|$)/gm, '');
  next = next.replace(/^\s*mappings\s+loom\.officialMojangMappings\(\)\s*(?:\r?\n|$)/gm, '');
  next = next.replace(/^\s*(?:implementation|modImplementation|compileOnly|modCompileOnly|runtimeOnly|modRuntimeOnly)\s+["']net\.fabricmc(?:\.fabric-api)?:[^"'\r\n]+["']\s*(?:\r?\n|$)/gm, '');

  if (mappingMode === 'yarn' && !/^\s*mappings\s+"net\.fabricmc:yarn:\$\{project\.yarn_mappings\}:v2"\s*$/m.test(next)) {
    next = injectDependencyLine(next, 'mappings "net.fabricmc:yarn:${project.yarn_mappings}:v2"');
  }

  if (mappingMode === 'official' && !/^\s*mappings\s+loom\.officialMojangMappings\(\)\s*$/m.test(next)) {
    next = injectDependencyLine(next, 'mappings loom.officialMojangMappings()');
  }

  next = next.replace(/\bmodImplementation\b/g, 'implementation');
  next = next.replace(/\bmodCompileOnly\b/g, 'compileOnly');
  next = next.replace(/\bmodRuntimeOnly\b/g, 'runtimeOnly');

  const validFabricApiVersion = getResolvedFabricApiVersion(version, researchedBuild);
  if (needsFabricApi && validFabricApiVersion && !/net\.fabricmc\.fabric-api:fabric-api:\$\{project\.fabric_version\}/.test(next)) {
    next = next.replace(
      /(implementation\s+"net\.fabricmc:fabric-loader:\$\{project\.loader_version\}"\s*\r?\n)/,
      `$1    implementation "net.fabricmc.fabric-api:fabric-api:\${project.fabric_version}"\n`,
    );
  }

  return next;
}

function injectDependencyLine(content, line) {
  return content.replace(
    /(dependencies\s*\{\s*\r?\n\s*minecraft\s+"com\.mojang:minecraft:\$\{project\.minecraft_version\}"\s*\r?\n)/,
    `$1    ${line}\n`,
  );
}

function normalizeFabricSettingsGradle(content) {
  const projectNameMatch = String(content || '').trim().match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
  const projectName = projectNameMatch ? projectNameMatch[1] : 'minecraftmod';
  return `pluginManagement {
    repositories {
        maven {
            name = 'Fabric'
            url = 'https://maven.fabricmc.net/'
        }
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = '${projectName}'`;
}

function getNormalizedFabricMappingMode(version, researchedBuild = null) {
  if (isFabricNonObfuscatedVersion(version)) {
    return 'none';
  }
  const yarnVersion = researchedBuild?.yarnVersion || getFabricYarnFallback(version);
  return isValidYarnVersion(yarnVersion) ? 'yarn' : 'yarn';
}

function normalizeFabricGradleProperties(content, version, researchedBuild = null, needsFabricApi = false) {
  let next = String(content || '');
  next = next.replace(/^\s*yarn_mappings=.*(?:\r?\n|$)/gm, '');
  if (!isFabricNonObfuscatedVersion(version)) {
    const validYarn = isValidYarnVersion(researchedBuild?.yarnVersion)
      ? researchedBuild.yarnVersion
      : getFabricYarnFallback(version);
    if (validYarn) {
      next = appendProperty(next, 'yarn_mappings', validYarn);
    }
  }

  next = next.replace(/^\s*fabric_version=.*(?:\r?\n|$)/gm, '');
  const validFabricApiVersion = getResolvedFabricApiVersion(version, researchedBuild);
  if (needsFabricApi && validFabricApiVersion) {
    next = appendProperty(next, 'fabric_version', validFabricApiVersion);
  }

  return next.trimEnd();
}

function appendProperty(content, key, value) {
  const suffix = content.endsWith('\n') || !content ? '' : '\n';
  return `${content}${suffix}${key}=${value}\n`;
}

function normalizeFabricModJson(content, needsFabricApi = false) {
  try {
    const parsed = JSON.parse(String(content || '{}'));
    const depends = parsed && typeof parsed.depends === 'object' && !Array.isArray(parsed.depends)
      ? { ...parsed.depends }
      : {};

    if (needsFabricApi) {
      depends['fabric-api'] = depends['fabric-api'] || '*';
    } else {
      delete depends['fabric-api'];
      delete depends['fabric-api-base'];
    }

    if (Object.keys(depends).length) {
      parsed.depends = depends;
    } else {
      delete parsed.depends;
    }

    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}

function projectUsesFabricApi(files) {
  return Object.values(files || {}).some(file => {
    const normalized = normalizeFileData(file);
    return normalized.encoding === 'utf8' && /\bnet\.fabricmc\.fabric\.api\b/.test(normalized.content || '');
  });
}

function normalizeFabricJavaSource(content, version) {
  let next = String(content || '');
  if (usesModernFabricIdentifierFactory(version)) {
    next = next.replace(/\bnew\s+Identifier\s*\(/g, 'Identifier.of(');
  }
  if (usesModernFabricRegistryKeys(version)) {
    next = normalizeModernFabricRegistryKeys(next);
  }
  return next;
}

function normalizeForgeJavaSource(content, version) {
  if (!isModernForgeVersion(version)) {
    return content;
  }

  let next = String(content || '');
  next = next.replace(/^import\s+net\.minecraftforge\.eventbus\.api\.SubscribeEvent\s*;\s*\r?\n/gm, '');
  next = next.replace(
    /FMLJavaModLoadingContext\.get\(\)\.getModEventBus\(\)/g,
    '/* TODO: inject IEventBus modEventBus via constructor parameter instead of FMLJavaModLoadingContext */',
  );
  if (/IEventBus/.test(next)) {
    next = ensureImport(next, 'net.minecraftforge.eventbus.api.IEventBus');
  }
  return next;
}

function normalizePluginBuildGradle(content, loader, version) {
  let next = String(content || '');
  next = next.replace(/https:\/\/papermc\.io\/repo\/repository\/maven-public\/?/g, 'https://repo.papermc.io/repository/maven-public/');

  if (/io\.papermc\.paper:paper-api:/i.test(next) && !/repo\.papermc\.io\/repository\/maven-public/i.test(next)) {
    if (/repositories\s*\{/i.test(next)) {
      next = next.replace(/repositories\s*\{\s*/i, match => `${match}\n    maven { url = 'https://repo.papermc.io/repository/maven-public/' }\n`);
    } else {
      next += `\n\nrepositories {\n    mavenCentral()\n    maven { url = 'https://repo.papermc.io/repository/maven-public/' }\n}\n`;
    }
  }

  if (loader === 'paper' && /paper-api:/i.test(next)) {
    next = next.replace(/1\.21\.1-R0\.1-SNAPSHOT/g, `${version}-R0.1-SNAPSHOT`);
  }

  return next;
}

function normalizeNeoForgeBuildGradle(content, researchedBuild = null) {
  let next = String(content || '');
  if (!/maven\.neoforged\.net\/releases/i.test(next)) {
    if (/repositories\s*\{/i.test(next)) {
      next = next.replace(/repositories\s*\{\s*/i, match => `${match}\n    maven { url = 'https://maven.neoforged.net/releases' }\n`);
    } else {
      next += `\n\nrepositories {\n    mavenCentral()\n    maven { url = 'https://maven.neoforged.net/releases' }\n}\n`;
    }
  }
  if (researchedBuild?.userdevVersion) {
    next = next.replace(/(id\s+'net\.neoforged\.gradle\.userdev'\s+version\s+')([^']+)(')/g, `$1${researchedBuild.userdevVersion}$3`);
  }
  if (researchedBuild?.neoforgeVersion) {
    next = next.replace(/implementation\s+"net\.neoforged:neoforge:[^"]+"/g, `implementation "net.neoforged:neoforge:${researchedBuild.neoforgeVersion}"`);
  }
  return next;
}

function normalizeModernFabricRegistryKeys(content) {
  let next = String(content || '');
  const blockRegistrations = collectFabricBlockRegistrations(next);
  if (!blockRegistrations.length) {
    return next;
  }

  next = ensureImport(next, 'net.minecraft.registry.RegistryKey');
  next = ensureImport(next, 'net.minecraft.registry.RegistryKeys');

  for (const registration of blockRegistrations) {
    const fieldPattern = new RegExp(
      `(^[ \\t]*)((?:public|private|protected)\\s+static\\s+final\\s+Block\\s+${escapeRegExp(registration.blockVar)}\\s*=\\s*new\\s+Block\\s*\\()([\\s\\S]*?)(\\)\\s*;)`,
      'm',
    );

    next = next.replace(fieldPattern, (match, indent, prefix, settingsExpr, suffix) => {
      if (/\.registryKey\s*\(/.test(String(settingsExpr || ''))) {
        return match;
      }
      const declarations = buildModernFabricRegistryDeclarations(next, registration, indent);
      return `${declarations}${indent}${prefix}${settingsExpr}.registryKey(${registration.blockKeyConst})${suffix}`;
    });

    const blockItemPattern = new RegExp(`(new\\s+BlockItem\\s*\\(\\s*${escapeRegExp(registration.blockVar)}\\s*,\\s*new\\s+Item\\.Settings\\s*\\(\\))`, 'g');
    next = next.replace(blockItemPattern, (match, constructorStart, offset) => {
      const lookahead = next.slice(offset, offset + 240);
      return /\.registryKey\s*\(/.test(lookahead)
        ? match
        : `${constructorStart}.useBlockPrefixedTranslationKey().registryKey(${registration.itemKeyConst})`;
    });
  }

  return next;
}

function collectFabricBlockRegistrations(content) {
  const pattern = /Registry\.register\(\s*Registries\.BLOCK\s*,\s*([\s\S]*?)\s*,\s*([A-Z0-9_]+)\s*\);/g;
  const registrations = [];
  const seen = new Set();
  let match;

  while ((match = pattern.exec(content)) !== null) {
    const idExpr = String(match[1] || '').trim();
    const blockVar = String(match[2] || '').trim();
    if (!idExpr || !blockVar || seen.has(blockVar)) {
      continue;
    }

    const baseConst = blockVar.endsWith('_BLOCK') ? blockVar.slice(0, -'_BLOCK'.length) : blockVar;
    registrations.push({
      blockVar,
      idExpr,
      idConst: `${baseConst}_ID`,
      blockKeyConst: `${baseConst}_BLOCK_KEY`,
      itemKeyConst: `${baseConst}_ITEM_KEY`,
    });
    seen.add(blockVar);
  }

  return registrations;
}

function buildModernFabricRegistryDeclarations(content, registration, indent = '') {
  const declarations = [];
  if (!hasDeclaration(content, registration.idConst)) {
    declarations.push(`${indent}private static final Identifier ${registration.idConst} = ${registration.idExpr};`);
  }
  if (!hasDeclaration(content, registration.blockKeyConst)) {
    declarations.push(`${indent}private static final RegistryKey<Block> ${registration.blockKeyConst} = RegistryKey.of(RegistryKeys.BLOCK, ${registration.idConst});`);
  }
  if (!hasDeclaration(content, registration.itemKeyConst)) {
    declarations.push(`${indent}private static final RegistryKey<Item> ${registration.itemKeyConst} = RegistryKey.of(RegistryKeys.ITEM, ${registration.idConst});`);
  }
  return declarations.length ? `${declarations.join('\n')}\n` : '';
}

function getResolvedFabricApiVersion(version, researchedBuild = null) {
  const candidate = String(researchedBuild?.fabricApiVersion || '').trim();
  return isFabricApiVersionForMinecraft(candidate, version) ? candidate : null;
}

function isFabricApiVersionForMinecraft(candidate, minecraftVersion) {
  const value = String(candidate || '').trim();
  const game = String(minecraftVersion || '').trim();
  return Boolean(value && game && value.endsWith(`+${game}`));
}

function isValidYarnVersion(version) {
  return /^\d+\.\d+(?:\.\d+)?\+build\.\d+$/.test(String(version || ''));
}

function getFabricYarnFallback(version) {
  const fallbacks = {
    '1.21.11': '1.21.11+build.4',
    '1.21.10': '1.21.10+build.3',
    '1.21.4': '1.21.4+build.8',
    '1.21.2': '1.21.2+build.1',
    '1.21.1': '1.21.1+build.3',
    '1.21': '1.21+build.9',
  };
  return fallbacks[String(version || '')] || null;
}

function isModernForgeVersion(version) {
  const match = String(version || '').match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    return false;
  }
  const minor = Number(match[1]);
  const patch = Number(match[2] || 0);
  return minor > 20 || (minor === 20 && patch >= 6);
}

function usesModernFabricIdentifierFactory(version) {
  return isModernFabricYarnVersion(version) || isFabricNonObfuscatedVersion(version);
}

function usesModernFabricRegistryKeys(version) {
  return /^1\.21\.(?:2|3|4|10|11)$/.test(String(version || '')) || isFabricNonObfuscatedVersion(version);
}

function isFabricNonObfuscatedVersion(version) {
  return /^26\./.test(String(version || ''));
}

function isModernFabricYarnVersion(version) {
  return /^1\.21(?:\.\d+)?$/.test(String(version || ''));
}

function hasDeclaration(content, identifierName) {
  return new RegExp(`\\b${escapeRegExp(identifierName)}\\b`).test(content);
}

function ensureImport(content, importPath) {
  const importLine = `import ${importPath};`;
  if (content.includes(importLine)) {
    return content;
  }
  const packageMatch = content.match(/^(package\s+[\w.]+\s*;\s*\r?\n)/m);
  if (packageMatch) {
    const insertionPoint = packageMatch.index + packageMatch[0].length;
    return `${content.slice(0, insertionPoint)}${importLine}\n${content.slice(insertionPoint)}`;
  }
  return `${importLine}\n${content}`;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
