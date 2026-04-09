export async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed: ${url}`);
  return res.json();
}

// ✅ Gradle (official API)
export async function getGradleVersion() {
  try {
    const data = await fetchJson("https://services.gradle.org/versions/current");
    return data.version;
  } catch {
    return "8.7"; // safe fallback
  }
}

// ✅ Fabric Loader
export async function getFabricLoaderVersion() {
  const data = await fetchJson("https://meta.fabricmc.net/v2/versions/loader");
  return data[0].version;
}

// ✅ Fabric API (matches MC version)
export async function getFabricApiVersion(mcVersion) {
  const data = await fetchJson("https://meta.fabricmc.net/v2/versions/yarn");
  return data.find(v => v.gameVersion === mcVersion)?.version || data[0].version;
}

// ✅ Yarn mappings
export async function getYarnMappings(mcVersion) {
  const data = await fetchJson("https://meta.fabricmc.net/v2/versions/yarn");
  const match = data.find(v => v.gameVersion === mcVersion);
  return match ? match.version : data[0].version;
}

// ✅ FULL COMPATIBILITY PACK
export async function researchAll(mcVersion = "1.21.1") {
  const [gradle, loader, yarn] = await Promise.all([
    getGradleVersion(),
    getFabricLoaderVersion(),
    getYarnMappings(mcVersion)
  ]);

  return {
    mcVersion,
    gradle,
    fabricLoader: loader,
    yarnMappings: yarn
  };
}