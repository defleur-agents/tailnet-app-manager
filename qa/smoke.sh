#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
APP_PID=''
FIXTURE_PID=''
CAP_PID=''
cleanup() {
  [[ -z "$APP_PID" ]] || kill "$APP_PID" 2>/dev/null || true
  [[ -z "$FIXTURE_PID" ]] || kill "$FIXTURE_PID" 2>/dev/null || true
  [[ -z "$CAP_PID" ]] || kill "$CAP_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

APP_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
FIXTURE_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
CAP_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')

mkdir -p "$TMP/bin" "$TMP/www" "$TMP/proc/4242" "$TMP/proc/4243"
printf '%s\n' '0::/user.slice/user-1000.slice/app.slice/demo8080.service' > "$TMP/proc/4242/cgroup"
printf '%s\n' '0::/user.slice/user-1000.slice/app.slice/ambiguous-subpath-proxy.service' > "$TMP/proc/4243/cgroup"
cat > "$TMP/apps.local.json" <<JSON
{"apps":{"/demo":{"service":"demo.service","repoPath":"$TMP/repos/demo"},"/unknown":{"name":"Unknown Cleanliness","service":"unknown.service","repoPath":"$TMP/repos/unknown"},"/current":{"name":"Catalog Newer Only","service":"current.service","repoPath":"$TMP/source"},"/race":{"name":"No-op Pull Race","service":"race.service","repoPath":"$TMP/repos/race"},"/credential":{"name":"Credential Redaction","service":"credential.service"},"/foo/bar":{"name":"Nested Route","service":"nested.service"},"/foo-bar":{"name":"Flat Route","service":"flat.service"},"https://qa.tailnet.example:9443/":{"id":"port-root-a","name":"Port Root A"},"https://qa.tailnet.example:9444/":{"id":"port-root-b","name":"Port Root B"}}}
JSON
printf '%s\n' '{' > "$TMP/apps.invalid.json"

git init --quiet --bare --initial-branch=main "$TMP/upstream.git"
git init --quiet --initial-branch=main "$TMP/source"
git -C "$TMP/source" config user.name 'Smoke Test'
git -C "$TMP/source" config user.email 'smoke@example.invalid'
printf '%s\n' 'v1' > "$TMP/source/version.txt"
git -C "$TMP/source" add version.txt
git -C "$TMP/source" commit --quiet -m 'v1'
git -C "$TMP/source" remote add origin "$TMP/upstream.git"
git -C "$TMP/source" push --quiet -u origin main
git clone --quiet "$TMP/upstream.git" "$TMP/repos/demo"
git clone --quiet "$TMP/upstream.git" "$TMP/repos/unknown"
git clone --quiet "$TMP/upstream.git" "$TMP/repos/race"
printf '%s\n' 'v2' > "$TMP/source/version.txt"
git -C "$TMP/source" commit --quiet -am 'v2'
git -C "$TMP/source" push --quiet
printf '%s\n' 'keep me' > "$TMP/repos/demo/local-change.txt"

cat > "$TMP/www/manifest.json" <<'JSON'
{"name":"Manifest Demo App","short_name":"Demo","id":"/demo/","start_url":"/demo/","scope":"/demo/","icons":[{"src":"javascript:alert(1)","sizes":"2048x2048"},{"src":"//evil.example/icon.png","sizes":"1024x1024"},{"src":"icon.svg","sizes":"any","type":"image/svg+xml"}]}
JSON
cat > "$TMP/www/apps.json" <<JSON
{"source":"smoke-catalog","apps":[{"id":"demo","path":"demo","name":"Demo App","version":"1.0.0","repo":"$TMP/upstream.git"},{"id":"current","path":"current","name":"Catalog Newer Only","version":"99.0.0","releaseDate":"2099-01-01","repo":"$TMP/upstream.git"}]}
JSON
cat > "$TMP/bin/tailscale" <<'SH'
#!/usr/bin/env bash
cat <<JSON
{"Web":{"qa.tailnet.example:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:${APP_PORT}"}}},"qa.tailnet.example":{"Handlers":{"/apps":{"Proxy":"http://127.0.0.1:9"},"/demo":{"Proxy":"http://127.0.0.1:${FIXTURE_PORT}"},"/unknown":{"Proxy":"http://127.0.0.1:9"},"/current":{"Proxy":"http://127.0.0.1:9"},"/race":{"Proxy":"http://127.0.0.1:9"},"/credential":{"Proxy":"http://127.0.0.1:9"},"/short":{"Proxy":"http://127.0.0.1"},"/inferred":{"Proxy":"http://127.0.0.1:8080"},"/ambiguous":{"Proxy":"http://127.0.0.1:8081"},"/foo/bar":{"Proxy":"http://127.0.0.1:9"},"/foo-bar":{"Proxy":"http://127.0.0.1:9"},"/downloads/example.apk":{"Proxy":"http://127.0.0.1:${FIXTURE_PORT}"}}},"qa.tailnet.example:9443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:${FIXTURE_PORT}"}}},"qa.tailnet.example:9444":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9"}}}}}
JSON
SH
chmod +x "$TMP/bin/tailscale"
cat > "$TMP/bin/systemctl" <<'SH'
#!/usr/bin/env bash
case " $* " in
  *" cat demo.service "*)
    printf '[Service]\nWorkingDirectory=%s\nExecStart=/usr/bin/node demo.mjs\n' "$DEMO_REPO"
    ;;
  *" cat unknown.service "*)
    printf '[Service]\nWorkingDirectory=%s\nExecStart=/usr/bin/node unknown.mjs\n' "$UNKNOWN_REPO"
    ;;
  *" cat current.service "*|*" cat race.service "*|*" cat custom-manager.service "*)
    printf '[Service]\nExecStart=/usr/bin/node app.mjs\n'
    ;;
  *" cat ambiguous-subpath-proxy.service "*)
    printf '[Unit]\nAfter=worker-a.service worker-b.service\n'
    ;;
  *" cat worker-a.service "*|*" cat worker-b.service "*)
    printf '[Service]\nExecStart=/usr/bin/node worker.mjs\n'
    ;;
  *" cat nested.service "*|*" cat flat.service "*)
    printf '[Service]\nExecStart=/usr/bin/node app.mjs\n'
    ;;
  *" is-active demo.service "*) printf '%s\n' 'active' ;;
  *" is-active unknown.service "*) printf '%s\n' 'active' ;;
  *" is-active current.service "*|*" is-active race.service "*|*" is-active custom-manager.service "*) printf '%s\n' 'active' ;;
  *" is-active nested.service "*|*" is-active flat.service "*) printf '%s\n' 'active' ;;
  *" is-enabled demo.service "*) printf '%s\n' 'enabled' ;;
  *" is-enabled unknown.service "*) printf '%s\n' 'enabled' ;;
  *" is-enabled current.service "*|*" is-enabled race.service "*|*" is-enabled custom-manager.service "*) printf '%s\n' 'enabled' ;;
  *" is-enabled nested.service "*|*" is-enabled flat.service "*) printf '%s\n' 'enabled' ;;
  *" enable credential.service "*) printf 'failed https://%s%s%s password%s%s %s%s%s %s%s%s {"password":"%s"} Authorization: Bearer %s\n' 'fixture-user:' 'fixture-pass' '@example.invalid' '=' 'fixture-secret' 'github_' 'pat_fixture_' 'finecredential1234567890' 'GITHUB_' 'TOKEN=' 'fixture-env' 'fixture-json' 'fixture-bearer' >&2; exit 1 ;;
  *" --user restart custom-manager.service "*) printf '%s\n' 'permission denied' >&2; exit 1 ;;
  *" restart custom-manager.service "*) printf '%s\n' 'UNSAFE-SYSTEM-FALLBACK' >> "$ACTION_LOG" ;;
  *" restart nested.service "*) sleep 0.35; printf '%s\n' 'nested.service' >> "$ACTION_LOG" ;;
  *" restart flat.service "*) printf '%s\n' 'flat.service' >> "$ACTION_LOG" ;;
  *" restart race.service "*) printf '%s\n' 'race.service' >> "$ACTION_LOG" ;;
  *) printf 'Unit %s could not be found\n' "${*: -1}" >&2; exit 1 ;;
