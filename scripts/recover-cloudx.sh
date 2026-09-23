#!/usr/bin/env bash
# Maintained entry point for installed versions that predate managed handoff.
set -euo pipefail
if ! command -v node >/dev/null || ! command -v git >/dev/null; then
  echo 'Managed CloudX recovery requires installed Node.js and Git.' >&2
  exit 1
fi
recovery_parent="${XDG_STATE_HOME:-$HOME/.local/state}/cloudx/recovery-launchers"
mkdir -p "$recovery_parent"
chmod 700 "$recovery_parent"
recovery_stage="$(mktemp -d "$recovery_parent/launcher-XXXXXXXX")"
git clone --quiet --depth=1 --branch main -- https://github.com/davidomil/cloudx.git "$recovery_stage/coordinator"
exec node "$recovery_stage/coordinator/scripts/update-cloudx.mjs" "$@"
