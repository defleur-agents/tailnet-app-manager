#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOST = process.env.APPS_HOST || '127.0.0.1';
const PORT = Number(process.env.APPS_PORT || 8786);
const BASE = '/apps';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(ROOT, 'index.html');
const HOME = process.env.HOME || os.homedir();
const TAILNET_BASE_ENV = process.env.TAILNET_BASE_URL || null;
const GIT_CACHE_TTL_MS = Number(process.env.APPS_GIT_CACHE_MS || 180000);
const RELEASES_URL = process.env.APPS_RELEASES_URL || 'https://humanitylabs.org/releases/apps.json';
const RELEASES_CACHE_TTL_MS = Number(process.env.APPS_RELEASES_CACHE_MS || 600000);
const MANIFEST_MAX_BYTES = Number(process.env.APPS_MANIFEST_MAX_BYTES || 262144);
const RELEASES_MAX_BYTES = Number(process.env.APPS_RELEASES_MAX_BYTES || 1048576);
const INCLUDE_ROOT_APP = String(process.env.APPS_INCLUDE_ROOT || '').toLowerCase() === '1';
const SELF_SERVICE = process.env.APPS_SERVICE_NAME || 'apps-manager.service';
if (!/^[A-Za-z0-9_.@:-]+\.service$/.test(SELF_SERVICE)) {
  throw new Error('APPS_SERVICE_NAME must be a valid systemd .service unit name.');
}
const PROC_ROOT = process.env.APPS_PROC_ROOT || '/proc';
const REPO_ROOTS = String(process.env.APPS_REPO_ROOTS || `${HOME}/apps,${HOME}/workspace`)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const CONFIG_PATH = path.resolve(ROOT, expandHome(process.env.APPS_CONFIG || 'apps.local.json'));

async function loadLocalConfig() {
  try {
    const parsed = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config root must be a JSON object');
    }
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT' && !process.env.APPS_CONFIG) return {};
    throw new Error(`Unable to load Apps Manager config: ${err?.message || err}`);
  }
}

function normalizePrefix(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return `/${raw.replace(/^\/+/, '').replace(/\/+$/, '')}/`;
}

function normalizeAppHint(hint) {
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return {};
  const rawRepoPath = String(hint.repoPath || '').trim();
  const repoPath = rawRepoPath ? path.resolve(ROOT, expandHome(rawRepoPath)) : null;
  const postUpdate = Array.isArray(hint.postUpdate)
    ? hint.postUpdate.map(value => String(value || '').trim()).filter(Boolean)
    : null;
  return { ...hint, repoPath, postUpdate };
}

const LOCAL_CONFIG = await loadLocalConfig();
const HIDDEN_SERVE_PATHS = new Set(
  (Array.isArray(LOCAL_CONFIG.hiddenPaths) ? LOCAL_CONFIG.hiddenPaths : [])
    .map(normalizeRoutePath),
);
const HIDDEN_SERVE_PREFIXES = [...new Set([
  '/qa/',
  '/downloads/',
  ...(Array.isArray(LOCAL_CONFIG.hiddenPrefixes) ? LOCAL_CONFIG.hiddenPrefixes : []),
].map(normalizePrefix).filter(Boolean))];
const DEVELOPMENT_SERVE_PATHS = new Set(
  (Array.isArray(LOCAL_CONFIG.developmentPaths) ? LOCAL_CONFIG.developmentPaths : [])
    .map(normalizeRoutePath),
);

function servePathHidden(publicPath) {
  return HIDDEN_SERVE_PATHS.has(publicPath)
    || HIDDEN_SERVE_PREFIXES.some(prefix => publicPath.startsWith(prefix));
}

function appGroupForPath(publicPath) {
  if (DEVELOPMENT_SERVE_PATHS.has(publicPath)) return 'development';
  return 'installed';
}

const GROUPS = {
  installed: {
    id: 'installed',
    label: 'Apps',
    description: 'Installed apps exposed through Tailscale Serve.',
  },
  development: {
    id: 'development',
    label: 'In Development',
    description: 'Apps marked as development in local configuration.',
  },
  ...(LOCAL_CONFIG.groups && typeof LOCAL_CONFIG.groups === 'object' ? LOCAL_CONFIG.groups : {}),
};

const configuredAppHints = Object.fromEntries(
  Object.entries(LOCAL_CONFIG.apps && typeof LOCAL_CONFIG.apps === 'object' ? LOCAL_CONFIG.apps : {})
    .map(([publicPath, hint]) => [normalizeRoutePath(publicPath), normalizeAppHint(hint)]),
);
const APP_HINTS = { ...configuredAppHints };
const configuredSelfHint = configuredAppHints[BASE] || {};
if (configuredSelfHint.service && configuredSelfHint.service !== SELF_SERVICE) {
  throw new Error(`The ${BASE} config service must match APPS_SERVICE_NAME (${SELF_SERVICE}).`);
}
if (configuredSelfHint.repoPath && path.resolve(configuredSelfHint.repoPath) !== ROOT) {
  throw new Error(`The ${BASE} config repoPath must match the Apps Manager root (${ROOT}).`);
}
APP_HINTS[BASE] = {
  ...configuredSelfHint,
  id: 'appsmanager',
  name: 'Apps Manager',
  service: SELF_SERVICE,
  repoPath: ROOT,
  healthUrl: `http://${HOST}:${PORT}${BASE}/api/health`,
  icon: `${BASE}/assets/app-appsmanager.png`,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

const STATIC_ROUTES = {
  [`${BASE}/manifest.webmanifest`]: path.join(ROOT, 'manifest.webmanifest'),
  [`${BASE}/icon-192.png`]: path.join(ROOT, 'icon-192.png'),
  [`${BASE}/icon-512.png`]: path.join(ROOT, 'icon-512.png'),
  [`${BASE}/apple-touch-icon.png`]: path.join(ROOT, 'apple-touch-icon.png'),
};

const gitStateCache = new Map();
const repoRemoteCache = new Map();
let releaseCatalogCache = { at: 0, data: null };
let localRepoIndexCache = { at: 0, repos: null };
let actionInFlight = false;

function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...headers,
  });
  res.end(body);
}

function configuredTailnetOrigin() {
  if (!TAILNET_BASE_ENV) return null;
  let url;
  try {
    url = new URL(TAILNET_BASE_ENV);
  } catch {
    throw new Error('TAILNET_BASE_URL must be a valid HTTPS URL.');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.origin === 'null'
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('TAILNET_BASE_URL must be a credential-free, origin-only HTTPS URL.');
  }
  if (!url.port || url.port === '443') {
    throw new Error('TAILNET_BASE_URL must use a dedicated nondefault HTTPS port so sibling Tailnet apps do not share the control origin.');
  }
  return url.origin;
}