esac
SH
chmod +x "$TMP/bin/systemctl"
cat > "$TMP/bin/ss" <<'SH'
#!/usr/bin/env bash
printf '%s\n' 'LISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:(("node",pid=4242,fd=7))'
printf '%s\n' 'LISTEN 0 128 127.0.0.1:8081 0.0.0.0:* users:(("node",pid=4243,fd=8))'
SH
chmod +x "$TMP/bin/ss"
REAL_GIT=$(command -v git)
cat > "$TMP/bin/git" <<SH
#!/usr/bin/env bash
if [[ " \$* " == *" -C \$UNKNOWN_REPO "* && " \$* " == *" status --porcelain "* ]]; then
  printf '%s\n' 'simulated git status failure' >&2
  exit 2
fi
if [[ " \$* " == *" -C \$RACE_REPO "* && " \$* " == *" pull --ff-only "* ]]; then
  printf '%s\n' 'Already up to date.'
  exit 0
fi
exec "$REAL_GIT" "\$@"
SH
chmod +x "$TMP/bin/git"

if APPS_CONFIG="$TMP/apps.invalid.json" node "$ROOT/server.mjs" >"$TMP/invalid.log" 2>&1; then
  printf '%s\n' 'invalid config unexpectedly started the server' >&2
  exit 1
