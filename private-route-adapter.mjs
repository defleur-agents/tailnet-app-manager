#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import process from "node:process";

import {
  injectPwaShell,
  loadPwaCatalog,
  pwaAppForPath,
  pwaAssetResponse,
} from "./cloudflare-pwa.mjs";

const HOST = process.env.CLOUDFLARE_ROUTE_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.CLOUDFLARE_ROUTE_PORT || "8920", 10);
const CONFIG_PATH = process.env.CLOUDFLARE_ROUTE_CONFIG || "/home/telos/apps/tailnet-app-manager/cloudflare-routes.json";
const PWA_CATALOG_PATH = process.env.CLOUDFLARE_PWA_CATALOG || "/home/telos/apps/tailnet-app-manager/cloudflare-pwa-apps.json";
const PWA_ICON_ROOT = process.env.CLOUDFLARE_PWA_ICON_ROOT || "/home/telos/apps/tailnet-app-manager/pwa-icons";
const PUBLIC_ORIGIN = (process.env.CLOUDFLARE_PUBLIC_ORIGIN || "https://apps.wizard001.com").replace(/\/$/, "");
const MAX_HTML_BYTES = 64 * 1024 * 1024;

function loadConfig() {
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!parsed.routes || typeof parsed.routes !== "object") throw new Error("route config is missing routes");
  const routes = Object.entries(parsed.routes).map(([path, value]) => {
    if (!path.startsWith("/")) throw new Error(`invalid public path: ${path}`);
    const target = new URL(value.target);
    if (!["http:", "https:"].includes(target.protocol)) throw new Error(`unsupported target: ${value.target}`);
    return { path, target, metadata: value };
  });
  routes.sort((a, b) => b.path.length - a.path.length);
  return { ...parsed, routes };
}

let config = loadConfig();
let pwaCatalog = loadPwaCatalog(PWA_CATALOG_PATH, PWA_ICON_ROOT);

function matchingRoute(pathname) {
  for (const route of config.routes) {
    if (route.path === "/") return route;
    if (pathname === route.path || pathname.startsWith(`${route.path}/`)) return route;
  }
  return null;
}

function normalizedJoin(basePath, suffix) {
  const base = basePath || "/";
  if (!suffix) return base;
  return `${base.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}` || "/";
}

function targetFor(route, requestUrl) {
  const incoming = new URL(requestUrl, PUBLIC_ORIGIN);
  const suffix = route.path === "/" ? incoming.pathname : incoming.pathname.slice(route.path.length);
  const target = new URL(route.target.toString());
  target.pathname = normalizedJoin(target.pathname, suffix);
  target.search = incoming.search;
  return target;
}

