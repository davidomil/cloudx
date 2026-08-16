# Cloudx Security Model

Private by default. Tailnet recommended. Public internet unsupported.

Cloudx is a local-first mobile workbench for Codex CLI. It is designed for a
single trusted developer running Cloudx on their own Linux workstation, devbox,
or homelab server. The process listens only on loopback; remote clients reach it
through an authenticated reverse proxy on a private network.

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

## Authenticated Tailnet Access

Network-facing `CLOUDX_HOST` values are rejected. Keep Cloudx on localhost and
use an identity-aware tailnet proxy. First admit the exact externally visible
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

Cloudx derives one trusted origin from its configured loopback listener, port,
and HTTP/HTTPS mode. `CLOUDX_TRUSTED_ORIGINS` adds exact canonical HTTP(S)
origins for a separate Vite server or authenticated reverse proxy. The variable
is a comma-separated list without paths or trailing slashes:

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

## Operational Checks

- Keep `CLOUDX_ALLOWED_ROOTS` as narrow as practical.
- Keep generated certificates, `.cloudx/`, `.codex/`, `.understand-anything/`,
  `.env*`, audio captures, and logs out of Git.
- Do not reuse a Cloudx process across untrusted users.
- Stop Cloudx services when they are not needed on shared machines.
