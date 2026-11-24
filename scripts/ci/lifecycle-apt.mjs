import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const archive = "https://archive.ubuntu.com/ubuntu";
const acquire = {
  "Acquire::Retries": "0",
  "Acquire::http::Timeout": "30",
  "Acquire::https::Timeout": "30",
};

// The disposable amd64 runner uses Noble's standard deb822 Ubuntu source file.
// Reject a different layout rather than rewriting an unknown package authority.
function officialUbuntuSources(original) {
  const suites = new Set();
  let sourceCount = 0;
  const effective = original
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => {
      const fields = new Map();
      for (const line of paragraph.split("\n")) {
        if (!line.trim() || line.trimStart().startsWith("#")) continue;
        const field = /^([A-Za-z][A-Za-z-]*):[ \t]*(\S.*)$/.exec(line);
        assert(
          field && !fields.has(field[1]),
          "Unsupported Ubuntu source field or continuation",
        );
        fields.set(field[1], field[2].trim());
      }
      if (!fields.size) return paragraph;
      for (const name of fields.keys())
        assert(
          [
            "Types",
            "URIs",
            "Suites",
            "Components",
            "Signed-By",
            "Architectures",
          ].includes(name),
          `Unsupported Ubuntu source field: ${name}`,
        );
      assert(
        /^deb(?: deb-src)?$/.test(fields.get("Types")),
        "Ubuntu sources must enable deb packages",
      );
      assert(
        fields.get("Signed-By") ===
          "/usr/share/keyrings/ubuntu-archive-keyring.gpg",
        "Ubuntu sources must retain the Ubuntu archive signing key",
      );
      assert(
        fields
          .get("Components")
          ?.split(/\s+/)
          .every((component) =>
            ["main", "restricted", "universe", "multiverse"].includes(
              component,
            ),
          ),
        "Unsupported Ubuntu components",
      );
      assert(
        !fields.has("Architectures") ||
          fields
            .get("Architectures")
            .split(/\s+/)
            .every((architecture) => ["amd64", "i386"].includes(architecture)),
        "Only the amd64 Ubuntu runner is supported",
      );
      assert(fields.get("Suites"), "Ubuntu sources must declare Noble suites");
      for (const suite of fields.get("Suites").split(/\s+/)) {
        assert(
          [
            "noble",
            "noble-updates",
            "noble-backports",
            "noble-security",
          ].includes(suite),
          `Unsupported Ubuntu suite: ${suite}`,
        );
        suites.add(suite);
      }
      assert(fields.get("URIs"), "Ubuntu sources must declare an archive URI");
      for (const uri of fields.get("URIs").split(/\s+/))
        assert(
          uri === "mirror+file:/etc/apt/apt-mirrors.txt" ||
            /^https?:\/\/(?:archive|security|azure\.archive|[a-z0-9-]+\.ec2\.archive)\.ubuntu\.com\/ubuntu\/?$/.test(
              uri,
            ),
          `Unsupported Ubuntu archive URI: ${uri}`,
        );
      sourceCount++;
      return paragraph.replace(/^URIs:.*$/m, `URIs: ${archive}`);
    })
    .join("\n\n");
  assert(
    sourceCount &&
      ["noble", "noble-updates", "noble-security"].every((suite) =>
        suites.has(suite),
      ),
    "Ubuntu sources must include Noble, updates, and security",
  );
  return effective;
}

export function configureLifecycleApt(aptDirectory, evidenceDirectory) {
  const sources = path.join(aptDirectory, "sources.list.d/ubuntu.sources");
  const original = fs.readFileSync(sources, "utf8");
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDirectory, "apt-original.sources"),
    original,
  );
  const effective = officialUbuntuSources(original);
  assert(
    path.isAbsolute(aptDirectory) && !/["\\\r\n]/.test(aptDirectory),
    "Expected an absolute APT directory without configuration delimiters",
  );
  // APT_CONFIG is read before the config fragments. Command-line Dir::Etc is too late.
  const reader = path.join(evidenceDirectory, "apt-reader.conf");
  fs.writeFileSync(reader, `Dir::Etc "${aptDirectory}";\n`);
  const readAcquire = () =>
    execFileSync("apt-config", ["dump", ...Object.keys(acquire)], {
      encoding: "utf8",
      env: { ...process.env, APT_CONFIG: reader, LC_ALL: "C" },
    });
  fs.writeFileSync(
    path.join(evidenceDirectory, "apt-acquire-original.txt"),
    readAcquire(),
  );
  const configuration = Object.entries(acquire)
    .map(([key, value]) => `${key} "${value}";\n`)
    .join("");
  // Runner images can already contain zz-retries. Verify the merged result too.
  const configurationFile = path.join(
    aptDirectory,
    "apt.conf.d/zzzz-cloudx-lifecycle",
  );
  assert(
    !fs.existsSync(configurationFile),
    "Lifecycle APT configuration already exists",
  );
  fs.writeFileSync(sources, effective);
  fs.writeFileSync(configurationFile, configuration);
  fs.writeFileSync(
    path.join(evidenceDirectory, "apt-effective.sources"),
    effective,
  );
  fs.writeFileSync(
    path.join(evidenceDirectory, "apt-lifecycle.conf"),
    configuration,
  );
  const actual = readAcquire();
  fs.writeFileSync(
    path.join(evidenceDirectory, "apt-acquire-effective.txt"),
    actual,
  );
  for (const [key, value] of Object.entries(acquire))
    assert(
      actual.split("\n").includes(`${key} "${value}";`),
      `Effective ${key} must be ${value}`,
    );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  assert(
    process.argv.length === 4,
    "Expected APT configuration directory and evidence directory",
  );
  configureLifecycleApt(process.argv[2], process.argv[3]);
}
