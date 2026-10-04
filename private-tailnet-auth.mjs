import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export function validPeer(ip) {
  return net.isIP(ip) === 4 ? /^100\./.test(ip) && +ip.split('.')[1] >= 64 && +ip.split('.')[1] <= 127
    : net.isIP(ip) === 6 && ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
}
export function principalFromWhois(data) {
  const node = data?.Node, user = data?.UserProfile;
  // Tagged/service nodes have no human principal. Preserve the app's own authorization policy.
  if (!node || node.Tags?.length || !user || node.User !== user.ID) return null;
  const login = user.LoginName;
  return typeof login === 'string' && /^[a-zA-Z0-9._+@-]{1,254}$/.test(login) ? login : null;
}
export function lookupPeer(ip, socketPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({socketPath, path:'/localapi/v0/whois?addr=' + encodeURIComponent(ip),
      headers:{Host:'local-tailscaled.sock'}, timeout:2000}, res => {
      let body = '';
      res.on('data', data => {body += data; if(body.length > 131072) req.destroy(new Error('response too large'));});
      res.on('end', () => {try {if(res.statusCode !== 200) throw new Error('whois rejected'); resolve(JSON.parse(body));} catch(e){reject(e);}});
    });
    req.on('timeout', () => req.destroy(new Error('whois timeout')));
    req.on('error', reject);
  });
}
export function createAuthServer({lookup = ip => lookupPeer(ip, process.env.TAILSCALE_SOCKET || '/run/user/1000/tailscale-private-gateway.sock')} = {}) {
  return http.createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    const deny = () => {res.writeHead(403);res.end('Authenticated Tailnet principal required');};
    if(req.method !== 'GET' || req.url !== '/verify') return deny();
    // Caddy overwrites X-Private-Peer with the connection peer carried by Serve PROXY v1.
    // It must never derive this header from X-Forwarded-For or any client-supplied header.
    const ip = req.headers['x-private-peer'];
    if(typeof ip !== 'string' || !validPeer(ip)) return deny();
    const origin = req.headers.origin;
    if(origin && origin !== 'https://private.wizard001.com') return deny();
    if(req.headers['sec-fetch-site'] === 'cross-site') return deny();
    try {
      const login = principalFromWhois(await lookup(ip));
      if(!login) return deny();
      res.writeHead(204, {'Tailscale-User-Login':login});res.end();
    } catch {deny();}
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAuthServer().listen(19447,'127.0.0.1');
}
