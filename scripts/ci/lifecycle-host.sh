#!/usr/bin/env bash
# This provisions a whole disposable Ubuntu host. Never run on a developer host.
set -euo pipefail

scenario=${1:?install or upgrade}
source_sha=${2:?source SHA}
target_sha=${3:?target SHA}
evidence=$(realpath -m "${4:?evidence directory}")
published_evidence=$evidence
controller=$(pwd)
test_user="cloudx-ci-${scenario}-$$"
test_home="/home/$test_user"
fixture=""
user_created=0
catalog_pid=""
hosts_changed=0
environment_changed=0
install -d -m 0755 "$evidence"
printf '{"scenario":"%s","sourceSha":"%s","targetSha":"%s","result":"setup-failed"}\n' "$scenario" "$source_sha" "$target_sha" > "$evidence/host-result.json"

as_application() {
  runuser -u "$test_user" -- env -i \
    HOME="$test_home" USER="$test_user" LOGNAME="$test_user" \
    PATH="$application_path" LANG=C.UTF-8 \
    XDG_RUNTIME_DIR="/run/user/$test_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$test_uid/bus" \
    PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
    DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a "$@"
}

cleanup() {
  result=$?
  trap - EXIT INT TERM
  set +e
  if [[ $user_created == 1 ]]; then
    as_application "$controller_node" "$controller/scripts/ci/lifecycle.mjs" collect "$scenario" "$source_sha" "$target_sha" "$test_home/cloudx" "$evidence"
    as_application systemctl --user show cloudx.service cloudx-terminal.service cloudx-asr.service cloudx-documentation.service cloudx-settings-update.service \
      --property=Id,MainPID,InvocationID,ActiveState,SubState,ControlGroup,Result,ExecMainStatus > "$evidence/services-final.txt" 2>&1
    journalctl --no-pager "_UID=$test_uid" -n 4000 > "$evidence/journal.txt" 2>&1
    # Only this fresh account's synthetic test data can enter these logs.
    if [[ -d "$test_home/.local/state/cloudx/settings-update" ]]; then
      find "$test_home/.local/state/cloudx/settings-update" -maxdepth 1 -name '*.log' -type f -exec cp '{}' "$evidence/" \;
    fi
    as_application systemctl --user stop cloudx-settings-update.service cloudx.service cloudx-terminal.service cloudx-asr.service cloudx-documentation.service
    loginctl disable-linger "$test_user"
    loginctl terminate-user "$test_user"
    systemctl stop "user@$test_uid.service"
    pkill -KILL -u "$test_uid"
    if pgrep -u "$test_uid" > /dev/null; then result=1; fi
    userdel "$test_user"
    rm -f "/etc/sudoers.d/$test_user"
  fi
  if [[ -n $catalog_pid ]]; then kill "$catalog_pid"; wait "$catalog_pid"; fi
  if [[ $hosts_changed == 1 ]]; then cat "$fixture/hosts" > /etc/hosts; fi
  if [[ $environment_changed == 1 ]]; then cat "$fixture/environment" > /etc/environment || result=1; fi
  printf '{"scenario":"%s","sourceSha":"%s","targetSha":"%s","exitCode":%d}\n' "$scenario" "$source_sha" "$target_sha" "$result" > "$evidence/host-result.json"
  chmod -R a+rX "$evidence"
  if [[ $evidence != "$published_evidence" ]]; then
    cp -a "$evidence/." "$published_evidence/" || result=1
  fi
  # The disposable VM owns the remaining private home/fixture, which are never uploaded.
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ ${CLOUDX_LIFECYCLE_DISPOSABLE:-} == 1 ]] || { echo 'A disposable host is required (CLOUDX_LIFECYCLE_DISPOSABLE=1).'; exit 1; }
[[ $(id -u) == 0 && $(cat /proc/1/comm) == systemd ]] || { echo 'Root and systemd as PID 1 are required.'; exit 1; }
[[ $scenario == install || $scenario == upgrade ]]
[[ $source_sha =~ ^[a-f0-9]{40}$ && $target_sha =~ ^[a-f0-9]{40}$ ]]
if [[ $scenario == upgrade ]]; then [[ $source_sha != "$target_sha" ]]; fi
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]]
controller_node=$(command -v node)
controller_bin=$(dirname "$controller_node")
application_path="$controller_bin:/usr/local/bin:/usr/bin:/bin"
: "${PLAYWRIGHT_BROWSERS_PATH:?Install the controller Chromium browser first}"
test -r "$controller/node_modules/@playwright/test/package.json"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
apt-get update > "$evidence/host-setup.log" 2>&1
apt-get install --yes dbus-user-session sudo git openssl >> "$evidence/host-setup.log" 2>&1
fixture=$(mktemp -d /tmp/cloudx-lifecycle.XXXXXX)
chmod 0755 "$fixture"
bash "$controller/scripts/ci/lifecycle-stage.sh" "$controller" "$PLAYWRIGHT_BROWSERS_PATH" "$fixture/controller"
install -d -m 0755 "$fixture/evidence"
cp -a "$evidence/." "$fixture/evidence/"
evidence="$fixture/evidence"
PLAYWRIGHT_BROWSERS_PATH="$fixture/controller/browsers"

