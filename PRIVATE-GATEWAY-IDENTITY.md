# Private gateway identity and native migration

The personal gateway remains an isolated Tailscale node. TCP443 forwards TLS to Caddy127.0.0.1:19445 with PROXY protocol v1, so Caddy receives the real tailnet peer address. Main-node Serve and Funnel are unchanged.

Cavi is routed directly to its live loopback service8851 after forward auth at127.0.0.1:19447. The helper queries whois on /run/user/1000/tailscale-private-gateway.sock, requires an untagged human node with a matching UserProfile, and returns the actual login. Cavi retains its existing principal/client allowlist. Incoming identity headers are stripped. Caller-supplied Cloudflare/Serve identity assertions are also stripped by the general route adapter. Direct loopback identity spoofing and foreign-origin requests fail closed.

Mizel uses /mizel ->8790 (the authenticated realtime bridge), which forwards durable requests to ingest. Port8788 is the ingest service and is insufficient for native realtime/auth. Music routes continue through the supervised8991/8992 SSH tunnel to Thales8791/4533. Music's live launch-agent public/bootstrap/stream URLs use the private domain; server credentials and ticket signing stay unchanged.

Deployment evidence and rollback snapshots: /home/telos/.hermes/state/private-app-migration/. Caddyfile.before-identity and gateway-serve-before-identity.json retain the pre-change gateway settings. Music launch-agent backup is /Volumes/ThalesMedia/AndroidBuilds/private-route-qa/music-home-before.plist on Thales.

Service: private-tailnet-auth.service. Restart checks cover the actual custom domain from Thales. Keep the adapter identity stripping if rolling back Cavi identity; never restore access by injecting a static owner name. The old public distribution Store and shared Company services remain on their existing domains.

Native releases are staged independently. Preserve same-package/same-signer upgrades and James's installed data; public Store promotion and phone adoption are distinct gates. CineQueue's separate installer pilot source and scope are outside this native/auth change.
