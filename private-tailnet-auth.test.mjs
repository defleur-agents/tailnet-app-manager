import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthServer, principalFromWhois, validPeer} from './private-tailnet-auth.mjs';
const real = {Node:{User:123},UserProfile:{ID:123,LoginName:'test-owner@example.com'}};
test('whois identity comes only from a matched human principal',()=>{
  assert.equal(principalFromWhois(real),'test-owner@example.com');
  for(const x of [{}, {...real,Node:{User:123,Tags:['tag:service']}}, {...real,Node:{User:999}}, {...real,UserProfile:{ID:123,LoginName:'evil\r\nHeader:yes'}}]) assert.equal(principalFromWhois(x),null);
});
test('peer address must be a Tailscale address',()=>{
  for(const ip of ['100.83.57.121','fd7a:115c:a1e0::1']) assert.equal(validPeer(ip),true);
  for(const ip of ['127.0.0.1','1.1.1.1','100.128.1.1','100.64.999.1','::1','fd00::1','100.64.1.1:443']) assert.equal(validPeer(ip),false);
});
test('auth rejects missing peer, spoofed user, cross-origin, tagged nodes and daemon failures',async()=>{
  let mode='real';
  const server=createAuthServer({lookup:async()=>{if(mode==='error')throw Error('down');if(mode==='tag')return {...real,Node:{User:123,Tags:['tag:service']}};return real;}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}/verify`;
  try {
    for(const headers of [{},{'Tailscale-User-Login':'test-owner@example.com'},{'X-Private-Peer':'127.0.0.1'},{'X-Private-Peer':'100.83.57.121',Origin:'https://evil.example'},{'X-Private-Peer':'100.83.57.121','Sec-Fetch-Site':'cross-site'}]) assert.equal((await fetch(url,{headers})).status,403);
    const res=await fetch(url,{headers:{'X-Private-Peer':'100.83.57.121','Tailscale-User-Login':'spoofed@example.com'}});
    assert.equal(res.status,204);assert.equal(res.headers.get('tailscale-user-login'),'test-owner@example.com');
    for(mode of ['tag','error']) assert.equal((await fetch(url,{headers:{'X-Private-Peer':'100.83.57.121'}})).status,403);
  } finally {await new Promise(r=>server.close(r));}
});
