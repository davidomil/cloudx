import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it.each([true, false])(
  "isolates application command lookup with an inherited runner PATH: %s",
  (hasRunnerPath) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx host env "));
    directories.push(root);
    const environment = path.join(root, "runner-environment");
    const original = [
      "# Runner environment",
      ...(hasRunnerPath ? ['PATH="/home/runner/.cargo/bin:/usr/bin"'] : []),
      'XDG_CONFIG_HOME="/home/runner/.config"',
      "  XDG_RUNTIME_DIR=/run/user/1001",
      "KEEP_PATH=/opt/cache",
      "LANG=C.UTF-8",
      "",
    ].join("\n");
    fs.writeFileSync(environment, original);
    const host = fs.readFileSync("scripts/ci/lifecycle-host.sh", "utf8");
    // Execute the host's actual preparation block against a temporary file.
    const setup = host
      .slice(
        host.indexOf("cp -p /etc/environment"),
        host.indexOf("loginctl enable-linger"),
      )
      .replaceAll("/etc/environment", '"$environment"');
    const controllerBin = path.dirname(process.execPath);
    const applicationPath = `${controllerBin}:/usr/local/bin:/usr/bin:/bin`;
    const result = execFileSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-euc",
        `${setup}\nset -a\nsource "$environment"\n"$controller_node" --input-type=module -e '
          import { spawnSync } from "node:child_process";
          const missing = spawnSync("cloudx-lifecycle-absent-executable");
          console.log(JSON.stringify({ path: process.env.PATH, error: missing.error?.code,
            config: process.env.XDG_CONFIG_HOME, runtime: process.env.XDG_RUNTIME_DIR }));
        '`,
      ],
      {
        env: {
          PATH: process.env.PATH,
          environment,
          fixture: root,
          controller_bin: controllerBin,
          controller_node: process.execPath,
          application_path: applicationPath,
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );

    expect(JSON.parse(result)).toEqual({
      path: applicationPath,
      error: "ENOENT",
    });
    expect(fs.readFileSync(path.join(root, "environment"), "utf8")).toBe(
      original,
    );
    expect(fs.readFileSync(environment, "utf8")).toContain(
      "KEEP_PATH=/opt/cache\nLANG=C.UTF-8\n",
    );
  },
);

it("overrides the generated service PATH before checking a transient service", () => {
  const result = runServiceProbe();

  expect(result.status).toBe(0);
  expect(result.manager.environment.PATH).toBe(result.applicationPath);
  expect(result.output).toContain(
    `PATH: actual=<${result.applicationPath}> expected=<${result.applicationPath}>`,
  );
  expect(result.output).toContain("XDG_CONFIG_HOME: inherited=<<unset>>");
  expect(result.output).toContain("nested user-manager access passes.");
  expect(
    result.commands.find(({ command }) => command === "systemd-run").args,
  ).toContain("--expand-environment=no");
});

it.each(["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "PATH"])(
  "reports every environment check when the service has an incorrect %s",
  (variable) => {
    const actual =
      variable === "PATH"
        ? "/usr/bin:/bin:/runner-owned/path"
        : "/runner-owned/path";
    const result = runServiceProbe({ [variable]: actual });

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      `${variable}: actual=<${actual}> expected=<${result.expected[variable]}>`,
    );
    for (const name of Object.keys(result.expected))
      expect(result.output).toMatch(
        new RegExp(`${name}: actual=<.*> expected=<`),
      );
    expect(result.output).not.toContain("Checking nested user-manager access.");
    expect(result.output).not.toContain("nested user-manager access passes.");
  },
);

it("reports nested user-manager failure after all environment checks pass", () => {
  const result = runServiceProbe({}, false);

  expect(result.status).toBe(1);
  expect(result.output).toContain("Checking nested user-manager access.");
  expect(result.output).toContain(
    "Failed to connect to bus: No such file or directory",
  );
  expect(result.output).not.toContain("nested user-manager access passes.");
});

function runServiceProbe(serviceOverrides = {}, busAvailable = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx service probe "));
  directories.push(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const applicationPath = `${bin}:/usr/bin:/bin`;
  const expected = {
    HOME: path.join(root, "application home"),
    XDG_CONFIG_HOME: path.join(root, "application home", ".config"),
    XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
    PATH: applicationPath,
  };
  const managerFile = path.join(root, "manager.json");
  const commandsFile = path.join(root, "commands.jsonl");
  fs.writeFileSync(
    managerFile,
    JSON.stringify({
      environment: {
        HOME: expected.HOME,
        XDG_RUNTIME_DIR: expected.XDG_RUNTIME_DIR,
        PATH: `${applicationPath}:/snap/bin`,
      },
      serviceOverrides,
      busAvailable,
    }),
  );
  // Model the manager separately from the caller, then run the actual probe shell.
  const managerCommand = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const managerFile = process.env.CLOUDX_PROBE_MANAGER;
const commandsFile = process.env.CLOUDX_PROBE_COMMANDS;
const manager = JSON.parse(fs.readFileSync(managerFile, "utf8"));
fs.appendFileSync(commandsFile, JSON.stringify({ command, args }) + "\\n");
if (command === "systemctl") {
  if (args[1] === "set-environment") {
    for (const assignment of args.slice(2)) {
      const separator = assignment.indexOf("=");
      manager.environment[assignment.slice(0, separator)] = assignment.slice(separator + 1);
    }
    fs.writeFileSync(managerFile, JSON.stringify(manager));
  } else if (args[1] === "show-environment" && !manager.busAvailable) {
    console.error("Failed to connect to bus: No such file or directory");
    process.exit(1);
  }
} else {
  const executable = args.indexOf("/bin/sh");
  const result = spawnSync(args[executable], args.slice(executable + 1), {
    env: { ...manager.environment, ...manager.serviceOverrides,
      CLOUDX_PROBE_MANAGER: managerFile, CLOUDX_PROBE_COMMANDS: commandsFile },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
`;
  for (const command of ["systemctl", "systemd-run"])
    fs.writeFileSync(path.join(bin, command), managerCommand, { mode: 0o755 });
  const host = fs.readFileSync("scripts/ci/lifecycle-host.sh", "utf8");
  const probe = host.slice(
    host.indexOf(
      "as_application systemctl --user",
      host.indexOf('systemctl start "user@'),
    ),
    host.indexOf("as_application git clone"),
  );
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-euc", `as_application() { "$@"; }\n${probe}`],
    {
      env: {
        PATH: applicationPath,
        test_home: expected.HOME,
        application_path: applicationPath,
        evidence: root,
        CLOUDX_PROBE_MANAGER: managerFile,
        CLOUDX_PROBE_COMMANDS: commandsFile,
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  return {
    status: result.status,
    applicationPath,
    expected,
    output: fs.readFileSync(path.join(root, "user-manager.txt"), "utf8"),
    manager: JSON.parse(fs.readFileSync(managerFile, "utf8")),
    commands: fs
      .readFileSync(commandsFile, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse),
  };
}
