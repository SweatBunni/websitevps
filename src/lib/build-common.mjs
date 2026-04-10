import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as tarExtract } from 'tar';
import { getBuildResearch, getDeepBuildResearch, getAutonomousRepairResearch } from './research-metadata.mjs';
import {
  sanitizeFiles as sanitizeProjectFiles,
  tail as tailText,
  extractBuildFailureSignature as extractFailureSignature,
  buildRepairFingerprint as createRepairFingerprint,
  extractLatestPrompt as extractConversationPrompt,
} from './build-file-utils.mjs';
import { normalizeGeneratedFiles as normalizeProjectFiles } from './build-normalization.mjs';
import { rememberBuildOutcome, rememberResearchBundle, retrieveRelevantMemories } from './site-memory.mjs';

const MAX_BUILD_ATTEMPTS = 6;
const MAX_REPAIR_ATTEMPTS_WITHOUT_PROGRESS = 3;
const MAX_AI_REPAIR_RETRIES = 6;
const BUILD_TIMEOUT_MS = 7 * 60 * 1000;   // 7 min per Gradle run — allows multiple attempts within server limit
const MAX_LOG_CHARS = 32000;
const MAX_REPAIR_LOG_CHARS = 12000;
const MAX_REPAIR_FILE_COUNT = 10;
const MAX_REPAIR_FILE_CHARS = 12000;
const JAVA_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const JAVA_EXTRACT_TIMEOUT_MS = 2 * 60 * 1000;
const javaRuntimeCache = new Map();

