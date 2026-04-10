/**
 * CodexMC Server
 * Express + WebSocket server for real-time mod generation
 */

require('dotenv').config();

const express = require('express');
const expressWs = require('express-ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');

const { getForgeVersions, getFabricVersions, getNeoForgeVersions } = require('./services/versions');
const { generateMod } = require('./services/generator');

const app = express();
expressWs(app);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── WebSocket sessions ────────────────────────────────────────────────────────
const activeSessions = new Map();

app.ws('/ws/:sessionId', (ws, req) => {
  const { sessionId } = req.params;
  activeSessions.set(sessionId, ws);
  console.log(`[WS] Session connected: ${sessionId}`);

  ws.on('close', () => {
    activeSessions.delete(sessionId);
    console.log(`[WS] Session disconnected: ${sessionId}`);
  });

  ws.send(JSON.stringify({
    type: 'connected',
    message: '🟢 Connected to CodexMC server'
  }));
});

function sendToSession(sessionId, data) {
  const ws = activeSessions.get(sessionId);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

// ── API Routes ────────────────────────────────────────────────────────────────

// Get versions for a loader
app.get('/api/versions/:loader', async (req, res) => {
  try {
    const { loader } = req.params;
    let versions;
    switch (loader.toLowerCase()) {
      case 'forge':    versions = await getForgeVersions(); break;
      case 'fabric':   versions = await getFabricVersions(); break;
      case 'neoforge': versions = await getNeoForgeVersions(); break;
      default: return res.status(400).json({ error: 'Unknown loader' });
    }
    res.json({ loader, versions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate a mod
app.post('/api/generate', async (req, res) => {
  const { prompt, loader, mcVersion, loaderVersion, sessionId } = req.body;

  if (!prompt || !loader || !mcVersion || !loaderVersion) {
    return res.status(400).json({ error: 'Missing required fields: prompt, loader, mcVersion, loaderVersion' });
  }

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required for live console' });
  }

  // Respond immediately so the client knows generation started
  res.json({ status: 'generating', message: 'Mod generation started. Watch the live console.' });

  // Run generation async, streaming progress via WebSocket
  generateMod(
    { prompt, loader, mcVersion, loaderVersion, sessionId },
    (event) => {
      sendToSession(sessionId, event);
    }
  ).then(result => {
    sendToSession(sessionId, {
      type: 'done',
      ...result
    });
  }).catch(err => {
    sendToSession(sessionId, {
      type: 'error',
      message: err.message
    });
  });
});

// Download generated ZIP
app.get('/api/download/:zipName', async (req, res) => {
  const { zipName } = req.params;
  
  // Basic security: only alphanumeric, dashes, dots, underscores
  if (!/^[\w\-\.]+\.zip$/.test(zipName)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const zipPath = path.join('/var/codexmc-output', zipName);
  
  if (!await fs.pathExists(zipPath)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }

  res.download(zipPath, zipName);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: activeSessions.size,
    node: process.version,
    uptime: Math.floor(process.uptime())
  });
});

// Serve frontend for all other routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log('\n╔═══════════════════════════════════╗');
  console.log('║        CodexMC Server             ║');
  console.log('╚═══════════════════════════════════╝');
  console.log(`\n  🌐 Running at http://${HOST}:${PORT}`);
  console.log(`  📡 WebSocket: ws://${HOST}:${PORT}/ws/:sessionId`);
  console.log(`  🔑 API Key: ${process.env.ANTHROPIC_API_KEY ? '✅ Set' : '❌ NOT SET'}`);
  console.log(`  🗂️  Workspace: ${process.env.WORKSPACE_DIR || '/tmp/codexmc-workspaces'}`);
  console.log('\n  Ready to generate Minecraft mods!\n');
});

module.exports = app;
