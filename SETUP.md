# CodexMC — VPS Setup Guide

## Requirements

- Node.js 20+ (`node --version`)
- Java 17+ for Gradle builds (`java -version`)
- A reverse proxy (nginx recommended)
- An [OpenRouter](https://openrouter.ai) API key

---

## 1. Upload & Install

```bash
# Upload codexmc_vps to your server, then:
cd codexmc_vps

# Install the one real dependency (tar, used for Gradle builds)
npm install
```

---

## 2. Configure Environment

```bash
cp .env.example .env
nano .env
```

Minimum required:
```
OPENROUTER_API_KEY=sk-or-...
```

Full options:
```
OPENROUTER_API_KEY=sk-or-...          # required
OPENROUTER_MODEL=qwen/qwen-2.5-coder-32b-instruct:free
OPENROUTER_HTTP_REFERER=https://your-domain.com
OPENROUTER_APP_TITLE=CodexMC
PORT=3000
HOST=0.0.0.0
BUILD_STORE_DIR=.data/build-jobs      # where job files are stored
```

---

## 3. Run with PM2 (recommended)

```bash
npm install -g pm2

# Start
pm2 start server.mjs --name codexmc

# Auto-restart on reboot
pm2 save
pm2 startup

# Useful commands
pm2 logs codexmc       # live logs
pm2 status             # process status
pm2 restart codexmc    # restart after config change
pm2 stop codexmc       # stop
```

---

## 4. Nginx Reverse Proxy

Create `/etc/nginx/sites-available/codexmc`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Redirect HTTP → HTTPS (remove this block if not using SSL)
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    # SSL — use certbot to generate:
    # sudo certbot --nginx -d your-domain.com
    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # Increase timeout for Gradle builds (can take 2–5 min)
    proxy_read_timeout    300s;
    proxy_connect_timeout 60s;
    proxy_send_timeout    300s;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;

        # Increase body size limit for large mod payloads
        client_max_body_size 10M;
    }
}
```

Enable it:
```bash
sudo ln -s /etc/nginx/sites-available/codexmc /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 5. SSL with Let's Encrypt

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Certbot auto-renews every 90 days.

---

## File Structure

```
codexmc_vps/
├── server.mjs              ← main entry point
├── package.json
├── .env.example
├── SETUP.md
├── public/
│   ├── index.html          ← landing page
│   ├── app.html            ← the coding app (served at /app)
│   └── app-build.js        ← build helper script
└── src/
    ├── routes/             ← HTTP route handlers
    │   ├── chat.mjs              POST /api/chat
    │   ├── research.mjs          GET  /api/research
    │   ├── build-mod.mjs         POST /api/build-mod
    │   ├── build-mod-worker.mjs  POST /api/build-mod-worker
    │   ├── build-mod-status.mjs  GET  /api/build-mod-status
    │   └── build-mod-result.mjs  GET  /api/build-mod-result
    └── lib/                ← shared logic
        ├── store.mjs             filesystem job store (replaces Vercel Blob)
        ├── http-utils.mjs        response/request helpers
        ├── runtime-utils.mjs     background task runner
        ├── chat-service.mjs      OpenRouter integration
        ├── research-metadata.mjs version/build metadata fetching
        ├── research-sources.mjs  fallback version data
        ├── build-common.mjs      Gradle build orchestration
        ├── build-job-runner.mjs  job lifecycle management
        ├── build-normalization.mjs  file normalization
        ├── build-file-utils.mjs  file utilities
        ├── build-contract.mjs    required file validation
        ├── sanitize-files.mjs    input sanitization
        ├── site-memory.mjs       chat memory persistence
        └── texture-generation.mjs  AI texture generation
```

---

## Data Storage

All build job data is stored on the local filesystem at `.data/build-jobs/`
(or the path set in `BUILD_STORE_DIR`).

Each job gets a UUID directory:
```
.data/build-jobs/
└── <job-uuid>/
    ├── input.json          ← original build request
    ├── files.json          ← generated source files
    ├── build.log           ← full Gradle output
    ├── artifact.jar        ← built JAR (if successful)
    └── status/
        ├── latest.json     ← current status (fast read)
        └── *.json          ← status history entries
```

To clean up old jobs:
```bash
# Delete jobs older than 7 days
find .data/build-jobs -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +
```

---

## Troubleshooting

**App page not loading (`/app` shows landing page)**
- Make sure you're running the new `server.mjs` from this package, not the old one.

**Version dropdown empty**
- Check `OPENROUTER_API_KEY` is set — the research endpoint needs network access.
- Check server logs: `pm2 logs codexmc`

**Gradle build fails immediately**
- Ensure Java 17+ is installed: `java -version`
- Gradle downloads itself on first run — needs internet access from the VPS.

**`OPENROUTER_API_KEY` missing error**
- Make sure `.env` exists (not just `.env.example`) and the key is filled in.
- Restart after changing: `pm2 restart codexmc`
