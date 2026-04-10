/**
 * CodexMC AI Generation Service
 * Uses Claude claude-sonnet-4-20250514 to generate complete Minecraft mod projects
 */

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const { execFile, spawn } = require('child_process');
const { getRequiredJdk } = require('./versions');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are CodexMC, an expert Minecraft mod developer with deep knowledge of:
- Forge modding (all versions from 1.7 to 1.21+)
- Fabric modding (all versions from 1.14+)  
- NeoForge modding (1.20.2+)
- Java programming, Gradle build systems, and Minecraft internals

When asked to create a mod, you MUST respond with a valid JSON object (no markdown, no backticks, just raw JSON) with this exact structure:
{
  "modName": "ExampleMod",
  "modId": "examplemod",
  "description": "What the mod does",
  "version": "1.0.0",
  "files": {
    "src/main/java/com/example/examplemod/ExampleMod.java": "// full java code here",
    "src/main/resources/META-INF/mods.toml": "// for forge/neoforge",
    "src/main/resources/fabric.mod.json": "// for fabric only",
    "build.gradle": "// full build.gradle",
    "gradle.properties": "// properties",
    "settings.gradle": "// settings"
  },
  "gradlewNeeded": true,
  "jdkRequired": "21"
}

Rules:
- Always write COMPLETE, COMPILABLE Java code. No placeholders, no TODOs.
- Include ALL necessary imports
- Include proper event handlers, registry calls, and main mod class
- The build.gradle must be complete and ready to run with ./gradlew build
- Use the exact correct APIs for the specified loader and MC version
- modId must be lowercase, no spaces, alphanumeric + underscores only
- Always include gradle wrapper files (gradlew, gradlew.bat, gradle/wrapper/gradle-wrapper.properties)
- For Forge 1.17+: use the correct ForgeGradle 5+ setup
- For Fabric: use loom 1.x with correct mappings
- For NeoForge: use the NeoGradle plugin
- NEVER truncate code. Every file must be 100% complete.`;
}

function buildUserPrompt(request) {
  const { prompt, loader, mcVersion, loaderVersion } = request;
  return `Create a complete Minecraft ${loader} mod for Minecraft ${mcVersion} using ${loader} ${loaderVersion}.

Mod Request: ${prompt}

Requirements:
- Loader: ${loader}
- Minecraft Version: ${mcVersion}  
- ${loader} Version: ${loaderVersion}
- Make it fully functional and compilable
- Include all necessary files for a complete Gradle project