const TAILNET_ORIGIN = configuredTailnetOrigin();

function allowedUnsafeOrigins() {
  const origins = new Set([
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
  ]);
  if (TAILNET_ORIGIN) origins.add(TAILNET_ORIGIN);
  return origins;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_UNSAFE_ORIGINS = allowedUnsafeOrigins();

function unsafeOriginAllowed(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (!UNSAFE_METHODS.has(method)) return true;

  const origin = req.headers.origin;
  if (origin) return ALLOWED_UNSAFE_ORIGINS.has(origin);

  const referer = req.headers.referer;
  if (referer) {
    try {
      return ALLOWED_UNSAFE_ORIGINS.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }

  // Preserve non-browser/local automation compatibility. Browser cross-site
  // unsafe requests include Origin, so hostile pages are rejected above.
  return true;
}

function resolveStaticPath(pathname) {
  if (STATIC_ROUTES[pathname]) return STATIC_ROUTES[pathname];
  if (!pathname.startsWith(`${BASE}/assets/`)) return null;
  const relative = pathname.slice(`${BASE}/assets/`.length);
  if (!relative || relative.includes('..') || path.isAbsolute(relative)) return null;
  return path.join(ROOT, 'assets', relative);
}

async function runExec(bin, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: opts.timeout ?? 20000,
      maxBuffer: opts.maxBuffer ?? 4_000_000,
      cwd: opts.cwd,
      env: opts.env,
    });
    return { ok: true, out: String(stdout || '').trim(), err: String(stderr || '').trim() };
  } catch (err) {
    return {
      ok: false,
      out: String(err?.stdout || '').trim(),
      err: String(err?.stderr || err?.message || '').trim(),
      code: err?.code,
    };
  }
}

function systemctlMissingUnit(res) {
  const text = `${res?.out || ''}\n${res?.err || ''}`;
  return /not found|could not be found|does not exist|No such file|Unit .* not loaded/i.test(text);
}

async function systemctl(args) {
  const scope = String(process.env.APPS_SYSTEMCTL_SCOPE || 'auto').toLowerCase();
  const runUser = () => runExec('systemctl', ['--user', ...args], { timeout: 15000, maxBuffer: 2_000_000 });
  const runSystem = () => runExec('systemctl', args, { timeout: 15000, maxBuffer: 2_000_000 });

  if (scope === 'user') return runUser();
  if (scope === 'system') return runSystem();

  const userRes = await runUser();
  if (userRes.ok || !systemctlMissingUnit(userRes)) return userRes;
  return runSystem();
}

async function git(repoPath, args, opts = {}) {
  return runExec('git', ['-C', repoPath, ...args], {
    timeout: opts.timeout ?? 30000,
    maxBuffer: opts.maxBuffer ?? 3_000_000,
  });
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function checkHealth(url) {
  if (!url) return { code: null, ok: false };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    return { code: res.status, ok: res.status >= 200 && res.status < 400 };
  } catch {
    return { code: null, ok: false };
  }
}

