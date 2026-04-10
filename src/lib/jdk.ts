import fs from "node:fs";
import path from "node:path";

const CANDIDATES = [
  process.env.JAVA_HOME,
  process.env.JDK_25_HOME,
  process.env.JDK_21_HOME,
  process.env.JDK_17_HOME,
  "/opt/codexmc/jdks/25",
  "/opt/codexmc/jdks/21",
  "/opt/codexmc/jdks/17",
  "C:\\Program Files\\Eclipse Adoptium\\jdk-21",
  "C:\\Program Files\\Eclipse Adoptium\\jdk-25",
];

export function resolveJavaHome(preferred?: "21" | "25" | "17"): string | undefined {
  if (preferred === "25" && process.env.JDK_25_HOME)
    return process.env.JDK_25_HOME;
  if (preferred === "21" && process.env.JDK_21_HOME)
    return process.env.JDK_21_HOME;
  if (preferred === "17" && process.env.JDK_17_HOME)
    return process.env.JDK_17_HOME;
  if (process.env.JAVA_HOME && isValidJdk(process.env.JAVA_HOME))
    return process.env.JAVA_HOME;
  for (const c of CANDIDATES) {
    if (c && isValidJdk(c)) return c;
  }
  return undefined;
}

function isValidJdk(home: string) {
  const java =
    process.platform === "win32"
      ? path.join(home, "bin", "java.exe")
      : path.join(home, "bin", "java");
  try {
    const mode =
      process.platform === "win32"
        ? fs.constants.F_OK
        : fs.constants.F_OK | fs.constants.X_OK;
    fs.accessSync(java, mode);
    return true;
  } catch {
    return false;
  }
}
