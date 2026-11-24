import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { configureLifecycleApt } from "./lifecycle-apt.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(uri = "mirror+file:/etc/apt/apt-mirrors.txt") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx apt "));
  directories.push(root);
  const apt = path.join(root, "apt");
  const evidence = path.join(root, "evidence");
  const sources = path.join(apt, "sources.list.d/ubuntu.sources");
  fs.mkdirSync(path.dirname(sources), { recursive: true });
  fs.mkdirSync(path.join(apt, "apt.conf.d"));
  const original = `# Runner Ubuntu sources\nTypes: deb deb-src\nURIs: ${uri}\nSuites: noble noble-updates noble-backports\nComponents: main universe restricted multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\nArchitectures: amd64 i386\n\nTypes: deb\nURIs: http://security.ubuntu.com/ubuntu/\nSuites: noble-security\nComponents: main universe restricted multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n`;
  fs.writeFileSync(sources, original);
  fs.writeFileSync(
    path.join(apt, "apt.conf.d/zz-retries"),
    'Acquire::Retries "10";\nAcquire::https::Timeout "600";\n',
  );
  return { root, apt, evidence, sources, original };
}

it.each([
  "mirror+file:/etc/apt/apt-mirrors.txt",
  "http://us-east-2.ec2.archive.ubuntu.com/ubuntu",
  "http://azure.archive.ubuntu.com/ubuntu/",
  "https://archive.ubuntu.com/ubuntu",
])(
  "configures the official HTTPS archive instead of %s and verifies real APT settings",
  (uri) => {
    const { apt, evidence, sources, original } = fixture(uri);
    const vendor = path.join(apt, "sources.list.d/vendor.list");
    fs.writeFileSync(vendor, "# An unrelated repository stays unchanged.\n");

    configureLifecycleApt(apt, evidence);

    const effective = fs.readFileSync(sources, "utf8");
    expect(effective).toBe(
      original.replace(
        /^URIs:.*$/gm,
        "URIs: https://archive.ubuntu.com/ubuntu",
      ),
    );
    expect(
      fs.readFileSync(path.join(evidence, "apt-original.sources"), "utf8"),
    ).toBe(original);
    expect(
      fs.readFileSync(path.join(evidence, "apt-effective.sources"), "utf8"),
    ).toBe(effective);
    expect(
      fs.readFileSync(path.join(evidence, "apt-acquire-original.txt"), "utf8"),
    ).toContain('Acquire::Retries "10";');
    expect(
      fs.readFileSync(path.join(evidence, "apt-acquire-effective.txt"), "utf8"),
    ).toBe(
      'Acquire::Retries "0";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n',
    );
    expect(fs.readFileSync(vendor, "utf8")).toBe(
      "# An unrelated repository stays unchanged.\n",
    );
    // APT parses the resulting deb822 file without downloads or host state changes.
    const uris = execFileSync(
      "apt-get",
      [
        "-o",
        `Dir::State=${path.join(evidence, "apt-state")}`,
        "-o",
        `Dir::Cache=${path.join(evidence, "apt-cache")}`,
        "--print-uris",
        "update",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          APT_CONFIG: path.join(evidence, "apt-reader.conf"),
          LC_ALL: "C",
        },
      },
    );
    expect(uris).toContain(
      "https://archive.ubuntu.com/ubuntu/dists/noble/InRelease",
    );
    expect(uris).toContain(
      "https://archive.ubuntu.com/ubuntu/dists/noble-security/InRelease",
    );
    expect(uris).not.toMatch(/ec2|azure|mirror\+file|http:/);
  },
);

