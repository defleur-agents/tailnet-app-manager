#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOST = process.env.APPS_HOST || '127.0.0.1';
const PORT = Number(process.env.APPS_PORT || 8786);
const BASE = '/apps';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const INDEX_PATH = path.join(ROOT, 'index.html');
const TAILNET_BASE = process.env.TAILNET_BASE_URL || 'https://srv1499816.tail6adf1a.ts.net';
const GIT_CACHE_TTL_MS = Number(process.env.APPS_GIT_CACHE_MS || 180000);
const RELEASES_URL = process.env.APPS_RELEASES_URL || 'https://humanitylabs.org/releases/apps.json';
const RELEASES_CACHE_TTL_MS = Number(process.env.APPS_RELEASES_CACHE_MS || 600000);

const GROUPS = {
  custom: {
    id: 'custom',
    label: 'Custom Apps',
    description: 'Designed and fully built by Humanity Labs.',
  },
  base: {
    id: 'base',
    label: 'Base Tailnet Apps',
    description: 'Baseline services using our Tailnet app template.',
  },
};

const APPS = [
  { id:'appsmanager', group:'custom', name:'Apps Manager', path:'/apps', service:'apps-manager.service', repoPath:'/root/.openclaw/workspace/AGENT-OSCAR/Code/tailnet-app-manager', healthUrl:'http://127.0.0.1:8786/apps/api/health', canUpdate:true, icon:'/apps/assets/app-appsmanager.png' },
  { id:'mizel', group:'custom', name:'Mizel', path:'/mizel', service:'mizel-local.service', repoPath:'/root/.openclaw/workspace/AGENT-OSCAR/Code/mizel', healthUrl:'http://127.0.0.1:8791/mizel', canUpdate:true, icon:'/apps/assets/app-mizel.png' },
  { id:'mindfeed', group:'custom', name:'MindFeed', path:'/mindfeed', service:'mindfeed.service', repoPath:'/root/.openclaw/workspace/AGENT-OSCAR/Code/mindfeed', healthUrl:'http://127.0.0.1:8787/mindfeed', canUpdate:true, icon:'/apps/assets/app-mindfeed.png' },
  { id:'bookcompressor', group:'custom', name:'BookCompressor', path:'/bookcompressor', service:'bookcompressor.service', repoPath:'/root/.openclaw/workspace/AGENT-OSCAR/Code/book-compressor', healthUrl:'http://127.0.0.1:3000/bookcompressor/api/health', canUpdate:true, icon:'/apps/assets/app-bookcompressor.png' },
  { id:'clawtabs', group:'custom', name:'ClawTabs', path:'/clawtabs', service:'clawtabs.service', repoPath:'/root/.openclaw/workspace/AGENT-OSCAR/Code/claw-tabs', healthUrl:'http://127.0.0.1:8788/clawtabs/api/health', canUpdate:true, icon:'/apps/assets/app-clawtabs.png' },
  { id:'browser', group:'base', name:'Browser', path:'/browser', service:'remote-browser.service', repoPath:'/root/.openclaw/workspace/AGENT-OSCAR/Code/tailnet-browser', healthUrl:'http://127.0.0.1:6080', canUpdate:true, icon:'/apps/assets/app-browser.png' },
  { id:'terminal', group:'base', name:'Terminal', path:'/terminal', service:'web-terminal.service', repoPath:'/root/.openclaw/workspace/AGENT-OSCAR/Code/tailnet-terminal', healthUrl:'http://127.0.0.1:7681', canUpdate:true, icon:'/apps/assets/app-terminal.png' },
  { id:'localstt', group:'base', name:'LocalSTT', path:'/stt', service:'local-stt.service', repoPath:'/root/.openclaw/workspace/AGENT-OSCAR/Code/local-stt', healthUrl:'http://127.0.0.1:9099/health', canUpdate:true, icon:'/apps/assets/app-localstt.png' },
  { id:'localllm', group:'base', name:'LocalLLM', path:'/llm/v1/models', service:'local-llm.service', repoPath:'/root/.openclaw/workspace/AGENT-OSCAR/Code/local-llm', healthUrl:'http://127.0.0.1:9098/v1/models', canUpdate:true, icon:'/apps/assets/app-localllm.png' },
];

const MIME = {
  '.html':'text/html; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8',
  '.png':'image/png',
};

const STATIC_ROUTES = {
  [`${BASE}/manifest.webmanifest`]: path.join(ROOT, 'manifest.webmanifest'),
  [`${BASE}/icon-192.png`]: path.join(ROOT, 'icon-192.png'),
  [`${BASE}/icon-512.png`]: path.join(ROOT, 'icon-512.png'),
  [`${BASE}/apple-touch-icon.png`]: path.join(ROOT, 'apple-touch-icon.png'),
};

