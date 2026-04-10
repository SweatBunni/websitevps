# CodexMC 🎮

> AI-powered Minecraft mod generator. Describe your mod, pick your loader & version, and get back a fully compilable Gradle project with the JAR built.

## Features

- **3 Mod Loaders** — Forge, Fabric, NeoForge
- **50+ MC Versions** — Dynamically fetched from official APIs
- **Live Console** — WebSocket streaming shows every step of AI generation and Gradle build
- **Compiled JARs** — Server builds the project with the correct JDK (8/17/21)
- **Full Project** — `build.gradle`, `gradlew`, `gradlew.bat`, all wrapper files included
- **ChatGPT-style UI** — Sidebar history, new mod button, clean dark theme
- **Claude claude-sonnet-4-20250514** — Best-in-class AI for code generation

## Quick Start (VPS)

### 1. Clone & Install

```bash
git clone https://github.com/youruser/codexmc.git
cd codexmc
npm run setup
```

The setup script will:
- Install OpenJDK 8, 17, 21 via apt
- Attempt JDK 25 early access download
- Create workspace directories
- Install npm dependencies
- Generate `.env` file

### 2. Configure

```bash
nano .env
```

Set your Anthropic API key:
```
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Start

```bash
npm start
```

Visit `http://your-server:3000`

### Production (PM2)

```bash
npm install -g pm2
pm2 start src/server.js --name codexmc
pm2 save
pm2 startup
```

### Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name codexmc.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }
}
```

## Architecture

```
codexmc/
├── src/
│   └── server.js          # Express + WebSocket server
├── services/
│   ├── generator.js        # Claude API + Gradle build runner
│   └── versions.js         # Forge/Fabric/NeoForge version fetcher
├── public/
│   ├── index.html          # Full SPA (landing + app)
│   ├── style.css           # Dark gaming aesthetic
│   └── app.js              # Frontend logic
├── scripts/
│   └── setup.js            # VPS setup script
├── package.json
└── .env.example
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/versions/:loader` | Get MC versions for loader |
| POST | `/api/generate` | Start mod generation (async) |
| GET | `/api/download/:zipName` | Download generated ZIP |
| GET | `/api/health` | Server health check |
| WS | `/ws/:sessionId` | Live console stream |

## Supported Loaders

### Forge
- MC 1.7.10 → 1.21.x
- JDK 8 (1.7–1.16), JDK 17 (1.17–1.20), JDK 21 (1.21+)
- ForgeGradle 5/6

### Fabric
- MC 1.14 → 1.21.x
- JDK 17/21
- Loom 1.x, Yarn mappings, Fabric API

### NeoForge
- MC 1.20.2 → 1.21.x
- JDK 21
- NeoGradle / ModDevGradle

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | **Required.** Your Anthropic API key |
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `WORKSPACE_DIR` | `/tmp/codexmc-workspaces` | Temp build directory |
| `MAX_CONCURRENT_BUILDS` | `3` | Parallel build limit |
| `BUILD_TIMEOUT_MS` | `300000` | 5 min build timeout |
| `JDK_8_PATH` | auto | Path to JDK 8 home |
| `JDK_17_PATH` | auto | Path to JDK 17 home |
| `JDK_21_PATH` | auto | Path to JDK 21 home |

## License

MIT
