#!/usr/bin/env node
/**
 * CodexMC VPS Setup Script
 * Installs required JDK versions, build tools, and configures the environment
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function run(cmd, opts = {}) {
  log(`  → ${cmd}`, 'cyan');
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
    return true;
  } catch (e) {
    log(`  ✗ Failed: ${e.message}`, 'red');
    return false;
  }
}

async function main() {
  log('\n╔════════════════════════════════════╗', 'bold');
  log('║     CodexMC VPS Setup Script       ║', 'bold');
  log('╚════════════════════════════════════╝\n', 'bold');

  // Detect OS
  let os = 'unknown';
  try {
    const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
    if (osRelease.includes('Ubuntu') || osRelease.includes('Debian')) os = 'debian';
    else if (osRelease.includes('CentOS') || osRelease.includes('Rocky') || osRelease.includes('AlmaLinux')) os = 'rhel';
    else if (osRelease.includes('Fedora')) os = 'fedora';
  } catch {}

  log(`Detected OS family: ${os}`, 'yellow');

  // ── Step 1: System packages ──────────────────────────────────────────
  log('\n[1/6] Updating system packages...', 'green');
  if (os === 'debian') {
    run('apt-get update -y');
    run('apt-get install -y curl wget unzip zip git build-essential software-properties-common apt-transport-https ca-certificates gnupg');
  } else if (os === 'rhel' || os === 'fedora') {
    run('dnf update -y');
    run('dnf install -y curl wget unzip zip git gcc gcc-c++ make');
  }

  // ── Step 2: Install Node.js 20 LTS if not present ───────────────────
  log('\n[2/6] Checking Node.js...', 'green');
  try {
    const nodeVersion = execSync('node --version').toString().trim();
    log(`  Node.js already installed: ${nodeVersion}`, 'yellow');
  } catch {
    log('  Installing Node.js 20 LTS...', 'cyan');
    if (os === 'debian') {
      run('curl -fsSL https://deb.nodesource.com/setup_20.x | bash -');
      run('apt-get install -y nodejs');
    } else {
      run('curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -');
      run('dnf install -y nodejs');
    }
  }

  // ── Step 3: Install JDK versions ────────────────────────────────────
  log('\n[3/6] Installing JDK versions...', 'green');

  const jdkVersions = [
    { version: '8',  adoptVersion: '8u392b08',  majorTag: '8' },
    { version: '17', adoptVersion: '17.0.10+7', majorTag: '17' },
    { version: '21', adoptVersion: '21.0.2+13', majorTag: '21' },
    { version: '25', adoptVersion: '25-ea',     majorTag: '25', earlyAccess: true },
  ];

  fs.mkdirSync('/opt/codexmc-jdk', { recursive: true });

  for (const jdk of jdkVersions) {
    const targetDir = `/opt/codexmc-jdk/${jdk.version}`;
    if (fs.existsSync(`${targetDir}/bin/java`)) {
      log(`  JDK ${jdk.version} already installed`, 'yellow');
      continue;
    }

    log(`  Installing JDK ${jdk.version}...`, 'cyan');

    if (os === 'debian') {
      // Use SDKMAN for clean multi-JDK management
      if (!fs.existsSync('/root/.sdkman')) {
        run('curl -s "https://get.sdkman.io" | bash');
      }

      // Alternatively use apt with specific versions
      if (jdk.version === '8') {
        run('apt-get install -y openjdk-8-jdk 2>/dev/null || true');
        const java8 = execSync('which java8 2>/dev/null || find /usr/lib/jvm -name "java" -path "*/java-8*" 2>/dev/null | head -1').toString().trim();
        if (java8) {
          const javaHome = java8.replace('/bin/java', '');
          fs.mkdirSync(targetDir, { recursive: true });
          run(`ln -sf ${javaHome} ${targetDir} 2>/dev/null || true`);
        }
      } else if (jdk.version === '17') {
        run('apt-get install -y openjdk-17-jdk 2>/dev/null || true');
      } else if (jdk.version === '21') {
        run('apt-get install -y openjdk-21-jdk 2>/dev/null || true');
      } else if (jdk.version === '25') {
        // JDK 25 EA - download from Adoptium
        log('  JDK 25 is early access - downloading from Adoptium EA...', 'yellow');
        run(`wget -q -O /tmp/jdk25.tar.gz "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25%2B15/OpenJDK25U-jdk_x64_linux_hotspot_25_15.tar.gz" || \
             wget -q -O /tmp/jdk25.tar.gz "https://builds.shipilev.net/openjdk-jdk/openjdk-jdk-latest-linux-x86_64-release.tar.xz" || true`);
        if (fs.existsSync('/tmp/jdk25.tar.gz')) {
          fs.mkdirSync(targetDir, { recursive: true });
          run(`tar -xzf /tmp/jdk25.tar.gz -C ${targetDir} --strip-components=1 2>/dev/null || true`);
          run('rm -f /tmp/jdk25.tar.gz');
        } else {
          log('  JDK 25 EA not available yet, using JDK 21 as fallback for MC 1.21+', 'yellow');
          run(`ln -sf /opt/codexmc-jdk/21 ${targetDir} 2>/dev/null || true`);
        }
      }
    }
  }

  // Find and record Java paths
  const javaMap = {};
  const jvmBase = '/usr/lib/jvm';
  if (fs.existsSync(jvmBase)) {
    const dirs = fs.readdirSync(jvmBase);
    for (const d of dirs) {
      const javaPath = path.join(jvmBase, d, 'bin', 'java');
      if (fs.existsSync(javaPath)) {
        if (d.includes('java-8') || d.includes('jdk-8') || d.includes('jdk8')) javaMap['8'] = path.join(jvmBase, d);
        if (d.includes('java-17') || d.includes('jdk-17') || d.includes('jdk17')) javaMap['17'] = path.join(jvmBase, d);
        if (d.includes('java-21') || d.includes('jdk-21') || d.includes('jdk21')) javaMap['21'] = path.join(jvmBase, d);
      }
    }
  }

  // ── Step 4: Create workspace directory ──────────────────────────────
  log('\n[4/6] Creating workspace directories...', 'green');
  fs.mkdirSync('/tmp/codexmc-workspaces', { recursive: true });
  fs.mkdirSync('/var/codexmc-output', { recursive: true });
  run('chmod 777 /tmp/codexmc-workspaces /var/codexmc-output');

  // ── Step 5: Write .env if not exists ────────────────────────────────
  log('\n[5/6] Configuring environment...', 'green');
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    const envContent = `ANTHROPIC_API_KEY=your_key_here
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
WORKSPACE_DIR=/tmp/codexmc-workspaces
MAX_CONCURRENT_BUILDS=3
BUILD_TIMEOUT_MS=300000
JDK_8_PATH=${javaMap['8'] || '/usr/lib/jvm/java-8-openjdk-amd64'}
JDK_17_PATH=${javaMap['17'] || '/usr/lib/jvm/java-17-openjdk-amd64'}
JDK_21_PATH=${javaMap['21'] || '/usr/lib/jvm/java-21-openjdk-amd64'}
JDK_25_PATH=${javaMap['21'] || '/usr/lib/jvm/java-21-openjdk-amd64'}
MAX_REQUESTS_PER_HOUR=20
`;
    fs.writeFileSync(envPath, envContent);
    log('  Created .env file - please add your ANTHROPIC_API_KEY!', 'yellow');
  } else {
    log('  .env already exists', 'yellow');
  }

  // ── Step 6: Install npm deps ─────────────────────────────────────────
  log('\n[6/6] Installing npm dependencies...', 'green');
  run('npm install', { cwd: path.join(__dirname, '..') });

  // ── Done ──────────────────────────────────────────────────────────────
  log('\n✅ Setup complete!', 'green');
  log('\nNext steps:', 'bold');
  log('  1. Edit .env and add your ANTHROPIC_API_KEY', 'yellow');
  log('  2. Run: npm start', 'yellow');
  log('  3. Visit: http://your-server:3000', 'yellow');
  log('\nFor production with PM2:', 'bold');
  log('  npm install -g pm2', 'cyan');
  log('  pm2 start src/server.js --name codexmc', 'cyan');
  log('  pm2 save && pm2 startup\n', 'cyan');
}

main().catch(console.error);
