# Tailnet Apps Manager

Clean mobile-first dashboard for local Tailnet apps.

## Routes

- `/apps`
- `/apps/api/health`
- `/apps/api/status`
- `/apps/api/action`

## Features

- Responsive card grid (mobile-friendly)
- Per-app icon + status pills
- Open / Restart / Update actions
- Installed version visibility (date + short commit)
- Latest release visibility (from `https://humanitylabs.org/releases/apps.json`)
- Update-available signals when local is behind git upstream or release date
- PWA manifest + install icons

## Run

```bash
node server.mjs
```

Defaults:
- host: `127.0.0.1`
- port: `8786`
- base path: `/apps`

Override with env vars:
- `APPS_HOST`
- `APPS_PORT`
- `TAILNET_BASE_URL`
- `TAILNET_REPO_ROOT` / `AGENT_WORKSPACE` / `HERMES_WORKSPACE` / `OPENCLAW_WORKSPACE` for the parent folder that contains local app repos. Defaults to the parent of this repo.
- Per-app repo overrides such as `BOOKCOMPRESSOR_REPO_PATH`, `MINDFEED_REPO_PATH`, `CLAWTABS_REPO_PATH`, `BROWSER_REPO_PATH`, and `TERMINAL_REPO_PATH`.
- `APPS_RELEASES_URL` (default: `https://humanitylabs.org/releases/apps.json`)
- `APPS_RELEASES_CACHE_MS` (default: `600000`)