Respond ONLY with the JSON structure described. No explanation, no markdown, just the JSON object.`;
}

// ── Gradle wrapper files ──────────────────────────────────────────────────────

function getGradleWrapperProps(loader, mcVersion) {
  // Use appropriate Gradle version based on loader/MC version
  const [, , minor] = mcVersion.split('.').map(Number);
  let gradleVersion = '8.8';
  if (minor <= 16) gradleVersion = '7.6.4';
  else if (minor <= 19) gradleVersion = '8.1.1';

  return `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists`;
}

const GRADLEW_SCRIPT = `#!/bin/sh
# Gradle wrapper script (Unix)
DEFAULT_JVM_OPTS='"-Xmx64m" "-Xms64m"'
APP_HOME="$( cd "$( dirname "$0" )" && pwd )"
CLASSPATH=$APP_HOME/gradle/wrapper/gradle-wrapper.jar
exec "$JAVACMD" -classpath "$CLASSPATH" org.gradle.wrapper.GradleWrapperMain "$@"
`;

const GRADLEW_BAT = `@rem Gradle wrapper script (Windows)
@echo off
set DIRNAME=%~dp0
set APP_HOME=%DIRNAME%
set CLASSPATH=%APP_HOME%\\gradle\\wrapper\\gradle-wrapper.jar
"%JAVA_HOME%\\bin\\java.exe" -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*
`;

// ── Core generation function ──────────────────────────────────────────────────

async function generateMod(request, onProgress) {
  const { prompt, loader, mcVersion, loaderVersion, sessionId } = request;
  const workId = uuidv4();
  const workDir = path.join(process.env.WORKSPACE_DIR || '/tmp/codexmc-workspaces', workId);

  const emit = (type, message) => {
    if (onProgress) onProgress({ type, message, workId });
  };

  try {
    emit('info', `🚀 Starting mod generation for ${loader} ${mcVersion}`);
    emit('info', `📝 Processing your request...`);
    emit('ai', `Connecting to Claude claude-sonnet-4-20250514...`);

    // ── Call Claude API ────────────────────────────────────────────────
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === 'your_key_here' || apiKey === 'your_anthropic_api_key_here') {
      throw new Error('ANTHROPIC_API_KEY not configured. Please set it in your .env file.');
    }

    emit('ai', `🤖 Generating mod code with AI...`);

    let fullResponse = '';
    
    // Use streaming for real-time output
    const response = await axios.post(ANTHROPIC_API, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      stream: true,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: buildUserPrompt(request) }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      responseType: 'stream',
      timeout: 120000
    });

    // Process streaming response
    await new Promise((resolve, reject) => {
      let buffer = '';
      response.data.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                fullResponse += parsed.delta.text;
                // Show AI thinking in console
                const preview = parsed.delta.text.replace(/\n/g, ' ');
                if (preview.trim()) emit('ai-stream', preview);
              }
            } catch {}
          }
        }
      });
      response.data.on('end', resolve);
      response.data.on('error', reject);
    });

    emit('ai', `✅ AI generation complete! Parsing mod structure...`);

    // ── Parse JSON response ────────────────────────────────────────────
    let modData;
    try {
      // Strip any accidental markdown wrapping
      const cleaned = fullResponse
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      modData = JSON.parse(cleaned);
    } catch (e) {
      // Try to extract JSON from response
      const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          modData = JSON.parse(jsonMatch[0]);
        } catch {
          throw new Error('AI returned invalid JSON. Please try again with a clearer description.');
        }
      } else {
        throw new Error('Could not parse AI response. Please try again.');
      }
    }

    emit('info', `📁 Creating project structure for "${modData.modName}"...`);

    // ── Write all files ────────────────────────────────────────────────
    await fs.ensureDir(workDir);

    for (const [filePath, content] of Object.entries(modData.files || {})) {
      const fullPath = path.join(workDir, filePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content, 'utf8');
      emit('file', `  📄 Created: ${filePath}`);
    }

    // ── Add Gradle wrapper files ───────────────────────────────────────
    emit('info', `🔧 Adding Gradle wrapper files...`);

    const wrapperDir = path.join(workDir, 'gradle', 'wrapper');
    await fs.ensureDir(wrapperDir);

    // gradle-wrapper.properties
    await fs.writeFile(
      path.join(wrapperDir, 'gradle-wrapper.properties'),
      getGradleWrapperProps(loader, mcVersion)
    );

    // gradlew (unix)
    const gradlewPath = path.join(workDir, 'gradlew');
    await fs.writeFile(gradlewPath, GRADLEW_SCRIPT);
    await fs.chmod(gradlewPath, 0o755);

    // gradlew.bat (windows)
    await fs.writeFile(path.join(workDir, 'gradlew.bat'), GRADLEW_BAT);

    // Download actual gradle-wrapper.jar
    emit('info', `📦 Downloading gradle-wrapper.jar...`);
    try {
      const jarRes = await axios.get(
        'https://github.com/gradle/gradle/raw/v8.8.0/gradle/wrapper/gradle-wrapper.jar',
        { responseType: 'arraybuffer', timeout: 30000 }
      );
      await fs.writeFile(path.join(wrapperDir, 'gradle-wrapper.jar'), jarRes.data);
      emit('info', `✅ gradle-wrapper.jar downloaded`);
    } catch {
      emit('warn', `⚠️ Could not download gradle-wrapper.jar (network). Build may require manual setup.`);
      // Write empty placeholder
      await fs.writeFile(path.join(wrapperDir, 'gradle-wrapper.jar'), Buffer.alloc(0));
    }

    // ── gitignore ────────────────────────────────────────────────────
    await fs.writeFile(path.join(workDir, '.gitignore'), `
