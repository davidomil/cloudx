import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { InstallerRunner, runInstaller, parseArgs } from "./install-cloudx.mjs";
import {
  inspectUpdateTarget,
  updateCheckout,
  documentationReadinessUrl,
} from "./install-update.mjs";

const scratch = [];
afterEach(() =>
  scratch
    .splice(0)
    .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })),
);
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-update-test-"));
  scratch.push(dir);
  return dir;
}
function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}
function checkout({ includeInstaller = false } = {}) {
  const dir = directory();
  git(dir, "init", "--bare", "--initial-branch=main", "origin.git");
  git(dir, "clone", path.join(dir, "origin.git"), "author");
  const author = path.join(dir, "author");
  git(author, "config", "user.name", "Installer test");
  git(author, "config", "user.email", "installer@example.invalid");
  fs.writeFileSync(path.join(author, "version"), "one\n");
  if (includeInstaller) {
    fs.mkdirSync(path.join(author, "scripts"));
    for (const file of ["install-cloudx.mjs", "install-update.mjs"])
      fs.copyFileSync(
        path.join(process.cwd(), "scripts", file),
        path.join(author, "scripts", file),
      );
  }
  git(author, "add", ".");
  git(author, "commit", "-m", "TEST: initial");
  git(author, "push", "origin", "main");
  git(dir, "clone", path.join(dir, "origin.git"), "installed");
  const root = path.join(dir, "installed");
  git(root, "config", "user.name", "Installer test");
  git(root, "config", "user.email", "installer@example.invalid");
  fs.writeFileSync(path.join(author, "version"), "two\n");
  if (includeInstaller)
    fs.writeFileSync(
      path.join(author, "scripts/install-cloudx.mjs"),
      'console.log("updated installer executed");\n',
    );
  git(author, "commit", "-am", "TEST: update");
  git(author, "push", "origin", "main");
  const mutations = [];
  const commands = {
    inspect: (command, args) => git(root, ...args),
    run: (command, args) => {
      mutations.push([command, ...args]);
      return git(root, ...args);
    },
    statusOk: (command, args) =>
      spawnSync(command, args, { cwd: root, stdio: "ignore" }).status === 0,
  };
  return {
    root,
    commands,
    mutations,
    latest: git(author, "rev-parse", "HEAD"),
  };
}

describe("updating the installed checkout from main", () => {
  it.each(["tracking main", "detached", "no upstream"])(
    "advances %s to main without changing its branch choice",
    (kind) => {
      const fixture = checkout();
      if (kind === "detached") git(fixture.root, "checkout", "--detach");
      if (kind === "no upstream")
        git(fixture.root, "checkout", "--no-track", "-b", "deploy/release");
      const beforeBranch = git(
        fixture.root,
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      );
      updateCheckout(fixture.commands, { repoRoot: fixture.root });
      expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.latest);
      expect(git(fixture.root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
        beforeBranch,
      );
    },
  );

  it.each(["unstaged", "staged", "untracked", "ahead", "diverged"])(
    "preserves %s work and rejects the update",
    (kind) => {
      const fixture = checkout();
      if (kind === "ahead")
        git(fixture.root, "pull", "--ff-only", "origin", "main");
      const file = kind === "untracked" ? "local-file" : "version";
      fs.writeFileSync(path.join(fixture.root, file), "local work\n");
      if (["staged", "ahead", "diverged"].includes(kind))
        git(fixture.root, "add", file);
      if (["ahead", "diverged"].includes(kind))
        git(fixture.root, "commit", "-m", "TEST: local work");
      const beforeHead = git(fixture.root, "rev-parse", "HEAD");
      const beforeStatus = git(fixture.root, "status", "--porcelain");
      expect(() =>
        updateCheckout(fixture.commands, { repoRoot: fixture.root }),
      ).toThrow(/local changes|not contained in origin\/main/i);
      expect(git(fixture.root, "rev-parse", "HEAD")).toBe(beforeHead);
      expect(git(fixture.root, "status", "--porcelain")).toBe(beforeStatus);
      expect(fs.readFileSync(path.join(fixture.root, file), "utf8")).toBe(
        "local work\n",
      );
      if (["unstaged", "staged", "untracked"].includes(kind))
        expect(fixture.mutations).toEqual([]);
    },
  );

  it("does not fetch or merge during a dry run", () => {
    const fixture = checkout();
    const beforeHead = git(fixture.root, "rev-parse", "HEAD");
    fixture.commands.run = (...args) => fixture.mutations.push(args);
    updateCheckout(fixture.commands, { repoRoot: fixture.root, dryRun: true });
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(fixture.mutations).toHaveLength(2);
  });

  it("rejects a missing main branch without updating HEAD", () => {
    const fixture = checkout();
    git(
      path.join(fixture.root, "..", "origin.git"),
      "symbolic-ref",
      "HEAD",
      "refs/heads/other",
    );
    git(
      path.join(fixture.root, "..", "origin.git"),
      "update-ref",
      "-d",
      "refs/heads/main",
    );
    const beforeHead = git(fixture.root, "rev-parse", "HEAD");
    expect(() =>
      updateCheckout(fixture.commands, { repoRoot: fixture.root }),
    ).toThrow();
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(beforeHead);
  });
});

