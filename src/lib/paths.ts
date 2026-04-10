import fs from "node:fs/promises";
import path from "node:path";

export const PROJECT_ROOT = process.cwd();

export function workspacesRoot() {
  return path.join(PROJECT_ROOT, "workspaces");
}

export function workspaceDir(sessionId: string) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(workspacesRoot(), safe || "default");
}

export function templatesDir() {
  return path.join(PROJECT_ROOT, "templates");
}

export function sharedGradleDir() {
  return path.join(templatesDir(), "_shared");
}

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export function isPathInsideWorkspace(root: string, target: string) {
  const rootR = path.resolve(root);
  const targetR = path.resolve(target);
  const rel = path.relative(rootR, targetR);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
