const BASE_REQUIRED_FILES = ['build.gradle', 'settings.gradle', 'gradle.properties'];

const LOADER_REQUIRED_FILES = {
  fabric: ['src/main/resources/fabric.mod.json'],
  forge: ['src/main/resources/META-INF/mods.toml'],
  neoforge: ['src/main/resources/META-INF/mods.toml'],
};

export function getRequiredProjectFiles(loader) {
  return [...BASE_REQUIRED_FILES, ...(LOADER_REQUIRED_FILES[String(loader || '').toLowerCase()] || [])];
}

export function getMissingProjectFiles(loader, files) {
  const present = new Set(
    Object.keys(files || {}).map(filePath => normalizeProjectPath(filePath)),
  );
  return getRequiredProjectFiles(loader).filter(filePath => !present.has(filePath));
}

export function normalizeProjectPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}