function installation() {
  const root = directory();
  const paths = {
    repoRoot: root,
    systemdDir: path.join(root, "units"),
    envPath: path.join(root, "cloudx.env"),
  };
  fs.mkdirSync(paths.systemdDir);
  fs.writeFileSync(paths.envPath, "CLOUDX_PORT=3001\n");
  const unitPath = path.join(paths.systemdDir, "cloudx.service");
  fs.writeFileSync(unitPath, "[Service]\n");
  const properties = {
    Id: "cloudx.service",
    LoadState: "loaded",
    WorkingDirectory: root,
    EnvironmentFiles: `${paths.envPath} (ignore_errors=no)`,
    FragmentPath: unitPath,
    NeedDaemonReload: "no",
    DropInPaths: "",
  };
  const extraUnits = {};
  const commands = {
    inspect: (_command, args) => {
      const selected =
        args[2] === properties.Id
          ? properties
          : (extraUnits[args[2]] ?? { LoadState: "not-found" });
      return Object.entries(selected)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
    },
  };
  return { paths, properties, commands, extraUnits };
}

describe("choosing the service owned by this checkout", () => {
  it("accepts the matching standard installation", () => {
    const fixture = installation();
    expect(inspectUpdateTarget(fixture)).toMatchObject({
      kind: "standard",
      servicesInstalled: true,
    });
  });
  it.each([
    ["another checkout", { WorkingDirectory: "/another-checkout" }],
    [
      "another environment",
      { EnvironmentFiles: "/another/cloudx.env (ignore_errors=no)" },
    ],
    ["another unit fragment", { FragmentPath: "/another/cloudx.service" }],
    ["a stale service definition", { NeedDaemonReload: "yes" }],
    ["a masked service", { LoadState: "masked" }],
    ["a drop-in override", { DropInPaths: "/another/override.conf" }],
  ])("rejects %s", (_name, overrides) => {
    const fixture = installation();
    Object.assign(fixture.properties, overrides);
    expect(() => inspectUpdateTarget(fixture)).toThrow();
  });
  it.each(["cloudx-asr.service", "cloudx-documentation.service"])(
    "rejects an auxiliary %s loaded outside the standard unit directory",
    (name) => {
      const fixture = installation();
      fixture.extraUnits[name] = {
        ...fixture.properties,
        Id: name,
        FragmentPath: "/etc/systemd/user/" + name,
      };
      expect(() => inspectUpdateTarget(fixture)).toThrow(
        "does not match the standard Cloudx unit",
      );
    },
  );
  it("accepts an explicitly selected transient web service without an environment file", () => {
    const fixture = installation();
    Object.assign(fixture.properties, {
      Id: "cloudx-forge-test-3002.service",
      EnvironmentFiles: "",
      FragmentPath:
        "/run/user/1000/systemd/transient/cloudx-forge-test-3002.service",
    });
    expect(
      inspectUpdateTarget({
        ...fixture,
        service: fixture.properties.Id,
        port: 3002,
      }),
    ).toMatchObject({
      kind: "web",
      serviceNames: [fixture.properties.Id],
      port: 3002,
    });
  });
});