it.each([
  [
    "missing signing key",
    (source) =>
      source.replaceAll(
        "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n",
        "",
      ),
    "signing key",
  ],
  [
    "different signing key",
    (source) => source.replaceAll("ubuntu-archive-keyring.gpg", "other.gpg"),
    "signing key",
  ],
  [
    "unsupported Ubuntu release",
    (source) => source.replaceAll("noble", "resolute"),
    "Unsupported Ubuntu suite",
  ],
  [
    "missing security",
    (source) => source.split("\n\n")[0],
    "updates, and security",
  ],
  [
    "untrusted option",
    (source) => `${source}Trusted: yes\n`,
    "Unsupported Ubuntu source field",
  ],
  [
    "unknown archive",
    (source) =>
      source.replace(
        "mirror+file:/etc/apt/apt-mirrors.txt",
        "https://packages.example.test/ubuntu",
      ),
    "Unsupported Ubuntu archive URI",
  ],
  [
    "multiline URI",
    (source) =>
      source.replace(
        "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
        "URIs:\n mirror+file:/etc/apt/apt-mirrors.txt",
      ),
    "Unsupported Ubuntu source field or continuation",
  ],
  [
    "unsupported architecture",
    (source) => source.replace("amd64 i386", "arm64"),
    "amd64 Ubuntu runner",
  ],
  [
    "duplicate field",
    (source) => `${source}Types: deb\n`,
    "Unsupported Ubuntu source field or continuation",
  ],
])(
  "rejects %s before changing package configuration",
  (_name, change, error) => {
    const { apt, evidence, sources, original } = fixture();
    const unsupported = change(original);
    fs.writeFileSync(sources, unsupported);

    expect(() => configureLifecycleApt(apt, evidence)).toThrow(error);

    expect(fs.readFileSync(sources, "utf8")).toBe(unsupported);
    expect(fs.readdirSync(path.join(apt, "apt.conf.d"))).toEqual([
      "zz-retries",
    ]);
    expect(
      fs.readFileSync(path.join(evidence, "apt-original.sources"), "utf8"),
    ).toBe(unsupported);
  },
);

it("fails clearly when later APT configuration overrides the bounded acquire settings", () => {
  const { apt, evidence } = fixture();
  fs.writeFileSync(path.join(apt, "apt.conf"), 'Acquire::Retries "50";\n');

  expect(() => configureLifecycleApt(apt, evidence)).toThrow(
    "Effective Acquire::Retries must be 0",
  );

  expect(
    fs.readFileSync(path.join(evidence, "apt-acquire-effective.txt"), "utf8"),
  ).toContain('Acquire::Retries "50";');
});

it("prepares APT before the disposable host's first package operation", () => {
  const { root, apt, evidence, sources } = fixture();
  const host = fs.readFileSync("scripts/ci/lifecycle-host.sh", "utf8");
  const preparation = host.slice(
    host.indexOf(
      '"$controller_node" "$controller/scripts/ci/lifecycle-apt.mjs"',
    ),
    host.indexOf("fixture=$(mktemp"),
  );
  const commands = path.join(root, "commands");
  fs.mkdirSync(commands);
  fs.writeFileSync(
    path.join(commands, "apt-get"),
    '#!/bin/sh\nset -eu\ngrep -q "URIs: https://archive.ubuntu.com/ubuntu" "$sources"\ncat "$evidence/apt-acquire-effective.txt"\nprintf "%s\\n" "$*"\n',
    { mode: 0o755 },
  );

  execFileSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-euc",
      preparation.replace(" /etc/apt ", ' "$apt" '),
    ],
    {
      env: {
        ...process.env,
        PATH: `${commands}:${process.env.PATH}`,
        controller: process.cwd(),
        controller_node: process.execPath,
        apt,
        sources,
        evidence,
      },
    },
  );

  const log = fs.readFileSync(path.join(evidence, "host-setup.log"), "utf8");
  expect(log).toContain('Acquire::Retries "0";');
  expect(log).toContain("update\n");
  expect(log).toContain("install --yes dbus-user-session sudo git openssl\n");
  expect(host.indexOf("CLOUDX_LIFECYCLE_DISPOSABLE:-")).toBeLessThan(
    host.indexOf(preparation),
  );
  expect(host.indexOf("--print-architecture")).toBeLessThan(
    host.indexOf(preparation),
  );
});
