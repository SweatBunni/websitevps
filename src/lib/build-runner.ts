import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { workspaceDir } from "./paths";
import { resolveJavaHome } from "./jdk";

export async function runGradleBuild(
  sessionId: string,
  onLine: (line: string) => void,
): Promise<{ code: number | null }> {
  const cwd = workspaceDir(sessionId);
  const gradlew =
    process.platform === "win32"
      ? path.join(cwd, "gradlew.bat")
      : path.join(cwd, "gradlew");

  try {
    await fs.access(gradlew);
  } catch {
    onLine("[codexmc] gradlew not found in workspace. Re-initialize the project.");
    return { code: 1 };
  }

  const javaHome = resolveJavaHome("21") ?? resolveJavaHome("25") ?? resolveJavaHome();
  const env = { ...process.env };
  if (javaHome) env.JAVA_HOME = javaHome;
  env.GRADLE_OPTS = (env.GRADLE_OPTS ? env.GRADLE_OPTS + " " : "") + "-Dorg.gradle.daemon=false";

  onLine(`[codexmc] JAVA_HOME=${javaHome ?? "(system default)"}`);
  onLine(`[codexmc] Running: ${gradlew} build`);

  const pipe = (stream: NodeJS.ReadableStream | null) => {
    let buf = "";
    stream?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      for (const line of parts) onLine(line);
    });
    stream?.on("end", () => {
      if (buf.trim()) onLine(buf);
    });
  };

  return await new Promise((resolve) => {
    const child = spawn(gradlew, ["build", "--no-daemon", "--warning-mode", "all"], {
      cwd,
      env,
      shell: process.platform === "win32",
    });
    pipe(child.stdout);
    pipe(child.stderr);
    child.on("close", (code) => resolve({ code }));
  });
}