function ingressAllowed(request, websocket = false) {
  const origin = request.headers.origin;
  if (origin && origin !== PUBLIC_ORIGIN) return false;
  if (websocket && !origin && request.headers['sec-fetch-site']) return false;
  if (!['GET','HEAD','OPTIONS'].includes(request.method) && request.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}
function outgoingHeaders(request, route, target, websocket = false) {
  const headers = { ...request.headers };
  // Custom-domain TCP ingress authenticates the network, not caller-supplied
  // Cloudflare or Serve identity headers. Never forward those assertions.
  for (const name of Object.keys(headers)) {
    if (name.startsWith('cf-access-') || name.startsWith('tailscale-user-') ||
        name === 'x-private-peer' || name === 'cf-connecting-ip') delete headers[name];
  }
  // Validate browser Origin at ingress, then bridge the legacy app allowlist.
  // Signed-URL applications keep their canonical private Origin untouched.
  if (headers.origin === PUBLIC_ORIGIN && route.path !== '/wizard-social') {
    headers.origin = 'https://apps.wizard001.com';
  }
  if (route.path !== '/wizard-social' && headers.referer?.startsWith(PUBLIC_ORIGIN + '/')) headers.referer = headers.referer.replace(PUBLIC_ORIGIN, 'https://apps.wizard001.com');
  const backendOrigin = route.path === '/wizard-social' || websocket ? PUBLIC_ORIGIN : 'https://apps.wizard001.com';
  headers.host = websocket || ['/nesquena', '/hermesUI'].includes(route.path) ? new URL(backendOrigin).host : target.host;
  if (websocket && request.headers.origin) headers.origin = PUBLIC_ORIGIN;
  headers["x-forwarded-host"] = new URL(backendOrigin).host;
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-prefix"] = route.path;
  if (!websocket) {
    delete headers.connection;
    delete headers.upgrade;
    delete headers["proxy-connection"];
    headers["accept-encoding"] = "identity";
  }
  return headers;
}

function rewriteLocation(location, route, target) {
  if (!location) return location;
  try {
    const resolved = new URL(location, target);
    if (resolved.origin === "https://apps.wizard001.com") return PUBLIC_ORIGIN + resolved.pathname + resolved.search + resolved.hash;
    if (resolved.host !== target.host) return location;
    const targetBase = route.target.pathname.replace(/\/$/, "");
    const suffix = resolved.pathname.startsWith(targetBase) ? resolved.pathname.slice(targetBase.length) : resolved.pathname;
    return `${PUBLIC_ORIGIN}${route.path === "/" ? "" : route.path}${suffix || "/"}${resolved.search}${resolved.hash}`;
  } catch {
    return location;
  }
}

function transportFor(target) {
  return target.protocol === "https:" ? https : http;
}

function writeJson(response, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

function writePayload(response, payload, method = "GET") {
  response.writeHead(payload.status, payload.headers);
  response.end(method === "HEAD" ? undefined : payload.body);
}

function shouldInjectPwa(request, upstreamResponse, app) {
  if (!app || (request.method || "GET").toUpperCase() !== "GET") return false;
  const status = upstreamResponse.statusCode || 0;
  if (status < 200 || status >= 300) return false;
  const contentType = String(upstreamResponse.headers["content-type"] || "").toLowerCase();
  const contentEncoding = String(upstreamResponse.headers["content-encoding"] || "identity").toLowerCase();
  return contentType.startsWith("text/html") && (contentEncoding === "identity" || contentEncoding === "");
}

function writeInjectedHtml(response, upstreamResponse, app) {
  const chunks = [];
  let total = 0;
  upstreamResponse.on("data", (chunk) => {
    total += chunk.length;
    if (total > MAX_HTML_BYTES) {
      upstreamResponse.destroy(new Error("HTML response exceeded PWA injection limit"));
      return;
    }
    chunks.push(chunk);
  });
  upstreamResponse.on("end", () => {
    if (response.destroyed) return;
    const source = Buffer.concat(chunks).toString("utf8");
    const body = Buffer.from(injectPwaShell(source, app));
    const headers = { ...upstreamResponse.headers };
    delete headers["content-encoding"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    delete headers.etag;
    delete headers["content-md5"];
    delete headers["last-modified"];
    delete headers["content-security-policy-report-only"];
    headers["content-length"] = body.length;
    headers["cache-control"] = "no-store";
    response.writeHead(upstreamResponse.statusCode || 200, headers);
    response.end(body);
  });
  upstreamResponse.on("error", (error) => {
    if (!response.headersSent) writeJson(response, 502, { ok: false, error: "pwa-injection-failed", route: app.path });
    else response.destroy(error);
  });
}

const server = http.createServer((request, response) => {
  if (!ingressAllowed(request)) { writeJson(response, 403, {ok:false,error:'forbidden-origin'}); return; }
  const incoming = new URL(request.url || "/", PUBLIC_ORIGIN);
  if (incoming.pathname === "/__cloudflare_apps/health") {
    writeJson(response, 200, { ok: true, service: "cloudflare-route-adapter", routes: config.routes.length, pwaApps: pwaCatalog.apps.length });
    return;
  }
  if (incoming.pathname === "/__cloudflare_apps/routes") {
    writeJson(response, 200, {
      ok: true,
      routes: config.routes.map((route) => ({
        path: route.path,
        target: `${route.target.protocol}//${route.target.host}${route.target.pathname}`,
        pwa: pwaAppForPath(pwaCatalog, route.path)?.path === route.path,
      })),
    });
    return;
  }
  const pwaAsset = pwaAssetResponse(pwaCatalog, incoming.pathname);
  if (pwaAsset) {
    writePayload(response, pwaAsset, request.method);
    return;
  }
  const route = matchingRoute(incoming.pathname);
  if (!route) {
    writeJson(response, 404, { ok: false, error: "route-not-found" });
    return;
  }
  if (incoming.pathname === route.path && !incoming.pathname.endsWith('/') && ['GET','HEAD'].includes(request.method)) {
    response.writeHead(308, { location: `${PUBLIC_ORIGIN}${incoming.pathname}/${incoming.search}` });
    response.end(); return;
  }
  const target = targetFor(route, request.url || "/");
  const pwaApp = pwaAppForPath(pwaCatalog, incoming.pathname);
  const upstream = transportFor(target).request(target, {
    method: request.method,
    headers: outgoingHeaders(request, route, target),
  }, (upstreamResponse) => {
    const headers = { ...upstreamResponse.headers };
    if (headers.location) headers.location = rewriteLocation(headers.location, route, target);
    delete headers["content-security-policy-report-only"];
    if (shouldInjectPwa(request, upstreamResponse, pwaApp)) {
      writeInjectedHtml(response, upstreamResponse, pwaApp);
      return;
    }
    response.writeHead(upstreamResponse.statusCode || 502, headers);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(120_000, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (error) => {
    if (!response.headersSent) writeJson(response, 502, { ok: false, error: "origin-unavailable", route: route.path });
    else response.destroy(error);
  });
  request.pipe(upstream);
});

server.on("upgrade", (request, socket, head) => {
  if (!ingressAllowed(request, true)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const incoming = new URL(request.url || "/", PUBLIC_ORIGIN);
  const route = matchingRoute(incoming.pathname);
  if (!route) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const target = targetFor(route, request.url || "/");
  const upstreamRequest = transportFor(target).request(target, {
    method: request.method,
    headers: outgoingHeaders(request, route, target, true),
  });
  upstreamRequest.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n`;
    const headerLines = Object.entries(upstreamResponse.headers)
      .flatMap(([name, value]) => Array.isArray(value) ? value.map((item) => `${name}: ${item}\r\n`) : [`${name}: ${value}\r\n`])
      .join("");
    socket.write(`${statusLine}${headerLines}\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstreamRequest.on("response", (upstreamResponse) => {
    socket.end(`HTTP/1.1 ${upstreamResponse.statusCode || 502} ${upstreamResponse.statusMessage || "Bad Gateway"}\r\nConnection: close\r\n\r\n`);
  });
  upstreamRequest.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
  upstreamRequest.end();
});

function reload() {
  try {
    const nextConfig = loadConfig();
    const nextPwaCatalog = loadPwaCatalog(PWA_CATALOG_PATH, PWA_ICON_ROOT);
    config = nextConfig;
    pwaCatalog = nextPwaCatalog;
    console.log(JSON.stringify({ event: "routes_reloaded", routes: config.routes.length, pwaApps: pwaCatalog.apps.length }));
  } catch (error) {
    console.error(JSON.stringify({ event: "reload_failed", error: error.message }));
  }
}

process.on("SIGHUP", reload);
server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ event: "listening", host: HOST, port: PORT, routes: config.routes.length, pwaApps: pwaCatalog.apps.length }));
});
