import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as tarExtract } from 'tar';

const MAX_BUILD_ATTEMPTS = 3;
const MAX_AI_REPAIR_RETRIES = 3;
const BUILD_TIMEOUT_MS = 14 * 60 * 1000;
const MAX_LOG_CHARS = 32000;
const MAX_REPAIR_LOG_CHARS = 12000;
const MAX_REPAIR_FILE_COUNT = 10;
const MAX_REPAIR_FILE_CHARS = 12000;
const JAVA_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const JAVA_EXTRACT_TIMEOUT_MS = 2 * 60 * 1000;
const javaRuntimeCache = new Map();

export async function executeBuildJob({ apiKey, loader, version, modName, files, conversation, onAttempt }) {
  const projectFiles = sanitizeFiles(files);
  normalizeGeneratedFiles(projectFiles, loader, version);
  const attempts = [];

  for (let attemptNumber = 1; attemptNumber <= MAX_BUILD_ATTEMPTS; attemptNumber += 1) {
    const buildResult = await runGradleBuild(projectFiles, loader, version);
    const attempt = {
      attempt: attemptNumber,
      success: buildResult.success,
      exitCode: buildResult.exitCode,
      command: buildResult.command,
      logTail: tail(buildResult.log, MAX_LOG_CHARS),
    };

    attempts.push(attempt);
    await notifyAttempt(onAttempt, attempts, projectFiles);

    if (buildResult.environmentError) {
      return {
        success: false,
        message: buildResult.environmentError,
        attempts,
        files: projectFiles,
        buildLogTail: attempt.logTail,
      };
    }

    if (buildResult.success) {
      return {
        success: true,
        attempts,
        files: projectFiles,
        jarBuffer: buildResult.jarBuffer,
        jarFileName: buildResult.jarName,
        buildLogTail: attempt.logTail,
      };
    }

    if (attemptNumber === MAX_BUILD_ATTEMPTS) {
      return {
        success: false,
        message: 'Build failed after AI repair attempts.',
        attempts,
        files: projectFiles,
        buildLogTail: attempt.logTail,
      };
    }

    let repair;
    try {
      repair = await requestBuildFix({
        apiKey,
        loader,
        version,
        modName,
        conversation,
        files: projectFiles,
        buildLog: attempt.logTail,
        attemptNumber,
      });
    } catch (error) {
      return {
        success: false,
        message: error?.message || 'The AI repair step failed.',
        attempts,
        files: projectFiles,
        buildLogTail: attempt.logTail,
      };
    }

    if (!repair || !repair.files || repair.files.length === 0) {
      return {
        success: false,
        message: repair?.summary || 'The AI could not produce a repair for the failed build.',
        attempts,
        files: projectFiles,
        buildLogTail: attempt.logTail,
      };
    }

    const changedFiles = applyFileUpdates(projectFiles, repair.files, loader, version);
    attempt.fixSummary = repair.summary || 'Applied AI build fixes.';
    attempt.changedFiles = changedFiles;
    await notifyAttempt(onAttempt, attempts, projectFiles);

    if (changedFiles.length === 0) {
      let retryRepair;
      try {
        retryRepair = await requestBuildFix({
          apiKey,
          loader,
          version,
          modName,
          conversation,
          files: projectFiles,
          buildLog: attempt.logTail,
          attemptNumber,
          requireConcreteChanges: true,
          previousSummary: repair.summary || '',
        });
      } catch (error) {
        return {
          success: false,
          message: error?.message || 'The stricter AI repair retry failed.',
          attempts,
          files: projectFiles,
          buildLogTail: attempt.logTail,
        };
      }

      if (!retryRepair || !retryRepair.files || retryRepair.files.length === 0) {
        return {
          success: false,
          message: retryRepair?.summary || 'The AI responded, but it did not change any project files.',
          attempts,
          files: projectFiles,
          buildLogTail: attempt.logTail,
        };
      }

      const retryChangedFiles = applyFileUpdates(projectFiles, retryRepair.files, loader, version);
      attempt.fixSummary = retryRepair.summary || repair.summary || 'Applied AI build fixes after retry.';
      attempt.changedFiles = retryChangedFiles;
      await notifyAttempt(onAttempt, attempts, projectFiles);

      if (retryChangedFiles.length === 0) {
        return {
          success: false,
          message: retryRepair.summary || 'The AI responded, but it still did not change any project files.',
          attempts,
          files: projectFiles,
          buildLogTail: attempt.logTail,
        };
      }
    }
  }

  return {
    success: false,
    message: 'Unexpected build loop exit.',
    attempts,
    files: projectFiles,
  };
}