fi
python3 - "$TMP/invalid.log" <<'PY'
import sys
text=open(sys.argv[1],encoding='utf-8').read()
assert 'Unable to load Apps Manager config' in text
PY

if TAILNET_BASE_URL='data:text/plain,opaque' APPS_CONFIG="$TMP/apps.local.json" node "$ROOT/server.mjs" >"$TMP/opaque.log" 2>&1; then
  printf '%s\n' 'opaque Tailnet origin unexpectedly started the server' >&2
  exit 1
fi
python3 - "$TMP/opaque.log" <<'PY'
import sys
text=open(sys.argv[1],encoding='utf-8').read()
assert 'TAILNET_BASE_URL' in text
PY

for bad_origin in 'https://qa.tailnet.example' 'https://qa.tailnet.example:8443/path?x=1#fragment'; do
  if TAILNET_BASE_URL="$bad_origin" APPS_CONFIG="$TMP/apps.local.json" node "$ROOT/server.mjs" >"$TMP/control-origin.log" 2>&1; then
    printf '%s\n' "unsafe control origin unexpectedly started: $bad_origin" >&2
    exit 1
  fi
done

printf '%s\n' '{"apps":{"/apps":{"service":"wrong.service"}}}' > "$TMP/self-conflict.json"
if TAILNET_BASE_URL='https://qa.tailnet.example:8443' APPS_SERVICE_NAME='custom-manager.service' APPS_CONFIG="$TMP/self-conflict.json" node "$ROOT/server.mjs" >"$TMP/self-conflict.log" 2>&1; then
  printf '%s\n' 'conflicting self-service config unexpectedly started the server' >&2
  exit 1
fi
python3 - "$TMP/self-conflict.log" <<'PY'
import sys
assert 'must match APPS_SERVICE_NAME' in open(sys.argv[1],encoding='utf-8').read()
PY

python3 -m http.server "$FIXTURE_PORT" --bind 127.0.0.1 --directory "$TMP/www" >"$TMP/fixture.log" 2>&1 &
FIXTURE_PID=$!