const gitStateCache = new Map();
let releaseCatalogCache = { at: 0, data: null };

function send(res, code, body, headers={}) {
  res.writeHead(code, { 'Cache-Control':'no-store', ...headers });
  res.end(body);
}

function resolveStaticPath(pathname) {
  if (STATIC_ROUTES[pathname]) return STATIC_ROUTES[pathname];
  if (!pathname.startsWith(`${BASE}/assets/`)) return null;
  const relative = pathname.slice(`${BASE}/assets/`.length);
  if (!relative || relative.includes('..') || path.isAbsolute(relative)) return null;
  return path.join(ROOT, 'assets', relative);
}

async function runExec(bin, args, opts={}) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: opts.timeout ?? 20000,
      maxBuffer: opts.maxBuffer ?? 4_000_000,
      cwd: opts.cwd,
      env: opts.env,
    });
    return { ok:true, out:String(stdout || '').trim(), err:String(stderr || '').trim() };
  } catch (err) {
    return {
      ok:false,
      out:String(err?.stdout || '').trim(),
      err:String(err?.stderr || err?.message || '').trim(),
      code: err?.code,
    };
  }
}

async function systemctl(args) {
  return runExec('systemctl', args, { timeout: 15000, maxBuffer: 2_000_000 });
}

async function git(repoPath, args, opts={}) {
  return runExec('git', ['-C', repoPath, ...args], {
    timeout: opts.timeout ?? 30000,
    maxBuffer: opts.maxBuffer ?? 3_000_000,
  });
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function checkHealth(url) {
  if (!url) return { code:null, ok:false };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { method:'GET', signal: controller.signal });
    clearTimeout(timer);
    return { code: res.status, ok: res.status >= 200 && res.status < 400 };
  } catch {
    return { code: null, ok:false };
  }
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
    const id = String(row.id || '').trim();
    if (!id) continue;
    const releaseDate = normalizeReleaseDate(row.releaseDate || row.date || row.latestDate);
    const version = String(row.version || row.tag || '').trim() || null;
    const commit = String(row.commit || row.sha || '').trim() || null;
    appsById[id] = {
      id,
      name: String(row.name || '').trim() || id,
      releaseDate,
      version,
      commit,
      repo: String(row.repo || '').trim() || null,
      notes: String(row.notes || '').trim() || null,
    };
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
    const res = await fetch(RELEASES_URL, {
      method: 'GET',
      headers: { 'accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const data = { ...fallback, error: `http_${res.status}` };
      releaseCatalogCache = { at: now, data };
      return data;
    }

    const payload = await res.json();
    const parsed = parseReleaseCatalog(payload);
    releaseCatalogCache = { at: now, data: parsed };
    return parsed;
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

function cacheGitState(appId, data) {
  gitStateCache.set(appId, { at: Date.now(), data });
  return data;
}

async function computeGitState(app, { force = false } = {}) {
  const fallback = {
    tracked: false,
    canCheck: false,
    dirty: false,
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
    upstream: null,
    checkedAt: new Date().toISOString(),
    reason: null,
    error: null,
  };

  const cached = gitStateCache.get(app.id);
  if (!force && cached && (Date.now() - cached.at) < GIT_CACHE_TTL_MS) {
    return cached.data;
  }

  if (!app.repoPath || !(await exists(app.repoPath))) {
    return cacheGitState(app.id, { ...fallback, reason: 'repo_missing' });
  }

  const inside = await git(app.repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') {
    return cacheGitState(app.id, { ...fallback, reason: 'not_git_repo' });
  }

  const [dirtyRes, branchRes, localShaRes, localCommitDateRes, upstreamRes] = await Promise.all([
    git(app.repoPath, ['status', '--porcelain']),
    git(app.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(app.repoPath, ['rev-parse', '--short=10', 'HEAD']),
    git(app.repoPath, ['show', '-s', '--date=short', '--format=%cd', 'HEAD']),
    git(app.repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
  ]);

  const dirty = dirtyRes.ok ? Boolean(dirtyRes.out) : false;
  const branch = branchRes.ok ? branchRes.out : null;
  const localSha = localShaRes.ok ? localShaRes.out : null;
  const localCommitDate = localCommitDateRes.ok ? normalizeReleaseDate(localCommitDateRes.out) : null;
  const upstream = upstreamRes.ok ? upstreamRes.out : null;

  let canCheck = false;
  let ahead = 0;
  let behind = 0;
  let remoteSha = null;
  let remoteCommitDate = null;
  let fetchError = null;

  if (upstream) {
    canCheck = true;
    const parts = upstream.split('/');
    const remoteName = parts.shift() || 'origin';
    const remoteBranch = parts.join('/');

    const fetchRes = remoteBranch
      ? await git(app.repoPath, ['fetch', '--quiet', remoteName, remoteBranch], { timeout: 60000 })
      : await git(app.repoPath, ['fetch', '--quiet', remoteName], { timeout: 60000 });

    if (!fetchRes.ok) fetchError = fetchRes.err || fetchRes.out || 'fetch_failed';

    const [remoteShaRes, countsRes, remoteCommitDateRes] = await Promise.all([
      git(app.repoPath, ['rev-parse', '--short=10', upstream]),
      git(app.repoPath, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]),
      git(app.repoPath, ['show', '-s', '--date=short', '--format=%cd', upstream]),
    ]);

    if (remoteShaRes.ok) remoteSha = remoteShaRes.out;
    if (remoteCommitDateRes.ok) remoteCommitDate = normalizeReleaseDate(remoteCommitDateRes.out);
    if (countsRes.ok) {
      const parsed = parseAheadBehind(countsRes.out);
      ahead = parsed.ahead;
      behind = parsed.behind;
    }
  }

  const diverged = ahead > 0 && behind > 0;
  const updateAvailable = canCheck && behind > 0 && ahead === 0 && !dirty;

  let status = 'unknown';
  if (!canCheck) status = 'local_only';
  else if (dirty) status = 'local_changes';
  else if (diverged) status = 'diverged';
  else if (updateAvailable) status = 'update_available';
  else status = 'up_to_date';

  return cacheGitState(app.id, {
    tracked: true,
    canCheck,
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
    upstream,
    checkedAt: new Date().toISOString(),
    reason: null,
    error: fetchError,
  });
}

async function appStatus(app, { forceGit = false, releaseCatalog = null } = {}) {
  const [installed, active, enabled, health, gitState] = await Promise.all([
    exists(app.repoPath),
    systemctl(['is-active', app.service]),
    systemctl(['is-enabled', app.service]),
    checkHealth(app.healthUrl),
    computeGitState(app, { force: forceGit }),
  ]);

  const releaseInfo = releaseCatalog?.appsById?.[app.id] || null;
  const localDate = gitState.localCommitDate || null;
  const localSha = gitState.localSha || null;
  const latestDate = releaseInfo?.releaseDate || gitState.remoteCommitDate || null;
  const latestSha = releaseInfo?.commit || gitState.remoteSha || null;
  const releaseOutdated = Boolean(localDate && latestDate && latestDate > localDate);
  const effectiveUpdateAvailable = Boolean(gitState.updateAvailable || releaseOutdated);

  return {
    ...app,
    installed,
    serviceActive: active.ok && active.out === 'active',
    serviceEnabled: enabled.ok && enabled.out.includes('enabled'),
    healthCode: health.code,
    healthOk: health.ok,
    publicUrl: `${TAILNET_BASE}${app.path}`,
    git: {
      ...gitState,
      updateAvailable: effectiveUpdateAvailable,
    },
    release: {
      source: releaseInfo ? 'humanitylabs' : 'git',
      localDate,
      localCommit: localSha,
      localLabel: formatVersionLabel(localDate, localSha),
      latestDate,
      latestCommit: latestSha,
      latestVersion: releaseInfo?.version || null,
      latestLabel: releaseInfo?.version
        ? `${releaseInfo.version} · ${formatVersionLabel(latestDate, latestSha)}`
        : formatVersionLabel(latestDate, latestSha),
      outdated: releaseOutdated,
      releaseManifestDate: releaseInfo?.releaseDate || null,
      releaseManifestVersion: releaseInfo?.version || null,
    },
    canToggleAutostart: Boolean(app.service),
  };
}

async function handleUpdate(app, logs) {
  const gitState = await computeGitState(app, { force: true });

  if (!gitState.tracked || !gitState.canCheck) {
    throw new Error('Update check unavailable for this app (no tracked upstream branch).');
  }
  if (gitState.diverged || gitState.ahead > 0) {
    throw new Error('Local repo diverged from upstream. Resolve manually before using Update.');
  }
  if (gitState.dirty && gitState.behind === 0) {
    throw new Error('Local changes only (no newer GitHub commits). Commit/stash/revert locally first.');
  }
  if (gitState.behind === 0) {
    logs.push('Already up to date.');
    return;
  }

  const pullArgs = gitState.dirty
    ? ['pull', '--rebase', '--autostash']
    : ['pull', '--ff-only'];

  const pull = await git(app.repoPath, pullArgs, { timeout: 180000, maxBuffer: 4_000_000 });
  logs.push(`git pull: ${pull.ok ? 'ok' : 'failed'}`);
  if (pull.out) logs.push(pull.out);
  if (pull.err) logs.push(pull.err);
  if (!pull.ok) throw new Error(logs.join('\n'));

  if (app.id === 'bookcompressor') {
    const build = await runExec('npm', ['run', 'build'], { cwd: app.repoPath, timeout: 300000, maxBuffer: 5_000_000 });
    logs.push(`npm build: ${build.ok ? 'ok' : 'failed'}`);
    if (build.out) logs.push(build.out.slice(-2000));
    if (build.err) logs.push(build.err.slice(-1200));
    if (!build.ok) throw new Error(logs.join('\n'));
  }

  await computeGitState(app, { force: true });
}

async function safeRestartService(service) {
  // If restarting this service itself, delay and detach so we can return a response first.
  if (service === 'apps-manager.service') {
    spawn('sh', ['-lc', 'sleep 0.3 && systemctl restart apps-manager.service'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return { ok: true, out: 'scheduled self-restart' };
  }
  return systemctl(['restart', service]);
}

async function handleAction(payload) {
  const { appId, action } = payload || {};
  const app = APPS.find(a => a.id === appId);
  if (!app) throw new Error('Unknown appId');

  const logs = [];

  if (action === 'setAutostart') {
    const enabled = Boolean(payload?.enabled);
    const cmd = enabled ? ['enable', app.service] : ['disable', app.service];
    const res = await systemctl(cmd);
    logs.push(`${enabled ? 'enable' : 'disable'} ${app.service}: ${res.ok ? 'ok' : 'failed'}`);
    if (res.out) logs.push(res.out);
    if (res.err) logs.push(res.err);
    if (!res.ok) throw new Error(logs.join('\n'));
    return { ok:true, output: logs.join('\n') };
  }

  if (!['restart', 'update'].includes(action)) {
    throw new Error('Invalid action');
  }

  if (action === 'update') {
    if (!app.canUpdate) throw new Error('Update not available for this app');
    if (!(await exists(app.repoPath))) throw new Error('Repo not found for this app');
    await handleUpdate(app, logs);
  }

  const restart = await safeRestartService(app.service);
  logs.push(`restart ${app.service}: ${restart.ok ? 'ok' : 'failed'}`);
  if (restart.out) logs.push(restart.out);
  if (restart.err) logs.push(restart.err);
  if (!restart.ok) throw new Error(logs.join('\n'));

  await computeGitState(app, { force: true });
  return { ok:true, output: logs.join('\n') };
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
        return send(res, 404, 'Not Found', { 'Content-Type':'text/plain; charset=utf-8' });
      }
    }

    if (pathname === `${BASE}/api/health`) {
      return send(res, 200, JSON.stringify({ ok:true, app:'tailnet-app-manager' }), { 'Content-Type': MIME['.json'] });
    }

    if (pathname === `${BASE}/api/status`) {
      const forceGit = url.searchParams.get('refresh') === '1';
      const releaseCatalog = await fetchReleaseCatalog({ force: forceGit });
      const apps = await Promise.all(APPS.map(app => appStatus(app, { forceGit, releaseCatalog })));
      return send(res, 200, JSON.stringify({
        ok:true,
        apps,
        groups: GROUPS,
        releases: {
          source: releaseCatalog?.source || RELEASES_URL,
          updatedAt: releaseCatalog?.updatedAt || null,
          fetchedAt: releaseCatalog?.fetchedAt || null,
          count: Object.keys(releaseCatalog?.appsById || {}).length,
          error: releaseCatalog?.error || null,
        },
      }), { 'Content-Type': MIME['.json'] });
    }

    if (pathname === `${BASE}/api/action`) {
      if (method !== 'POST') return send(res, 405, JSON.stringify({ error:'Method Not Allowed' }), { 'Content-Type': MIME['.json'] });
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
      try {
        const out = await handleAction(parsed);
        return send(res, 200, JSON.stringify(out), { 'Content-Type': MIME['.json'] });
      } catch (err) {
        return send(res, 400, JSON.stringify({ ok:false, error: String(err?.message || err) }), { 'Content-Type': MIME['.json'] });
      }
    }

    if (pathname === BASE || pathname === `${BASE}/`) {
      const html = await fs.readFile(INDEX_PATH);
      return send(res, 200, html, { 'Content-Type': MIME['.html'] });
    }

    return send(res, 404, 'Not Found', { 'Content-Type':'text/plain; charset=utf-8' });
  } catch (err) {
    return send(res, 500, String(err?.message || err), { 'Content-Type':'text/plain; charset=utf-8' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[apps-manager] serving ${BASE} at http://${HOST}:${PORT}${BASE}`);
});
