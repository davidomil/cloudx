#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

DRY_RUN=0
UNINSTALL=0
UPDATE=0
QUARTO_VERSION="1.9.38"
QUARTO_DEB_PATH="/tmp/quarto-${QUARTO_VERSION}-linux-amd64.deb"
QUARTO_DEB_URL="https://github.com/quarto-dev/quarto-cli/releases/download/v${QUARTO_VERSION}/quarto-${QUARTO_VERSION}-linux-amd64.deb"
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=1
  elif [[ "$arg" == "--uninstall" ]]; then
    UNINSTALL=1
  elif [[ "$arg" == "--update" ]]; then
    UPDATE=1
  fi
done

if [[ "$UNINSTALL" -eq 1 && "$UPDATE" -eq 1 ]]; then
  echo "--update cannot be combined with --uninstall." >&2
  exit 1
fi

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

install_quarto() {
  if [[ "$(dpkg --print-architecture)" != "amd64" ]]; then
    echo "Cloudx installs the official Quarto linux-amd64 .deb. Detected unsupported architecture: $(dpkg --print-architecture)" >&2
    exit 1
  fi
  if [[ "$DRY_RUN" -eq 0 ]] && command -v quarto >/dev/null 2>&1 && [[ "$(quarto --version)" == "$QUARTO_VERSION" ]]; then
    echo "Using Quarto $(quarto --version)."
    return 0
  fi
  run curl -fL -o "$QUARTO_DEB_PATH" "$QUARTO_DEB_URL"
  run sudo apt-get install -y "$QUARTO_DEB_PATH"
  run quarto --version
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  step "Launch the Cloudx uninstall wizard"
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required to run the uninstall wizard. The installer does not install Node.js during uninstall." >&2
    echo "Manual cleanup targets:" >&2
    echo "  ~/.config/systemd/user/cloudx.service" >&2
    echo "  ~/.config/systemd/user/cloudx-asr.service" >&2
    echo "  ~/.config/systemd/user/cloudx-documentation.service" >&2
    echo "  ~/.config/cloudx/cloudx.env" >&2
    echo "  services/asr/.venv" >&2
    echo "  services/documentation-indexer/.venv" >&2
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
  software-properties-common \
  build-essential \
  cmake \
  pciutils \
  gpg-agent \
  wget \
  libreoffice \
  poppler-utils \
  ffmpeg \
  pandoc \
  texlive-xetex \
  texlive-latex-recommended \
  texlive-latex-extra \
  texlive-fonts-recommended \
  lmodern \
  python3 \
  python3-venv \
  python3-pip \
  openssl \
  jq \
  ripgrep

step "Install documentation PDF render tools"
install_quarto
run pandoc --version
run xelatex --version
run lualatex --version

step "Check Node.js and npm"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "Node.js 22+ is required. Installing the NodeSource Node.js 22 package."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo '$ curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -'
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  fi
  run sudo apt-get install -y nodejs
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is missing. Installing Ubuntu's npm package."
  run sudo apt-get install -y npm
fi

if [[ "$DRY_RUN" -eq 0 ]] && ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found after installation. Install npm and rerun ./install.sh." >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  echo "Using Node.js $(node -v) and npm $(npm -v)."
else
  echo '$ node -v'
  echo '$ npm -v'
fi

if [[ "$DRY_RUN" -eq 1 ]] && ! command -v node >/dev/null 2>&1; then
  echo '$ node scripts/install-cloudx.mjs "$@"'
  echo "Node is not installed, so only the shell bootstrap dry-run was printed." >&2
  exit 0
fi

export CLOUDX_INSTALL_BOOTSTRAPPED=1

if [[ "$UPDATE" -eq 1 ]]; then
  step "Pull latest Cloudx checkout"
  run git pull --ff-only
  export CLOUDX_INSTALL_ALREADY_PULLED=1
fi

step "Launch the Cloudx installer wizard"
exec node scripts/install-cloudx.mjs "$@"
