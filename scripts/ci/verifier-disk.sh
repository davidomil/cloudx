#!/usr/bin/env bash
set -euo pipefail

# Reserve space for the verifier image, Buildx layers and Docker's loaded image.
minimum_free_bytes=$((24 * 1024 * 1024 * 1024))

available_bytes() {
  local available
  available=$(df -B1 --output=avail / | tail -n1) || return
  if [[ ! $available =~ ^[[:space:]]*[0-9]+[[:space:]]*$ ]]; then
    echo "Failed to prepare runner: disk capacity could not be measured." >&2
    return 1
  fi
  echo "$available"
}

df -B1 /
available=$(available_bytes)
if (( available < minimum_free_bytes )); then
  sudo rm -rf -- /usr/local/lib/android/sdk /usr/share/dotnet
  df -B1 /
  available=$(available_bytes)
fi
if (( available < minimum_free_bytes )); then
  echo "Failed to prepare runner: insufficient disk space for the verifier build: ${available} bytes free; ${minimum_free_bytes} required." >&2
  exit 1
fi
echo "Verifier build capacity: ${available} bytes free; ${minimum_free_bytes} bytes reserved."