PATH="$TMP/bin:$PATH" \
HOME="$TMP/home" \
APP_PORT="$CAP_PORT" \
FIXTURE_PORT="$FIXTURE_PORT" \
DEMO_REPO="$TMP/repos/demo" \
UNKNOWN_REPO="$TMP/repos/unknown" \
RACE_REPO="$TMP/repos/race" \
ACTION_LOG="$TMP/cap-actions.log" \
APPS_HOST=127.0.0.1 \
APPS_PORT="$CAP_PORT" \
APPS_CONFIG="$TMP/apps.local.json" \
APPS_PROC_ROOT="$TMP/proc" \
APPS_SERVICE_NAME="custom-manager.service" \
APPS_REPO_ROOTS="$TMP/repos" \
APPS_RELEASES_URL="http://127.0.0.1:${FIXTURE_PORT}/apps.json" \
APPS_MANIFEST_MAX_BYTES=32 \
APPS_RELEASES_MAX_BYTES=32 \
TAILNET_BASE_URL="https://qa.tailnet.example:8443" \
node "$ROOT/server.mjs" >"$TMP/cap-app.log" 2>&1 &
CAP_PID=$!
python3 - "$CAP_PORT" <<'PY'
import json,sys,time,urllib.request
base=f'http://127.0.0.1:{int(sys.argv[1])}'
for _ in range(80):
    try:
        with urllib.request.urlopen(base+'/apps/api/status',timeout=20) as r:
            status=json.load(r)
        break
    except Exception:
        time.sleep(.1)
else:
    raise SystemExit('byte-cap server did not become ready')
demo=next(app for app in status['apps'] if app['path']=='/demo')
assert demo['name']=='Demo', demo
assert demo['icon'] is None
assert status['releases']['available'] is False
PY
kill "$CAP_PID"
wait "$CAP_PID" 2>/dev/null || true
CAP_PID=''

PATH="$TMP/bin:$PATH" \
HOME="$TMP/home" \
APP_PORT="$APP_PORT" \
FIXTURE_PORT="$FIXTURE_PORT" \
DEMO_REPO="$TMP/repos/demo" \
UNKNOWN_REPO="$TMP/repos/unknown" \
RACE_REPO="$TMP/repos/race" \
ACTION_LOG="$TMP/actions.log" \
APPS_HOST=127.0.0.1 \
APPS_PORT="$APP_PORT" \
APPS_CONFIG="$TMP/apps.local.json" \
APPS_PROC_ROOT="$TMP/proc" \
APPS_SERVICE_NAME="custom-manager.service" \
APPS_REPO_ROOTS="$TMP/repos" \
APPS_RELEASES_URL="http://127.0.0.1:${FIXTURE_PORT}/apps.json" \
TAILNET_BASE_URL="https://qa.tailnet.example:8443" \
node "$ROOT/server.mjs" >"$TMP/app.log" 2>&1 &
APP_PID=$!

python3 - "$APP_PORT" "$TMP/repos/demo" "$TMP/repos/unknown" "$TMP/repos/race" <<'PY'
import http.client,json,pathlib,sys,time,urllib.error,urllib.request
port=int(sys.argv[1]); repo=pathlib.Path(sys.argv[2]); unknown_repo=pathlib.Path(sys.argv[3]); race_repo=pathlib.Path(sys.argv[4]); base=f'http://127.0.0.1:{port}'
for _ in range(80):
    try:
        with urllib.request.urlopen(base+'/apps/api/health',timeout=.5) as r:
            if r.status==200: break
    except Exception: time.sleep(.1)
else: raise SystemExit('server did not become ready')
with urllib.request.urlopen(base+'/apps/api/status',timeout=20) as r:
    status=json.load(r)
