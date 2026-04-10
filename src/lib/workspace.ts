import { chmod, cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoaderId } from "./loaders";
import {
  ensureDir,
  isPathInsideWorkspace,
  sharedGradleDir,
  templatesDir,
  workspaceDir,
} from "./paths";
import { alignGradleWrapper } from "./gradle-align";
import {
  parseForgeCoordinates,
  parseNeoMcFromNeoVersion,
  resolveFabricVersions,
} from "./versions";

// Workspace initialization does a delete + copy of many files. If the client
// triggers init twice (loader/version changes, double-clicks, etc.), concurrent
// inits for the same session can race and fail mid-copy. We serialize per-session.
const initLocks = new Map<string, Promise<void>>();

export async function initWorkspace(
  sessionId: string,
  loader: LoaderId,
  versionValue: string,
) {
  const root = workspaceDir(sessionId);

  const prev = initLocks.get(sessionId);
  if (prev) await prev;

  const lock = (async () => {
    await rm(root, { recursive: true, force: true });
    await ensureDir(root);

    const shared = sharedGradleDir();
    const tpl = path.join(templatesDir(), loader);
    await cp(shared, root, { recursive: true });
    await cp(tpl, root, { recursive: true });

    try {
      await chmod(path.join(root, "gradlew"), 0o755);
    } catch {
      /* windows or missing */
    }

    const propsPath = path.join(root, "gradle.properties");
    let props = await readFile(propsPath, "utf8");

    let fabricLoom: string | undefined;
    let mcForGradle: string | undefined;

    if (loader === "fabric") {
      const v = await resolveFabricVersions(versionValue);
      fabricLoom = v.loom_version;
      props = setProp(props, "minecraft_version", versionValue);
      props = setProp(props, "loader_version", v.loader_version);
      props = setProp(props, "fabric_api_version", v.fabric_api_version);
      props = setProp(props, "loom_version", v.loom_version);
    } else if (loader === "forge") {
      const { minecraft_version, forge_version } = parseForgeCoordinates(versionValue);
      mcForGradle = minecraft_version;
      props = setProp(props, "minecraft_version", minecraft_version);
      props = setProp(props, "forge_version", forge_version);
    } else {
      props = setProp(props, "neo_version", versionValue);
      const { minecraft_version } = parseNeoMcFromNeoVersion(versionValue);
      mcForGradle = minecraft_version;
      props = setProp(props, "minecraft_version", minecraft_version);
    }

    await writeFile(propsPath, props, "utf8");

    await alignGradleWrapper(root, loader, {
      fabricLoomVersion: fabricLoom,
      minecraftVersion: mcForGradle,
    });
  })();

  initLocks.set(sessionId, lock);
  try {
    await lock;
  } finally {
    if (initLocks.get(sessionId) === lock) initLocks.delete(sessionId);
  }

  return root;
}

function setProp(content: string, key: string, value: string) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) return content.replace(re, line);
  return `${content.trimEnd()}\n${line}\n`;
}

export async function applyGeneratedFiles(
  sessionId: string,
  files: { path: string; content: string }[],
) {
  const root = workspaceDir(sessionId);
  for (const f of files) {
    const dest = path.join(root, f.path);
    if (!isPathInsideWorkspace(root, dest)) continue;
    await ensureDir(path.dirname(dest));
    await writeFile(dest, f.content, "utf8");
  }
}

export async function readWorkspaceFile(sessionId: string, rel: string) {
  const root = workspaceDir(sessionId);
  const dest = path.join(root, rel);
  if (!isPathInsideWorkspace(root, dest)) return null;
  try {
    return await readFile(dest, "utf8");
  } catch {
    return null;
  }
}
