#!/usr/bin/env bash
set -euo pipefail

controller=${1:?controller checkout}
browsers=${2:?installed browser directory}
destination=${3:?staged controller directory}

# Copy only the harness and its browser tools, never the runner's home or profile.
install -d -m 0755 "$destination/scripts/ci" "$destination/node_modules/@playwright"
for script in lifecycle.mjs lifecycle-browser.mjs lifecycle-evidence.mjs lifecycle-catalog.mjs; do
  install -m 0644 "$controller/scripts/ci/$script" "$destination/scripts/ci/$script"
done
for package in @playwright/test playwright playwright-core; do
  cp -aL "$controller/node_modules/$package" "$destination/node_modules/$package"
done
cp -aL "$browsers" "$destination/browsers"
chmod -R a+rX,go-w "$destination"
