/**
 * CodexMC — Frontend Application
 * Handles: page routing, WebSocket live console, version fetching, mod generation
 */

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  sessionId: generateUUID(),
  ws: null,
  wsReconnectTimer: null,
  currentLoader: 'forge',
  versionsCache: {},
  sessions: [],       // history items
  activeSessionIdx: -1,
  isGenerating: false,
};

// ── UUID ──────────────────────────────────────────────────────────────────────
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  BACKGROUND CANVAS (landing page)
// ══════════════════════════════════════════════════════════════════════════════

function initCanvas() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles;

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function makeParticles() {
    particles = Array.from({ length: 80 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      r: Math.random() * 1.5 + 0.5,
      alpha: Math.random() * 0.4 + 0.1
    }));
  }

  let raf;
  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = 'rgba(30,37,53,0.6)';
    ctx.lineWidth = 1;
    const gridSize = 60;
    for (let x = 0; x < W; x += gridSize) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += gridSize) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Glow at top center
    const grad = ctx.createRadialGradient(W/2, 0, 0, W/2, 0, W * 0.6);
    grad.addColorStop(0, 'rgba(74,222,128,0.07)');
    grad.addColorStop(1, 'rgba(74,222,128,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Particles
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W;
      if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H;
      if (p.y > H) p.y = 0;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(74,222,128,${p.alpha})`;
      ctx.fill();
    }

    // Connect close particles
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < 120) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(74,222,128,${0.06 * (1 - dist/120)})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    raf = requestAnimationFrame(draw);
  }

  resize();
  makeParticles();
  draw();

  window.addEventListener('resize', () => {
    resize();
    makeParticles();
  });

  // Stop canvas when on app page
  return () => cancelAnimationFrame(raf);
}

// ══════════════════════════════════════════════════════════════════════════════
//  PAGE NAVIGATION
// ══════════════════════════════════════════════════════════════════════════════

function showApp() {
  document.getElementById('landing-page').style.display = 'none';
  const appPage = document.getElementById('app-page');
  appPage.style.display = 'flex';
  appPage.classList.add('fade-in');
  connectWS();
  loadVersions('forge');
}

function showLanding() {
  document.getElementById('app-page').style.display = 'none';
  document.getElementById('landing-page').style.display = 'block';
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
}

// ══════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET
// ══════════════════════════════════════════════════════════════════════════════

function connectWS() {
  if (state.ws && state.ws.readyState < 2) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws/${state.sessionId}`;

  state.ws = new WebSocket(url);

  state.ws.onopen = () => {
    setStatus('connected', 'Connected');
    clearTimeout(state.wsReconnectTimer);
  };

  state.ws.onclose = () => {
    setStatus('error', 'Disconnected');
    state.wsReconnectTimer = setTimeout(connectWS, 3000);
  };

  state.ws.onerror = () => {
    setStatus('error', 'Connection error');
  };

  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    } catch {}
  };
}

function handleWsMessage(msg) {
  const { type, message } = msg;

  // Update live console
  appendConsoleOutput(type, message);

  if (type === 'done') {
    onGenerationDone(msg);
  } else if (type === 'error') {
    onGenerationError(message);
  }
}

function setStatus(state_, text) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  dot.className = 'status-dot ' + state_;
  label.textContent = text;
}

// ══════════════════════════════════════════════════════════════════════════════
//  VERSION LOADING
// ══════════════════════════════════════════════════════════════════════════════

async function loadVersions(loader) {
  const select = document.getElementById('version-select');
  if (!select) return;

  if (state.versionsCache[loader]) {
    populateVersionSelect(loader, state.versionsCache[loader]);
    return;
  }

  select.innerHTML = '<option value="">Loading versions...</option>';

  // Show spinner
  select.parentElement.insertAdjacentHTML('beforeend',
    '<div class="loader-loader"><div class="spinner"></div>Fetching versions...</div>'
  );

  try {
    const res = await fetch(`/api/versions/${loader}`);
    const data = await res.json();
    state.versionsCache[loader] = data.versions;
    populateVersionSelect(loader, data.versions);
  } catch (e) {
    select.innerHTML = '<option value="">Failed to load</option>';
    console.error('Version fetch error:', e);
  } finally {
    const loader_el = select.parentElement.querySelector('.loader-loader');
    if (loader_el) loader_el.remove();
  }
}

function populateVersionSelect(loader, versions) {
  const select = document.getElementById('version-select');
  select.innerHTML = '';

  if (!versions || versions.length === 0) {
    select.innerHTML = '<option value="">No versions found</option>';
    return;
  }

  versions.forEach((v, i) => {
    const opt = document.createElement('option');
    const loaderVersion = v.recommended || v.loaderVersion || v.forgeVersions?.[0] || v.neoforgeVersions?.[0] || '';
    opt.value = JSON.stringify({ mcVersion: v.mcVersion, loaderVersion });
    opt.textContent = `MC ${v.mcVersion}`;
    if (i === 0) opt.selected = true;
    select.appendChild(opt);
  });
}