describe("documentation service readiness", () => {
  it.each([
    [{}, "http://127.0.0.1:7820/ready"],
    [{ CLOUDX_DOCUMENTATION_PORT: "9000" }, "http://127.0.0.1:9000/ready"],
    [
      {
        CLOUDX_DOCUMENTATION_HOST: "0.0.0.0",
        CLOUDX_DOCUMENTATION_PORT: "9000",
      },
      "http://127.0.0.1:9000/ready",
    ],
    [
      { CLOUDX_DOCUMENTATION_HOST: "::", CLOUDX_DOCUMENTATION_PORT: "9000" },
      "http://[::1]:9000/ready",
    ],
  ])("checks the configured listener %j", (env, expected) =>
    expect(documentationReadinessUrl(env)).toBe(expected),
  );
  it.each(["0", "65536", "9000junk"])("rejects invalid port %s", (port) =>
    expect(() =>
      documentationReadinessUrl({ CLOUDX_DOCUMENTATION_PORT: port }),
    ).toThrow(),
  );
});

describe("installer update entrypoints", () => {
  it("reloads the installer from the fetched commit before running package updates", () => {
    const fixture = checkout({ includeInstaller: true });
    const bin = path.join(directory(), "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      '#!/bin/sh\nprintf "LoadState=loaded\\nNeedDaemonReload=no\\nWorkingDirectory=%s\\n" "$CLOUDX_TEST_CHECKOUT"\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [
        "scripts/install-cloudx.mjs",
        "--update",
        "--service",
        "preview.service",
        "--port",
        "3002",
        "--yes",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CLOUDX_TEST_CHECKOUT: fixture.root,
        },
      },
    );
    expect(result.stderr).not.toContain("Error");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("updated installer executed");
    expect(result.stdout).not.toContain("npm ci");
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.latest);
  });

  it("routes shell updates to the Node preflight before bootstrap packages", () => {
    const bin = directory();
    fs.writeFileSync(
      path.join(bin, "node"),
      '#!/bin/sh\nprintf "update entry: %s\\n" "$*"\nexit 17\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      "bash",
      ["install.sh", "--update", "--dry-run", "--yes"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.status).toBe(17);
    expect(result.stdout).toContain(
      "update entry: scripts/install-cloudx.mjs --update --dry-run --yes",
    );
    expect(result.stdout).not.toContain("apt-get");
  });

  it.each([
    ["--update", "--service", "preview.service"],
    ["--update", "--port", "3002"],
    ["--service", "preview.service", "--port", "3002"],
    ["--update", "--service", "preview.service", "--port", "0"],
  ])("rejects incomplete custom service options %j", (...args) =>
    expect(() => parseArgs(args)).toThrow(),
  );
});

function plannedUpdate({ service = false, modelExists = false } = {}) {
  const fixture = checkout();
  const fixtureHome = directory();
  const envPath = path.join(fixtureHome, ".config/cloudx/cloudx.env");
  const unitDir = path.join(fixtureHome, ".config/systemd/user");
  const modelDir = path.join(fixtureHome, "saved-model");
  const dataDir = path.join(fixtureHome, "saved-data");
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.mkdirSync(unitDir, { recursive: true });
  fs.mkdirSync(modelDir);
  if (modelExists) fs.writeFileSync(path.join(modelDir, "config.json"), "{}");
  const envText = `CLOUDX_PORT=3443\nCLOUDX_ASR_MODEL_PATH=${modelDir}\nCLOUDX_DATA_DIR=${dataDir}\nCLOUDX_DOCUMENTATION_PORT=9000\n`;
  fs.writeFileSync(envPath, envText);
  fs.writeFileSync(
    path.join(unitDir, "cloudx.service"),
    "original production unit",
  );
  const runner = new InstallerRunner({
    dryRun: true,
    cwd: fixture.root,
    log: () => {},
  });
  const inspect = runner.inspect.bind(runner);
  runner.inspect = (command, args) => {
    if (command === "git") return inspect(command, args);
    if (!service && !fs.existsSync(path.join(unitDir, args[2])))
      return "LoadState=not-found";
    return [
      "LoadState=loaded",
      "NeedDaemonReload=no",
      `WorkingDirectory=${fixture.root}`,
      `FragmentPath=${path.join(unitDir, args[2])}`,
      `EnvironmentFiles=${envPath} (ignore_errors=no)`,
    ].join("\n");
  };
  const options = {
    repoRoot: fixture.root,
    home: fixtureHome,
    env: { PATH: "/usr/bin" },
    yes: true,
    dryRun: true,
    update: true,
    runner,
    osRelease: { ID: "ubuntu", VERSION_ID: "24.04" },
    networkInterfaces: {},
    ...(service ? { service: "preview.service", port: 3002 } : {}),
  };
  return {
    ...fixture,
    runner,
    options,
    envPath,
    envText,
    unitDir,
    modelDir,
    dataDir,
  };
}

