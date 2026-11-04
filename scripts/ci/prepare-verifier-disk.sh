#!/usr/bin/env bash
set -euo pipefail

# Conservative admission policy, not a guarantee of future image-build size.
minimum_bytes=$((24 * 1024 * 1024 * 1024))

available_disk_bytes() {
  local report
  local -a lines
  report=$(LC_ALL=C df -B1 --output=avail /) || return "$?"
  mapfile -t lines <<< "$report"
  if [[ ${#lines[@]} != 2 ]] || [[ ! ${lines[1]} =~ ^[[:space:]]*([0-9]+)[[:space:]]*$ ]]; then
    printf 'Invalid available disk bytes reported by df: %s\n' "$report" >&2
    return 1
  fi
  printf '%s\n' "${BASH_REMATCH[1]}"
}

disk_budget_met() {
  awk -v available="$1" -v required="$minimum_bytes" 'BEGIN { exit !(available >= required) }'
}

available_bytes=$(available_disk_bytes)
printf 'Verifier disk admission: required=%s available=%s bytes\n' "$minimum_bytes" "$available_bytes"
if disk_budget_met "$available_bytes"; then
  printf 'Sufficient disk space; skip unused SDK cleanup.\n'
  exit 0
fi

sudo rm -rf -- /usr/local/lib/android/sdk /usr/share/dotnet
available_bytes=$(available_disk_bytes)
printf 'Verifier disk after SDK cleanup: available=%s bytes\n' "$available_bytes"
if ! disk_budget_met "$available_bytes"; then
  printf 'Verifier preparation needs at least %s available bytes; found %s after SDK cleanup.\n' "$minimum_bytes" "$available_bytes" >&2
  exit 1
fi