function onLoaderChange() {
  const loader = document.getElementById('loader-select').value;
  state.currentLoader = loader;
  loadVersions(loader);
}

function getSelectedVersion() {
  const select = document.getElementById('version-select');
  if (!select.value) return null;
  try { return JSON.parse(select.value); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MOD GENERATION
// ══════════════════════════════════════════════════════════════════════════════

async function sendPrompt() {
  if (state.isGenerating) return;

  const promptInput = document.getElementById('prompt-input');
  const prompt = promptInput.value.trim();
  if (!prompt) {
    promptInput.focus();
    return;
  }

  const loader = document.getElementById('loader-select').value;
  const versionData = getSelectedVersion();
  if (!versionData) {
    alert('Please wait for versions to load and select a Minecraft version.');
    return;
  }

  const { mcVersion, loaderVersion } = versionData;

  // Hide welcome
  const welcome = document.getElementById('welcome-state');
  if (welcome) welcome.style.display = 'none';

  // Add user message
  addUserMessage(prompt, loader, mcVersion, loaderVersion);

  // Clear input
  promptInput.value = '';
  promptInput.style.height = 'auto';

  // Disable inputs
  setGenerating(true);

  // Create console card in messages
  const consoleId = 'console-' + Date.now();
  addConsoleMessage(consoleId, loader, mcVersion);

  // Ensure WS connected
  if (!state.ws || state.ws.readyState > 1) connectWS();

  // Add to history
  addHistoryItem(prompt, loader, mcVersion, consoleId);

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        loader,
        mcVersion,
        loaderVersion,
        sessionId: state.sessionId
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    // Generation is now streaming via WS
    updateConsoleStatus(consoleId, 'running');

  } catch (err) {
    appendConsoleOutput('error', `Failed to start: ${err.message}`);
    setGenerating(false);
    updateConsoleStatus(consoleId, 'error');
  }
}

// Track active console
let activeConsoleId = null;

function addUserMessage(prompt, loader, mcVersion, loaderVersion) {
  const msgs = document.getElementById('messages');
  const loaderEmoji = { forge: '🔥', fabric: '🪡', neoforge: '✨' }[loader] || '🎮';

  const div = document.createElement('div');
  div.className = 'message-user';
  div.innerHTML = `
    <div class="message-user-bubble">
      <div style="font-size:0.78rem;font-family:var(--font-mono);color:var(--text-muted);margin-bottom:6px">
        ${loaderEmoji} ${loader.toUpperCase()} · MC ${mcVersion}
      </div>
      ${escapeHtml(prompt)}
    </div>`;
  msgs.appendChild(div);
  scrollToBottom();
}

function addConsoleMessage(consoleId, loader, mcVersion) {
  const msgs = document.getElementById('messages');
  activeConsoleId = consoleId;

  const div = document.createElement('div');
  div.className = 'message-ai';
  div.id = 'msg-' + consoleId;
  div.innerHTML = `
    <div class="message-ai-header">
      <div class="ai-avatar">AI</div>
      <div class="ai-label">CodexMC Generator</div>
      <div class="message-info">
        <div class="generating-dots"><span></span><span></span><span></span></div>
      </div>
    </div>
    <div class="console-card" id="${consoleId}">
      <div class="console-header">
        <div class="console-dots">
          <div class="console-dot" style="background:#ff5f57"></div>
          <div class="console-dot" style="background:#ffbd2e"></div>
          <div class="console-dot" style="background:#28c840"></div>
        </div>
        <span class="console-title">codexmc — ${loader} ${mcVersion}</span>
        <span class="console-status running" id="status-${consoleId}">⏳ Generating</span>
      </div>
      <div class="console-output" id="output-${consoleId}">
        <span class="console-line type-info">Waiting for AI...</span>
      </div>
    </div>
    <div id="download-area-${consoleId}"></div>
  `;
  msgs.appendChild(div);
  scrollToBottom();
}

function appendConsoleOutput(type, message) {
  if (!activeConsoleId) return;
  const output = document.getElementById('output-' + activeConsoleId);
  if (!output) return;

  // Remove "waiting" placeholder
  const waiting = output.querySelector('.type-info');
  if (waiting && waiting.textContent === 'Waiting for AI...') waiting.remove();

  if (!message) return;

  const lines = String(message).split('\n');
  for (const line of lines) {
    if (!line) continue;
    const span = document.createElement('span');
    span.className = `console-line type-${type}`;
    span.textContent = line;
    output.appendChild(span);
    output.appendChild(document.createTextNode('\n'));
  }

  // Auto-scroll console
  output.scrollTop = output.scrollHeight;
  scrollToBottom();
}

function updateConsoleStatus(consoleId, status) {
  const el = document.getElementById('status-' + consoleId);
  if (!el) return;
  el.className = 'console-status ' + status;
  el.textContent = status === 'running' ? '⏳ Generating' :
                   status === 'done'    ? '✅ Complete' :
                   status === 'error'   ? '❌ Error' : status;
}

function onGenerationDone(result) {
  const { zipName, modName, buildSuccess } = result;

  updateConsoleStatus(activeConsoleId, 'done');

  // Update generating dots → checkmark
  const msgDiv = document.getElementById('msg-' + activeConsoleId);
  if (msgDiv) {
    const info = msgDiv.querySelector('.message-info');
    if (info) info.innerHTML = `<span style="color:var(--accent);font-size:0.82rem">✅ Done</span>`;
  }

  // Show download card
  if (zipName && activeConsoleId) {
    const dlArea = document.getElementById('download-area-' + activeConsoleId);
    if (dlArea) {
      dlArea.innerHTML = `
        <div class="download-card">
          <div class="download-info">
            <h4>🎉 ${escapeHtml(modName || 'Your mod')} is ready!</h4>
            <p>${buildSuccess ? '✅ Compiled JAR included' : '📁 Source files (build manually)'} · ${escapeHtml(zipName)}</p>
          </div>
          <a class="download-btn" href="/api/download/${encodeURIComponent(zipName)}" download>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download Project
          </a>
        </div>`;
    }
  }

  setGenerating(false);
  scrollToBottom();

  // Update title
  if (modName) {
    document.getElementById('topbar-title').textContent = `CodexMC — ${modName}`;
  }
}

function onGenerationError(message) {
  updateConsoleStatus(activeConsoleId, 'error');

  const msgDiv = document.getElementById('msg-' + activeConsoleId);
  if (msgDiv) {
    const info = msgDiv.querySelector('.message-info');
    if (info) info.innerHTML = `<span style="color:var(--red);font-size:0.82rem">❌ Failed</span>`;
  }

  setGenerating(false);
}

function setGenerating(val) {
  state.isGenerating = val;
  const btn = document.getElementById('send-btn');
  const input = document.getElementById('prompt-input');
  if (btn) btn.disabled = val;
  if (input) input.disabled = val;
}

// ══════════════════════════════════════════════════════════════════════════════
//  HISTORY
// ══════════════════════════════════════════════════════════════════════════════

function addHistoryItem(prompt, loader, mcVersion, consoleId) {
  const history = document.getElementById('chat-history');
  const empty = history.querySelector('.history-empty');
  if (empty) empty.remove();

  const loaderIcon = { forge: '🔥', fabric: '🪡', neoforge: '✨' }[loader] || '🎮';

  const item = document.createElement('div');
  item.className = 'history-item active';
  item.dataset.consoleId = consoleId;
  item.innerHTML = `
    <div class="history-item-icon">${loaderIcon}</div>
    <div class="history-item-text">
      <div class="history-item-title">${escapeHtml(prompt.slice(0, 40))}${prompt.length > 40 ? '…' : ''}</div>
      <div class="history-item-meta">${loader} · MC ${mcVersion}</div>
    </div>`;

  item.onclick = () => {
    document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
    item.classList.add('active');
    const el = document.getElementById('msg-' + consoleId);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  // Mark previous items as inactive
  document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));

  history.insertBefore(item, history.firstChild);
}