describe("the complete updater plan", () => {
  it("rebuilds and restarts only the selected custom web service", async () => {
    const fixture = plannedUpdate({ service: true });
    const result = await runInstaller(fixture.options);
    const planned = fixture.runner.commands
      .filter((command) => !command.inspect)
      .map((command) => [command.command, ...command.args]);
    expect(result).toMatchObject({ port: 3002, restartServices: true });
    expect(planned).toContainEqual([
      "systemctl",
      "--user",
      "restart",
      "preview.service",
    ]);
    expect(planned.filter((command) => command[0] === "npm")).toEqual([
      ["npm", "-v"],
      ["npm", "ci"],
      ["npm", "run", "build"],
    ]);
    expect(
      planned.filter((command) => command[0] === "systemctl"),
    ).toHaveLength(1);
    expect(
      planned.some((command) =>
        /uv|python|codex|sudo|cert:create/.test(command.join(" ")),
      ),
    ).toBe(false);
    expect(
      fixture.runner.writes.every((write) =>
        write.path.startsWith(path.join(fixture.root, "apps/server/dist")),
      ),
    ).toBe(true);
    expect(fs.readFileSync(fixture.envPath, "utf8")).toBe(fixture.envText);
    expect(
      fs.readFileSync(path.join(fixture.unitDir, "cloudx.service"), "utf8"),
    ).toBe("original production unit");
  });
  it("leaves the selected service running with --no-start", async () => {
    const fixture = plannedUpdate({ service: true });
    const result = await runInstaller({ ...fixture.options, noStart: true });
    expect(result.restartServices).toBe(false);
    expect(
      fixture.runner.commands.filter(
        (command) => !command.inspect && command.command === "systemctl",
      ),
    ).toEqual([]);
  });
  it.each([true, false])(
    "uses the saved ASR model and data paths when model exists=%s",
    async (modelExists) => {
      const fixture = plannedUpdate({ modelExists });
      const result = await runInstaller(fixture.options);
      expect(result.paths.modelDir).toBe(fixture.modelDir);
      expect(result.paths.dataDir).toBe(fixture.dataDir);
      const certificate = fixture.runner.commands.find(
        (command) =>
          command.command === "npm" && command.args.includes("cert:create"),
      );
      expect(certificate.env).toEqual({
        CLOUDX_DATA_DIR: fixture.dataDir,
        CLOUDX_CERT_HOSTS: "",
        CLOUDX_CERT_DAYS: "365",
      });
      const downloads = fixture.runner.commands.filter(
        (command) => path.basename(command.command) === "hf",
      );
      if (modelExists) expect(downloads).toEqual([]);
      else
        expect(downloads[0].args).toEqual([
          "download",
          "Systran/faster-whisper-large-v3",
          "--local-dir",
          fixture.modelDir,
        ]);
      const updatedEnv = fixture.runner.writes.find(
        (write) => write.path === fixture.envPath,
      ).contents;
      expect(updatedEnv).toContain(
        `CLOUDX_DOCUMENTATION_DATA_DIR=${path.join(fixture.dataDir, "documentation")}`,
      );
      expect(
        fixture.runner.commands.some(
          (command) =>
            command.command === "curl" &&
            command.args.includes("http://127.0.0.1:9000/ready"),
        ),
      ).toBe(true);
    },
  );
  it("rejects a sibling checkout before package, Git, or file mutations", async () => {
    const fixture = plannedUpdate();
    fixture.runner.inspect = () =>
      "LoadState=loaded\nNeedDaemonReload=no\nWorkingDirectory=/sibling";
    await expect(runInstaller(fixture.options)).rejects.toThrow(
      "belongs to another checkout",
    );
    expect(
      fixture.runner.commands.filter((command) => !command.inspect),
    ).toEqual([]);
    expect(fixture.runner.writes).toEqual([]);
  });
});
