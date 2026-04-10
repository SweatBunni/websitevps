import type { LoaderId } from "./loaders";

export type VersionOption = { value: string; label: string };

type FabricGameVersion = { version: string; stable: boolean };

export async function fetchFabricGameVersions(): Promise<VersionOption[]> {
  const res = await fetch("https://meta.fabricmc.net/v2/versions/game", {
    next: { revalidate: 3600 },
  });
  if (!res.ok) throw new Error(`Fabric meta failed: ${res.status}`);
  const data = (await res.json()) as FabricGameVersion[];
  return data
    .filter((v) => v.stable)
    .map((v) => ({ value: v.version, label: v.version }))
    .slice(0, 80);
}

export async function fetchForgeVersions(): Promise<VersionOption[]> {
  const res = await fetch(
    "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
    { next: { revalidate: 3600 } },
  );
  if (!res.ok) throw new Error(`Forge promos failed: ${res.status}`);
  const json = (await res.json()) as { promos: Record<string, string> };
  const out: VersionOption[] = [];
  const seen = new Set<string>();
  for (const [key, forgeVer] of Object.entries(json.promos)) {
    if (!key.endsWith("-latest") && !key.endsWith("-recommended")) continue;
    const mc = key.replace(/-(latest|recommended)$/, "");
    if (!/^\d/.test(mc)) continue;
    const combined = `${mc}-${forgeVer}`;
    if (seen.has(combined)) continue;
    seen.add(combined);
    out.push({
      value: combined,
      label: `${mc} (Forge ${forgeVer})`,
    });
  }
  out.sort((a, b) => compareMcVersions(a.value.split("-")[0], b.value.split("-")[0]));
  return out.slice(0, 120);
}

export async function fetchNeoForgeVersions(): Promise<VersionOption[]> {
  const res = await fetch(
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
    { next: { revalidate: 3600 } },
  );
  if (!res.ok) throw new Error(`NeoForge maven failed: ${res.status}`);
  const text = await res.text();
  const versions = [...text.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((m) => m[1])
    .filter(Boolean);
  const dedup = [...new Set(versions)].reverse();
  return dedup.slice(0, 150).map((v) => ({
    value: v,
    label: `${v} (${neoVersionToMcLabel(v)})`,
  }));
}

function neoVersionToMcLabel(neo: string): string {
  const base = neo.split("-")[0];
  const parts = base.split(".");
  if (parts.length >= 2) {
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      return `MC 1.${a}.${b}`;
    }
  }
  return "MC (see NeoForge docs)";
}

function compareMcVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return db - da;
  }
  return 0;
}

export async function versionsForLoader(loader: LoaderId): Promise<VersionOption[]> {
  if (loader === "fabric") return fetchFabricGameVersions();
  if (loader === "forge") return fetchForgeVersions();
  return fetchNeoForgeVersions();
}

const FABRIC_API_MAVEN_META =
  "https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml";
const FABRIC_LOOM_MAVEN_META =
  "https://maven.fabricmc.net/net/fabricmc/fabric-loom/maven-metadata.xml";

/** https://meta.fabricmc.net/v2/versions/loader/{game_version} */
type FabricLoaderMetaEntry = {
  loader?: { version: string; stable?: boolean };
};

function pickFabricLoaderVersion(entries: FabricLoaderMetaEntry[]): string | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const stable = entries.find((e) => e.loader?.stable === true)?.loader?.version;
  if (stable) return stable;
  return entries[0]?.loader?.version;
}

async function fetchMavenArtifactVersions(metaUrl: string): Promise<string[]> {
  const res = await fetch(metaUrl, { next: { revalidate: 3600 } });
  if (!res.ok) throw new Error(`Maven metadata failed (${metaUrl}): ${res.status}`);
  const text = await res.text();
  return [...text.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((m) => m[1])
    .filter(Boolean);
}

/** fabric-api uses coordinates like 0.145.4+26.1.2 (MC version after '+'). */
function pickFabricApiForMc(
  fabricApiVersions: string[],
  mcVersion: string,
): string | undefined {
  const matches = fabricApiVersions.filter((v) => {
    const i = v.lastIndexOf("+");
    if (i < 0) return false;
    return v.slice(i + 1) === mcVersion;
  });
  if (matches.length === 0) return undefined;
  matches.sort(compareFabricApiCoordDesc);
  return matches[0];
}

function compareFabricApiCoordDesc(a: string, b: string): number {
  const preA = a.split("+")[0] ?? a;
  const preB = b.split("+")[0] ?? b;
  return compareSemverPartsDesc(preA, preB);
}

function compareSemverPartsDesc(a: string, b: string): number {
  const pa = preReleaseParts(a);
  const pb = preReleaseParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return db - da;
  }
  return 0;
}