# Fetch only selected immutable objects. No service ever sees the controller checkout.
git init --bare "$fixture/origin.git" >> "$evidence/host-setup.log" 2>&1
git -c safe.directory="$controller" -C "$fixture/origin.git" fetch "$controller" "$source_sha:refs/heads/source" "$target_sha:refs/heads/main"
git -C "$fixture/origin.git" symbolic-ref HEAD refs/heads/main
chmod -R a+rX "$fixture/origin.git"
controller="$fixture/controller"

[[ ! -e $test_home ]]
useradd --create-home --shell /bin/bash "$test_user"
user_created=1
test_uid=$(id -u "$test_user")
chown "$test_user:$test_user" "$evidence"
chown -R "$test_user:$test_user" "$fixture/origin.git"
printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$test_user" > "/etc/sudoers.d/$test_user"
chmod 0440 "/etc/sudoers.d/$test_user"
# Hosted runners put their own session paths in this system-wide file. The user
# manager reparses it even when its caller uses env -i; restore it during cleanup.
cp -p /etc/environment "$fixture/environment"
environment_changed=1
sed -i -E '/^[[:space:]]*(PATH|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)=/d' /etc/environment
printf 'PATH="%s"\n' "$application_path" >> /etc/environment
loginctl enable-linger "$test_user"
systemctl start "user@$test_uid.service"
# Environment generators (including snapd) can extend PATH after reading
# /etc/environment. A client override remains authoritative across daemon-reload.
as_application systemctl --user set-environment "PATH=$application_path"
as_application systemd-run --user --wait --pipe --collect --expand-environment=no /bin/sh -ec '
  failed=0
  check() {
    printf "%s: actual=<%s> expected=<%s>\n" "$1" "$2" "$3"
    if [ "$2" != "$3" ]; then failed=1; fi
  }
  check HOME "${HOME-<unset>}" "$1"
  printf "XDG_CONFIG_HOME: inherited=<%s>\n" "${XDG_CONFIG_HOME-<unset>}"
  check XDG_CONFIG_HOME "${XDG_CONFIG_HOME:-$HOME/.config}" "$1/.config"
  check XDG_RUNTIME_DIR "${XDG_RUNTIME_DIR-<unset>}" "/run/user/$(id -u)"
  check PATH "${PATH-<unset>}" "$2"
  if [ "$failed" != 0 ]; then exit 1; fi
  printf "Checking nested user-manager access.\n"
  systemctl --user show-environment > /dev/null
  printf "Application service home, runtime directory and PATH are isolated; nested user-manager access passes.\n"
' sh "$test_home" "$application_path" > "$evidence/user-manager.txt" 2>&1
as_application git clone --no-hardlinks "$fixture/origin.git" "$test_home/cloudx"
install_sha=$target_sha
if [[ $scenario == upgrade ]]; then install_sha=$source_sha; fi
as_application git -C "$test_home/cloudx" checkout -B main "$install_sha"
as_application "$controller_node" "$controller/scripts/ci/lifecycle.mjs" install "$scenario" "$source_sha" "$target_sha" "$test_home/cloudx" "$evidence"

if [[ $scenario == upgrade ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=api.github.com \
    -addext 'subjectAltName=DNS:api.github.com' -keyout "$fixture/catalog.key" -out "$fixture/catalog.crt" >> "$evidence/host-setup.log" 2>&1
  chmod 0600 "$fixture/catalog.key"
  "$controller_node" "$controller/scripts/ci/lifecycle-catalog.mjs" "$fixture/catalog.key" "$fixture/catalog.crt" "$source_sha" "$target_sha" > "$evidence/catalog.log" 2>&1 &
  catalog_pid=$!
  cp /etc/hosts "$fixture/hosts"
  hosts_changed=1
  printf '\n127.0.0.1 api.github.com\n' >> /etc/hosts
  # Preserve installer-generated units. EnvironmentFile is the supported configuration interface.
  printf '\nNODE_EXTRA_CA_CERTS=%s\n' "$fixture/catalog.crt" >> "$test_home/.config/cloudx/cloudx.env"
  as_application systemctl --user restart cloudx.service
fi
as_application "$controller_node" "$controller/scripts/ci/lifecycle.mjs" exercise "$scenario" "$source_sha" "$target_sha" "$test_home/cloudx" "$evidence"