assert status['ok'] is True
assert len(status['apps'])==14, status['apps']
demo=next(a for a in status['apps'] if a['path']=='/demo')
unknown=next(a for a in status['apps'] if a['path']=='/unknown')
current=next(a for a in status['apps'] if a['path']=='/current')
race=next(a for a in status['apps'] if a['path']=='/race')
credential=next(a for a in status['apps'] if a['path']=='/credential')
short=next(a for a in status['apps'] if a['path']=='/short')
inferred=next(a for a in status['apps'] if a['path']=='/inferred')
ambiguous=next(a for a in status['apps'] if a['path']=='/ambiguous')
self_app=next(a for a in status['apps'] if a['path']=='/apps' and a['service']=='custom-manager.service')
shadow_apps=next(a for a in status['apps'] if a['path']=='/apps' and a['service'] is None)
port_root_a=next(a for a in status['apps'] if a['publicUrl']=='https://qa.tailnet.example:9443/')
port_root_b=next(a for a in status['apps'] if a['publicUrl']=='https://qa.tailnet.example:9444/')
nested=next(a for a in status['apps'] if a['path']=='/foo/bar')
flat=next(a for a in status['apps'] if a['path']=='/foo-bar')
assert nested['id']==flat['id']=='foo-bar'
assert nested['actionKey'] != flat['actionKey']
assert demo['name']=='Manifest Demo App'
assert port_root_a['name']=='Port Root A' and port_root_b['name']=='Port Root B'
assert port_root_a['id']=='port-root-a' and port_root_b['id']=='port-root-b'
assert port_root_a['actionKey'] != port_root_b['actionKey']
assert port_root_a['canRestart'] is False and port_root_b['canRestart'] is False
assert demo['release']['source']=='catalog' and demo['release']['sourceHost']=='smoke-catalog'
assert demo['publicUrl']=='https://qa.tailnet.example/demo/'
assert self_app['publicUrl']=='https://qa.tailnet.example:8443/apps/'
assert status['serve']['host']=='qa.tailnet.example:8443'
assert status['serve']['baseUrl']=='https://qa.tailnet.example:8443'
assert demo['icon']=='/demo/icon.svg'
assert demo['git']['dirty'] is True
assert demo['git']['behind']==1
assert demo['canUpdate'] is False
assert unknown['git']['behind']==1
assert unknown['git']['cleanKnown'] is False, unknown['git']
assert unknown['git']['dirty'] is None
assert unknown['git']['status']=='unknown'
assert unknown['canUpdate'] is False
assert current['git']['autoUpdateAvailable'] is False
assert current['git']['updateAvailable'] is True
assert current['release']['outdated'] is True
assert current['canUpdate'] is False
assert short['service'] is None and short['canRestart'] is False, (short,ambiguous)
assert inferred['service']=='demo8080.service' and inferred['canRestart'] is False
assert ambiguous['service'] is None and ambiguous['canRestart'] is False
assert self_app['service']=='custom-manager.service'
assert self_app['canRestart'] is True and shadow_apps['canRestart'] is False
assert self_app['actionKey'] != shadow_apps['actionKey']
assert status['updates']['updateableCount']==1
assert '/downloads/example.apk' not in {app['path'] for app in status['apps']}
assert 'socket' not in status['serve'] and 'paths' not in status['serve']
for app in status['apps']:
    assert not ({'repoPath','repoRemote','proxyUrl','proxyService','healthUrl','postUpdate','manifest','releaseInfo'} & set(app)), app
with urllib.request.urlopen(base+'/apps/',timeout=2) as r:
    html=r.read().decode()
    assert r.headers['X-Frame-Options']=='DENY'
    assert r.headers['X-Content-Type-Options']=='nosniff'
    assert 'function redirectToControlOrigin(data)' in html
    assert 'if (redirectToControlOrigin(data)) return;' in html
    assert "function launchTargetAttr() {\n      return '';" in html
    assert 'target="_blank"' not in html
    assert r.headers['Cross-Origin-Opener-Policy']=='same-origin'
    assert r.headers['Cross-Origin-Resource-Policy']=='same-origin'
    assert "frame-ancestors 'none'" in r.headers['Content-Security-Policy']
    assert "img-src 'self' data:" in r.headers['Content-Security-Policy']
