import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PWA_ASSET_PREFIX = '__pwa';
const SAFE_ROUTE = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)$/;
const SAFE_ICON_FILE = /^[A-Za-z0-9._-]+\.png$/;

function routeBase(routePath) {
  return `${routePath.replace(/\/$/, '')}/`;
}

function readIcon(iconRoot, fileName) {
  if (!SAFE_ICON_FILE.test(fileName)) throw new Error(`invalid PWA icon file: ${fileName}`);
  const root = path.resolve(iconRoot);
  const resolved = path.resolve(root, fileName);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`PWA icon escaped icon root: ${fileName}`);
  const body = fs.readFileSync(resolved);
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  return { body, hash };
}

export function loadPwaCatalog(catalogPath, iconRoot) {
  const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (!parsed.apps || typeof parsed.apps !== 'object' || Array.isArray(parsed.apps)) {
    throw new Error('PWA catalog is missing apps');
  }
  const apps = Object.entries(parsed.apps).map(([routePath, value]) => {
    if (!SAFE_ROUTE.test(routePath) || routePath === '/') throw new Error(`invalid PWA route: ${routePath}`);
    if (!value || typeof value !== 'object') throw new Error(`invalid PWA metadata: ${routePath}`);
    const name = String(value.name || '').trim();
    if (!name) throw new Error(`PWA name is missing: ${routePath}`);
    const shortName = String(value.shortName || name).trim().slice(0, 30);
    const icon192 = readIcon(iconRoot, value.icon192);
    const icon512 = readIcon(iconRoot, value.icon512);
    return {
      path: routePath.replace(/\/$/, ''),
      name,
      shortName,
      description: String(value.description || `${name} on Wizard001 Apps`).trim(),
      themeColor: String(value.themeColor || '#0b0d12'),
      backgroundColor: String(value.backgroundColor || '#0b0d12'),
      icon192,
      icon512,
    };
  });
  apps.sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
  return { version: parsed.version || 1, generatedAt: parsed.generatedAt || null, apps };
}

export function pwaAppForPath(catalog, pathname) {
  for (const app of catalog.apps) {
    if (pathname === app.path || pathname.startsWith(`${app.path}/`)) return app;
  }
  return null;
}

function manifestFor(app) {
  const base = routeBase(app.path);
  return {
    id: base,
    name: app.name,
    short_name: app.shortName,
    description: app.description,
    start_url: base,
    scope: base,
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone', 'minimal-ui'],
    background_color: app.backgroundColor,
    theme_color: app.themeColor,
    prefer_related_applications: false,
    icons: [
      {
        src: `${base}${PWA_ASSET_PREFIX}/icon-192.png?v=${app.icon192.hash}`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable',
      },
      {
        src: `${base}${PWA_ASSET_PREFIX}/icon-512.png?v=${app.icon512.hash}`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  };
}

function installScriptFor(app) {
  const base = routeBase(app.path);
  const scopeJson = JSON.stringify(base);
  const workerJson = JSON.stringify(`${base}${PWA_ASSET_PREFIX}/service-worker.js`);
  return `(() => {
  const scope = ${scopeJson};
  const worker = ${workerJson};
  async function ensureScopedWorker() {
    if (!('serviceWorker' in navigator)) return;
    const expectedScope = new URL(scope, location.origin).href;
    try {
      const existing = await navigator.serviceWorker.getRegistration(scope);
      if (existing && existing.scope === expectedScope) return;
      await navigator.serviceWorker.register(worker, { scope });
    } catch (error) {
      console.warn('PWA worker registration failed', error);
    }
  }
  const schedule = () => setTimeout(ensureScopedWorker, 750);
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
})();
`;
}

function workerScriptFor(app) {
  const base = routeBase(app.path);
  return `// Wizard001 scoped PWA worker: ${base}\nself.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));\nself.addEventListener('fetch', (event) => {\n  const url = new URL(event.request.url);\n  if (event.request.method === 'GET' && url.origin === self.location.origin) {\n    event.respondWith(fetch(event.request));\n  }\n});\n`;
}

function responsePayload(status, contentType, body, extraHeaders = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    status,
    headers: {
      'content-type': contentType,
      'content-length': buffer.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
    body: buffer,
  };
}

export function pwaAssetResponse(catalog, pathname) {
  const app = pwaAppForPath(catalog, pathname);
  if (!app) return null;
  const prefix = `${routeBase(app.path)}${PWA_ASSET_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const asset = pathname.slice(prefix.length);
  if (asset === 'manifest.webmanifest') {
    return responsePayload(200, 'application/manifest+json; charset=utf-8', `${JSON.stringify(manifestFor(app), null, 2)}\n`);
  }
  if (asset === 'install.js') {
    return responsePayload(200, 'text/javascript; charset=utf-8', installScriptFor(app));
  }
  if (asset === 'service-worker.js') {
    return responsePayload(200, 'text/javascript; charset=utf-8', workerScriptFor(app), {
      'service-worker-allowed': routeBase(app.path),
    });
  }
  if (asset === 'icon-192.png') {
    return responsePayload(200, 'image/png', app.icon192.body, { 'cache-control': 'public, max-age=31536000, immutable' });
  }
  if (asset === 'icon-512.png') {
    return responsePayload(200, 'image/png', app.icon512.body, { 'cache-control': 'public, max-age=31536000, immutable' });
  }
  return responsePayload(404, 'text/plain; charset=utf-8', 'PWA asset not found\n');
}

function isManifestLink(tag) {
  const match = tag.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const value = (match?.[1] || match?.[2] || match?.[3] || '').toLowerCase();
  return value.split(/\s+/).includes('manifest');
}

function isViewportMeta(tag) {
  const match = tag.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return (match?.[1] || match?.[2] || match?.[3] || '').toLowerCase() === 'viewport';
}

function containedViewportTag(tag) {
  const content = tag.match(/\bcontent\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const source = content ? (content[2] || content[3] || content[4] || '') : '';
  const tokens = source
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !/^viewport-fit\s*=/i.test(token));
  if (!tokens.some((token) => /^width\s*=/i.test(token))) tokens.unshift('width=device-width');
  if (!tokens.some((token) => /^initial-scale\s*=/i.test(token))) tokens.push('initial-scale=1');
  const value = tokens.join(',');
  if (content) return tag.replace(content[0], `content="${value}"`);
  return tag.replace(/\s*\/?>(\s*)$/, ` content="${value}">$1`);
}

export function injectPwaShell(html, app) {
  const base = routeBase(app.path);
  let hasViewport = false;
  let output = html
    .replace(/<link\b[^>]*>/gi, (tag) => (isManifestLink(tag) ? '' : tag))
    .replace(/<meta\b[^>]*>/gi, (tag) => {
      if (!isViewportMeta(tag)) return tag;
      hasViewport = true;
      return containedViewportTag(tag);
    })
    .replace(/<script\b[^>]*\bdata-cloudflare-pwa=(?:"[^"]*"|'[^']*')[^>]*><\/script>/gi, '');
  const tags = [
    ...(hasViewport ? [] : ['<meta name="viewport" content="width=device-width,initial-scale=1">']),
    `<link data-cloudflare-pwa="manifest" rel="manifest" href="${base}${PWA_ASSET_PREFIX}/manifest.webmanifest" crossorigin="use-credentials">`,
    `<script data-cloudflare-pwa="installer" defer src="${base}${PWA_ASSET_PREFIX}/install.js"></script>`,
  ].join('\n  ');
  if (/<\/head\s*>/i.test(output)) return output.replace(/<\/head\s*>/i, `  ${tags}\n</head>`);
  return `${tags}\n${output}`;
}