async function notifyAttempt(onAttempt, attempts, files) {
  if (typeof onAttempt === 'function') {
    await onAttempt({ attempts, files });
  }
}

async function runGradleBuild(files, loader, version) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-mod-build-'));
  const gradleUserHome = path.join(tempRoot, '.gradle-user-home');
  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'cmd.exe' : './gradlew';
  const args = isWindows
    ? ['/c', 'gradlew.bat', 'build', '--stacktrace', '--console=plain', '--no-daemon']
    : ['build', '--stacktrace', '--console=plain', '--no-daemon'];

  try {
    await writeProjectFiles(tempRoot, files);
    if (!isWindows) {
      await fs.chmod(path.join(tempRoot, 'gradlew'), 0o755);
    }

    let javaRuntime;
    try {
      javaRuntime = await ensureJavaRuntime(getRequiredJavaVersion(loader, version));
    } catch (error) {
      return {
        success: false,
        environmentError: error.message || 'The build host could not prepare a Java runtime.',
        command,
        exitCode: null,
        log: '',
      };
    }

    const execResult = await spawnWithOutput(command, args, {
      cwd: tempRoot,
      env: {
        ...process.env,
        GRADLE_USER_HOME: gradleUserHome,
        ...(javaRuntime.javaHome ? { JAVA_HOME: javaRuntime.javaHome } : {}),
        PATH: javaRuntime.binDir
          ? `${javaRuntime.binDir}${path.delimiter}${process.env.PATH || ''}`
          : (process.env.PATH || ''),
      },
      timeoutMs: BUILD_TIMEOUT_MS,
    });

    const log = `${execResult.stdout}${execResult.stderr ? `\n${execResult.stderr}` : ''}`.trim();

    const javaEnvironmentError = detectJavaEnvironmentError(log, execResult.errorCode);
    if (javaEnvironmentError) {
      return {
        success: false,
        environmentError: javaEnvironmentError,
        command,
        exitCode: null,
        log,
      };
    }

    if (execResult.timedOut) {
      return {
        success: false,
        command,
        exitCode: null,
        log: `${log}\n\nBuild timed out after ${Math.round(BUILD_TIMEOUT_MS / 1000)} seconds.`,
      };
    }

    if (execResult.exitCode !== 0) {
      return {
        success: false,
        command,
        exitCode: execResult.exitCode,
        log,
      };
    }

    const jarInfo = await findBuiltJar(tempRoot);
    return {
      success: true,
      command,
      exitCode: execResult.exitCode,
      log,
      jarBuffer: jarInfo.buffer,
      jarName: jarInfo.name,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeProjectFiles(rootDir, files) {
  for (const [relativePath, file] of Object.entries(files)) {
    const normalized = normalizeFileData(file);
    const absPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    if (normalized.encoding === 'base64') {
      await fs.writeFile(absPath, Buffer.from(normalized.content, 'base64'));
    } else {
      await fs.writeFile(absPath, normalized.content, 'utf8');
    }
  }
}

async function findBuiltJar(rootDir) {
  const libsDir = path.join(rootDir, 'build', 'libs');
  const entries = await fs.readdir(libsDir, { withFileTypes: true });
  const jarEntry = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jar'))
    .map(entry => entry.name)
    .find(name => !name.endsWith('-sources.jar') && !name.endsWith('-javadoc.jar') && !name.includes('-plain'));

  if (!jarEntry) {
    throw new Error('Build completed, but no distributable jar was found in build/libs.');
  }

  return {
    name: jarEntry,
    buffer: await fs.readFile(path.join(libsDir, jarEntry)),
  };
}

function spawnWithOutput(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        timedOut,
        errorCode: error.code,
      });
    });

    child.on('close', exitCode => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        errorCode: null,
      });
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1000, Math.round(seconds * 1000));
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(1000, dateMs - Date.now());
  }
  return null;
}