function preReleaseParts(v: string): number[] {
  return v.split(/[.\-]/).map((x) => parseInt(/^\d+/.exec(x)?.[0] ?? "0", 10) || 0);
}

function pickLoomForMc(mcVersion: string, loomVersions: string[]): string {
  const stable = loomVersions.filter((v) => !v.toUpperCase().includes("SNAPSHOT"));
  const sorted = [...stable].sort(compareSemverPartsDesc);

  let candidates: string[];
  if (/^\d{2}\.\d/.test(mcVersion)) {
    candidates = sorted.filter((v) => {
      const m = /^(\d+)\.(\d+)/.exec(v);
      if (!m) return false;
      return m[1] === "1" && parseInt(m[2], 10) >= 15;
    });
  } else if (mcVersion.startsWith("1.21.")) {
    candidates = sorted.filter((v) => {
      const m = /^(\d+)\.(\d+)/.exec(v);
      if (!m) return false;
      const minor = parseInt(m[2], 10);
      return m[1] === "1" && minor >= 9 && minor <= 17;
    });
  } else if (mcVersion.startsWith("1.20.")) {
    candidates = sorted.filter((v) => {
      const m = /^(\d+)\.(\d+)/.exec(v);
      if (!m) return false;
      const minor = parseInt(m[2], 10);
      return m[1] === "1" && minor >= 3 && minor <= 6;
    });
  } else if (mcVersion.startsWith("1.19.")) {
    candidates = sorted.filter((v) => {
      const m = /^(\d+)\.(\d+)/.exec(v);
      if (!m) return false;
      const minor = parseInt(m[2], 10);
      return m[1] === "1" && minor >= 7 && minor <= 9;
    });
  } else if (mcVersion.startsWith("1.18.")) {
    candidates = sorted.filter((v) => {
      const m = /^(\d+)\.(\d+)/.exec(v);
      if (!m) return false;
      const minor = parseInt(m[2], 10);
      return m[1] === "1" && minor >= 1 && minor <= 3;
    });
  } else {
    candidates = sorted.filter((v) => /^1\.9\.\d+/.test(v));
  }

  return candidates[0] ?? sorted[0] ?? "1.9.2";
}

export async function resolveFabricVersions(mcVersion: string) {
  const [loaderRes, apiVersions, loomVersions] = await Promise.all([
    fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`),
    fetchMavenArtifactVersions(FABRIC_API_MAVEN_META),
    fetchMavenArtifactVersions(FABRIC_LOOM_MAVEN_META),
  ]);
  if (!loaderRes.ok) {
    throw new Error(`Fabric loader meta failed: ${loaderRes.status}`);
  }
  const loaderPayload = (await loaderRes.json()) as FabricLoaderMetaEntry[];
  const loader = pickFabricLoaderVersion(loaderPayload);
  if (!loader) throw new Error("No Fabric loader for this Minecraft version.");

  const api = pickFabricApiForMc(apiVersions, mcVersion);
  if (!api) {
    throw new Error(
      `No fabric-api artifact for Minecraft ${mcVersion} (expected a Maven version ending in +${mcVersion}).`,
    );
  }

  const loom_version = pickLoomForMc(mcVersion, loomVersions);
  return { loader_version: loader, fabric_api_version: api, loom_version };
}

export function parseForgeCoordinates(combined: string) {
  const idx = combined.indexOf("-");
  if (idx <= 0) throw new Error("Invalid Forge version string.");
  const minecraft_version = combined.slice(0, idx);
  const forge_version = combined.slice(idx + 1);
  return { minecraft_version, forge_version };
}

export function parseNeoMcFromNeoVersion(neo: string) {
  const base = neo.split("-")[0];
  const [major, minor] = base.split(".").map((x) => parseInt(x, 10));
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    return { minecraft_version: "1.21.1" };
  }
  return { minecraft_version: `1.${major}.${minor}` };
}
