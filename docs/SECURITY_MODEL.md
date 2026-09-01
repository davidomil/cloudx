# Cloudx Security Model

Private by default. Tailnet recommended. Public internet unsupported.

Cloudx is a local-first mobile workbench for Codex CLI. It is designed for a
single trusted developer running Cloudx on their own Linux workstation, devbox,
or homelab server. The process listens on loopback by default; remote clients
should normally reach it through an authenticated reverse proxy on a private
network. Direct IPv4 LAN binding is an explicit, less-safe opt-in for a trusted,
firewalled network.

## What Cloudx Can Do

- Read and write files under configured allowed roots.
- Spawn Codex CLI and shell sessions on the host.
- Send text and control keys to running terminal sessions.
- Proxy local dashboard URLs into workspace panes.
- Transcribe browser microphone audio when voice control is enabled.

## What Cloudx Does Not Currently Provide

- Multi-user isolation.
- Public internet hardening.
- Sandboxing of arbitrary shell commands.
- Runtime execution of third-party GitHub plugin code; GitHub plugin installs
  currently register validated metadata only.
- Zero-trust authentication by itself.
- Auditing suitable for untrusted users.
- Authorization boundaries between different projects under the same allowed
  root.

## Default Exposure

The server binds to `127.0.0.1` by default.

```bash
./install.sh
```

Use the local URL from the installer output:

```text
https://127.0.0.1:3001
```

This is the recommended baseline because the app can control terminals and
files as the local user running Cloudx.

## Direct Trusted-LAN Access

Set the listener to the explicit IPv4 wildcard and admit the exact URL that the
browser will use:

```bash
CLOUDX_HOST=0.0.0.0
CLOUDX_TRUSTED_ORIGINS=https://192.168.8.250:3001
```

Restart Cloudx, then open `https://192.168.8.250:3001`. `0.0.0.0` is a listener
wildcard, not a client URL. If the existing certificate does not include that
IP address, regenerate it before restarting:

```bash
CLOUDX_CERT_HOSTS=192.168.8.250 npm run cert:create -- --force
```

This mode has no Cloudx authentication. The exact Host/Origin checks reduce
browser-origin exposure but are not an authorization boundary; a raw client can
choose its own `Host` header. Restrict port `3001` with host firewall and LAN
controls, use it only where every network client is trusted, and never expose it
to the public internet or an untrusted LAN.

## Authenticated Tailnet Access

Keep Cloudx on localhost and use an identity-aware tailnet proxy. First admit
the exact externally visible
origin, without a path or trailing slash, in the installer-owned environment
file. Restart Cloudx so the service reads that environment before enabling the
proxy:

```bash
printf '%s\n' 'CLOUDX_TRUSTED_ORIGINS=https://build-host.example.ts.net' \
  >> ~/.config/cloudx/cloudx.env
systemctl --user restart cloudx.service
tailscale serve --bg https+insecure://localhost:3001
```

The external browser `Origin` and proxy `Host` must exactly match the configured
origin. Restrict access with tailnet grants or ACLs so only intended users and
devices can reach the Cloudx node.

## Reverse Proxy Guidance

Use a reverse proxy only with external authentication and a private network
boundary. Examples include Tailscale Serve, WireGuard/NordVPN Meshnet with host
firewall rules, or Cloudflare Access in front of a Cloudflare Tunnel.

Do not publish Cloudx directly with a public DNS record and open port. A reverse
proxy without identity-aware access control is not enough for this threat model.

## Request Origin Admission

Cloudx derives one trusted loopback origin from its configured port and
HTTP/HTTPS mode, including when it listens on the IPv4 wildcard, so local health
checks and internal helpers remain admitted. `CLOUDX_TRUSTED_ORIGINS` adds exact
canonical HTTP(S) origins for the actual browser URL, a separate Vite server, or
an authenticated reverse proxy. It is required when `CLOUDX_HOST=0.0.0.0`,
because a browser never uses the wildcard as its destination. The variable is a
comma-separated list without paths or trailing slashes:

```bash
CLOUDX_TRUSTED_ORIGINS=https://build-host.example.ts.net,http://127.0.0.1:5173
```

An absent variable adds no extra origins. A present empty value, empty list
element, duplicate, listener-origin repetition, credential, path, query,
fragment, other whitespace, or noncanonical origin stops startup. There is no
compatibility fallback: an unconfigured `localhost` alias, alternate port,
Vite origin, or proxy authority receives the same `403` as an attacker origin.

Every HTTP request and WebSocket upgrade must contain exactly one raw `Host`
whose authority belongs to the configured set. A browser `Origin`, when
present, must also exactly belong to that set. Cloudx does not trust
`Forwarded`, `X-Forwarded-Host`, or `X-Forwarded-Proto`; the reverse proxy must
therefore preserve an admitted raw Host or use another admitted Host while the
browser Origin is explicitly configured.

## Recommended Deployment

- Localhost.
- Tailscale Serve with grants or ACLs.
- Another reverse proxy only with external authentication and a private network
  boundary.
- Direct `0.0.0.0` binding only on an entirely trusted LAN with a host firewall;
  this is less safe because Cloudx does not authenticate direct clients.

## Operational Checks

- Keep `CLOUDX_ALLOWED_ROOTS` as narrow as practical.
- Keep generated certificates, `.cloudx/`, `.codex/`, `.understand-anything/`,
  `.env*`, audio captures, and logs out of Git.
- Do not reuse a Cloudx process across untrusted users.
- Stop Cloudx services when they are not needed on shared machines.