.gradle/
build/
run/
out/
*.iml
*.ipr
*.iws
.idea/
eclipse/
*.class
*.jar
!gradle-wrapper.jar
`);

    // ── Run Gradle build ──────────────────────────────────────────────
    emit('build', `\n🏗️  Starting Gradle build...`);
    emit('build', `  Using JDK ${modData.jdkRequired || getRequiredJdk(mcVersion)}`);
    
    const jdkKey = `JDK_${modData.jdkRequired || getRequiredJdk(mcVersion)}_PATH`;
    const javaHome = process.env[jdkKey] || findJavaHome(modData.jdkRequired || getRequiredJdk(mcVersion));
    
    emit('build', `  JAVA_HOME: ${javaHome}`);
    emit('build', `  Running: ./gradlew build --no-daemon\n`);

    let buildSuccess = false;
    let jarPath = null;

    await new Promise((resolve) => {
      const env = {
        ...process.env,
        JAVA_HOME: javaHome,
        PATH: `${javaHome}/bin:${process.env.PATH}`
      };

      const gradle = spawn('./gradlew', ['build', '--no-daemon', '--console=plain'], {
        cwd: workDir,
        env,
        shell: true
      });

      gradle.stdout.on('data', data => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) emit('build-output', line);
        }
      });

      gradle.stderr.on('data', data => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) emit('build-output', `⚠️ ${line}`);
        }
      });

      gradle.on('close', async code => {
        if (code === 0) {
          buildSuccess = true;
          emit('build', `\n✅ Build successful! (exit code 0)`);
          
          // Find the output JAR
          const buildLibs = path.join(workDir, 'build', 'libs');
          if (await fs.pathExists(buildLibs)) {
            const files = await fs.readdir(buildLibs);
            const jars = files.filter(f => f.endsWith('.jar') && !f.includes('sources') && !f.includes('dev'));
            if (jars.length > 0) {
              jarPath = path.join(buildLibs, jars[0]);
              emit('build', `  📦 Output JAR: build/libs/${jars[0]}`);
            }
          }
        } else {
          emit('build', `\n⚠️ Build exited with code ${code}`);
          emit('build', `  The project files are still valid - build may need manual setup`);
          emit('build', `  Common fix: ensure correct JDK version is installed`);
        }
        resolve();
      });

      // Timeout
      setTimeout(() => {
        gradle.kill();
        emit('build', `⏱️ Build timeout - packaging source files`);
        resolve();
      }, parseInt(process.env.BUILD_TIMEOUT_MS) || 300000);
    });

    // ── Package ZIP ───────────────────────────────────────────────────
    emit('info', `\n📦 Creating download package...`);
    
    const outputDir = '/var/codexmc-output';
    await fs.ensureDir(outputDir);
    const zipName = `${modData.modId || 'mod'}-${mcVersion}-${loader}-${workId.slice(0, 8)}.zip`;
    const zipPath = path.join(outputDir, zipName);

    await new Promise((resolve, reject) => {
      const output = require('fs').createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(workDir, modData.modId || 'mod');
      archive.finalize();
    });

    emit('success', `\n🎉 Complete! Your mod project is ready.`);
    emit('success', `  Mod: ${modData.modName}`);
    emit('success', `  Loader: ${loader} for MC ${mcVersion}`);
    emit('success', `  Build: ${buildSuccess ? '✅ Compiled successfully' : '⚠️ Source only (compile manually)'}`);
    if (jarPath) emit('success', `  JAR: Included in download`);

    // Cleanup workspace after packaging
    setTimeout(() => fs.remove(workDir).catch(() => {}), 60000);

    return {
      success: true,
      modName: modData.modName,
      modId: modData.modId,
      zipName,
      zipPath,
      buildSuccess,
      jarIncluded: !!jarPath
    };

  } catch (error) {
    emit('error', `\n❌ Error: ${error.message}`);
    // Cleanup on error
    await fs.remove(workDir).catch(() => {});
    throw error;
  }
}

function findJavaHome(version) {
  const candidates = [
    `/usr/lib/jvm/java-${version}-openjdk-amd64`,
    `/usr/lib/jvm/java-${version}-openjdk`,
    `/usr/lib/jvm/temurin-${version}`,
    `/opt/codexmc-jdk/${version}`,
    `/usr/local/lib/jvm/jdk-${version}`,
  ];
  for (const c of candidates) {
    if (require('fs').existsSync(path.join(c, 'bin', 'java'))) return c;
  }
  // Fallback: use system java
  try {
    const which = require('child_process').execSync('which java').toString().trim();
    return which.replace('/bin/java', '');
  } catch {
    return '/usr';
  }
}

module.exports = { generateMod };