async function responseTextLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseAheadBehind(raw) {
  const [left, right] = String(raw || '').trim().split(/\s+/);
  const ahead = Number.parseInt(left ?? '0', 10);
  const behind = Number.parseInt(right ?? '0', 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

function normalizeReleaseDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const direct = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  if (direct) return direct;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeRoutePath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '/';
  return `/${raw.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function routeKey(value) {
  return normalizeRoutePath(value).replace(/^\//, '');
}

function routeId(value) {
  const key = routeKey(value);
  if (!key) return 'root';
  if (key === 'apps') return 'appsmanager';
  return key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'app';
}

function routeActionKey(publicPath) {
  return `p_${Buffer.from(normalizeRoutePath(publicPath), 'utf8').toString('base64url')}`;
}

function titleFromPath(value) {
  const key = routeKey(value);
  if (!key) return 'Tailnet Home';
  return key
    .split(/[\/-]+/)
    .filter(Boolean)
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

function ensureTrailingSlash(value) {
  const raw = String(value || '').trim();
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function absolutePublicPath(src, publicPath) {
  const raw = String(src || '').trim();
  if (!raw || raw.startsWith('data:') || raw.startsWith('//')) return null;
  try {
    const parsed = new URL(raw);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.pathname
      : null;
  } catch {}
  if (raw.startsWith('/')) return raw;
  const base = `${normalizeRoutePath(publicPath)}/`;
  return new URL(raw, `https://tailnet.local${base}`).pathname;
}

function manifestCanonicalPath(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  for (const field of ['id', 'scope', 'start_url']) {
    const raw = String(manifest[field] || '').trim();
    if (!raw || raw === './') continue;
    if (!raw.startsWith('/') && !raw.startsWith('http://') && !raw.startsWith('https://')) continue;
    try {
      const parsed = raw.startsWith('http://') || raw.startsWith('https://')
        ? new URL(raw)
        : new URL(raw, 'https://tailnet.local/');
      const route = normalizeRoutePath(parsed.pathname);
      if (route !== '/') return route;
    } catch {}
  }
  return null;
}

function manifestPrefersTrailingSlash(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  return ['id', 'scope', 'start_url'].some(field => {
    const raw = String(manifest[field] || '').trim();
    return raw === './' || raw.endsWith('/');
  });
}

function manifestIconPath(manifest, publicPath) {
  const icons = Array.isArray(manifest?.icons) ? manifest.icons : [];
  const scored = icons
    .filter(icon => icon && typeof icon === 'object' && icon.src)
    .map(icon => {
      const sizes = String(icon.sizes || '');
      const maxSize = Math.max(0, ...sizes.split(/\s+/).map(s => Number((s.match(/\d+/) || [0])[0])));
      const svgBonus = String(icon.type || '').includes('svg') || String(icon.src || '').endsWith('.svg') ? 10000 : 0;
      return { src: icon.src, score: svgBonus + maxSize };
    })
    .sort((a, b) => b.score - a.score);
  return absolutePublicPath(scored[0]?.src, publicPath);
}

function sameProxyTarget(a, b) {
  const normalize = value => String(value || '').trim().replace(/\/+$/, '');
  return normalize(a) && normalize(a) === normalize(b);
}

async function fetchAppManifest(proxyUrl, publicPath) {
  const candidates = [];
  const add = value => {
    const raw = String(value || '').trim();
    if (raw && !candidates.includes(raw)) candidates.push(raw);
  };

  try { add(new URL('manifest.webmanifest', ensureTrailingSlash(proxyUrl)).href); } catch {}
  try {
    const origin = new URL(proxyUrl).origin;
    add(`${origin}${normalizeRoutePath(publicPath)}/manifest.webmanifest`);
  } catch {}

  for (const url of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    try {
      const res = await fetch(url, { headers: { accept: 'application/manifest+json,application/json;q=0.9,*/*;q=0.5' }, signal: controller.signal });
      if (!res.ok) continue;
      const text = await responseTextLimited(res, MANIFEST_MAX_BYTES);
      const manifest = JSON.parse(text);
      if (manifest && typeof manifest === 'object') return { manifest, url };
    } catch {
      // Try the next canonical manifest location.
    } finally {
      clearTimeout(timer);
    }
  }
  return { manifest: null, url: null };
}

function releaseKeysFor(row, fallbackId) {
  const keys = new Set();
  const add = value => {
    const raw = String(value || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (raw) keys.add(raw);
  };

  add(row.id);
  add(row.path);
  add(fallbackId);

  // Compatibility with this app's historical release key.
  if (keys.has('apps')) keys.add('appsmanager');
  if (keys.has('appsmanager')) keys.add('apps');

  return [...keys];
}

function parseReleaseCatalog(payload) {
  const fallback = {
    source: RELEASES_URL,
    updatedAt: null,
    fetchedAt: new Date().toISOString(),
    appsById: {},
    error: null,
  };

  if (!payload || typeof payload !== 'object') return fallback;

  const appsRaw = Array.isArray(payload.apps)
    ? payload.apps
    : Object.entries(payload.apps || {}).map(([id, row]) => ({ id, ...(row || {}) }));

  const appsById = {};
  for (const row of appsRaw) {
    if (!row || typeof row !== 'object') continue;
    const rawId = String(row.id || '').trim();
    const rawPath = String(row.path || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
    const id = rawId || rawPath;
    if (!id) continue;
    const releaseDate = normalizeReleaseDate(row.releaseDate || row.date || row.latestDate);
    const version = String(row.version || row.tag || '').trim() || null;
    const commit = String(row.commit || row.sha || '').trim() || null;
    const info = {
      id,
      path: rawPath || null,
      name: String(row.name || '').trim() || id,
      releaseDate,
      version,
      commit,
      repo: String(row.repo || '').trim() || null,
      notes: String(row.notes || '').trim() || null,
    };
    for (const key of releaseKeysFor(row, id)) appsById[key] = info;
  }

  return {
    source: String(payload.source || RELEASES_URL),
    updatedAt: String(payload.updatedAt || '').trim() || null,
    fetchedAt: new Date().toISOString(),
    appsById,
    error: null,
  };
}

async function fetchReleaseCatalog({ force = false } = {}) {
  const now = Date.now();
  if (!force && releaseCatalogCache.data && (now - releaseCatalogCache.at) < RELEASES_CACHE_TTL_MS) {
    return releaseCatalogCache.data;
  }

  const fallback = {
    source: RELEASES_URL,
    updatedAt: null,
    fetchedAt: new Date().toISOString(),
    appsById: {},
    error: 'unavailable',
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(RELEASES_URL, {
        method: 'GET',
        headers: { 'accept': 'application/json' },
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = { ...fallback, error: `http_${res.status}` };
        releaseCatalogCache = { at: now, data };
        return data;
      }

      const text = await responseTextLimited(res, RELEASES_MAX_BYTES);
      const parsed = parseReleaseCatalog(JSON.parse(text));
      releaseCatalogCache = { at: now, data: parsed };
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const data = {
      ...fallback,
      error: String(err?.message || err || 'fetch_failed'),
    };
    releaseCatalogCache = { at: now, data };
    return data;
  }
}

function formatVersionLabel(date, sha) {
  const d = normalizeReleaseDate(date);
  const shortSha = String(sha || '').trim();
  if (d && shortSha) return `${d} · ${shortSha}`;
  if (d) return d;
  if (shortSha) return shortSha;
  return 'unknown';
}

function normalizeGitRemote(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const ssh = raw.match(/^git@([^:]+):(.+)$/i);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`.replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString().replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
    }
  } catch {}
  return raw.replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
}

function redactSensitiveText(value, maxLength = 4000) {
  const label = '(?:api[_-]?key|private[_-]?key|(?:github|gitlab|access|auth|api)[_-]?token|token|password|passwd|secret)';
  let text = String(value || '');
  text = text
    .replace(/\b(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\bgithub_pat_[a-zA-Z0-9_]{16,}\b/g, '[redacted-token]')
    .replace(/\bgh[pousr]_[a-zA-Z0-9_]{16,}\b/g, '[redacted-token]')
    .replace(/\b(glpat-[a-zA-Z0-9_-]{16,})\b/g, '[redacted-token]')
    .replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(new RegExp(`((?:"|')?${label}(?:"|')?\\s*[=:]\\s*)((?:"|'))([^\\r\\n]*?)\\2`, 'gi'), '$1$2[redacted]$2')
    .replace(new RegExp(`\\b(${label}\\s*[=:]\\s*)[^\\s,;}'\\"]+`, 'gi'), '$1[redacted]');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

async function gitRemote(repoPath) {
  if (!repoPath) return null;
  if (repoRemoteCache.has(repoPath)) return repoRemoteCache.get(repoPath);
  const res = await git(repoPath, ['remote', 'get-url', 'origin']);
  const remote = res.ok ? res.out : null;
  repoRemoteCache.set(repoPath, remote);
  return remote;
}

async function gitRootForPath(startPath) {
  if (!startPath || !(await exists(startPath))) return null;
  const stat = await fs.stat(startPath).catch(() => null);
  const cwd = stat?.isDirectory() ? startPath : path.dirname(startPath);
  const root = await git(cwd, ['rev-parse', '--show-toplevel'], { timeout: 5000 });
  return root.ok && root.out ? root.out : null;
}

async function indexLocalRepos() {
  const now = Date.now();
  if (localRepoIndexCache.repos && (now - localRepoIndexCache.at) < 300000) return localRepoIndexCache.repos;

  const repos = [];
  const seen = new Set();
  async function walk(dir, depth) {
    if (depth < 0 || seen.has(dir) || !(await exists(dir))) return;
    seen.add(dir);
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.name === '.git')) {
      const remote = await gitRemote(dir);
      repos.push({ path: dir, remote, normalizedRemote: normalizeGitRemote(remote) });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (['.git', 'node_modules', '.cache', 'venv', '.venv', '__pycache__'].includes(entry.name)) continue;
      await walk(path.join(dir, entry.name), depth - 1);
    }
  }

  for (const root of REPO_ROOTS) await walk(root, 4);
  localRepoIndexCache = { at: now, repos };
  return repos;
}

async function findRepoByRemote(remoteUrl) {
  const needle = normalizeGitRemote(remoteUrl);
  if (!needle) return null;
  const repos = await indexLocalRepos();
  return repos.find(repo => repo.normalizedRemote === needle)?.path || null;
}

function cacheGitState(appId, data) {
  gitStateCache.set(appId, { at: Date.now(), data });
  return data;
}

async function computeGitState(app, { force = false } = {}) {
  const cacheKey = app.actionKey || routeActionKey(app.path || app.id);
  const fallback = {
    tracked: false,
    canCheck: false,
    cleanKnown: false,
    fetchOk: false,
    countsKnown: false,
    dirty: null,
    ahead: 0,
    behind: 0,
    diverged: false,
    updateAvailable: false,
    status: 'n/a',
    branch: null,
    localSha: null,
    localCommitDate: null,
    remoteSha: null,
    remoteCommitDate: null,
    remoteUrl: null,
    upstream: null,
    checkedAt: new Date().toISOString(),
    reason: null,
    error: null,
  };

  const cached = gitStateCache.get(cacheKey);
  if (!force && cached && (Date.now() - cached.at) < GIT_CACHE_TTL_MS) return cached.data;

  if (!app.repoPath || !(await exists(app.repoPath))) {
    return cacheGitState(cacheKey, { ...fallback, reason: app.repoPath ? 'repo_missing' : 'no_repo_linked' });
  }

  const inside = await git(app.repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') {
    return cacheGitState(cacheKey, { ...fallback, reason: 'not_git_repo' });
  }

  const [dirtyRes, branchRes, localShaRes, localCommitDateRes, upstreamRes, remoteUrlRes] = await Promise.all([
    git(app.repoPath, ['status', '--porcelain']),
    git(app.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(app.repoPath, ['rev-parse', '--short=10', 'HEAD']),
    git(app.repoPath, ['show', '-s', '--date=short', '--format=%cd', 'HEAD']),
    git(app.repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    git(app.repoPath, ['remote', 'get-url', 'origin']),
  ]);

  const cleanKnown = dirtyRes.ok;
  const dirty = cleanKnown ? Boolean(dirtyRes.out) : null;
  const branch = branchRes.ok ? branchRes.out : null;
  const localSha = localShaRes.ok ? localShaRes.out : null;
  const localCommitDate = localCommitDateRes.ok ? normalizeReleaseDate(localCommitDateRes.out) : null;
  const upstream = upstreamRes.ok ? upstreamRes.out : null;
  const remoteUrl = remoteUrlRes.ok ? remoteUrlRes.out : null;

  let canCheck = false;
  let ahead = 0;
  let behind = 0;
  let remoteSha = null;
  let remoteCommitDate = null;
  let fetchError = null;
  let fetchOk = false;
  let countsKnown = false;
  let countsError = null;

  if (upstream) {
    const parts = upstream.split('/');
    const remoteName = parts.shift() || 'origin';
    const remoteBranch = parts.join('/');

    const fetchRes = remoteBranch
      ? await git(app.repoPath, ['fetch', '--quiet', remoteName, remoteBranch], { timeout: 60000 })
      : await git(app.repoPath, ['fetch', '--quiet', remoteName], { timeout: 60000 });

    fetchOk = fetchRes.ok;
    if (!fetchOk) fetchError = fetchRes.err || fetchRes.out || 'fetch_failed';

    const [remoteShaRes, countsRes, remoteCommitDateRes] = await Promise.all([
      git(app.repoPath, ['rev-parse', '--short=10', upstream]),
      git(app.repoPath, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]),
      git(app.repoPath, ['show', '-s', '--date=short', '--format=%cd', upstream]),
    ]);

    if (remoteShaRes.ok) remoteSha = remoteShaRes.out;
    if (remoteCommitDateRes.ok) remoteCommitDate = normalizeReleaseDate(remoteCommitDateRes.out);
    countsKnown = countsRes.ok;
    if (countsKnown) {
      const parsed = parseAheadBehind(countsRes.out);
      ahead = parsed.ahead;
      behind = parsed.behind;
    } else countsError = countsRes.err || countsRes.out || 'git_counts_failed';
  }

  canCheck = Boolean(upstream && cleanKnown && fetchOk && countsKnown);

  const diverged = ahead > 0 && behind > 0;
  const updateAvailable = canCheck && behind > 0 && ahead === 0;

  let status = 'unknown';
  if (!cleanKnown || (upstream && !canCheck)) status = 'unknown';
  else if (!canCheck) status = remoteUrl ? 'remote_untracked' : 'local_only';
  else if (dirty && behind === 0) status = 'local_changes';
  else if (diverged) status = 'diverged';
  else if (updateAvailable) status = 'update_available';
  else status = 'up_to_date';

  return cacheGitState(cacheKey, {
    tracked: true,
    canCheck,
    cleanKnown,
    fetchOk,
    countsKnown,
    dirty,
    ahead,
    behind,
    diverged,
    updateAvailable,
    status,
    branch,
    localSha,
    localCommitDate,
    remoteSha,
    remoteCommitDate,
    remoteUrl,
    upstream,
    checkedAt: new Date().toISOString(),
    reason: null,
    error: !cleanKnown
      ? (dirtyRes.err || dirtyRes.out || 'git_status_failed')
      : (fetchError || countsError),
  });
}

async function detectTailscaleSocket() {
  const candidates = [
    process.env.APPS_TAILSCALE_SOCKET,
    process.env.TS_SOCKET,
    `/run/user/${process.getuid?.() || 1000}/tailscale/tailscaled.sock`,
    '/var/run/tailscale/tailscaled.sock',
  ].filter(Boolean);
  for (const socket of candidates) {
    if (await exists(socket)) return socket;
  }
  return null;
}

async function tailscale(args, opts = {}) {
  const socket = await detectTailscaleSocket();
  const finalArgs = socket ? [`--socket=${socket}`, ...args] : args;
  const res = await runExec('tailscale', finalArgs, { timeout: opts.timeout ?? 20000, maxBuffer: opts.maxBuffer ?? 4_000_000 });
  return { ...res, socket };
}

function hostFromTailnetBase() {
  if (!TAILNET_BASE_ENV) return null;
  try { return new URL(TAILNET_BASE_ENV).hostname; } catch { return null; }
}

function appSortKey(app) {
  if (app.path === BASE) return `000-${app.path}`;
  return `100-${app.path}`;
}

function extractProxyUrl(handler) {
  if (!handler || typeof handler !== 'object') return null;
  return typeof handler.Proxy === 'string' ? handler.Proxy : null;
}

function portFromUrl(value) {
  try {
    const url = new URL(value);
    return url.port || (url.protocol === 'https:' ? '443' : '80');
  } catch {
    return null;
  }
}

async function findServiceByPort(port) {
  if (!port) return null;
  const ss = await runExec('ss', ['-ltnp'], { timeout: 5000, maxBuffer: 2_000_000 });
  if (!ss.ok) return null;
  const pids = new Set();
  for (const row of ss.out.split('\n')) {
    const parts = row.trim().split(/\s+/);
    if (parts[0] !== 'LISTEN') continue;
    const listeningPort = parts[3]?.match(/:(\d+)$/)?.[1] || null;
    if (listeningPort !== String(port)) continue;
    const pid = row.match(/pid=(\d+)/)?.[1];
    if (pid) pids.add(pid);
  }
  if (pids.size !== 1) return null;
  const [pid] = pids;
  try {
    const cgroup = await fs.readFile(path.join(PROC_ROOT, pid, 'cgroup'), 'utf8');
    const match = cgroup.match(/app\.slice\/([^/\n]+\.service)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function firstExistingService(candidates) {
  const existing = [];
  for (const service of candidates.filter(Boolean)) {
    const cat = await systemctl(['cat', service]);
    if (cat.ok) existing.push(service);
  }
  return existing.length === 1 ? existing[0] : null;
}

async function serviceForRoute(publicPath) {
  const id = routeId(publicPath);
  const candidates = [
    `${id}-subpath-proxy.service`,
    `${id}-slash-redirect.service`,
    `${id}-dashboard.service`,
    `${id}.service`,
  ];
  return firstExistingService(candidates);
}

function serviceCandidatesFromUnit(unitText) {
  const candidates = [];
  const re = /(?:After|Wants|Requires)=([^\n]+)/g;
  let match;
  while ((match = re.exec(unitText))) {
    for (const token of match[1].split(/\s+/)) {
      const service = token.trim();
      if (service.endsWith('.service') && !candidates.includes(service)) candidates.push(service);
    }
  }
  return candidates.filter(service => !/network|dbus|basic|default/i.test(service));
}

async function primaryServiceForProxy(proxyService) {
  if (!proxyService) return { service: null, ambiguous: false };
  if (!/(?:subpath-proxy|slash-redirect)\.service$/.test(proxyService)) {
    return { service: proxyService, ambiguous: false };
  }
  const cat = await systemctl(['cat', proxyService]);
  if (!cat.ok) return { service: proxyService, ambiguous: false };
  const candidates = serviceCandidatesFromUnit(cat.out).filter(service => service !== proxyService);
  if (candidates.length > 1) return { service: null, ambiguous: true };
  return { service: candidates[0] || proxyService, ambiguous: false };
}

function expandHome(value) {
  return String(value || '').replaceAll('%h', HOME).replace(/^~/, HOME);
}

function absoluteExecPathFromLine(line) {
  const cleaned = expandHome(line || '').replace(/^ExecStart=/, '').trim();
  const match = cleaned.match(/(?:^|\s)(\/[^\s]+)/);
  return match ? match[1] : null;
}

async function repoPathForService(service) {
  if (!service) return null;
  const cat = await systemctl(['cat', service]);
  if (!cat.ok) return null;
  const lines = cat.out.split('\n');
  const workingDir = lines.find(line => line.startsWith('WorkingDirectory='));
  if (workingDir) {
    const root = await gitRootForPath(expandHome(workingDir.slice('WorkingDirectory='.length)));
    if (root) return root;
  }
  for (const line of lines.filter(row => row.startsWith('ExecStart='))) {
    const execPath = absoluteExecPathFromLine(line);
    const root = execPath ? await gitRootForPath(execPath) : null;
    if (root) return root;
  }
  return null;
}

async function discoverServedApps(releaseCatalog) {
  const serve = await tailscale(['serve', 'status', '--json'], { timeout: 20000 });
  if (!serve.ok) {
    return {
      apps: [],
      serve: {
        ok: false,
        socket: serve.socket || null,
        error: serve.err || serve.out || 'tailscale serve status failed',
        host: hostFromTailnetBase(),
        baseUrl: TAILNET_ORIGIN,
        paths: [],
      },
    };
  }

  let payload = {};
  try { payload = JSON.parse(serve.out || '{}'); } catch {}
  const web = payload.Web || {};
  const preferredHost = hostFromTailnetBase();
  const host = preferredHost && web[preferredHost] ? preferredHost : Object.keys(web)[0];
  const handlers = host ? (web[host]?.Handlers || {}) : {};
  const tailnetBase = TAILNET_ORIGIN || (host ? `https://${host}` : '');

  const apps = [];
  for (const [rawPath, handler] of Object.entries(handlers)) {
    const publicPath = normalizeRoutePath(rawPath);
    if (publicPath === '/' && !INCLUDE_ROOT_APP) continue;
    if (servePathHidden(publicPath)) continue;

    // Every canonical served route is an app. Hints enrich operational metadata;
    // the explicit exclusions above remove aliases, downloads, and QA fixtures.
    const hint = APP_HINTS[publicPath] || {};

    const proxyUrl = extractProxyUrl(handler);
    if (!proxyUrl) continue;

    const { manifest: appManifest, url: manifestUrl } = await fetchAppManifest(proxyUrl, publicPath);
    const canonicalPath = manifestCanonicalPath(appManifest);
    if (canonicalPath && canonicalPath !== publicPath) {
      const canonicalEntry = Object.entries(handlers).find(([pathKey]) => normalizeRoutePath(pathKey) === canonicalPath);
      const canonicalProxy = canonicalEntry ? extractProxyUrl(canonicalEntry[1]) : null;
      if (sameProxyTarget(proxyUrl, canonicalProxy)) continue;
    }

    const id = routeId(hint.id || canonicalPath || publicPath);
    const key = routeKey(publicPath);
    const canonicalKey = canonicalPath ? routeKey(canonicalPath) : null;
    const releaseInfo = releaseCatalog?.appsById?.[id] || releaseCatalog?.appsById?.[key] || releaseCatalog?.appsById?.[canonicalKey] || null;
    const routeService = await serviceForRoute(publicPath);
    const routeResolution = await primaryServiceForProxy(routeService);
    const proxyService = hint.proxyService || await findServiceByPort(portFromUrl(proxyUrl)) || null;
    const proxyResolution = await primaryServiceForProxy(proxyService);
    const service = hint.service || routeResolution.service || proxyResolution.service || null;
    const serviceActionAuthorized = Boolean(hint.service);
    const repoActionAuthorized = Boolean(hint.repoPath);
    let repoPath = hint.repoPath || await repoPathForService(service);
    if ((!repoPath || !(await exists(repoPath))) && releaseInfo?.repo) {
      repoPath = await findRepoByRemote(releaseInfo.repo) || repoPath;
    }
    const trailingSlash = hint.trailingSlash ?? manifestPrefersTrailingSlash(appManifest);

    apps.push({
      id,
      actionKey: routeActionKey(publicPath),
      group: hint.group || appGroupForPath(publicPath),
      name: hint.name || appManifest?.name || appManifest?.short_name || releaseInfo?.name || titleFromPath(publicPath),
      path: publicPath,
      service: service || null,
      proxyService: proxyService || null,
      repoPath: repoPath || null,
      serviceActionAuthorized,
      repoActionAuthorized,
      healthUrl: hint.healthUrl || proxyUrl,
      proxyUrl,
      canUpdate: Boolean(repoPath && service && serviceActionAuthorized && repoActionAuthorized),
      icon: absolutePublicPath(hint.icon, publicPath) || manifestIconPath(appManifest, publicPath) || null,
      manifest: appManifest ? {
        id: appManifest.id || null,
        name: appManifest.name || null,
        shortName: appManifest.short_name || null,
        startUrl: appManifest.start_url || null,
        scope: appManifest.scope || null,
        canonicalPath: canonicalPath || null,
        url: manifestUrl,
      } : null,
      releaseInfo,
      postUpdate: hint.postUpdate || null,
      installed: true,
      publicUrl: `${tailnetBase}${publicPath === '/' ? '/' : publicPath}${trailingSlash && publicPath !== '/' ? '/' : ''}`,
    });
  }

  apps.sort((a, b) => appSortKey(a).localeCompare(appSortKey(b)));

  return {
    apps,
    serve: {
      ok: true,
      socket: serve.socket || null,
      host,
      baseUrl: tailnetBase,
      paths: Object.keys(handlers).map(normalizeRoutePath),
      listedPaths: apps.map(app => app.path),
      rootIncluded: INCLUDE_ROOT_APP,
      error: null,
    },
  };
}

function releaseInfoForApp(app, releaseCatalog) {
  const key = routeKey(app.path);
  return app.releaseInfo || releaseCatalog?.appsById?.[app.id] || releaseCatalog?.appsById?.[key] || null;
}

async function appStatus(app, { forceGit = false, releaseCatalog = null } = {}) {
  const releaseInfo = releaseInfoForApp(app, releaseCatalog);
  const [active, enabled, health, gitState] = await Promise.all([
    app.service ? systemctl(['is-active', app.service]) : Promise.resolve({ ok: false, out: '' }),
    app.service ? systemctl(['is-enabled', app.service]) : Promise.resolve({ ok: false, out: '' }),
    checkHealth(app.healthUrl),
    computeGitState(app, { force: forceGit }),
  ]);

  const localDate = gitState.localCommitDate || null;
  const localSha = gitState.localSha || null;
  const latestDate = releaseInfo?.releaseDate || gitState.remoteCommitDate || null;
  const latestSha = releaseInfo?.commit || gitState.remoteSha || null;
  const releaseOutdated = Boolean(localDate && latestDate && latestDate > localDate);
  const effectiveUpdateAvailable = Boolean(gitState.updateAvailable || releaseOutdated);
  const hasRemoteRepo = Boolean(gitState.remoteUrl || releaseInfo?.repo);
  const canSafeUpdate = Boolean(app.canUpdate && gitState.updateAvailable && gitState.tracked && gitState.canCheck && gitState.cleanKnown && !gitState.dirty && !gitState.diverged && Number(gitState.ahead || 0) === 0);

  return {
    ...app,
    installed: true,
    serviceKnown: Boolean(app.service),
    serviceActive: app.service ? (active.ok && active.out === 'active') : health.ok,
    serviceEnabled: app.service ? (enabled.ok && enabled.out.includes('enabled')) : false,
    healthCode: health.code,
    healthOk: health.ok,
    repoLinked: hasRemoteRepo,
    repoRemote: gitState.remoteUrl || releaseInfo?.repo || null,
    git: {
      ...gitState,
      autoUpdateAvailable: gitState.updateAvailable,
      updateAvailable: effectiveUpdateAvailable,
    },
    release: {
      source: releaseInfo ? (releaseCatalog?.source || 'catalog') : (gitState.remoteUrl ? 'git' : 'local'),
      localDate,
      localCommit: localSha,
      localLabel: formatVersionLabel(localDate, localSha),
      latestDate,
      latestCommit: latestSha,
      latestVersion: releaseInfo?.version || null,
      latestLabel: releaseInfo?.version
        ? `${releaseInfo.version} · ${formatVersionLabel(latestDate, latestSha)}`
        : (latestDate || latestSha ? formatVersionLabel(latestDate, latestSha) : 'no remote release'),
      outdated: releaseOutdated,
      releaseManifestDate: releaseInfo?.releaseDate || null,
      releaseManifestVersion: releaseInfo?.version || null,
    },
    canRestart: Boolean(app.service && app.serviceActionAuthorized),
    canUpdate: canSafeUpdate,
    canToggleAutostart: Boolean(app.service && app.serviceActionAuthorized),
  };
}

function appCanUpdateNow(app) {
  const g = app.git || {};
  return Boolean(app.canUpdate && g.autoUpdateAvailable && g.tracked && g.canCheck && g.cleanKnown && !g.dirty && !g.diverged && Number(g.ahead || 0) === 0);
}

async function getStatus({ forceGit = false } = {}) {
  const releaseCatalog = await fetchReleaseCatalog({ force: forceGit });
  const discovered = await discoverServedApps(releaseCatalog);
  const apps = await Promise.all(discovered.apps.map(app => appStatus(app, { forceGit, releaseCatalog })));
  const updateableApps = apps.filter(appCanUpdateNow);
  const updateAvailableApps = apps.filter(app => app.git?.updateAvailable || app.release?.outdated);

  return {
    ok: true,
    apps,
    groups: GROUPS,
    releases: {
      source: releaseCatalog?.source || RELEASES_URL,
      updatedAt: releaseCatalog?.updatedAt || null,
      fetchedAt: releaseCatalog?.fetchedAt || null,
      count: Object.keys(releaseCatalog?.appsById || {}).length,
      error: releaseCatalog?.error || null,
    },
    serve: discovered.serve,
    updates: {
      availableCount: updateAvailableApps.length,
      updateableCount: updateableApps.length,
      updateableIds: updateableApps.map(app => app.id),
    },
  };
}

function publicSourceLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try { return new URL(normalizeGitRemote(raw)).hostname.replace(/^www\./, ''); } catch {}
  return /^[a-zA-Z0-9 _.-]{1,80}$/.test(raw) ? raw : null;
}

function publicGitState(gitState = {}) {
  const keys = [
    'tracked', 'canCheck', 'cleanKnown', 'fetchOk', 'countsKnown', 'dirty',
    'ahead', 'behind', 'diverged', 'status', 'reason', 'localSha', 'remoteSha',
    'localCommitDate', 'remoteCommitDate', 'autoUpdateAvailable', 'updateAvailable',
  ];
  return Object.fromEntries(keys.map(key => [key, gitState[key]]));
}

function publicAppStatus(app) {
  const {
    repoPath, repoRemote, proxyUrl, proxyService, healthUrl, postUpdate,
    manifest, releaseInfo, serviceActionAuthorized, repoActionAuthorized,
    git: gitState, release, ...safe
  } = app;
  const sourceHost = publicSourceLabel(repoRemote) || publicSourceLabel(release?.source);
  return {
    ...safe,
    sourceHost,
    git: publicGitState(gitState),
    release: {
      ...release,
      source: release?.source === 'git' || release?.source === 'local' ? release.source : 'catalog',
      sourceHost,
    },
  };
}

function publicStatus(status) {
  return {
    ok: true,
    apps: status.apps.map(publicAppStatus),
    groups: status.groups,
    releases: {
      source: publicSourceLabel(status.releases?.source),
      updatedAt: status.releases?.updatedAt || null,
      fetchedAt: status.releases?.fetchedAt || null,
      count: status.releases?.count || 0,
      available: !status.releases?.error,
    },
    serve: {
      ok: Boolean(status.serve?.ok),
      host: status.serve?.host || null,
      baseUrl: status.serve?.baseUrl || null,
      rootIncluded: Boolean(status.serve?.rootIncluded),
    },
    updates: {
      availableCount: status.updates?.availableCount || 0,
      updateableCount: status.updates?.updateableCount || 0,
    },
  };
}

async function handleUpdate(app, logs) {
  const gitState = await computeGitState(app, { force: true });

  if (!gitState.tracked || !gitState.canCheck) {
    throw new Error('Update check unavailable for this app (no tracked upstream branch).');
  }
  if (!gitState.cleanKnown) {
    throw new Error('Repository cleanliness could not be verified. Run git status manually before updating.');
  }
  if (gitState.diverged || gitState.ahead > 0) {
    throw new Error('Local repo diverged from upstream. Resolve manually before using Update.');
  }
  if (gitState.dirty) {
    throw new Error('Local repo has uncommitted changes. Commit or stash them before using Update.');
  }
  if (gitState.behind === 0) {
    throw new Error('Repository is already up to date; no update was performed.');
  }

  const beforeHead = await git(app.repoPath, ['rev-parse', 'HEAD']);
  if (!beforeHead.ok || !beforeHead.out) {
    throw new Error('Unable to verify the repository HEAD before updating.');
  }
  const pull = await git(app.repoPath, ['pull', '--ff-only'], { timeout: 180000, maxBuffer: 4_000_000 });
  logs.push(`git pull: ${pull.ok ? 'ok' : 'failed'}`);
  if (pull.out) logs.push(redactSensitiveText(pull.out));
  if (pull.err) logs.push(redactSensitiveText(pull.err));
  if (!pull.ok) throw new Error(logs.join('\n'));

  const afterHead = await git(app.repoPath, ['rev-parse', 'HEAD']);
  if (!afterHead.ok || !afterHead.out) {
    throw new Error('Unable to verify the repository HEAD after updating; post-update and restart were skipped.');
  }
  if (afterHead.out === beforeHead.out) {
    throw new Error('The pull did not change HEAD; post-update and restart were skipped.');
  }

  if (Array.isArray(app.postUpdate) && app.postUpdate.length > 0) {
    const [command, ...args] = app.postUpdate;
    const build = await runExec(command, args, { cwd: app.repoPath, timeout: 300000, maxBuffer: 5_000_000 });
    logs.push(redactSensitiveText(`${command} ${args.join(' ')}: ${build.ok ? 'ok' : 'failed'}`));
    if (build.out) logs.push(redactSensitiveText(build.out, 2000));
    if (build.err) logs.push(redactSensitiveText(build.err, 1200));
    if (!build.ok) throw new Error(logs.join('\n'));
  }

  await computeGitState(app, { force: true });
}

async function safeRestartService(service) {
  if (!service) throw new Error('No restartable service is linked to this app.');

  // If restarting this service itself, delay and detach so we can return a response first.
  if (service === SELF_SERVICE) {
    const scope = String(process.env.APPS_SYSTEMCTL_SCOPE || 'auto').toLowerCase();
    const childScript = `
      const { spawnSync } = require('node:child_process');
      const service = process.argv[1];
      const scope = process.argv[2];
      const run = args => spawnSync('systemctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const code = result => Number.isInteger(result.status) ? result.status : 1;
      const missing = result => /not found|could not be found|does not exist|No such file|Unit .* not loaded/i.test(String(result.stdout || '') + '\\n' + String(result.stderr || ''));
      setTimeout(() => {
        if (scope === 'system') process.exit(code(run(['restart', service])));
        const user = run(['--user', 'restart', service]);
        if (user.status === 0) process.exit(0);
        if (scope === 'auto' && missing(user)) process.exit(code(run(['restart', service])));
        process.exit(code(user));
      }, 300);
    `;
    const child = spawn(process.execPath, ['-e', childScript, SELF_SERVICE, scope], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: Boolean(child.pid), scheduled: true, out: 'self-restart scheduled; outcome pending' };
  }
  return systemctl(['restart', service]);
}

async function restartApp(app, logs) {
  if (!app.canRestart) throw new Error('No restartable service is linked to this app.');
  const restart = await safeRestartService(app.service);
  logs.push(`restart ${app.service}: ${restart.scheduled ? 'scheduled' : (restart.ok ? 'ok' : 'failed')}`);
  if (restart.out) logs.push(redactSensitiveText(restart.out));
  if (restart.err) logs.push(redactSensitiveText(restart.err));
  if (!restart.ok) throw new Error(logs.join('\n'));
}

async function handleUpdateAll() {
  const status = await getStatus({ forceGit: true });
  const updateable = status.apps
    .filter(appCanUpdateNow)
    .sort((a, b) => (a.service === SELF_SERVICE ? 1 : 0) - (b.service === SELF_SERVICE ? 1 : 0));

  const logs = [];
  if (!updateable.length) return { ok: true, output: 'No updateable apps found.', updated: [] };

  const updated = [];
  for (const app of updateable) {
    logs.push(`== ${app.name} (${app.path}) ==`);
    await handleUpdate(app, logs);
    await restartApp(app, logs);
    updated.push(app.id);
  }

  return { ok: true, output: logs.join('\n'), updated };
}

async function handleAction(payload) {
  const { appId, action } = payload || {};

  if (action === 'updateAll') return handleUpdateAll();

  const status = await getStatus({ forceGit: true });
  let app = status.apps.find(a => a.actionKey === appId);
  if (!app) {
    const legacyMatches = status.apps.filter(a => a.id === appId);
    if (legacyMatches.length > 1) throw new Error('Ambiguous legacy appId. Refresh Apps Manager and retry with the route action key.');
    app = legacyMatches[0] || null;
  }
  if (!app) throw new Error('Unknown appId or app is not currently served by Tailscale Serve');

  const logs = [];

  if (action === 'setAutostart') {
    if (!app.canToggleAutostart) throw new Error('No linked service for autostart control.');
    const enabled = Boolean(payload?.enabled);
    const cmd = enabled ? ['enable', app.service] : ['disable', app.service];
    const res = await systemctl(cmd);
    logs.push(`${enabled ? 'enable' : 'disable'} ${app.service}: ${res.ok ? 'ok' : 'failed'}`);
    if (res.out) logs.push(redactSensitiveText(res.out));
    if (res.err) logs.push(redactSensitiveText(res.err));
    if (!res.ok) throw new Error(logs.join('\n'));
    return { ok: true, output: logs.join('\n') };
  }

  if (!['restart', 'update'].includes(action)) throw new Error('Invalid action');

  if (action === 'update') {
    if (!app.canUpdate) {
      if (app.git?.cleanKnown === false) throw new Error('Repository cleanliness could not be verified. Run git status manually before updating.');
      if (app.git?.dirty) throw new Error('Local repo has uncommitted changes. Commit or stash them before using Update.');
      if (app.git?.diverged) throw new Error('Local repo diverged from upstream. Resolve it manually before using Update.');
      if (Number(app.git?.ahead || 0) > 0) throw new Error('Local repo has unpushed commits. Push or reconcile them before using Update.');
      throw new Error('Update is not available for this app in its current repo/service state.');
    }
    if (!(await exists(app.repoPath))) throw new Error('Repo not found for this app.');
    await handleUpdate(app, logs);
  }

  await restartApp(app, logs);
  await computeGitState(app, { force: true });
  return { ok: true, output: logs.join('\n') };
}

async function withActionLock(operation) {
  if (actionInFlight) {
    const error = new Error('Another Apps Manager action is already running.');
    error.statusCode = 409;
    throw error;
  }
  actionInFlight = true;
  try {
    return await operation();
  } finally {
    actionInFlight = false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const method = (req.method || 'GET').toUpperCase();
    const host = req.headers.host || `${HOST}:${PORT}`;
    const url = new URL(req.url || '/', `http://${host}`);
    const pathname = decodeURIComponent(url.pathname);

    const staticFile = resolveStaticPath(pathname);
    if (staticFile) {
      try {
        const body = await fs.readFile(staticFile);
        const ext = path.extname(staticFile).toLowerCase();
        return send(res, 200, body, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      } catch {
        return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
    }

    if (pathname === `${BASE}/api/health`) {
      return send(res, 200, JSON.stringify({ ok: true, app: 'tailnet-app-manager' }), { 'Content-Type': MIME['.json'] });
    }

    if (pathname === `${BASE}/api/status`) {
      const forceGit = url.searchParams.get('refresh') === '1';
      const status = await getStatus({ forceGit });
      return send(res, 200, JSON.stringify(publicStatus(status)), { 'Content-Type': MIME['.json'] });
    }

    if (pathname === `${BASE}/api/action`) {
      if (method !== 'POST') return send(res, 405, JSON.stringify({ error: 'Method Not Allowed' }), { 'Content-Type': MIME['.json'] });
      if (!unsafeOriginAllowed(req)) return send(res, 403, JSON.stringify({ error: 'forbidden origin' }), { 'Content-Type': MIME['.json'] });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) {
          return send(res, 413, JSON.stringify({ error: 'request body too large' }), { 'Content-Type': MIME['.json'] });
        }
      }
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
      try {
        const out = await withActionLock(() => handleAction(parsed));
        const safeOut = typeof out?.output === 'string' ? { ...out, output: redactSensitiveText(out.output, 12000) } : out;
        return send(res, 200, JSON.stringify(safeOut), { 'Content-Type': MIME['.json'] });
      } catch (err) {
        const code = Number(err?.statusCode) || 400;
        return send(res, code, JSON.stringify({ ok: false, error: redactSensitiveText(err?.message || err) }), { 'Content-Type': MIME['.json'] });
      }
    }

    if (pathname === '/' || pathname === BASE || pathname === `${BASE}/`) {
      const html = await fs.readFile(INDEX_PATH);
      return send(res, 200, html, { 'Content-Type': MIME['.html'] });
    }

    return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (err) {
    return send(res, 500, redactSensitiveText(err?.message || err), { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[apps-manager] serving ${BASE} at http://${HOST}:${PORT}${BASE}`);
});
