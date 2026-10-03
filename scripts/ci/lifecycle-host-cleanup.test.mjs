import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function failUserManagerSetup(failure) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx cleanup "));
  directories.push(fixture);
  const evidence = path.join(fixture, "evidence");
  const published = path.join(fixture, "published");
  const home = path.join(fixture, "home");
  const bin = path.join(fixture, "bin");
  const environment = path.join(fixture, "host-environment");
  for (const directory of [
    evidence,
    published,
    bin,
    path.join(fixture, "sudoers"),
  ])
    fs.mkdirSync(directory);
  fs.writeFileSync(environment, 'PATH="/runner/bin"\nLANG=C.UTF-8\n');
  // Model the application account's initially read-only access without root.
  fs.chmodSync(evidence, 0o500);
  const command = path.join(bin, "host-command");
  fs.writeFileSync(
    command,
    `#!/bin/bash
set -eu
evidence=${quote(evidence)}
home=${quote(home)}
failure=${quote(failure)}
case "\${0##*/}" in
  useradd) mkdir "$home" ;;
  id) printf '12345\\n' ;;
  chown)
    if [[ "\${*: -1}" == "$evidence" ]]; then
      [[ "$1" == cloudx-fixture:cloudx-fixture ]]
      chmod u+w "$evidence"
    fi
    ;;
  loginctl)
    if [[ "$1" == enable-linger && "$failure" == linger ]]; then exit 42; fi
    ;;
  systemctl)
    if [[ "$1" == start && "$failure" == manager ]]; then exit 43; fi
    printf 'ActiveState=inactive\\n'
    ;;
  systemd-run) [[ "$failure" != probe ]] || exit 44 ;;
  runuser)
    [[ "$1" == -u && "$2" == cloudx-fixture && "$3" == -- ]]
    shift 3
    # Enforce the modeled account permission even when the test runner is root.
    for argument in "$@"; do
      if [[ "$argument" == collect ]]; then
        [[ $(stat -c %a "$evidence") == 700 ]] || exit 77
      fi
    done
    exec "$@"
    ;;
  curl) printf 'Services have not been installed.\\n' >&2; exit 7 ;;
  journalctl) printf 'User manager setup failed.\\n' ;;
  pgrep) exit 1 ;;
  pkill|userdel) ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  for (const name of [
    "useradd",
    "id",
    "chown",
    "loginctl",
    "systemctl",
    "systemd-run",
    "runuser",
    "curl",
    "journalctl",
    "pgrep",
    "pkill",
    "userdel",
  ])
    fs.symlinkSync(command, path.join(bin, name));

  const host = fs.readFileSync("scripts/ci/lifecycle-host.sh", "utf8");
  const functions = host.slice(
    host.indexOf("as_application()"),
    host.indexOf("[[ ${CLOUDX_LIFECYCLE_DISPOSABLE"),
  );
  const setup = host.slice(
    host.indexOf("[[ ! -e $test_home ]]"),
    host.indexOf("as_application git clone"),
  );
  // Run production setup and EXIT cleanup, redirecting all host file writes.
  const script = `${functions}\n${setup}`
    .replaceAll("/etc/sudoers.d", path.join(fixture, "sudoers"))
    .replaceAll("/etc/environment", '"$host_environment"');
  const result = spawnSync("bash", ["--noprofile", "--norc", "-euc", script], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      host_environment: environment,
      scenario: "install",
      source_sha: "a".repeat(40),
      target_sha: "b".repeat(40),
      controller: process.cwd(),
      controller_node: process.execPath,
      application_path: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      PLAYWRIGHT_BROWSERS_PATH: fixture,
      test_user: "cloudx-fixture",
      test_home: home,
      user_created: "0",
      hosts_changed: "0",
      environment_changed: "0",
      catalog_pid: "",
      fixture,
      evidence,
      published_evidence: published,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { result, published, environment };
}

it.each([
  ["linger", 42],
  ["manager", 43],
  ["probe", 44],
])(
  "collects diagnostics and preserves failure when %s setup fails",
  (failure, status) => {
    const { result, published, environment } = failUserManagerSetup(failure);

    expect(result.status, result.stderr).toBe(status);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(published, "host-result.json"), "utf8"),
      ),
    ).toMatchObject({ scenario: "install", exitCode: status });
    const responses = JSON.parse(
      fs.readFileSync(path.join(published, "final-responses.json"), "utf8"),
    );
    expect(Object.keys(responses)).toEqual([
      "web",
      "runtime",
      "asr",
      "documentation",
    ]);
    for (const response of Object.values(responses))
      expect(response.error).toContain("Services have not been installed.");
    expect(
      fs.readFileSync(path.join(published, "journal.txt"), "utf8"),
    ).toContain("User manager setup failed.");
    expect(fs.readFileSync(environment, "utf8")).toBe(
      'PATH="/runner/bin"\nLANG=C.UTF-8\n',
    );
  },
);