function isRetryableAiStatus(status) {
  return status === 429 || status === 503 || status === 502 || status === 504;
}

async function requestBuildFix({ apiKey, loader, version, modName, conversation, files, buildLog, attemptNumber, requireConcreteChanges = false, previousSummary = '' }) {
  const repairFiles = collectRepairFiles(files, buildLog).map(({ path: filePath, content }) => ({
    path: filePath,
    content: truncateRepairFileContent(content, filePath),
  }));
  const trimmedBuildLog = tail(buildLog, MAX_REPAIR_LOG_CHARS);

  const requestBody = {
    model: process.env.MISTRAL_MODEL || 'codestral-latest',
    temperature: 0.1,
    max_tokens: 3000,
    stream: false,
    messages: [
      {
        role: 'system',
        content: [
          'You repair Minecraft mod projects after a real Gradle build failure.',
          'Return JSON only with this shape:',
          '{"summary":"short summary","files":[{"path":"relative/path","content":"full file contents"}]}',
          'Only include files that must be replaced.',
          'Use valid code for the exact loader and version.',
          'Do not invent libraries, mappings, classes, events, or plugin versions.',
          'If a build script is wrong, fix the build script.',
          'If Java imports or APIs are wrong, fix those files.',
          'For Fabric Loom, do not add unsupported loom properties or blocks such as refreshVersions.',
          'Keep generated Gradle files close to the verified scaffold unless the build log clearly requires a script change.',
          buildRepairGuidance(loader, version),
          requireConcreteChanges
            ? 'Your previous repair attempt did not change any project files. You must change at least one relevant file if the build log is fixable.'
            : 'If the build log is fixable, make concrete file changes rather than restating the problem.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          loader,
          version,
          modName,
          attemptNumber,
          requireConcreteChanges,
          previousSummary,
          recentConversation: Array.isArray(conversation) ? conversation.slice(-3) : [],
          buildLog: trimmedBuildLog,
          files: repairFiles,
        }),
      },
    ],
  };

  let responseJson = {};
  let lastErrorMessage = 'AI repair request failed.';
  for (let retryIndex = 0; retryIndex < MAX_AI_REPAIR_RETRIES; retryIndex += 1) {
    const upstreamResponse = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const responseText = await upstreamResponse.text();
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      responseJson = {};
    }

    if (upstreamResponse.ok) {
      const content = responseJson.choices?.[0]?.message?.content;
      const parsed = parseJsonContent(content);
      if (!parsed || !Array.isArray(parsed.files)) {
        throw new Error('AI repair response did not include a valid files array.');
      }

      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary : 'Applied AI build fixes.',
        files: parsed.files.filter(file => file && typeof file.path === 'string' && typeof file.content === 'string'),
      };
    }

    lastErrorMessage = responseJson.message || responseJson.error || responseText || `AI repair request failed with HTTP ${upstreamResponse.status}.`;
    if (!isRetryableAiStatus(upstreamResponse.status) || retryIndex === MAX_AI_REPAIR_RETRIES - 1) {
      break;
    }

    const retryAfterMs = parseRetryAfterMs(upstreamResponse.headers.get('retry-after'));
    const backoffMs = retryAfterMs || (2000 * (retryIndex + 1));
    await sleep(backoffMs);
  }

  if (/rate limit/i.test(lastErrorMessage)) {
    throw new Error('Rate limit exceeded while CodexMC was trying to auto-fix the build. Please wait a moment and try the build again.');
  }

  throw new Error(lastErrorMessage || 'AI repair request failed.');
}

