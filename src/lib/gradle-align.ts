import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoaderId } from "./loaders";

/** Gradle releases used by CodexMC (must exist on services.gradle.org). */
const GRADLE = {
  /** Fabric Loom 1.16+ (MC year releases) requires Gradle 9.4+ plugin API. */
  fabricLoomModern: "9.4.0",
  /** Loom 1.9–1.15, Forge, NeoForge, most MDKs. */
  defaultStable: "8.11.1",
  /** Older Forge lines sometimes validated against 8.8.x in MDKs. */
  forgeLegacy: "8.8.1",
} as const;

/**
 * Loom 1.16.x is for year-style Minecraft (26.x); it needs Gradle 9.4+.
 * Loom 1.9–1.13 covers classic 1.21.x / 1.20.x style.
 */
export function gradleVersionForFabricLoom(loomVersion: string): string {
  const base = loomVersion.split("-")[0] ?? loomVersion;
  const parts = base.split(".").map((x) => parseInt(x.replace(/\D.*/, ""), 10));
  const major = parts[0] ?? 1;
  const minor = parts[1] ?? 0;
  if (major === 1 && minor >= 16) return GRADLE.fabricLoomModern;
  return GRADLE.defaultStable;
}

export function gradleVersionForForgeMinecraft(minecraftVersion: string): string {
  const m = /^1\.(\d+)/.exec(minecraftVersion);
  if (!m) return GRADLE.defaultStable;
  const minor = parseInt(m[1], 10);
  if (minor <= 19) return GRADLE.forgeLegacy;
  return GRADLE.defaultStable;
}

export function gradleVersionForNeoForge(): string {
  return GRADLE.defaultStable;
}

export function resolveGradleVersion(
  loader: LoaderId,
  ctx: {
    fabricLoomVersion?: string;
    minecraftVersion?: string;
  },
): string {
  if (loader === "fabric" && ctx.fabricLoomVersion) {
    return gradleVersionForFabricLoom(ctx.fabricLoomVersion);
  }
  if (loader === "forge" && ctx.minecraftVersion) {
    return gradleVersionForForgeMinecraft(ctx.minecraftVersion);
  }
  if (loader === "neoforge") {
    return gradleVersionForNeoForge();
  }
  return GRADLE.defaultStable;
}

/**
 * Writes gradle/wrapper/gradle-wrapper.properties with the correct distribution
 * for the resolved loader + toolchain versions.
 */
export async function alignGradleWrapper(
  projectRoot: string,
  loader: LoaderId,
  ctx: {
    fabricLoomVersion?: string;
    minecraftVersion?: string;
  },
): Promise<void> {
  const gradleVersion = resolveGradleVersion(loader, ctx);
  const wrapperPath = path.join(
    projectRoot,
    "gradle",
    "wrapper",
    "gradle-wrapper.properties",
  );
  let content = await readFile(wrapperPath, "utf8");
  const url = `https\\://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip`;
  if (/^distributionUrl=/m.test(content)) {
    content = content.replace(/^distributionUrl=.*$/m, `distributionUrl=${url}`);
  } else {
    content = `${content.trimEnd()}\ndistributionUrl=${url}\n`;
  }
  await writeFile(wrapperPath, content, "utf8");
}
