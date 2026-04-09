export function getRequiredProjectFiles(loader) {
  const required = ['build.gradle', 'settings.gradle', 'gradle.properties'];
  if (loader === 'fabric') required.push('src/main/resources/fabric.mod.json');
  if (loader === 'forge' || loader === 'neoforge') required.push('src/main/resources/META-INF/mods.toml');
  return required;
}

export function normalizeProjectPaths(files) {
  return new Set(Object.keys(files || {}).map(relativePath => String(relativePath || '').replace(/\\/g, '/')));
}

export function getMissingProjectFiles(loader, files) {
  const normalizedPaths = normalizeProjectPaths(files);
  return getRequiredProjectFiles(loader).filter(relativePath => !normalizedPaths.has(relativePath));
}
