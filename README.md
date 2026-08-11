# Tailnet Apps Manager

A mobile-first launcher and operations dashboard for apps exposed with [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve).

Apps Manager discovers the live Serve configuration instead of requiring a central app registry. It enriches each route with manifest, service, health, repository, and release metadata when those signals are available.

## Features

- Discovers one app card per active Tailscale Serve route.
- Reads each app's web manifest for its name, canonical route, and icon.
- Infers linked systemd services and local Git repositories for display; inferred targets remain read-only.
- Shows health, local changes, and upstream version state.
- Distinguishes local-only apps from remote-linked apps.
- Restarts services and applies safe tracked-branch updates only for explicitly configured service/repository mappings.
- Offers Update all for clean, non-diverged repositories that are behind upstream.
- Rejects overlapping server actions, prevents duplicate browser submissions, and shows persistent success or failure feedback.
- Installs as a PWA on desktop and mobile.

## Requirements

- Node.js 20 or newer.
- Tailscale with at least one active Serve handler.
- `systemctl` for service controls and `git` for repository controls. Missing integrations degrade gracefully.

The server uses only Node.js standard-library modules; there is no package-install step.

## Run

```bash
export TAILNET_BASE_URL="https://device.tailnet.example:8443"
node server.mjs
```

Defaults:

- host: `127.0.0.1`
- port: `8786`
- base path: `/apps`

Expose it to the Tailnet:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8786
```

Then open the URL configured in `TAILNET_BASE_URL` with `/apps/` appended.

## Discovery

Apps Manager reads `tailscale serve status --json` and creates cards only for routes currently served on the device. It then attempts to:

1. read the proxied app's web manifest;
2. identify a listening systemd service;
3. inspect the service unit for its working directory;
4. match release metadata or Git remotes to repositories under `~/apps` and `~/workspace`.

No local repository or tracked remote is required. Inferred service/repository links provide status only. Restart and autostart require an explicit `service` hint; updates additionally require an explicit `repoPath` hint.

## Local configuration

Most apps need no configuration. Use a local file for aliases, non-standard service names, custom health checks, grouping, or build steps:

```bash
cp apps.config.example.json apps.local.json
```

`apps.local.json` is ignored by Git. Set `APPS_CONFIG=/absolute/path/to/config.json` to load a different file.

Supported top-level keys:

- `apps`: route-keyed metadata hints.
- `hiddenPaths`: exact Serve routes that should not become cards.
- `hiddenPrefixes`: route families such as download or QA endpoints.
- `developmentPaths`: routes assigned to the development group.
- `groups`: optional label and description overrides.

Per-app hints support `id`, `name`, `service`, `proxyService`, `repoPath`, `healthUrl`, `icon`, `trailingSlash`, `group`, `hidden`, and `postUpdate`. Route-path keys are convenient when a path is unique. When several Serve origins use the same path—commonly `/` on dedicated ports—use an absolute HTTPS route key so hints and action authority cannot collide. Ambiguous path-only hints are ignored. `postUpdate` is an executable plus arguments, never a shell string:

```json
{
  "apps": {
    "/example-app": {
      "service": "example-app.service",
      "repoPath": "~/apps/example-app",
      "postUpdate": ["npm", "run", "build"]
    },
    "https://device.tailnet.example:6080/": {
      "id": "browser",
      "name": "Browser",
      "proxyService": "remote-browser.service"
    }
  }
}
```

`APPS_SERVICE_NAME` and the Apps Manager repository root are canonical for `/apps`; conflicting `/apps` hints fail startup. Bundled `assets/app-<route-id>.png` files are optional dynamic icon fallbacks when an app manifest has no usable same-origin icon.

## Environment

- `APPS_HOST`
- `APPS_PORT`
- `APPS_CONFIG`
- `APPS_SERVICE_NAME`
- `TAILNET_BASE_URL`
- `APPS_TAILSCALE_SOCKET` / `TS_SOCKET`
- `APPS_INCLUDE_ROOT=1` to include the root `/` Serve handler
- `APPS_REPO_ROOTS` as comma-separated repository search roots
- `APPS_RELEASES_URL` (default: `https://humanitylabs.org/releases/apps.json`)
- `APPS_RELEASES_CACHE_MS` (default: `600000`)
- `APPS_MANIFEST_MAX_BYTES` (default: `262144`)
- `APPS_RELEASES_MAX_BYTES` (default: `1048576`)
- `APPS_GIT_CACHE_MS` (default: `180000`)
- `APPS_SYSTEMCTL_SCOPE` (`auto`, `user`, or `system`; default: `auto`)

## Safety model

The server binds to loopback by default and is intended to sit behind a dedicated Tailscale Serve HTTPS port. `TAILNET_BASE_URL` must be an origin-only HTTPS URL with an explicit nondefault port; this keeps destructive controls isolated from sibling apps on the device's default Tailnet origin. Browser write requests are accepted only from configured local/control origins. Actions are limited to explicitly mapped apps discovered in the current Serve configuration, updates require a clean tracked branch proven behind its fetched upstream and a verified `HEAD` change, overlapping actions receive `409`, request bodies are capped at 64 KiB, manifests at 256 KiB, and release catalogs at 1 MiB. Command output is credential-redacted before it reaches the browser.

A self-restart response means the restart was scheduled and its outcome is pending. In `auto` systemctl scope, a delayed self-restart falls back from user to system scope only when the user unit is missing; permission and runtime failures remain failures at user scope.

Origin validation is browser cross-site request protection, not client authentication. Restrict the dedicated control port to intended operators with Tailscale ACLs/grants; sibling apps on other origins cannot inherit that browser authority, while originless API clients inherit the Tailnet and host-access boundary.

Run the clean-environment smoke test with:

```bash
./qa/smoke.sh
```

## Routes

- `/` and `/apps/` — dashboard
- `/apps/api/health` — lightweight health check
- `/apps/api/status` — discovered apps and operational state
- `/apps/api/action` — restart, update, update-all, and autostart actions