export async function executeBuildJob({ apiKey, loader, version, modName, files, conversation, onAttempt, onBuildStart, onActivity, researchBundle: preloadedResearch = null }) {
  const projectFiles = sanitizeProjectFiles(files);
  const researchBundle = await loadBuildResearchBundle(loader, version, preloadedResearch);
  const researchedBuild = researchBundle?.build || null;
  if (typeof onActivity === 'function') {
    await onActivity({
      message: researchBundle?.summary
        ? researchBundle.summary
        : researchedBuild
        ? `Researched official build metadata for ${loader} ${version}.`
        : `Fell back to local build defaults for ${loader} ${version}.`,
      buildResearch: researchBundle || researchedBuild,
    }).catch(() => {});
  }
  await normalizeProjectFiles(projectFiles, loader, version, researchedBuild);
  const attempts = [];

  // Track consecutive repair rounds that produced no file changes, so we can
  // detect a true dead-end where the AI keeps returning the same non-fix.
  let stuckRepairRounds = 0;
  let previousLogTail = null;
  let previousRepairFingerprint = null;
  let previousRepairSummary = null;
  let repeatedFailureSignatureRounds = 0;

  for (let attemptNumber = 1; attemptNumber <= MAX_BUILD_ATTEMPTS; attemptNumber += 1) {
    // Notify before the build starts so the client knows the worker is alive.
    if (typeof onBuildStart === 'function') {
      await onBuildStart({ attemptNumber }).catch(() => {});
    }
    const buildResult = await runGradleBuild(projectFiles, loader, version);
    const attempt = {
      attempt: attemptNumber,
      success: buildResult.success,
      exitCode: buildResult.exitCode,
      command: buildResult.command,
      logTail: tailText(buildResult.log, MAX_LOG_CHARS),
    };
    attempt.failureSignature = extractFailureSignature(attempt.logTail);

    attempts.push(attempt);
    await notifyAttempt(onAttempt, attempts, projectFiles);

    // Hard stop: environment problems (missing Java, etc.) cannot be repaired.
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
      await rememberBuildOutcome({
        loader,
        version,
        modName,
        prompt: extractConversationPrompt(conversation),
        success: true,
        failureSignature: attempts.slice(-1)[0]?.failureSignature || '',
        fixSummary: attempts.slice(-1)[0]?.fixSummary || '',
        changedFiles: attempts.slice(-1)[0]?.changedFiles || [],
        buildLog: attempt.logTail,
      });
      return {
        success: true,
        attempts,
        files: projectFiles,
        jarBuffer: buildResult.jarBuffer,
        jarFileName: buildResult.jarName,
        buildLogTail: attempt.logTail,
      };
    }

    // Last attempt — give up.
    if (attemptNumber === MAX_BUILD_ATTEMPTS) {
      return {
        success: false,
        message: `Build failed after ${MAX_BUILD_ATTEMPTS} attempts with AI repair.`,
        attempts,
        files: projectFiles,
        buildLogTail: attempt.logTail,
      };
    }

    // If the log is identical to the previous round the AI already saw this
    // exact failure and its fix didn't help — count that as a stuck round.
    const logUnchanged = previousLogTail !== null && attempt.logTail === previousLogTail;
    previousLogTail = attempt.logTail;
    if (attempt.failureSignature && attempts.length > 1 && attempts[attempts.length - 2]?.failureSignature === attempt.failureSignature) {
      repeatedFailureSignatureRounds += 1;
    } else {
      repeatedFailureSignatureRounds = 0;
    }

    // Request a repair. If the AI fails to respond, log it and try again next
    // round rather than aborting immediately.
    let repair = null;
    try {
      if (typeof onActivity === 'function') {
        await onActivity({
          message: `Researching the build failure and asking the AI to repair attempt ${attemptNumber}.`,
          buildResearch: researchBundle || researchedBuild,
        }).catch(() => {});
      }
      repair = await requestBuildFix({
        apiKey,
        loader,
        version,
        modName,
        conversation,
        files: projectFiles,
        buildLog: attempt.logTail,
        attemptNumber,
        requireConcreteChanges: stuckRepairRounds > 0,
        previousSummary: attempts.length > 1 ? (attempts[attempts.length - 2].fixSummary || '') : '',
        previousAttempts: attempts.slice(0, -1),
        researchedBuild,
        researchBundle,
        failureSignature: attempt.failureSignature,
      });
    } catch (error) {
      // AI call failed (network, rate-limit after retries, etc.).  If it's a
      // rate-limit we surface it immediately; otherwise keep trying.
      const msg = error?.message || '';
      if (/rate limit/i.test(msg)) {
        return {
          success: false,
          message: msg,
          attempts,
          files: projectFiles,
          buildLogTail: attempt.logTail,
        };
      }
      attempt.fixSummary = `AI repair call failed (${msg}); retrying build as-is.`;
      await notifyAttempt(onAttempt, attempts, projectFiles);
      stuckRepairRounds += 1;
      if (stuckRepairRounds >= MAX_REPAIR_ATTEMPTS_WITHOUT_PROGRESS) {
        return {
          success: false,
          message: `Build repair stalled after ${stuckRepairRounds} consecutive unsuccessful AI repair rounds.`,
          attempts,
          files: projectFiles,
          buildLogTail: attempt.logTail,
        };
      }
      continue;
    }

    // Apply whatever files the AI returned (may be empty).
    const changedFiles = (repair && Array.isArray(repair.files) && repair.files.length > 0)
      ? await applyFileUpdates(projectFiles, repair.files, loader, version, researchedBuild)
      : [];

    attempt.fixSummary = repair?.summary || 'Applied AI build fixes.';
    attempt.changedFiles = changedFiles;
    attempt.repairFingerprint = createRepairFingerprint(projectFiles, attempt.fixSummary, changedFiles);
    if (typeof onActivity === 'function') {
      await onActivity({
        message: changedFiles.length
          ? `${attempt.fixSummary} (${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} changed).`
          : `AI repair produced no file changes on attempt ${attemptNumber}.`,
        buildResearch: researchBundle || researchedBuild,
      }).catch(() => {});
    }
    await notifyAttempt(onAttempt, attempts, projectFiles);

    const repeatedFingerprint = previousRepairFingerprint && attempt.repairFingerprint === previousRepairFingerprint;
    const repeatedSummary = previousRepairSummary !== null && attempt.fixSummary === previousRepairSummary;
    previousRepairFingerprint = attempt.repairFingerprint;
    previousRepairSummary = attempt.fixSummary;

    if (changedFiles.length === 0 || logUnchanged || repeatedFingerprint) {
      stuckRepairRounds += 1;
      await rememberBuildOutcome({
        loader,
        version,
        modName,
        prompt: extractConversationPrompt(conversation),
        success: false,
        failureSignature: attempt.failureSignature,
        fixSummary: attempt.fixSummary,
        changedFiles,
        buildLog: attempt.logTail,
      });
      if (stuckRepairRounds >= MAX_REPAIR_ATTEMPTS_WITHOUT_PROGRESS) {
        return {
          success: false,
          message: `Build repair stalled: the AI made no effective changes after ${stuckRepairRounds} consecutive rounds. Last repair summary: ${repair?.summary || 'none'}.`,
          attempts,
          files: projectFiles,
          buildLogTail: attempt.logTail,
        };
      }
      } else {
        // Progress was made — reset the stuck counter.
        stuckRepairRounds = 0;
      }

    if (repeatedFailureSignatureRounds >= 1 && repeatedSummary && changedFiles.length === 0) {
      return {
        success: false,
        message: `Build repair stopped early because the same failure repeated and the AI returned the same repair summary without changing files. Last repair summary: ${attempt.fixSummary}.`,
        attempts,
        files: projectFiles,
        buildLogTail: attempt.logTail,
      };
    }

    if (repeatedFailureSignatureRounds >= 2 && repeatedFingerprint) {
      return {
        success: false,
        message: `Build repair stopped early because the same failure kept repeating after equivalent fixes. Last repair summary: ${attempt.fixSummary}.`,
        attempts,
        files: projectFiles,
        buildLogTail: attempt.logTail,
      };
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
  let command = isWindows ? 'cmd.exe' : './gradlew';
  let args = isWindows
    ? ['/c', 'gradlew.bat', 'build', '--stacktrace', '--console=plain', '--no-daemon']
    : ['build', '--stacktrace', '--console=plain', '--no-daemon'];

  try {
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

    await writeProjectFiles(tempRoot, files);
    if (!isWindows) {
      await fs.chmod(path.join(tempRoot, 'gradlew'), 0o755);
    }

    const javaExecutable = path.join(
      javaRuntime.binDir || path.join(javaRuntime.javaHome || '', 'bin'),
      isWindows ? 'java.exe' : 'java',
    );
    const wrapperJar = path.join(tempRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');

    if (javaRuntime.javaHome) {
      const gradleJavaArg = `-Dorg.gradle.java.home=${javaRuntime.javaHome}`;
      command = javaExecutable;
      args = [
        gradleJavaArg,
        '-Dorg.gradle.appname=gradlew',
        '-classpath',
        wrapperJar,
        'org.gradle.wrapper.GradleWrapperMain',
        'build',
        '--stacktrace',
        '--console=plain',
        '--no-daemon',
      ];
    }

    const execResult = await spawnWithOutput(command, args, {
      cwd: tempRoot,
      env: {
        ...process.env,
        GRADLE_USER_HOME: gradleUserHome,
        ...(javaRuntime.javaHome ? { JAVA_HOME: javaRuntime.javaHome } : {}),
        ...(javaRuntime.javaHome ? { GRADLE_OPTS: joinGradleOpts(process.env.GRADLE_OPTS, `-Dorg.gradle.java.home=${javaRuntime.javaHome}`) } : {}),
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

function joinGradleOpts(existingValue, nextValue) {
  const existing = String(existingValue || '').trim();
  return existing ? `${existing} ${nextValue}` : nextValue;
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

async function requestBuildFix({ apiKey, loader, version, modName, conversation, files, buildLog, attemptNumber, requireConcreteChanges = false, previousSummary = '', previousAttempts = [], researchedBuild = null, researchBundle = null, failureSignature = '' }) {
  const repairFiles = collectRepairFiles(files, buildLog).map(({ path: filePath, content }) => ({
    path: filePath,
    content: truncateRepairFileContent(content, filePath),
  }));
  const trimmedBuildLog = tailText(buildLog, MAX_REPAIR_LOG_CHARS);
  const autonomousResearch = await loadAutonomousRepairResearch({
    loader,
    version,
    failureSignature,
    buildLog: trimmedBuildLog,
    prompt: extractConversationPrompt(conversation),
  });
  const relevantMemories = loader === 'fabric' && isFabricNonObfuscatedVersion(version)
    ? []
    : await retrieveRelevantMemories({
        query: `${failureSignature}\n${trimmedBuildLog}\n${extractConversationPrompt(conversation)}`,
        loader,
        version,
        type: 'build',
        limit: 3,
      });

  // Build a concise history of what was already tried so the AI doesn't repeat itself.
  const attemptHistory = previousAttempts
    .filter(a => a.fixSummary)
    .map(a => ({ attempt: a.attempt, summary: a.fixSummary, changedFiles: a.changedFiles || [] }));

  const requestBody = {
    model: process.env.OPENROUTER_MODEL || 'qwen/qwen-2.5-coder-32b-instruct:free',
    temperature: 0.1,
    max_tokens: 3000,
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
          'Research exact version numbers from official sources before changing wrappers, plugins, mappings, or dependencies. Never guess a Gradle distribution version.',
          'If a build script is wrong, fix the build script.',
          'If Java imports or APIs are wrong, fix those files.',
          'For Fabric Loom, do not add unsupported loom properties or blocks such as refreshVersions.',
          'For Fabric Loom, accessWidener must ONLY appear inside loom { accessWidenerPath = file("...") }. Never use bare accessWidener = "..." or accessWidener "..." assignments outside the loom block — they cause "Cannot set the property accessWidener because the backing field is final". If the build log shows this error, move the declaration into the loom block or remove it.',
          'Never add systemProp.* keys to gradle.properties unless they are real, well-known Java/Gradle system properties (e.g. systemProp.https.proxyHost). Do not invent recursive or deeply-nested systemProp keys. The only valid top-level gradle.properties keys are org.gradle.* settings and mod-specific short keys like minecraft_version, loader_version, yarn_mappings, fabric_version, mod_version, maven_group, archives_base_name.',
          'Keep generated Gradle files close to the verified scaffold unless the build log clearly requires a script change.',
          researchedBuild ? `Researched build metadata for this target: ${JSON.stringify(researchedBuild)}` : '',
          formatResearchPromptContext(researchBundle),
          formatAutonomousResearchContext(autonomousResearch),
          relevantMemories.length ? `Relevant prior site memory:\n${relevantMemories.map(memory => `- ${memory.text}`).join('\n')}` : '',
          buildRepairGuidance(loader, version),
          requireConcreteChanges
            ? 'Your previous repair attempt did not change any project files. You must change at least one relevant file if the build log is fixable.'
            : 'If the build log is fixable, make concrete file changes rather than restating the problem.',
          attemptHistory.length > 0
            ? `Previous repair attempts that did NOT fully fix the build: ${JSON.stringify(attemptHistory)}. Do not repeat those same changes. Try a different approach.`
            : '',
        ].filter(Boolean).join('\n'),
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
          attemptHistory,
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
    const upstreamResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3000',
        'X-Title': process.env.OPENROUTER_APP_TITLE || 'CodexMC',
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
    // For 429 rate limit responses, use a much longer backoff — Mistral rate limit windows
    // are typically 60s. If no retry-after header, use exponential backoff capped at 60s.
    const is429 = upstreamResponse.status === 429;
    const defaultBackoffMs = is429
      ? Math.min(60000, 10000 * (retryIndex + 1))
      : 2000 * (retryIndex + 1);
    const backoffMs = retryAfterMs || defaultBackoffMs;
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

async function applyFileUpdates(files, updates, loader, version, researchedBuild = null) {
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
  const normalizedPaths = await normalizeProjectFiles(files, loader, version, researchedBuild);
  normalizedPaths.forEach(relativePath => {
    if (!changedFiles.includes(relativePath)) {
      changedFiles.push(relativePath);
    }
  });
  return changedFiles;
}

// Gradle version compatibility matrix:
// - Gradle < 8.3: no Java 21 support
// - Gradle 8.3–8.x: Java 21 supported; compatible with Fabric Loom 1.x and ForgeGradle 6.x
// - Gradle 9.x: broke Fabric Loom 1.x Problems API (forNamespace removed), ForgeGradle not yet compatible
//
// Safe pinned version for each loader:
const GRADLE_SAFE_VERSION = {
  fabric:   '9.3.0',
  forge:    '8.12.1',
  neoforge: '8.12.1',
  paper:    '8.12.1',
  spigot:   '8.12.1',
  default:  '8.12.1',
};
const GRADLE_MIN_VERSION = [8, 3]; // Minimum for Java 21 support
const GRADLE_MAX_VERSION = [8, 99]; // Never go to Gradle 9.x until plugins catch up

function normalizeGradleWrapper(content, loader, researchedBuild = null) {
  const safeVersion = researchedBuild?.gradleVersion || GRADLE_SAFE_VERSION[loader] || GRADLE_SAFE_VERSION.default;

  return String(content || '').replace(
    /(distributionUrl\s*=\s*https\\:\/\/services\.gradle\.org\/distributions\/gradle-)(.+?)(-(?:bin|all)\.zip)/,
    (match, prefix, ver, suffix) => {
      const parts = String(ver).split(/[^0-9]+/).filter(Boolean).map(Number);
      const major = parts[0] || 0;
      const minor = parts[1] || 0;

      const tooOld =
        major < GRADLE_MIN_VERSION[0] ||
        (major === GRADLE_MIN_VERSION[0] && minor < GRADLE_MIN_VERSION[1]);

      const tooNew =
        loader !== 'fabric' && (
          major > GRADLE_MAX_VERSION[0] ||
          (major === GRADLE_MAX_VERSION[0] && minor > GRADLE_MAX_VERSION[1])
        );

      if (tooOld || tooNew || String(ver) !== safeVersion) {
        return `${prefix}${safeVersion}${suffix}`;
      }
      return match;
    }
  );
}

// Keep old name as alias so nothing else breaks
function upgradeGradleWrapperIfNeeded(content) {
  return normalizeGradleWrapper(content, 'default');
}

async function loadAutonomousRepairResearch({ loader, version, failureSignature, buildLog, prompt }) {
  try {
    const bundle = await getAutonomousRepairResearch(loader, version, {
      errorText: [failureSignature, buildLog].filter(Boolean).join('\n'),
      prompt,
      timeBudgetMs: 45000,
    });
    await rememberResearchBundle({
      loader,
      version,
      query: bundle.query,
      summary: bundle.summary,
      sources: bundle.sources,
      errorText: bundle.errorText,
    });
    return bundle;
  } catch {
    return null;
  }
}

async function normalizeGeneratedFiles(files, loader, version, researchedBuild = null) {
  const changedFiles = [];
  const resolvedBuild = researchedBuild || await loadBuildResearch(loader, version);
  const needsFabricApi = loader === 'fabric' ? projectUsesFabricApi(files) : false;

  if (loader === 'fabric') {
    const settingsKey = Object.keys(files).find(key => key.replace(/\\/g, '/') === 'settings.gradle') || 'settings.gradle';
    const existing = files[settingsKey] ? normalizeFileData(files[settingsKey]).content : '';
    const cleaned = normalizeFabricSettingsGradle(existing);
    if (!files[settingsKey] || cleaned !== existing) {
      files[settingsKey] = { encoding: 'utf8', content: cleaned };
      changedFiles.push(settingsKey);
    }
  }

  // Upgrade Gradle wrapper if it's too old to support the host JVM.
  // Gradle < 8.3 cannot run on Java 21 (class file major version 65).
  const wrapperPropsKey = Object.keys(files).find(
    k => k.replace(/\\/g, '/') === 'gradle/wrapper/gradle-wrapper.properties'
  );
  if (wrapperPropsKey) {
    const normalized = normalizeFileData(files[wrapperPropsKey]);
    const upgraded = normalizeGradleWrapper(normalized.content, loader, resolvedBuild);
    if (upgraded !== normalized.content) {
      files[wrapperPropsKey] = { encoding: 'utf8', content: upgraded };
      changedFiles.push(wrapperPropsKey);
    }
  }

  // Fix Fabric Loom plugin version in build.gradle — SNAPSHOT versions and
  // anything older than 1.7 are incompatible with Gradle 8.8+ Problems API.
  if (loader === 'fabric' && files['build.gradle']) {
    const normalized = normalizeFileData(files['build.gradle']);
    const fixed = normalizeFabricLoomPluginVersion(normalized.content);
    if (fixed !== normalized.content) {
      files['build.gradle'] = { encoding: 'utf8', content: fixed };
      if (!changedFiles.includes('build.gradle')) changedFiles.push('build.gradle');
    }
  }

  if (loader === 'fabric' && files['build.gradle']) {
    const normalized = normalizeFileData(files['build.gradle']);
    const cleaned = normalizeFabricBuildGradle(stripUnsupportedFabricLoomSettings(normalized.content, version), version, resolvedBuild, needsFabricApi);
    if (cleaned !== normalized.content) {
      files['build.gradle'] = { encoding: 'utf8', content: cleaned };
      changedFiles.push('build.gradle');
    }
  }
  if (loader === 'fabric' && files['gradle.properties']) {
    const normalized = normalizeFileData(files['gradle.properties']);
    const cleaned = normalizeFabricGradleProperties(normalized.content, version, resolvedBuild, needsFabricApi);
    if (cleaned !== normalized.content) {
      files['gradle.properties'] = { encoding: 'utf8', content: cleaned };
      changedFiles.push('gradle.properties');
    }
  }
  // For all loaders, strip hallucinated systemProp keys from gradle.properties
  if (loader !== 'fabric' && files['gradle.properties']) {
    const normalized = normalizeFileData(files['gradle.properties']);
    const cleaned = sanitizeGradleProperties(normalized.content);
    if (cleaned !== normalized.content) {
      files['gradle.properties'] = { encoding: 'utf8', content: cleaned };
      if (!changedFiles.includes('gradle.properties')) changedFiles.push('gradle.properties');
    }
  }
  if (loader === 'fabric') {
    for (const candidate of ['fabric.mod.json', 'src/main/resources/fabric.mod.json']) {
      if (!files[candidate]) continue;
      const normalized = normalizeFileData(files[candidate]);
      const cleaned = normalizeFabricModJson(normalized.content, needsFabricApi);
      if (cleaned !== normalized.content) {
        files[candidate] = { encoding: 'utf8', content: cleaned };
        changedFiles.push(candidate);
      }
    }
  }
  if ((loader === 'paper' || loader === 'spigot') && files['build.gradle']) {
    const normalized = normalizeFileData(files['build.gradle']);
    const cleaned = normalizePluginBuildGradle(normalized.content, loader, version);
    if (cleaned !== normalized.content) {
      files['build.gradle'] = { encoding: 'utf8', content: cleaned };
      changedFiles.push('build.gradle');
    }
  }
  if (loader === 'neoforge' && files['build.gradle']) {
    const normalized = normalizeFileData(files['build.gradle']);
    const cleaned = normalizeNeoForgeBuildGradle(normalized.content, version, resolvedBuild);
    if (cleaned !== normalized.content) {
      files['build.gradle'] = { encoding: 'utf8', content: cleaned };
      changedFiles.push('build.gradle');
    }
  }
  if (loader === 'fabric') {
    for (const [relativePath, file] of Object.entries(files)) {
      if (!/\.java$/i.test(relativePath)) continue;
      const normalized = normalizeFileData(file);
      if (normalized.encoding !== 'utf8') continue;
      const cleaned = normalizeFabricJavaSource(normalized.content, version);
      if (cleaned !== normalized.content) {
        files[relativePath] = { encoding: 'utf8', content: cleaned };
        changedFiles.push(relativePath);
      }
    }
  }
  if (loader === 'forge') {
    for (const [relativePath, file] of Object.entries(files)) {
      if (!/\.java$/i.test(relativePath)) continue;
      const normalized = normalizeFileData(file);
      if (normalized.encoding !== 'utf8') continue;
      const cleaned = normalizeForgeJavaSource(normalized.content, version);
      if (cleaned !== normalized.content) {
        files[relativePath] = { encoding: 'utf8', content: cleaned };
        changedFiles.push(relativePath);
      }
    }
  }
  return changedFiles;
}

async function loadBuildResearch(loader, version) {
  try {
    const result = await getBuildResearch(loader, version);
    return result?.build || null;
  } catch {
    return null;
  }
}

async function loadBuildResearchBundle(loader, version, preloadedResearch = null) {
  if (preloadedResearch && typeof preloadedResearch === 'object') {
    return preloadedResearch;
  }
  try {
    return await getDeepBuildResearch(loader, version, { timeBudgetMs: 115000 });
  } catch {
    const build = await loadBuildResearch(loader, version);
    return build ? { loader, version, build, sources: [], evidence: [], summary: '' } : null;
  }
}

function formatResearchPromptContext(researchBundle) {
  if (!researchBundle || !Array.isArray(researchBundle.evidence) || !researchBundle.evidence.length) {
    return '';
  }
  const official = researchBundle.evidence
    .filter(entry => entry && entry.status === 'ok' && entry.snippet && entry.tier !== 'community')
    .slice(0, 6)
    .map(entry => `- ${entry.title || entry.url}: ${entry.snippet}`);
  const community = researchBundle.evidence
    .filter(entry => entry && entry.status === 'ok' && entry.snippet && entry.tier === 'community')
    .slice(0, 6)
    .map(entry => `- ${entry.title || entry.url}: ${entry.snippet}`);
  if (!official.length && !community.length) return '';
  const sections = [];
  if (official.length) {
    sections.push(`Official research bundle for this target:\n${official.join('\n')}`);
  }
  if (community.length) {
    sections.push(`Supplemental community research for this target:\n${community.join('\n')}\nTreat community findings as hints only. When they conflict with official metadata or docs, follow the official sources.`);
  }
  return sections.join('\n');
}

function formatAutonomousResearchContext(bundle) {
  if (!bundle || !Array.isArray(bundle.sources) || !bundle.sources.length) return '';
  const lines = bundle.sources
    .slice(0, 8)
    .map(source => `- [${source.tier || 'unknown'}] ${source.title || source.url}: ${source.snippet || ''}`);
  if (!lines.length) return '';
  return `Autonomous online repair research for this exact failure:\nSearch query: ${bundle.query}\n${lines.join('\n')}\nPrioritize official sources first, then GitHub/issues/forums/posts when confirming the fix.`;
}

function buildRepairGuidance(loader, version) {
  if (loader === 'fabric') {
    const accessWidenerRule = 'CRITICAL: Never set accessWidener as a bare property assignment (e.g. accessWidener = "file.aw" or accessWidener "file.aw") — this causes "Cannot set the property \'accessWidener\' because the backing field is final". The ONLY correct way to declare an access widener in Fabric Loom is inside the loom block: loom { accessWidenerPath = file("src/main/resources/mod.accesswidener") }. If the mod does not need an access widener, remove the declaration entirely.';
    if (isFabricNonObfuscatedVersion(version)) {
      return `For Fabric 26.x targets, assume the environment is non-obfuscated. Do not add mappings dependencies, and do not use old Yarn-era remap assumptions. NEVER use Yarn-style package guesses like net.minecraft.block.*, net.minecraft.registry.*, or net.minecraft.util.Identifier unless you have verified they exist for this exact 26.x target. If the generated code uses those imports, replace them with the current 26.x official names or simplify the scaffold to code you know is valid. For blocks and block items, set registryKey(...) on AbstractBlock.Settings and Item.Settings before constructing the instances. ${accessWidenerRule}`;
    }
    return `For this Fabric target, assume the project uses Yarn mappings. Prefer Yarn-style Minecraft imports, use Identifier.of(namespace, path) instead of new Identifier(...), and prefer Item.Settings and AbstractBlock.Settings.copy(...) over outdated FabricItemSettings or FabricBlockSettings helpers.${usesModernFabricRegistryKeys(version) ? ' For modern Fabric block and block-item registration, set registryKey(...) on AbstractBlock.Settings and Item.Settings before constructing the instances.' : ''} ${accessWidenerRule}`;
  }
  if (loader === 'forge') {
    const isModern = isModernForgeVersion(version);
    if (isModern) {
      return [
        'For Forge 1.20.6+ targets, the event bus API changed significantly. Apply ALL of the following:',
        '1. FMLJavaModLoadingContext.get().getModEventBus() is REMOVED. Use the IEventBus injected into the mod constructor: annotate the constructor with @Mod("modid") and accept IEventBus modEventBus as a parameter, e.g. public MyMod(IEventBus modEventBus) { modEventBus.addListener(this::setup); }',
        '2. net.minecraftforge.eventbus.api.SubscribeEvent is REMOVED. Use net.neoforged.bus.api.SubscribeEvent (if NeoForge) OR for Forge 1.20.6+ use net.minecraftforge.eventbus.api.SubscribeEvent only if it still exists in that exact Forge build — if the import fails, switch to registering listeners directly via modEventBus.addListener().',
        '3. @Mod.EventBusSubscriber is still available but the bus parameter syntax changed. Prefer explicit modEventBus.addListener() registration in the constructor instead.',
        '4. DeferredRegister.create() and register(modEventBus) patterns are correct for 1.20.6+.',
        '5. Do not use FMLJavaModLoadingContext.get() anywhere — it is deprecated and its getModEventBus() method was removed.',
        'Use official Mojang mappings names. Do not mix in Fabric or NeoForge imports.',
      ].join('\n');
    }
    return 'For Forge targets, use official Mojang mappings names and Forge-only APIs. Do not mix in Fabric or NeoForge imports.';
  }
  if (loader === 'neoforge') {
    return [
      'For NeoForge targets, use official Mojang names and NeoForge-compatible APIs.',
      'Event bus registration: accept IEventBus modEventBus as a constructor parameter (injected by NeoForge) and call modEventBus.addListener() to register event handlers. Do not use FMLJavaModLoadingContext.',
      'Use net.neoforged.bus.api.SubscribeEvent and net.neoforged.bus.api.IEventBus for event bus types.',
      'Use net.neoforged.fml.common.Mod for the @Mod annotation.',
      'Research the current net.neoforged.gradle.userdev plugin version and the matching net.neoforged:neoforge artifact version from official NeoForged Maven before changing build files.',
      'Do not mix in Fabric or Forge-only imports unless they are truly shared.',
    ].join('\n');
  }
  if (loader === 'paper') {
    return 'For Paper targets, use the current Paper API repository at https://repo.papermc.io/repository/maven-public/ and do not use the old papermc.io repository URL.';
  }
  if (loader === 'spigot') {
    return 'For Spigot targets, avoid Paper-only dependencies unless explicitly requested. If using Paper API, use the current repository at https://repo.papermc.io/repository/maven-public/.';
  }
  return 'Respect the generated mappings mode and loader-specific API style for the exact target version.';
}

function isModernForgeVersion(version) {
  // Forge 1.20.6+ removed FMLJavaModLoadingContext.get().getModEventBus() and old eventbus imports.
  const match = String(version || '').match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const minor = Number(match[1]);
  const patch = Number(match[2] || 0);
  return minor > 20 || (minor === 20 && patch >= 6);
}

// Mechanically rewrite known-broken Forge 1.20.6+ Java patterns before the first build.
function normalizeForgeJavaSource(content, version) {
  if (!isModernForgeVersion(version)) return content;
  let next = String(content || '');

  // Remove bad eventbus import — net.minecraftforge.eventbus.api.SubscribeEvent was removed.
  // The annotation itself is still available via @Mod.EventBusSubscriber so we only strip the
  // standalone import; listener registration needs to move to the constructor.
  next = next.replace(
    /^import\s+net\.minecraftforge\.eventbus\.api\.SubscribeEvent\s*;\s*\r?\n/gm,
    '',
  );

  // Replace FMLJavaModLoadingContext.get().getModEventBus() with a constructor-injection
  // comment so the AI knows what to do on the next repair pass, and strip the broken call
  // so at minimum the file compiles (addListener will be re-added by the AI repair).
  next = next.replace(
    /FMLJavaModLoadingContext\.get\(\)\.getModEventBus\(\)/g,
    '/* TODO: inject IEventBus modEventBus via constructor parameter instead of FMLJavaModLoadingContext */',
  );

  // Add IEventBus import if missing and the file references it.
  if (/IEventBus/.test(next) && !/import\s+net\.minecraftforge\.fml\.javafmlmod\.FMLJavaModLoadingContext/.test(next)) {
    next = ensureImport(next, 'net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext');
  }
  if (/IEventBus/.test(next)) {
    next = ensureImport(next, 'net.minecraftforge.eventbus.api.IEventBus');
  }

  return next;
}

// Fabric Loom version compatibility:
// Loom 1.6-SNAPSHOT and older use Problems.forNamespace() which was removed/changed in Gradle 8.8+/9.x.
// Loom 1.7.x is the first stable release that works with Gradle 8.8.
// Always pin to a known-stable non-SNAPSHOT version.
const LOOM_SAFE_VERSION = '1.7.4';

function normalizeFabricLoomPluginVersion(content) {
  let next = String(content || '');

  // Replace any loom version that is a SNAPSHOT, or older than 1.7, with the safe version.
  // Matches: id 'fabric-loom' version '1.6-SNAPSHOT'
  //          id 'net.fabricmc.fabric-loom' version '1.6-SNAPSHOT'
  //          id("net.fabricmc.fabric-loom") version "1.5.3"
  next = next.replace(
    /(id\s*[\("'](?:fabric-loom|net\.fabricmc\.fabric-loom)[\)"']\s+version\s+[\("'])([^"'\s)]+)([\)"'])/g,
    (match, prefix, ver, suffix) => {
      // Always replace SNAPSHOTs
      if (/-SNAPSHOT/i.test(ver)) {
        return `${prefix}${LOOM_SAFE_VERSION}${suffix}`;
      }
      // Replace versions older than 1.7
      const parts = ver.split('.').map(Number);
      const major = parts[0] || 0;
      const minor = parts[1] || 0;
      if (major < 1 || (major === 1 && minor < 7)) {
        return `${prefix}${LOOM_SAFE_VERSION}${suffix}`;
      }
      return match;
    }
  );

  return next;
}

function stripUnsupportedFabricLoomSettings(content, version) {
  let next = String(content || '');
  next = next.replace(/^\s*refreshVersions\s*=\s*.*(?:\r?\n|$)/gm, '');
  next = next.replace(/^\s*loom\.refreshVersions\s*=\s*.*(?:\r?\n|$)/gm, '');
  next = next.replace(/^\s*refreshVersions\s*\(.*\)\s*(?:\r?\n|$)/gm, '');
  next = next.replace(/loom\s*\{\s*\}/g, '');
  // Remove bare `accessWidener = "..."` assignments outside of a loom{} block.
  // These cause "Cannot set the property 'accessWidener' because the backing field is final".
  // The correct declaration is inside loom { accessWidenerPath = file("...") }.
  next = next.replace(/^\s*accessWidener\s*=\s*['"][^'"]*['"]\s*(?:\r?\n|$)/gm, '');
  // Also fix the case where the AI puts `accessWidener "path"` as a bare statement outside loom{}.
  // Detect it: not inside a loom block — we strip it globally and let the loom block handle it.
  next = next.replace(/^\s*accessWidener\s+['"][^'"]*['"]\s*(?:\r?\n|$)/gm, '');
  if (isFabricNonObfuscatedVersion(version)) {
    next = next.replace(/^\s*mappings\s+loom\.officialMojangMappings\(\)\s*(?:\r?\n|$)/gm, '');
    next = next.replace(/^\s*mappings\s+"net\.fabricmc:yarn:[^"\r\n]+"\s*(?:\r?\n|$)/gm, '');
  }
  next = next.replace(/\n{3,}/g, '\n\n');
  return next.trimEnd();
}

function normalizeFabricBuildGradle(content, version, researchedBuild = null, needsFabricApi = false) {
  let next = String(content || '');
  const mappingMode = getNormalizedFabricMappingMode(version, researchedBuild);
  next = next.replace(/id\s+'net\.fabricmc\.fabric-loom-remap'/g, "id 'net.fabricmc.fabric-loom'");
  next = next.replace(/id\s+'fabric-loom'/g, "id 'net.fabricmc.fabric-loom'");
  next = next.replace(/\bid\s+"net\.fabricmc\.fabric-loom-remap"/g, 'id "net.fabricmc.fabric-loom"');
  next = next.replace(/\bid\s+"fabric-loom"/g, 'id "net.fabricmc.fabric-loom"');
  next = next.replace(/\bfabricLoader\s*\(\s*(["'][^"']+["'])\s*\)/g, 'implementation $1');
  next = next.replace(/\bfabricApi\s*\(\s*(["'][^"']+["'])\s*\)/g, 'implementation $1');
  next = next.replace(/\byarnMappings\s*\(\s*(["'][^"']+["'])\s*\)/g, 'mappings $1');
  next = next.replace(/\bofficialMappings\s*\(\s*\)/g, 'mappings loom.officialMojangMappings()');

  next = next.replace(/^\s*mappings\s+"net\.fabricmc:yarn:[^"\r\n]*"\s*(?:\r?\n|$)/gm, '');
  next = next.replace(/^\s*mappings\s+loom\.officialMojangMappings\(\)\s*(?:\r?\n|$)/gm, '');
  next = next.replace(/^\s*(?:implementation|modImplementation|compileOnly|modCompileOnly|runtimeOnly|modRuntimeOnly)\s+["']net\.fabricmc(?:\.fabric-api)?:[^"'\r\n]+["']\s*(?:\r?\n|$)/gm, '');

  if (mappingMode === 'yarn') {
    if (!/^\s*mappings\s+"net\.fabricmc:yarn:\$\{project\.yarn_mappings\}:v2"\s*$/m.test(next)) {
      next = next.replace(
        /(dependencies\s*\{\s*\r?\n\s*minecraft\s+"com\.mojang:minecraft:\\\$\{project\.minecraft_version\}"\s*\r?\n)/,
        `$1    mappings "net.fabricmc:yarn:\${project.yarn_mappings}:v2"\n`,
      );
    }
  } else if (mappingMode === 'official') {
    if (!/^\s*mappings\s+loom\.officialMojangMappings\(\)\s*$/m.test(next)) {
      next = next.replace(
        /(dependencies\s*\{\s*\r?\n\s*minecraft\s+"com\.mojang:minecraft:\\\$\{project\.minecraft_version\}"\s*\r?\n)/,
        `$1    mappings loom.officialMojangMappings()\n`,
      );
    }
  }

  next = next.replace(/\bmodImplementation\b/g, 'implementation');
  next = next.replace(/\bmodCompileOnly\b/g, 'compileOnly');
  next = next.replace(/\bmodRuntimeOnly\b/g, 'runtimeOnly');
  const validFabricApiVersion = getResolvedFabricApiVersion(version, researchedBuild);
  if (needsFabricApi && validFabricApiVersion && !/net\.fabricmc\.fabric-api:fabric-api:\$\{project\.fabric_version\}/.test(next)) {
    next = next.replace(
      /(implementation\s+"net\.fabricmc:fabric-loader:\\\$\{project\.loader_version\}"\s*\r?\n)/,
      `$1    implementation "net.fabricmc.fabric-api:fabric-api:\${project.fabric_version}"\n`,
    );
  }
  return next;
}

function normalizeFabricSettingsGradle(content) {
  const raw = String(content || '').trim();
  const projectNameMatch = raw.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
  const projectName = projectNameMatch ? projectNameMatch[1] : 'minecraftmod';
  return `pluginManagement {
    repositories {
        maven {
            name = 'Fabric'
            url = 'https://maven.fabricmc.net/'
        }
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = '${projectName}'`;
}

function getNormalizedFabricMappingMode(version, researchedBuild = null) {
  if (isFabricNonObfuscatedVersion(version)) return 'none';
  const yarnVersion = researchedBuild?.yarnVersion || getFabricYarnFallback(version);
  if (isValidYarnVersion(yarnVersion)) return 'yarn';
  return 'yarn';
}

function isValidYarnVersion(version) {
  return /^\d+\.\d+(?:\.\d+)?\+build\.\d+$/.test(String(version || ''));
}

function getFabricYarnFallback(version) {
  const key = String(version || '');
  if (key === '1.21.11') return '1.21.11+build.4';
  if (key === '1.21.10') return '1.21.10+build.3';
  if (key === '1.21.4') return '1.21.4+build.8';
  if (key === '1.21.2') return '1.21.2+build.1';
  if (key === '1.21.1') return '1.21.1+build.3';
  if (key === '1.21') return '1.21+build.9';
  return null;
}

// Strip hallucinated / garbage lines from gradle.properties.
// The AI sometimes generates recursive systemProp keys that repeat a suffix
// hundreds of times (e.g. systemProp.org.gradle.daemon.performance.enable…Timeout=1000
// appended to itself forever). We remove any systemProp key whose name exceeds a
// reasonable length, and any systemProp key that is not a known valid Gradle property.
const VALID_SYSTEM_PROP_PREFIXES = [
  'systemProp.https.',
  'systemProp.http.',
  'systemProp.file.encoding',
  'systemProp.sun.',
  'systemProp.java.',
  'systemProp.javax.',
  'systemProp.jdk.',
  'systemProp.socks',
  'systemProp.socksProxy',
  'systemProp.proxyHost',
  'systemProp.proxyPort',
  'systemProp.nonProxyHosts',
];
function sanitizeGradleProperties(content) {
  return String(content || '').split(/\r?\n/).filter(line => {
    const trimmed = line.trim();
    // Keep blank lines and comments
    if (!trimmed || trimmed.startsWith('#')) return true;
    // Keep standard well-known org.gradle.* keys
    if (/^org\.gradle\./.test(trimmed)) return true;
    // Keep mod-specific properties (short alphanumeric keys)
    if (/^[a-zA-Z_][a-zA-Z0-9_.]*\s*=/.test(trimmed)) {
      const key = trimmed.split('=')[0].trim();
      // Reject any key longer than 80 characters — these are always hallucinated
      if (key.length > 80) return false;
      // Reject systemProp keys that don't match known valid prefixes
      if (key.startsWith('systemProp.')) {
        return VALID_SYSTEM_PROP_PREFIXES.some(prefix => key.startsWith(prefix));
      }
      return true;
    }
    return true;
  }).join('\n');
}

function normalizeFabricGradleProperties(content, version, researchedBuild = null, needsFabricApi = false) {
  let next = sanitizeGradleProperties(content);
  next = next.replace(/^\s*yarn_mappings=.*(?:\r?\n|$)/gm, '');
  if (!isFabricNonObfuscatedVersion(version)) {
    const validYarn = isValidYarnVersion(researchedBuild?.yarnVersion)
      ? researchedBuild.yarnVersion
      : getFabricYarnFallback(version);
    if (validYarn) {
      const suffix = next.endsWith('\n') ? '' : '\n';
      next = `${next}${suffix}yarn_mappings=${validYarn}\n`;
    }
  }
  next = next.replace(/^\s*fabric_version=.*(?:\r?\n|$)/gm, '');
  const validFabricApiVersion = getResolvedFabricApiVersion(version, researchedBuild);
  if (needsFabricApi && validFabricApiVersion) {
    const suffix = next.endsWith('\n') ? '' : '\n';
    next = `${next}${suffix}fabric_version=${validFabricApiVersion}\n`;
  }
  return next.trimEnd();
}

function getResolvedFabricApiVersion(version, researchedBuild = null) {
  const candidate = String(researchedBuild?.fabricApiVersion || '').trim();
  if (!candidate) return null;
  return isFabricApiVersionForMinecraft(candidate, version) ? candidate : null;
}

function isFabricApiVersionForMinecraft(candidate, minecraftVersion) {
  const version = String(candidate || '').trim();
  const game = String(minecraftVersion || '').trim();
  if (!version || !game) return false;
  return version.endsWith(`+${game}`);
}

function normalizeFabricModJson(content, needsFabricApi = false) {
  try {
    const parsed = JSON.parse(String(content || '{}'));
    const depends = parsed && typeof parsed.depends === 'object' && !Array.isArray(parsed.depends)
      ? { ...parsed.depends }
      : {};
    if (needsFabricApi) {
      depends['fabric-api'] = depends['fabric-api'] || '*';
    } else {
      delete depends['fabric-api'];
      delete depends['fabric-api-base'];
    }
    if (Object.keys(depends).length) parsed.depends = depends;
    else delete parsed.depends;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}

function projectUsesFabricApi(files) {
  return Object.values(files || {}).some(file => {
    const normalized = normalizeFileData(file);
    if (normalized.encoding !== 'utf8') return false;
    return /\bnet\.fabricmc\.fabric\.api\b/.test(normalized.content || '');
  });
}

function normalizeFabricJavaSource(content, version) {
  let next = String(content || '');
  if (usesModernFabricIdentifierFactory(version)) {
    next = next.replace(/\bnew\s+Identifier\s*\(/g, 'Identifier.of(');
  }
  if (usesModernFabricRegistryKeys(version)) {
    next = normalizeModernFabricRegistryKeys(next);
  }
  return next;
}

function normalizePluginBuildGradle(content, loader, version) {
  let next = String(content || '');
  next = next.replace(/https:\/\/papermc\.io\/repo\/repository\/maven-public\/?/g, 'https://repo.papermc.io/repository/maven-public/');

  if (/io\.papermc\.paper:paper-api:/i.test(next) && !/repo\.papermc\.io\/repository\/maven-public/i.test(next)) {
    if (/repositories\s*\{/i.test(next)) {
      next = next.replace(/repositories\s*\{\s*/i, match => `${match}\n    maven { url = 'https://repo.papermc.io/repository/maven-public/' }\n`);
    } else {
      next += `\n\nrepositories {\n    mavenCentral()\n    maven { url = 'https://repo.papermc.io/repository/maven-public/' }\n}\n`;
    }
  }

  if (loader === 'paper' && /paper-api:/i.test(next)) {
    next = next.replace(/1\.21\.1-R0\.1-SNAPSHOT/g, `${version}-R0.1-SNAPSHOT`);
  }

  return next;
}

function normalizeNeoForgeBuildGradle(content, version, researchedBuild = null) {
  let next = String(content || '');
  if (!/maven\.neoforged\.net\/releases/i.test(next)) {
    if (/repositories\s*\{/i.test(next)) {
      next = next.replace(/repositories\s*\{\s*/i, match => `${match}\n    maven { url = 'https://maven.neoforged.net/releases' }\n`);
    } else {
      next += `\n\nrepositories {\n    mavenCentral()\n    maven { url = 'https://maven.neoforged.net/releases' }\n}\n`;
    }
  }
  if (researchedBuild?.userdevVersion) {
    next = next.replace(
      /(id\s+'net\.neoforged\.gradle\.userdev'\s+version\s+')([^']+)(')/g,
      `$1${researchedBuild.userdevVersion}$3`,
    );
  }
  if (researchedBuild?.neoforgeVersion) {
    next = next.replace(
      /implementation\s+"net\.neoforged:neoforge:[^"]+"/g,
      `implementation "net.neoforged:neoforge:${researchedBuild.neoforgeVersion}"`,
    );
  }
  return next;
}

function usesModernFabricIdentifierFactory(version) {
  return isModernFabricYarnVersion(version) || isFabricNonObfuscatedVersion(version);
}

function usesModernFabricRegistryKeys(version) {
  return /^1\.21\.(?:2|3|4|10|11)$/.test(String(version || '')) || isFabricNonObfuscatedVersion(version);
}

function isFabricNonObfuscatedVersion(version) {
  return /^26\./.test(String(version || ''));
}

function isModernFabricYarnVersion(version) {
  return /^1\.21(?:\.\d+)?$/.test(String(version || ''));
}

function normalizeModernFabricRegistryKeys(content) {
  let next = String(content || '');
  const blockRegistrations = collectFabricBlockRegistrations(next);
  if (!blockRegistrations.length) return next;

  next = ensureImport(next, 'net.minecraft.registry.RegistryKey');
  next = ensureImport(next, 'net.minecraft.registry.RegistryKeys');

  for (const registration of blockRegistrations) {
    const fieldPattern = new RegExp(
      `(^[ \\t]*)((?:public|private|protected)\\s+static\\s+final\\s+Block\\s+${escapeRegExp(registration.blockVar)}\\s*=\\s*new\\s+Block\\s*\\()([\\s\\S]*?)(\\)\\s*;)`,
      'm',
    );

    next = next.replace(fieldPattern, (match, indent, prefix, settingsExpr, suffix) => {
      const settingsText = String(settingsExpr || '');
      if (/\.registryKey\s*\(/.test(settingsText)) {
        return match;
      }

      const declarations = buildModernFabricRegistryDeclarations(next, registration, indent);
      return `${declarations}${indent}${prefix}${settingsText}.registryKey(${registration.blockKeyConst})${suffix}`;
    });

    const blockItemPattern = new RegExp(
      `(new\\s+BlockItem\\s*\\(\\s*${escapeRegExp(registration.blockVar)}\\s*,\\s*new\\s+Item\\.Settings\\s*\\(\\))`,
      'g',
    );

    next = next.replace(blockItemPattern, (match, constructorStart, offset) => {
      const lookahead = next.slice(offset, offset + 240);
      if (/\.registryKey\s*\(/.test(lookahead)) {
        return match;
      }
      return `${constructorStart}.useBlockPrefixedTranslationKey().registryKey(${registration.itemKeyConst})`;
    });
  }

  return next;
}

function collectFabricBlockRegistrations(content) {
  const registrations = [];
  const seen = new Set();
  const pattern = /Registry\.register\(\s*Registries\.BLOCK\s*,\s*([\s\S]*?)\s*,\s*([A-Z0-9_]+)\s*\);/g;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    const idExpr = String(match[1] || '').trim();
    const blockVar = String(match[2] || '').trim();
    if (!idExpr || !blockVar || seen.has(blockVar)) continue;

    const baseConst = blockVar.endsWith('_BLOCK')
      ? blockVar.slice(0, -'_BLOCK'.length)
      : blockVar;

    registrations.push({
      blockVar,
      idExpr,
      idConst: `${baseConst}_ID`,
      blockKeyConst: `${baseConst}_BLOCK_KEY`,
      itemKeyConst: `${baseConst}_ITEM_KEY`,
    });
    seen.add(blockVar);
  }

  return registrations;
}

function buildModernFabricRegistryDeclarations(content, registration, indent = '') {
  const declarations = [];
  if (!hasDeclaration(content, registration.idConst)) {
    declarations.push(`${indent}private static final Identifier ${registration.idConst} = ${registration.idExpr};`);
  }
  if (!hasDeclaration(content, registration.blockKeyConst)) {
    declarations.push(`${indent}private static final RegistryKey<Block> ${registration.blockKeyConst} = RegistryKey.of(RegistryKeys.BLOCK, ${registration.idConst});`);
  }
  if (!hasDeclaration(content, registration.itemKeyConst)) {
    declarations.push(`${indent}private static final RegistryKey<Item> ${registration.itemKeyConst} = RegistryKey.of(RegistryKeys.ITEM, ${registration.idConst});`);
  }
  return declarations.length ? `${declarations.join('\n')}\n` : '';
}

function hasDeclaration(content, identifierName) {
  return new RegExp(`\\b${escapeRegExp(identifierName)}\\b`).test(content);
}

function ensureImport(content, importPath) {
  const importLine = `import ${importPath};`;
  if (content.includes(importLine)) return content;

  const packageMatch = content.match(/^(package\s+[\w.]+\s*;\s*\r?\n)/m);
  if (packageMatch) {
    const insertionPoint = packageMatch.index + packageMatch[0].length;
    return `${content.slice(0, insertionPoint)}${importLine}\n${content.slice(insertionPoint)}`;
  }

  return `${importLine}\n${content}`;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function extractBuildFailureSignature(log) {
  const text = String(log || '');
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const picked = [];

  for (const line of lines) {
    if (/^\*\s+What went wrong:/i.test(line) || /^\>\s/.test(line) || /error:/i.test(line) || /cannot find symbol/i.test(line) || /package .* does not exist/i.test(line)) {
      picked.push(line.replace(/\s+/g, ' '));
    }
    if (picked.length >= 8) break;
  }

  return picked.join(' | ').slice(0, 1200);
}

function buildRepairFingerprint(files, summary, changedFiles) {
  const selected = (Array.isArray(changedFiles) ? changedFiles : [])
    .slice()
    .sort()
    .map(filePath => `${filePath}:${tail(normalizeFileData(files[filePath]).content, 240)}`);
  return `${summary || ''}\n${selected.join('\n')}`;
}

function extractLatestPrompt(conversation) {
  const entries = Array.isArray(conversation) ? [...conversation].reverse() : [];
  for (const entry of entries) {
    if (entry?.role !== 'user') continue;
    const content = String(entry.content || '').trim();
    if (!content) continue;
    const marker = '[User request]';
    return content.includes(marker) ? content.split(marker).pop().trim() : content;
  }
  return '';
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
    if (major !== null && major >= requiredVersion) {
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
    throw new Error(`The downloaded JDK could not be extracted.\n${tailText(error?.message || String(error), 1200)}`);
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
