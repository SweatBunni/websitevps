# VPS Setup

This project now supports running on a normal Linux VPS without Vercel.

## Requirements

- Ubuntu 22.04 or 24.04
- Node.js 22+
- Java is optional to preinstall
  - The build backend will auto-download the required JDK for each mod target on Linux.

## Install

```bash
sudo apt update
sudo apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

## Deploy

```bash
git clone <your-repo-url> /srv/codexmc
cd /srv/codexmc
npm install
cp .env.example .env
```

Edit `.env` and set at least:

```env
MISTRAL_API_KEY=your_real_key
PORT=3000
HOST=0.0.0.0
BUILD_STORE_MODE=filesystem
BUILD_STORE_DIR=.data/build-jobs
ENABLE_VERCEL_JAR_BUILD=false
```

## Run

```bash
npm start
```

## Reverse Proxy

Point nginx at `127.0.0.1:3000`.

Example:

```nginx
server {
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Notes

- Build job state is stored on local disk in `.data/build-jobs` by default.
- On Linux, missing Java runtimes are downloaded automatically and cached when a build needs them.
- The frontend UI is unchanged; the VPS server serves the same site and the same `/api/*` routes.