assert 'Apps Manager' in html and 'actionFeedback' in html
conn=http.client.HTTPConnection('127.0.0.1',port,timeout=2)
conn.request('GET','/apps/?legacy=1',headers={'Host':'qa.tailnet.example'})
legacy=conn.getresponse()
assert legacy.status==302, legacy.status
assert legacy.getheader('Location')=='https://qa.tailnet.example:8443/apps/?legacy=1'
legacy.read(); conn.close()
conn=http.client.HTTPConnection('127.0.0.1',port,timeout=2)
conn.request('GET','/apps/',headers={'Host':'qa.tailnet.example:8443'})
control=conn.getresponse()
assert control.status==200, control.status
control.read(); conn.close()
with urllib.request.urlopen(base+'/apps/assets/app-terminal.png',timeout=2) as r:
    assert r.status==200 and r.headers['Content-Type']=='image/png'
req=urllib.request.Request(base+'/apps/api/action',data=b'{}',headers={'Content-Type':'application/json','Origin':'https://hostile.example'},method='POST')
try: urllib.request.urlopen(req,timeout=2); raise AssertionError('cross-origin action was accepted')
except urllib.error.HTTPError as e: assert e.code==403
req=urllib.request.Request(base+'/apps/api/action',data=b'{}',headers={'Content-Type':'application/json','Origin':'null'},method='POST')
try: urllib.request.urlopen(req,timeout=2); raise AssertionError('null-origin action was accepted')
except urllib.error.HTTPError as e: assert e.code==403
req=urllib.request.Request(base+'/apps/api/action',data=b'{}',headers={'Content-Type':'application/json','Origin':'https://qa.tailnet.example'},method='POST')
try: urllib.request.urlopen(req,timeout=2); raise AssertionError('sibling-app origin was accepted')
except urllib.error.HTTPError as e: assert e.code==403
req=urllib.request.Request(base+'/apps/api/action',data=b'{}',headers={'Content-Type':'application/json','Origin':'https://qa.tailnet.example:8443'},method='POST')
try: urllib.request.urlopen(req,timeout=20); raise AssertionError('invalid Tailnet-origin action unexpectedly succeeded')
except urllib.error.HTTPError as e: assert e.code==400
req=urllib.request.Request(base+'/apps/api/action',data=b'x'*70000,headers={'Content-Type':'application/json','Origin':base},method='POST')
try: urllib.request.urlopen(req,timeout=2); raise AssertionError('oversized action was accepted')
except urllib.error.HTTPError as e: assert e.code==413
req=urllib.request.Request(base+'/apps/api/action',data=json.dumps({'action':'update','appId':demo['actionKey']}).encode(),headers={'Content-Type':'application/json','Origin':base},method='POST')
try: urllib.request.urlopen(req,timeout=20); raise AssertionError('dirty repository was updated')
except urllib.error.HTTPError as e:
    payload=json.loads(e.read())
    assert e.code==400, payload
    assert 'uncommitted changes' in payload.get('error',''), payload
assert (repo/'version.txt').read_text().strip()=='v1'
assert (repo/'local-change.txt').read_text().strip()=='keep me'
req=urllib.request.Request(base+'/apps/api/action',data=json.dumps({'action':'update','appId':unknown['actionKey']}).encode(),headers={'Content-Type':'application/json','Origin':base},method='POST')
try: urllib.request.urlopen(req,timeout=20); raise AssertionError('unknown-cleanliness repository was updated')
except urllib.error.HTTPError as e:
    payload=json.loads(e.read())
    assert e.code==400, payload
    assert 'cleanliness could not be verified' in payload.get('error',''), payload
assert (unknown_repo/'version.txt').read_text().strip()=='v1'
req=urllib.request.Request(base+'/apps/api/action',data=json.dumps({'action':'update','appId':race['actionKey']}).encode(),headers={'Content-Type':'application/json','Origin':base},method='POST')
try: urllib.request.urlopen(req,timeout=20); raise AssertionError('successful no-op pull triggered post-update/restart')
except urllib.error.HTTPError as e:
    payload=json.loads(e.read())
    assert e.code==400, payload
    assert 'did not change HEAD' in payload.get('error',''), payload