function newSession() {
  // Reset conversation
  document.getElementById('messages').innerHTML = '';
  document.getElementById('welcome-state').style.display = 'flex';
  document.getElementById('prompt-input').value = '';
  document.getElementById('topbar-title').textContent = 'CodexMC — Mod Generator';

  // New session ID
  state.sessionId = generateUUID();
  activeConsoleId = null;
  state.isGenerating = false;

  document.getElementById('send-btn').disabled = false;
  document.getElementById('prompt-input').disabled = false;

  // Reconnect WS with new session
  if (state.ws) state.ws.close();
  setTimeout(connectWS, 100);

  // Deselect history items
  document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
}

// ══════════════════════════════════════════════════════════════════════════════
//  UTILITY
// ══════════════════════════════════════════════════════════════════════════════

function scrollToBottom() {
  const area = document.getElementById('conversation-area');
  if (area) area.scrollTop = area.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function handleInputKey(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendPrompt();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

function useExample(btn) {
  const input = document.getElementById('prompt-input');
  input.value = btn.textContent;
  autoResize(input);
  input.focus();
}

// ══════════════════════════════════════════════════════════════════════════════
//  LANDING PAGE TERMINAL ANIMATION
// ══════════════════════════════════════════════════════════════════════════════

function animateTerminalPreview() {
  const body = document.getElementById('terminal-preview-body');
  if (!body) return;

  const lines = body.querySelectorAll('.t-line');
  lines.forEach(l => { l.style.opacity = '0'; });
  const cursor = body.querySelector('.t-cursor');
  if (cursor) cursor.style.display = 'none';

  let i = 0;
  function showNext() {
    if (i < lines.length) {
      lines[i].style.opacity = '1';
      lines[i].style.transition = 'opacity 0.1s';
      i++;
      const delay = i === 1 ? 300 : i < 4 ? 600 : i < 8 ? 400 : 800;
      setTimeout(showNext, delay);
    } else {
      if (cursor) cursor.style.display = 'inline-block';
    }
  }

  setTimeout(showNext, 800);
}

// ══════════════════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  initCanvas();
  animateTerminalPreview();
});
