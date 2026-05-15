#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

DRY_RUN=0
UNINSTALL=0
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=1
  elif [[ "$arg" == "--uninstall" ]]; then
    UNINSTALL=1
  fi
done

if [[ ! -r /etc/os-release ]]; then
  echo "Cloudx installer currently supports Ubuntu first. /etc/os-release is missing." >&2
  exit 1
fi

# shellcheck disable=SC1091
. /etc/os-release

if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "Cloudx installer currently supports Ubuntu first. Detected: ${PRETTY_NAME:-unknown OS}" >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 0 && "$UNINSTALL" -eq 0 ]] && ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required for Ubuntu package installation." >&2
  exit 1
fi

step() {
  printf '\n==> %s\n' "$1"
}

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '$'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  step "Launch the Cloudx uninstall wizard"
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required to run the uninstall wizard. The installer does not install Node.js during uninstall." >&2
    echo "Manual cleanup targets:" >&2
    echo "  ~/.config/systemd/user/cloudx.service" >&2
    echo "  ~/.config/systemd/user/cloudx-asr.service" >&2
    echo "  ~/.config/cloudx/cloudx.env" >&2
    echo "  services/asr/.venv" >&2
    echo "  .cloudx" >&2
    exit 1
  fi
  exec node scripts/install-cloudx.mjs "$@"
fi

step "Install Ubuntu packages required by Cloudx"
run sudo apt-get update
run sudo apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  git \
  build-essential \
  python3 \
  python3-venv \
  python3-pip \
  openssl \
  ripgrep

step "Check Node.js and npm"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 22 ]] || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22+ and npm are required. Installing the NodeSource Node.js 22 package, which includes npm."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo '$ curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -'
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  fi
  run sudo apt-get install -y nodejs
else
  echo "Using existing Node.js $(node -v) and npm $(npm -v)."
fi

if [[ "$DRY_RUN" -eq 1 ]] && ! command -v node >/dev/null 2>&1; then
  echo '$ node scripts/install-cloudx.mjs "$@"'
  echo "Node is not installed, so only the shell bootstrap dry-run was printed." >&2
  exit 0
fi

step "Launch the Cloudx installer wizard"
exec node scripts/install-cloudx.mjs "$@"