assert (race_repo/'version.txt').read_text().strip()=='v1'
req=urllib.request.Request(base+'/apps/api/action',data=json.dumps({'action':'setAutostart','appId':credential['actionKey'],'enabled':True}).encode(),headers={'Content-Type':'application/json','Origin':base},method='POST')
try: urllib.request.urlopen(req,timeout=20); raise AssertionError('credential failure unexpectedly succeeded')
except urllib.error.HTTPError as e:
    raw=e.read().decode()
    assert e.code==400, raw
    for marker in ('fixture-user','fixture-pass','fixture-secret','finecredential','fixture-env','fixture-json','fixture-bearer'):
        assert marker not in raw, raw
req=urllib.request.Request(base+'/apps/api/action',data=json.dumps({'action':'update','appId':current['actionKey']}).encode(),headers={'Content-Type':'application/json','Origin':base},method='POST')
try: urllib.request.urlopen(req,timeout=20); raise AssertionError('release-only mismatch triggered a Git update')
except urllib.error.HTTPError as e:
    assert e.code==400
    assert 'not available' in json.loads(e.read())['error']
assert (repo.parent.parent/'actions.log').exists() is False
import concurrent.futures
def restart(app):
    request=urllib.request.Request(base+'/apps/api/action',data=json.dumps({'action':'restart','appId':app['actionKey']}).encode(),headers={'Content-Type':'application/json','Origin':base},method='POST')
    try:
        with urllib.request.urlopen(request,timeout=20) as response: return response.status,json.load(response)
    except urllib.error.HTTPError as error: return error.code,json.loads(error.read())
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    concurrent_results=list(pool.map(lambda _: restart(nested),range(2)))
assert sorted(code for code,_ in concurrent_results)==[200,409], concurrent_results
assert any('already running' in payload.get('error','') for code,payload in concurrent_results if code==409)
assert (repo.parent.parent/'actions.log').read_text().splitlines()==['nested.service']
assert restart(inferred)[0]==400
assert (repo.parent.parent/'actions.log').read_text().splitlines()==['nested.service']
assert restart(flat)[0]==200
assert (repo.parent.parent/'actions.log').read_text().splitlines()==['nested.service','flat.service']
req=urllib.request.Request(base+'/apps/api/action',data=b'{"action":"restart","appId":"foo-bar"}',headers={'Content-Type':'application/json','Origin':base},method='POST')
try: urllib.request.urlopen(req,timeout=20); raise AssertionError('ambiguous legacy appId was accepted')
except urllib.error.HTTPError as e:
    assert e.code==400
    assert 'Ambiguous legacy appId' in json.loads(e.read())['error']
assert (repo.parent.parent/'actions.log').read_text().splitlines()==['nested.service','flat.service']
code,payload=restart(self_app)
assert code==200 and 'scheduled' in payload.get('output','') and 'outcome pending' in payload.get('output',''), payload
time.sleep(.7)
assert (repo.parent.parent/'actions.log').read_text().splitlines()==['nested.service','flat.service']
print('smoke: isolated control origin, explicit action authority, sanitized status/cache/output, bounded remote JSON, HEAD-change proof, fail-closed Git, serialized collision-safe actions, missing-unit-only self fallback, credential redaction, safe icons, self identity, UI, headers, and body cap passed')
PY

node --check "$ROOT/server.mjs"
python3 - "$ROOT/index.html" "$TMP/index-script.js" <<'PY'
import re,sys
src=open(sys.argv[1],encoding='utf-8').read()
assert 'new URL(`/apps/assets/app-${routeId}.png`, window.location.origin).href' in src
assert 'restart scheduled; outcome pending.' in src
server_src=open(sys.argv[1].replace('index.html','server.mjs'),encoding='utf-8').read()
assert 'localstt' not in server_src and 'localllm' not in server_src
blocks=re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>',src,re.S)
assert blocks, 'no inline script found'
open(sys.argv[2],'w',encoding='utf-8').write('\n'.join(blocks))
PY
node --check "$TMP/index-script.js"
printf '%s\n' 'smoke: syntax checks passed'
