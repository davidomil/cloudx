# Security Policy

Cloudx is a local developer workbench. It can start terminals, send input to
Codex and shells, read files under configured roots, edit files through plugin
actions, and proxy local web dashboards.

Do not expose Cloudx to the public internet. Use localhost, a trusted LAN, or a
private tailnet. Public deployment would require authentication, authorization,
auditing, rate limiting, CSRF protection, process isolation, and a dedicated
security review.

Never commit local runtime data:

- `.cloudx/`
- `.codex/`
- `.understand-anything/`
- `.env*`
- generated certificates, keys, audio captures, and logs

If you find a vulnerability, open a private report or contact the maintainer
directly before publishing details.
