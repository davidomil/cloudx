import { execFileSync } from "node:child_process";
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