function parseJsonContent(content) {
  if (!content) return null;
  if (typeof content === 'object') return content;

  const trimmed = String(content).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const codeBlockMatch = trimmed.match(/```json\s*([\s\S]*?)```/i) || trimmed.match(/```\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1].trim());
      } catch {
        return null;
      }
    }
  }

  return null;
}

function truncateRepairFileContent(content, filePath) {
  const text = String(content || '');
  if (text.length <= MAX_REPAIR_FILE_CHARS) {
    return text;
  }
  const head = Math.floor(MAX_REPAIR_FILE_CHARS * 0.7);
  const tailChars = Math.max(0, MAX_REPAIR_FILE_CHARS - head - 64);
  return `${text.slice(0, head)}\n\n// [... ${filePath} truncated for repair context ...]\n\n${text.slice(text.length - tailChars)}`;
}

function collectRepairFiles(files, buildLog) {
  const utf8Entries = Object.entries(files)
    .filter(([, file]) => normalizeFileData(file).encoding === 'utf8')
    .map(([filePath, file]) => ({
      path: filePath,
      content: normalizeFileData(file).content,
    }));

  const preferred = [
    'build.gradle',
    'settings.gradle',
    'gradle.properties',
    'fabric.mod.json',
    'META-INF/mods.toml',
    'src/main/resources/fabric.mod.json',
    'src/main/resources/META-INF/mods.toml',
  ];
  const mentioned = new Set();
  const logText = String(buildLog || '').replace(/\\/g, '/');

  for (const entry of utf8Entries) {
    const normalizedPath = entry.path.replace(/\\/g, '/');
    if (preferred.includes(normalizedPath)) {
      mentioned.add(normalizedPath);
      continue;
    }
    if (logText.includes(normalizedPath) || logText.includes(`/${normalizedPath}`)) {
      mentioned.add(normalizedPath);
      continue;
    }
    const baseName = path.posix.basename(normalizedPath);
    if (baseName && logText.includes(baseName)) {
      mentioned.add(normalizedPath);
    }
  }

  const selected = [];
  for (const wanted of preferred) {
    const hit = utf8Entries.find(entry => entry.path.replace(/\\/g, '/') === wanted);
    if (hit && !selected.some(entry => entry.path === hit.path)) {
      selected.push(hit);
    }
  }
  for (const entry of utf8Entries) {
    if (mentioned.has(entry.path.replace(/\\/g, '/')) && !selected.some(item => item.path === entry.path)) {
      selected.push(entry);
    }
  }
  for (const entry of utf8Entries) {
    if (selected.length >= MAX_REPAIR_FILE_COUNT) break;
    if (!selected.some(item => item.path === entry.path)) {
      selected.push(entry);
    }
  }

  return selected.slice(0, MAX_REPAIR_FILE_COUNT);
}

function applyFileUpdates(files, updates, loader, version) {
  const changedFiles = [];
  for (const update of updates) {
    const relativePath = sanitizeRelativePath(update.path);
    const previous = files[relativePath];
    const next = { encoding: 'utf8', content: update.content };
    if (!previous || normalizeFileData(previous).content !== next.content) {
      files[relativePath] = next;
      changedFiles.push(relativePath);
    }
  }
  const normalizedPaths = normalizeGeneratedFiles(files, loader, version);
  normalizedPaths.forEach(relativePath => {
    if (!changedFiles.includes(relativePath)) {
      changedFiles.push(relativePath);
    }
  });
  return changedFiles;
}

function normalizeGeneratedFiles(files, loader, version) {
  const changedFiles = [];
  if (loader === 'fabric' && files['build.gradle']) {
    const normalized = normalizeFileData(files['build.gradle']);
    const cleaned = normalizeFabricBuildGradle(stripUnsupportedFabricLoomSettings(normalized.content, version), version);
    if (cleaned !== normalized.content) {
      files['build.gradle'] = { encoding: 'utf8', content: cleaned };
      changedFiles.push('build.gradle');
    }
  }
  return changedFiles;
}

function buildRepairGuidance(loader, version) {
  if (loader === 'fabric') {
    if (version === '1.21' || version === '1.21.1' || version === '1.21.4' || version === '1.21.11') {
      return 'For this Fabric target, assume the project uses Yarn mappings. Prefer Yarn-style Minecraft imports and prefer Item.Settings and AbstractBlock.Settings.copy(...) over outdated FabricItemSettings or FabricBlockSettings helpers.';
    }
    if (isFabricNonObfuscatedVersion(version)) {
      return 'For Fabric 26.x targets, assume the environment is non-obfuscated. Do not add mappings dependencies, and do not use old Yarn-era remap assumptions.';
    }
    return 'For this Fabric target, respect the generated mappings mode exactly and do not mix Yarn names into an official-mappings build or vice versa.';
  }
  if (loader === 'forge') {
    return 'For Forge targets, use official Mojang mappings names and Forge-only APIs. Do not mix in Fabric or NeoForge imports.';
  }
  if (loader === 'neoforge') {
    return 'For NeoForge targets, use official Mojang names and NeoForge-compatible APIs. Do not mix in Fabric or Forge-only imports unless they are truly shared.';
  }
  return 'Respect the generated mappings mode and loader-specific API style for the exact target version.';
}

function stripUnsupportedFabricLoomSettings(content, version) {
  let next = String(content || '');
  next = next.replace(/^\s*refreshVersions\s*=\s*.*(?:\r?\n|$)/gm, '');
  next = next.replace(/^\s*loom\.refreshVersions\s*=\s*.*(?:\r?\n|$)/gm, '');
  next = next.replace(/^\s*refreshVersions\s*\(.*\)\s*(?:\r?\n|$)/gm, '');
  next = next.replace(/loom\s*\{\s*\}/g, '');
  if (isFabricNonObfuscatedVersion(version)) {
    next = next.replace(/^\s*mappings\s+loom\.officialMojangMappings\(\)\s*(?:\r?\n|$)/gm, '');
    next = next.replace(/^\s*mappings\s+"net\.fabricmc:yarn:[^"\r\n]+"\s*(?:\r?\n|$)/gm, '');
  }
  next = next.replace(/\n{3,}/g, '\n\n');
  return next.trimEnd();
}

function normalizeFabricBuildGradle(content, version) {
  let next = String(content || '');
  if (version === '1.21.11') {
    next = next.replace(/id\s+'net\.fabricmc\.fabric-loom'(?!-remap)/g, "id 'net.fabricmc.fabric-loom-remap'");
    next = next.replace(/^\s*mappings\s+loom\.officialMojangMappings\(\)\s*(?:\r?\n|$)/gm, '');
    if (!/^\s*mappings\s+"net\.fabricmc:yarn:\$\{project\.yarn_mappings\}:v2"\s*$/m.test(next)) {
      next = next.replace(
        /(dependencies\s*\{\s*\r?\n\s*minecraft\s+"com\.mojang:minecraft:\\\$\{project\.minecraft_version\}"\s*\r?\n)/,
        `$1    mappings "net.fabricmc:yarn:\${project.yarn_mappings}:v2"\n`,
      );
    }
    next = next.replace(/\bimplementation\s+"net\.fabricmc:fabric-loader:/g, 'modImplementation "net.fabricmc:fabric-loader:');
    next = next.replace(/\bimplementation\s+"net\.fabricmc\.fabric-api:fabric-api:/g, 'modImplementation "net.fabricmc.fabric-api:fabric-api:');
  }
  if (isFabricNonObfuscatedVersion(version)) {
    next = next.replace(/id\s+'net\.fabricmc\.fabric-loom-remap'/g, "id 'net.fabricmc.fabric-loom'");
    next = next.replace(/id\s+'fabric-loom'/g, "id 'net.fabricmc.fabric-loom'");
    next = next.replace(/\bmodImplementation\b/g, 'implementation');
    next = next.replace(/\bmodCompileOnly\b/g, 'compileOnly');
    next = next.replace(/\bmodRuntimeOnly\b/g, 'runtimeOnly');
  }
  return next;
}

function isFabricNonObfuscatedVersion(version) {
  return /^26\./.test(String(version || ''));
}

export function sanitizeFiles(files) {
  const sanitized = {};
  for (const [relativePath, file] of Object.entries(files)) {
    const safePath = sanitizeRelativePath(relativePath);
    sanitized[safePath] = normalizeFileData(file);
  }
  return sanitized;
}

function normalizeFileData(file) {
  if (typeof file === 'string') {
    return { encoding: 'utf8', content: file };
  }

  return {
    encoding: file && file.encoding === 'base64' ? 'base64' : 'utf8',
    content: file && typeof file.content === 'string' ? file.content : '',
  };
}

function sanitizeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Each file must have a non-empty relative path.');
  }

  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe file path: ${relativePath}`);
  }

  return normalized;
}

function tail(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function getRequiredJavaVersion(loader, version) {
  const normalized = String(version || '');

  if (/^26\./.test(normalized)) {
    return 25;
  }

  const match = normalized.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (match) {
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3] || 0);

    if (major === 1) {
      if (minor <= 16) return 8;
      if (minor === 17) return 16;
      if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
      return 17;
    }

    if (major > 1) return 21;
  }

  return loader === 'forge' || loader === 'fabric' || loader === 'neoforge' ? 17 : 17;
}

async function ensureJavaRuntime(requiredVersion) {
  const cacheKey = `${process.platform}:${process.arch}:java-${requiredVersion}`;
  if (javaRuntimeCache.has(cacheKey)) {
    return javaRuntimeCache.get(cacheKey);
  }

  const systemRuntime = await detectSystemJava(requiredVersion);
  if (systemRuntime) {
    javaRuntimeCache.set(cacheKey, systemRuntime);
    return systemRuntime;
  }

  const downloadedRuntime = await downloadTemurinJdk(requiredVersion);
  javaRuntimeCache.set(cacheKey, downloadedRuntime);
  return downloadedRuntime;
}

async function detectSystemJava(requiredVersion) {
  const javaExeName = process.platform === 'win32' ? 'java.exe' : 'java';
  const javaHome = process.env.JAVA_HOME ? String(process.env.JAVA_HOME).replace(/^"|"$/g, '') : '';
  const javaBinFromHome = javaHome ? path.join(javaHome, 'bin', javaExeName) : null;
  const candidates = [javaBinFromHome, 'java'].filter(Boolean);

  for (const candidate of candidates) {
    const result = await spawnWithOutput(candidate, ['-version'], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 15000,
    });

    const versionText = `${result.stdout}\n${result.stderr}`.trim();
    const major = parseJavaMajorVersion(versionText);
    if (major === requiredVersion) {
      const resolvedHome = candidate === 'java'
        ? (javaHome || '')
        : path.dirname(path.dirname(candidate));
      return {
        javaHome: resolvedHome || javaHome || '',
        binDir: candidate === 'java' ? (javaHome ? path.join(javaHome, 'bin') : '') : path.dirname(candidate),
        source: 'system',
        version: major,
      };
    }
  }

  return null;
}

async function downloadTemurinJdk(requiredVersion) {
  if (process.platform !== 'linux') {
    throw new Error(`The build host is missing Java ${requiredVersion}, and automatic Java installation is only configured for Linux hosts right now.`);
  }

  const arch = mapTemurinArch(process.arch);
  if (!arch) {
    throw new Error(`Automatic Java installation is not configured for architecture "${process.arch}".`);
  }

  const cacheRoot = path.join(os.tmpdir(), 'codexmc-java');
  const installRoot = path.join(cacheRoot, `temurin-jdk-${requiredVersion}-${process.platform}-${arch}`);
  const javaBin = path.join(installRoot, 'bin', 'java');
  if (await fileExists(javaBin)) {
    return {
      javaHome: installRoot,
      binDir: path.dirname(javaBin),
      source: 'temurin-cache',
      version: requiredVersion,
    };
  }

  await fs.mkdir(cacheRoot, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(cacheRoot, `jdk-${requiredVersion}-`));
  const extractRoot = path.join(tempRoot, 'extract');
  const downloadUrl = `https://api.adoptium.net/v3/binary/latest/${requiredVersion}/ga/linux/${arch}/jdk/hotspot/normal/adoptium`;

  try {
    await fs.mkdir(extractRoot, { recursive: true });
    await downloadAndExtractTarGz(downloadUrl, extractRoot);

    const entries = await fs.readdir(extractRoot, { withFileTypes: true });
    const extractedDir = entries.find(entry => entry.isDirectory());
    if (!extractedDir) {
      throw new Error('The downloaded JDK archive did not contain an installable directory.');
    }

    await fs.rm(installRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rename(path.join(extractRoot, extractedDir.name), installRoot);

    if (!(await fileExists(javaBin))) {
      throw new Error('The downloaded JDK does not contain a usable `java` binary.');
    }

    const detected = await detectInstalledJava(javaBin);
    if (detected !== requiredVersion) {
      throw new Error(`The downloaded JDK reported Java ${detected || 'unknown'} instead of the required Java ${requiredVersion}.`);
    }

    return {
      javaHome: installRoot,
      binDir: path.dirname(javaBin),
      source: 'temurin-download',
      version: requiredVersion,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function detectInstalledJava(javaBin) {
  const result = await spawnWithOutput(javaBin, ['-version'], {
    cwd: path.dirname(javaBin),
    env: process.env,
    timeoutMs: 15000,
  });
  return parseJavaMajorVersion(`${result.stdout}\n${result.stderr}`);
}

function parseJavaMajorVersion(text) {
  const value = String(text || '');
  const quoted = value.match(/version\s+"(\d+)(?:\.\d+)?/i);
  if (quoted) {
    const raw = Number(quoted[1]);
    return raw === 1 ? 8 : raw;
  }
  const runtime = value.match(/(?:OpenJDK|Java)[^0-9]*(\d+)(?:\.\d+)?/i);
  if (runtime) {
    const raw = Number(runtime[1]);
    return raw === 1 ? 8 : raw;
  }
  return null;
}

function mapTemurinArch(arch) {
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'aarch64';
  return null;
}

async function downloadAndExtractTarGz(url, extractRoot) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'CodexMC-BuildWorker',
      Accept: 'application/octet-stream',
    },
    signal: AbortSignal.timeout(JAVA_DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Java runtime from Adoptium (HTTP ${response.status}).`);
  }

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('The downloaded JDK could not be extracted before the timeout expired.')), JAVA_EXTRACT_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      pipeline(
        Readable.fromWeb(response.body),
        tarExtract({
          cwd: extractRoot,
          strict: true,
          gzip: true,
        })
      ),
      timeout,
    ]);
  } catch (error) {
    throw new Error(`The downloaded JDK could not be extracted.\n${tail(error?.message || String(error), 1200)}`);
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function detectJavaEnvironmentError(log, errorCode) {
  if (errorCode === 'ENOENT') {
    return 'The build host does not have Java available to run Gradle. Add a Java runtime to the host or move jar builds to a Java-capable backend.';
  }

  const text = String(log || '');
  if (!text) return null;

  if (/JAVA_HOME is not set and no ['"]?java['"]? command could be found in your PATH/i.test(text)) {
    return 'The build host cannot run Gradle because Java is missing. Set JAVA_HOME and make sure `java` is on PATH, or use a backend that provides Java.';
  }

  if (/JAVA_HOME is set to an invalid directory/i.test(text)) {
    return 'The build host has an invalid JAVA_HOME setting. Point JAVA_HOME to a valid Java installation before running jar builds.';
  }

  if (/\bjava: command not found\b/i.test(text) || /\bjava is not recognized as an internal or external command\b/i.test(text)) {
    return 'The build host cannot find the `java` command. Install Java and expose it on PATH, or move jar builds to a Java-capable backend.';
  }

  return null;
}
