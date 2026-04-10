import fs from "node:fs/promises";
import path from "node:path";
import { workspaceDir } from "./paths";

/** Main mod jar in build/libs (exclude sources/javadoc/dev classifiers). */
export async function findBuiltModJar(sessionId: string): Promise<{
  absolutePath: string;
  filename: string;
} | null> {
  const root = workspaceDir(sessionId);
  const libs = path.join(root, "build", "libs");
  let entries: string[];
  try {
    entries = await fs.readdir(libs);
  } catch {
    return null;
  }
  const jars = entries.filter(
    (f) =>
      f.endsWith(".jar") &&
      !f.endsWith("-sources.jar") &&
      !f.endsWith("-javadoc.jar") &&
      !f.endsWith("-dev.jar"),
  );
  if (jars.length === 0) return null;

  const withMtime = await Promise.all(
    jars.map(async (f) => {
      const absolutePath = path.join(libs, f);
      const st = await fs.stat(absolutePath);
      return { f, absolutePath, mtime: st.mtimeMs };
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const best = withMtime[0];
  return { absolutePath: best.absolutePath, filename: best.f };
}
