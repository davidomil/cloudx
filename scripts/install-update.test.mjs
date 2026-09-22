import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
function writeFile(root, file, contents) {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}
function publishFile(fixture, file, contents) {
  writeFile(fixture.author, file, contents);
  git(fixture.author, "add", "--", file);
  git(fixture.author, "commit", "-m", "TEST: upstream file");
  git(fixture.author, "push", "origin", "main");
  fixture.latest = git(fixture.author, "rev-parse", "HEAD");
}
function updateCli(fixture, ...args) {
  const bin = directory();
  const serviceLog = path.join(bin, "service-calls");
  fs.writeFileSync(
    path.join(bin, "systemctl"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$CLOUDX_TEST_SERVICE_LOG"',
      '[ "$1" = --user ] && [ "$2" = show ] || exit 19',
      'printf "LoadState=loaded\\nActiveState=inactive\\nMainPID=0\\nNeedDaemonReload=no\\nWorkingDirectory=%s\\n" "$CLOUDX_TEST_CHECKOUT"',
    ].join("\n"),
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, [
    "scripts/install-cloudx.mjs", "--update", "--service", "preview.service",
    "--port", "3002", "--yes", ...args,
  ], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CLOUDX_TEST_CHECKOUT: fixture.root,
      CLOUDX_TEST_SERVICE_LOG: serviceLog,
      CLOUDX_INSTALL_UPDATED_COMMIT: "",
      LC_ALL: "C",
    },
  });
  return {
    ...result,
    serviceCalls: fs.readFileSync(serviceLog, "utf8").trim().split("\n"),
  };
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
    for (const file of [
      "install-cloudx.mjs",
      "codex-updater.mjs",
      "install-update.mjs",
      "install-terminal-upgrade.mjs",
      "install-runtime.mjs",
      "terminal-upgrade-recovery.mjs",
      "installer-environment.mjs",
    ])
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
    author,
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

  it.each(["unstaged", "staged", "ahead", "diverged"])(
    "preserves %s work and rejects the update",
    (kind) => {
      const fixture = checkout();
      if (kind === "ahead")
        git(fixture.root, "pull", "--ff-only", "origin", "main");
      const file = "version";
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
      if (["unstaged", "staged"].includes(kind))
        expect(fixture.mutations).toEqual([]);
    },
  );

  it.each(["main", "selected commit"])(
    "preserves unrelated untracked files through an update to %s and reload",
    (target) => {
      const fixture = checkout();
      publishFile(fixture, "diagnostics/upstream.txt", "upstream file\n");
      const localFiles = [
        "local notes.txt",
        "diagnostics/nested/local notes.txt",
        "scratch/deep/notes.txt",
      ];
      const contents = Buffer.from([0, 1, 2, 255, 10]);
      for (const file of localFiles) writeFile(fixture.root, file, contents);
      const options = {
        repoRoot: fixture.root,
        ...(target === "selected commit" ? { targetCommit: fixture.latest } : {}),
      };

      expect(updateCheckout(fixture.commands, options)).toBe(fixture.latest);
      fixture.mutations.length = 0;
      expect(updateCheckout(fixture.commands, {
        ...options,
        updatedCommit: fixture.latest,
      })).toBe(fixture.latest);

      expect(fixture.mutations).toEqual([]);
      expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.latest);
      for (const file of localFiles) {
        expect(fs.readFileSync(path.join(fixture.root, file))).toEqual(contents);
        expect(git(fixture.root, "ls-files", "--", file)).toBe("");
      }
      expect(fs.readFileSync(path.join(fixture.root, "diagnostics/upstream.txt"), "utf8"))
        .toBe("upstream file\n");
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

describe("updating the installed checkout to a selected commit", () => {
  it("installs the selected release even when main has newer changes", () => {
    const fixture = checkout();
    const targetCommit = fixture.latest;
    git(fixture.author, "tag", "v1.0.0", targetCommit);
    fs.writeFileSync(path.join(fixture.author, "version"), "unreleased\n");
    git(fixture.author, "commit", "-am", "TEST: unreleased main change");
    git(fixture.author, "push", "origin", "main", "v1.0.0");

    expect(
      updateCheckout(fixture.commands, {
        repoRoot: fixture.root,
        targetCommit,
      }),
    ).toBe(targetCommit);
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(targetCommit);
    expect(fs.readFileSync(path.join(fixture.root, "version"), "utf8")).toBe(
      "two\n",
    );
    expect(fixture.mutations).toEqual([
      ["git", "fetch", "--no-tags", "origin", targetCommit],
      ["git", "merge", "--ff-only", "--no-edit", targetCommit],
    ]);
  });

  it.each([
    "",
    "main",
    "a".repeat(39),
    "A".repeat(40),
    "--upload-pack=other",
    42,
  ])("rejects malformed target %j before Git commands", (targetCommit) => {
    const inspect = vi.fn();
    expect(() =>
      updateCheckout({ inspect }, { repoRoot: "/unused", targetCommit }),
    ).toThrow("commit SHA");
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(["ahead", "diverged"])(
    "preserves %s history when the selected release cannot be fast-forwarded",
    (kind) => {
      const fixture = checkout();
      if (kind === "ahead")
        git(fixture.root, "pull", "--ff-only", "origin", "main");
      fs.writeFileSync(path.join(fixture.root, "version"), "local commit\n");
      git(fixture.root, "commit", "-am", "TEST: local commit");
      const head = git(fixture.root, "rev-parse", "HEAD");
      expect(() =>
        updateCheckout(fixture.commands, {
          repoRoot: fixture.root,
          targetCommit: fixture.latest,
        }),
      ).toThrow("selected update commit");
      expect(git(fixture.root, "rev-parse", "HEAD")).toBe(head);
      expect(fixture.mutations).toEqual([
        ["git", "fetch", "--no-tags", "origin", fixture.latest],
      ]);
    },
  );

  it("rejects a tag object SHA instead of silently selecting its commit", () => {
    const fixture = checkout();
    git(fixture.author, "tag", "-a", "v1.0.0", "-m", "Release");
    git(fixture.author, "push", "origin", "v1.0.0");
    const targetCommit = git(fixture.author, "rev-parse", "v1.0.0");
    const head = git(fixture.root, "rev-parse", "HEAD");
    expect(() =>
      updateCheckout(fixture.commands, {
        repoRoot: fixture.root,
        targetCommit,
      }),
    ).toThrow("does not identify a commit");
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(head);
  });

  it("leaves the checkout unchanged when origin cannot supply the selected commit", () => {
    const fixture = checkout();
    const head = git(fixture.root, "rev-parse", "HEAD");
    expect(() =>
      updateCheckout(fixture.commands, {
        repoRoot: fixture.root,
        targetCommit: "a".repeat(40),
      }),
    ).toThrow();
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(head);
    expect(fixture.mutations).toEqual([
      ["git", "fetch", "--no-tags", "origin", "a".repeat(40)],
    ]);
  });

  it("keeps the selected commit pinned across installer reload without another fetch", () => {
    const fixture = checkout();
    const targetCommit = fixture.latest;
    updateCheckout(fixture.commands, {
      repoRoot: fixture.root,
      targetCommit,
    });
    fixture.mutations.length = 0;
    expect(
      updateCheckout(fixture.commands, {
        repoRoot: fixture.root,
        targetCommit,
        updatedCommit: targetCommit,
      }),
    ).toBe(targetCommit);
    expect(fixture.mutations).toEqual([]);
    expect(() =>
      updateCheckout(fixture.commands, {
        repoRoot: fixture.root,
        targetCommit: "a".repeat(40),
        updatedCommit: targetCommit,
      }),
    ).toThrow("selected update commit");
    expect(() =>
      updateCheckout(fixture.commands, {
        repoRoot: fixture.root,
        targetCommit,
        updatedCommit: "a".repeat(40),
      }),
    ).toThrow("reloading");
    expect(fixture.mutations).toEqual([]);
  });

  it("plans the selected commit during a dry run without changing HEAD", () => {
    const fixture = checkout();
    const before = git(fixture.root, "rev-parse", "HEAD");
    fixture.commands.run = (command, args) =>
      fixture.mutations.push([command, ...args]);
    updateCheckout(fixture.commands, {
      repoRoot: fixture.root,
      targetCommit: fixture.latest,
      dryRun: true,
    });
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(before);
    expect(fixture.mutations).toEqual([
      ["git", "fetch", "--no-tags", "origin", fixture.latest],
      ["git", "merge", "--ff-only", "--no-edit", fixture.latest],
    ]);
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
  it.each(["cloudx-asr.service", "cloudx-documentation.service", "cloudx-terminal.service"])(
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
  it.each([
    [undefined, "https://127.0.0.1:3002"],
    ["::1", "https://[::1]:3002"],
    ["0:0:0:0:0:0:0:1", "https://[::1]:3002"],
    ["::", "https://[::1]:3002"],
    ["0:0:0:0:0:0:0:0", "https://[::1]:3002"],
    ["0.0.0.0", "https://127.0.0.1:3002"],
    ["192.0.2.12", "https://192.0.2.12:3002"],
    ["2001:db8::12", "https://[2001:db8::12]:3002"],
  ])("uses the selected readiness host %s", (host, origin) => {
    const fixture = installation();
    expect(
      inspectUpdateTarget({
        ...fixture,
        service: fixture.properties.Id,
        port: 3002,
        host,
      }),
    ).toMatchObject({ kind: "web", origin });
  });
  it.each([
    "localhost",
    "https://[::1]",
    "127.0.0.1:3002",
    "::1/path",
    "[::1]",
    "fe80::1%eth0",
    "",
    42,
  ])("rejects invalid readiness host %j before service inspection", (host) => {
    const fixture = installation();
    fixture.commands.inspect = () => {
      throw new Error("Service inspection must not run for an invalid host.");
    };
    expect(() =>
      inspectUpdateTarget({
        ...fixture,
        service: fixture.properties.Id,
        port: 3002,
        host,
      }),
    ).toThrow(/--host.*IPv4 or IPv6/);
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
  it("reloads the production checkout check with unrelated untracked work", () => {
    const fixture = checkout({ includeInstaller: true });
    publishFile(fixture, "scripts/install-cloudx.mjs", [
      'import { updateCheckout } from "./install-update.mjs";',
      'import { execFileSync } from "node:child_process";',
      'const commands = { inspect: (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim() };',
      'updateCheckout(commands, { repoRoot: process.cwd(), updatedCommit: process.env.CLOUDX_INSTALL_UPDATED_COMMIT });',
      'console.log("updated checkout accepted after reload");',
    ].join("\n"));
    const file = "local diagnostics/nested/notes.txt";
    writeFile(fixture.root, file, "keep these notes\n");

    const result = updateCli(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("updated checkout accepted after reload");
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.latest);
    expect(fs.readFileSync(path.join(fixture.root, file), "utf8"))
      .toBe("keep these notes\n");
  });

  it.each([
    ["file replacing a file", "local notes.txt", "local notes.txt"],
    ["directory replacing a file", "local notes", "local notes/upstream.txt"],
    ["file replacing a directory", "local notes/nested/notes.txt", "local notes"],
  ])("rejects an upstream %s before installing packages or changing services", (_name, localFile, upstreamFile) => {
    const fixture = checkout({ includeInstaller: true });
    publishFile(fixture, upstreamFile, "upstream content\n");
    writeFile(fixture.root, localFile, "irreplaceable local notes\n");
    const beforeHead = git(fixture.root, "rev-parse", "HEAD");
    const beforeStatus = git(fixture.root, "status", "--porcelain");
    const beforeIndex = git(fixture.root, "ls-files", "--stage");

    const result = updateCli(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/would be overwritten by merge|would lose untracked files/);
    expect(result.stderr).toContain("local notes");
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(git(fixture.root, "status", "--porcelain")).toBe(beforeStatus);
    expect(git(fixture.root, "ls-files", "--stage")).toBe(beforeIndex);
    expect(fs.readFileSync(path.join(fixture.root, localFile), "utf8"))
      .toBe("irreplaceable local notes\n");
    expect(fs.readFileSync(path.join(fixture.root, "version"), "utf8"))
      .toBe("one\n");
    expect(result.stdout).not.toMatch(/npm ci|apt-get|updated installer executed/);
    expect(result.serviceCalls).toEqual([
      expect.stringMatching(/^--user show preview\.service /),
      expect.stringMatching(/^--user show preview\.service /),
      expect.stringMatching(/^--user show cloudx-terminal\.service /),
    ]);
  });

  it.each(["unrelated", "colliding"])("previews updates with %s untracked files without fetching or merging", (kind) => {
    const fixture = checkout({ includeInstaller: true });
    if (kind === "colliding") publishFile(fixture, "local notes.txt", "upstream content\n");
    writeFile(fixture.root, "local notes.txt", "keep these notes\n");
    writeFile(fixture.root, "local diagnostics/nested/notes.txt", "nested notes\n");
    const beforeHead = git(fixture.root, "rev-parse", "HEAD");
    const beforeRefs = git(fixture.root, "show-ref");
    const beforeStatus = git(fixture.root, "status", "--porcelain");
    const beforeIndex = git(fixture.root, "ls-files", "--stage");

    const result = updateCli(fixture, "--dry-run");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("untracked-path collisions require a real fetch");
    expect(result.stdout).toContain("npm ci");
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(git(fixture.root, "show-ref")).toBe(beforeRefs);
    expect(git(fixture.root, "status", "--porcelain")).toBe(beforeStatus);
    expect(git(fixture.root, "ls-files", "--stage")).toBe(beforeIndex);
    expect(fs.existsSync(path.join(fixture.root, ".git/FETCH_HEAD"))).toBe(false);
    expect(fs.readFileSync(path.join(fixture.root, "local notes.txt"), "utf8"))
      .toBe("keep these notes\n");
    expect(fs.readFileSync(path.join(fixture.root, "local diagnostics/nested/notes.txt"), "utf8"))
      .toBe("nested notes\n");
    expect(result.serviceCalls).toEqual([
      expect.stringMatching(/^--user show preview\.service /),
      expect.stringMatching(/^--user show preview\.service /),
      expect.stringMatching(/^--user show cloudx-terminal\.service /),
    ]);
  });

  it("requires explicit terminal migration and an absolute staged-updater checkout", () => {
    expect(parseArgs(["--update", "--migrate-terminals", "--checkout", "/installed/cloudx"]))
      .toMatchObject({ update: true, migrateTerminals: true, repoRoot: "/installed/cloudx" });
    for (const args of [
      ["--migrate-terminals"], ["--update", "--migrate-terminals", "--non-interactive"],
      ["--update", "--migrate-terminals", "--service", "custom.service", "--port", "3002"],
      ["--checkout", "/installed/cloudx"], ["--update", "--checkout", "relative"],
    ]) expect(() => parseArgs(args)).toThrow();
  });

  it("runs a staged updater against the installed checkout before replacing its files", () => {
    const fixture = checkout({ includeInstaller: true });
    const staged = directory();
    fs.cpSync(path.join(fixture.root, "scripts"), path.join(staged, "scripts"), { recursive: true });
    const bin = directory();
    fs.writeFileSync(path.join(bin, "systemctl"),
      '#!/bin/sh\nprintf "LoadState=loaded\\nActiveState=inactive\\nMainPID=0\\nNeedDaemonReload=no\\nWorkingDirectory=%s\\n" "$CLOUDX_TEST_CHECKOUT"\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [path.join(staged, "scripts/install-cloudx.mjs"),
      "--checkout", fixture.root, "--update", "--service", "preview.service", "--port", "3002", "--yes"], {
      cwd: staged, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLOUDX_TEST_CHECKOUT: fixture.root },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("updated installer executed");
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.latest);
  });

  it("accepts a complete target commit only in update mode", () => {
    const targetCommit = "b".repeat(40);
    expect(
      parseArgs(["--update", "--target-commit", targetCommit]),
    ).toMatchObject({ update: true, targetCommit });
    expect(() => parseArgs(["--target-commit", targetCommit])).toThrow(
      "requires --update",
    );
    for (const invalid of [undefined, "main", "B".repeat(40), "b".repeat(39)]) {
      expect(() =>
        parseArgs([
          "--update",
          "--target-commit",
          ...(invalid ? [invalid] : []),
        ]),
      ).toThrow("commit SHA");
    }
  });

  it("reloads the selected release installer with the same target and commit handoff when main moves ahead", () => {
    const fixture = checkout({ includeInstaller: true });
    fs.writeFileSync(
      path.join(fixture.author, "scripts/install-cloudx.mjs"),
      [
        'console.log("selected release installer executed");',
        "console.log(JSON.stringify({ args: process.argv.slice(2), updatedCommit: process.env.CLOUDX_INSTALL_UPDATED_COMMIT }));",
      ].join("\n"),
    );
    git(fixture.author, "commit", "-am", "TEST: release installer");
    const targetCommit = git(fixture.author, "rev-parse", "HEAD");
    git(fixture.author, "tag", "v1.0.0");
    fs.writeFileSync(
      path.join(fixture.author, "scripts/install-cloudx.mjs"),
      'throw new Error("main must not be installed");\n',
    );
    git(fixture.author, "commit", "-am", "TEST: main moves ahead");
    git(fixture.author, "push", "origin", "main", "v1.0.0");
    const bin = directory();
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      '#!/bin/sh\nprintf "LoadState=loaded\\nActiveState=inactive\\nMainPID=0\\nNeedDaemonReload=no\\nWorkingDirectory=%s\\n" "$CLOUDX_TEST_CHECKOUT"\n',
      { mode: 0o755 },
    );
    const args = [
      "--update",
      "--target-commit",
      targetCommit,
      "--service",
      "preview.service",
      "--port",
      "3002",
      "--yes",
    ];
    const result = spawnSync(
      process.execPath,
      ["scripts/install-cloudx.mjs", ...args],
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
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("selected release installer executed");
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1))).toEqual({
      args,
      updatedCommit: targetCommit,
    });
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(targetCommit);
  });

  it("reloads the installer from the fetched commit before running package updates", () => {
    const fixture = checkout({ includeInstaller: true });
    const bin = path.join(directory(), "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      '#!/bin/sh\nprintf "LoadState=loaded\\nActiveState=inactive\\nMainPID=0\\nNeedDaemonReload=no\\nWorkingDirectory=%s\\n" "$CLOUDX_TEST_CHECKOUT"\n',
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
    ["--update", "--host", "::1"],
    ["--host", "::1"],
    ["--update", "--service", "preview.service", "--port", "3002", "--host"],
  ])("rejects incomplete custom service options %j", (...args) =>
    expect(() => parseArgs(args)).toThrow(),
  );
  it("accepts an explicit IPv6 host for a custom web service", () => {
    expect(
      parseArgs([
        "--update",
        "--service",
        "preview.service",
        "--port",
        "3002",
        "--host",
        "::1",
      ]),
    ).toMatchObject({
      update: true,
      service: "preview.service",
      port: 3002,
      host: "::1",
    });
  });
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
      "ActiveState=inactive",
      "MainPID=0",
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
  it.each(["cloudx.service", "cloudx-terminal.service"])("refuses a live unpinned %s before Git or package mutations", async service => {
    const fixture = plannedUpdate();
    fs.writeFileSync(path.join(fixture.unitDir, service), "installed service");
    const inspect = fixture.runner.inspect.bind(fixture.runner);
    fixture.runner.inspect = (command, args) => command === "systemctl" && args[2] === service
      ? ["LoadState=loaded", "NeedDaemonReload=no", "ActiveState=active", "MainPID=123", "ControlGroup=/cloudx-test.service",
        `WorkingDirectory=${fixture.root}`, `FragmentPath=${path.join(fixture.unitDir, service)}`,
        `EnvironmentFiles=${fixture.envPath} (ignore_errors=no)`].join("\n") : inspect(command, args);
    const before = git(fixture.root, "rev-parse", "HEAD");
    await expect(runInstaller(fixture.options)).rejects.toThrow(`${service} cannot safely survive`);
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(before);
    expect(fixture.runner.commands.some(({ command, args }) => command === "npm" || command === "git" && ["fetch", "merge"].includes(args[0]))).toBe(false);
    expect(fixture.runner.writes).toEqual([]);
  });

  it("uses the same complete installation plan for terminal and Settings updates", async () => {
    const fixture = plannedUpdate();
    for (const name of [
      "cloudx-asr.service",
      "cloudx-documentation.service",
      "cloudx-terminal.service",
    ]) {
      fs.writeFileSync(path.join(fixture.unitDir, name), "installed service");
    }
    const terminalResult = await runInstaller(fixture.options);
    const terminalCommands = structuredClone(fixture.runner.commands);
    const terminalWrites = structuredClone(fixture.runner.writes);
    fixture.runner.commands = [];
    fixture.runner.writes = [];

    const settingsResult = await runInstaller({
      ...fixture.options,
      nonInteractive: true,
    });
    const sudoPrechecks = fixture.runner.commands.filter(
      ({ command, args }) =>
        command === "sudo" && args.join(" ") === "-n true",
    );
    expect(sudoPrechecks).toHaveLength(1);
    const settingsCommands = fixture.runner.commands
      .filter((command) => !sudoPrechecks.includes(command))
      .map(({ command, args, ...options }) => ({
        command,
        args:
          command === "sudo"
            ? args.slice(1)
            : command === "sh"
              ? args.map((arg) =>
                  arg.replace("| sudo -n -E bash -", "| sudo -E bash -"),
                )
              : args,
        ...options,
      }));

    expect(settingsCommands).toEqual(terminalCommands);
    expect(fixture.runner.writes).toEqual(terminalWrites);
    for (const key of [
      "paths",
      "port",
      "servicesInstalled",
      "restartServices",
      "urls",
    ]) {
      expect(settingsResult[key]).toEqual(terminalResult[key]);
    }
    expect(settingsResult.restartServices).toBe(true);
    expect(
      settingsCommands
        .filter(({ command, args }) =>
          command === "curl" && args.at(-1).endsWith("/ready"),
        )
        .map(({ args }) => args.at(-1)),
    ).toEqual([
      "http://127.0.0.1:7810/ready",
      "http://127.0.0.1:9000/ready",
      "https://127.0.0.1:3443/api/ready",
    ]);
  });
  it("reports documentation startup failure and collects diagnostics before checking the web service", async () => {
    const fixture = plannedUpdate();
    const verificationStartedAt = Date.parse("2026-09-15T06:25:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(verificationStartedAt);
    onTestFinished(() => now.mockRestore());
    const capture = fixture.runner.capture.bind(fixture.runner);
    fixture.runner.capture = (command, args, options) => {
      const result = capture(command, args, options);
      if (command === "curl" && args.at(-1) === "http://127.0.0.1:9000/ready") {
        now.mockReturnValue(verificationStartedAt + 6 * 60_000);
        throw new Error("Command failed (exit code 22)");
      }
      return result;
    };

    await expect(runInstaller(fixture.options)).rejects.toThrow(
      "Cloudx documentation indexer readiness verification failed at http://127.0.0.1:9000/ready",
    );
    const commands = fixture.runner.commands;
    expect(commands
      .filter(({ command, args }) =>
        command === "curl" && args.at(-1).endsWith("/ready"),
      )
      .map(({ args }) => args.at(-1)),
    ).toEqual(["http://127.0.0.1:7810/ready", "http://127.0.0.1:9000/ready"]);
    expect(commands.some(({ command, args }) =>
      command === "systemctl" && args[1] === "status",
    )).toBe(true);
    expect(commands.find(({ command }) => command === "journalctl")?.args).toEqual(
      expect.arrayContaining([
        "-u", "cloudx-documentation.service",
        "--since", `@${verificationStartedAt / 1000 - 5 * 60}`,
      ]),
    );
  });
  it("checks unattended sudo before changing the checkout", async () => {
    const fixture = plannedUpdate();
    const run = fixture.runner.run.bind(fixture.runner);
    fixture.runner.run = (command, args, options) => {
      if (command === "sudo") throw new Error("Password required");
      return run(command, args, options);
    };
    await expect(runInstaller({ ...fixture.options, nonInteractive: true })).rejects.toThrow("Password required");
    expect(fixture.runner.commands.some(({ command }) => command === "git")).toBe(false);
    expect(fixture.runner.writes).toEqual([]);
  });
  it("fails unattended updates without starting Codex login when authentication is missing", async () => {
    const fixture = plannedUpdate();
    const statusOk = fixture.runner.statusOk.bind(fixture.runner);
    fixture.runner.statusOk = (command, args, options) => args[0] === "login" ? false : statusOk(command, args, options);
    await expect(runInstaller({ ...fixture.options, nonInteractive: true, answers: { runCodexLogin: true } })).rejects.toThrow("Codex must be authenticated");
    expect(fixture.runner.commands.some(({ args }) => args[0] === "login")).toBe(false);
    expect(fixture.runner.commands.filter(({ command }) => command === "sudo").every(({ args }) => args[0] === "-n")).toBe(true);
    expect(fixture.runner.commands.some(({ command, args }) => command === "npm" && args[0] === "ci")).toBe(false);
  });
  it.each([false, true])("preserves terminal processes when their service is already installed=%s", async installed => {
    const fixture = plannedUpdate();
    const terminalUnit = path.join(fixture.unitDir, "cloudx-terminal.service");
    if (installed) fs.writeFileSync(terminalUnit, "existing terminal owner");
    await runInstaller(fixture.options);
    const serviceCommands = fixture.runner.commands
      .filter(command => command.command === "systemctl" && !command.inspect)
      .map(command => command.args);
    expect(fixture.runner.writes.find(write => write.path === terminalUnit)?.contents)
      .toContain("apps/server/dist/terminal/broker.js");
    expect(serviceCommands).toContainEqual(["--user", "enable", "cloudx-terminal.service"]);
    const start = serviceCommands.findIndex(args => args[1] === "start");
    const restart = serviceCommands.findIndex(args => args[1] === "restart");
    expect(serviceCommands[start]).toEqual(["--user", "start", "cloudx-terminal.service"]);
    expect(start).toBeLessThan(restart);
    expect(serviceCommands[restart]).toEqual([
      "--user", "restart", "cloudx-asr.service", "cloudx-documentation.service", "cloudx.service",
    ]);
    expect(serviceCommands.some(args => ["stop", "restart"].includes(args[1]) && args.includes("cloudx-terminal.service")))
      .toBe(false);
  });
  it("refreshes the persistent terminal unit without starting or stopping processes with --no-start", async () => {
    const fixture = plannedUpdate();
    await runInstaller({ ...fixture.options, noStart: true });
    expect(fixture.runner.writes.some(write => write.path === path.join(fixture.unitDir, "cloudx-terminal.service"))).toBe(true);
    expect(fixture.runner.commands.some(command => command.command === "systemctl" && ["start", "stop", "restart"].includes(command.args[1])))
      .toBe(false);
  });
  it("leaves web services running if the persistent terminal service cannot start", async () => {
    const fixture = plannedUpdate();
    const run = fixture.runner.run.bind(fixture.runner);
    fixture.runner.run = (command, args, options) => {
      if (command === "systemctl" && args[1] === "start" && args[2] === "cloudx-terminal.service") {
        throw new Error("Terminal service could not start");
      }
      return run(command, args, options);
    };
    await expect(runInstaller(fixture.options)).rejects.toThrow("Terminal service could not start");
    expect(fixture.runner.commands.some(command => command.command === "systemctl" && command.args[1] === "restart"))
      .toBe(false);
  });
  it.each([
    [undefined, "https://127.0.0.1:3002"],
    ["::1", "https://[::1]:3002"],
    ["::", "https://[::1]:3002"],
  ])(
    "rebuilds and restarts only the selected custom web service on %s",
    async (host, origin) => {
      const fixture = plannedUpdate({ service: true });
      const result = await runInstaller({ ...fixture.options, host });
      const planned = fixture.runner.commands
        .filter((command) => !command.inspect)
        .map((command) => [command.command, ...command.args]);
      expect(result).toMatchObject({ port: 3002, restartServices: true });
      expect(result.urls).toEqual([origin]);
      const readiness = planned.filter((command) => command[0] === "curl");
      expect(readiness).toHaveLength(2);
      expect(readiness[0].at(-1)).toBe(`${origin}/api/ready`);
      expect(readiness[1].at(-1)).toBe(`${origin}/api/ready/terminals`);
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
    },
  );
  it("leaves the selected service running with --no-start", async () => {
    const fixture = plannedUpdate({ service: true });
    const result = await runInstaller({
      ...fixture.options,
      host: "::1",
      noStart: true,
    });
    expect(result.restartServices).toBe(false);
    expect(result.urls).toEqual(["https://[::1]:3002"]);
    expect(
      fixture.runner.commands.filter(
        (command) => !command.inspect && command.command === "systemctl",
      ),
    ).toEqual([]);
  });
  it("rejects an invalid readiness host before Git, package, or file mutations", async () => {
    const fixture = plannedUpdate({ service: true });
    await expect(
      runInstaller({ ...fixture.options, host: "::1/other" }),
    ).rejects.toThrow(/--host.*IPv4 or IPv6/);
    expect(fixture.runner.commands).toEqual([]);
    expect(fixture.runner.writes).toEqual([]);
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

describe("interactive updater cleanup", () => {
  it.each([
    ["standard", false],
    ["standard", true],
    ["web", false],
    ["web", true],
  ])("closes input after %s update with readiness failure=%s", async (kind, failReadiness) => {
    const fixture = plannedUpdate({ service: kind === "web" });
    const input = new PassThrough();
    const output = new PassThrough();
    onTestFinished(() => { input.destroy(); output.destroy(); });
    output.on("data", () => queueMicrotask(() => input.write("yes\n")));
    const capture = fixture.runner.capture.bind(fixture.runner);
    fixture.runner.capture = (command, args, options) => {
      if (command === "curl") {
        expect(input.listenerCount("data")).toBe(1);
        if (failReadiness) throw new Error("Permanent readiness failure");
      }
      return capture(command, args, options);
    };
    const update = runInstaller({
      ...fixture.options,
      dryRun: false,
      yes: false,
      env: { ...fixture.options.env, CLOUDX_INSTALL_UPDATED_COMMIT: git(fixture.root, "rev-parse", "HEAD") },
      input,
      output,
    });

    if (failReadiness) await expect(update).rejects.toThrow("Permanent readiness failure");
    else expect((await update).restartServices).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.isPaused()).toBe(true);
  });
});

describe("legacy terminal upgrade preparation", () => {
  it("preserves the legacy workspace before install commands and service restart", async () => {
    const fixture = plannedUpdate();
    const workspace = '{"windows":[{"id":"saved-window","tabs":["legacy-tab"]}]}\n';
    fs.mkdirSync(fixture.dataDir);
    fs.writeFileSync(path.join(fixture.dataDir, "workspace.json"), workspace);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const run = fixture.runner.run.bind(fixture.runner);
    fixture.runner.run = (command, args, options) => {
      const backups = fs.readdirSync(fixture.dataDir).filter(name => name.startsWith("terminal-upgrade-backup-"));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(fixture.dataDir, backups[0], "workspace.json"), "utf8")).toBe(workspace);
      expect(warn.mock.calls.flat().join("\n")).toContain("cannot preserve legacy in-memory tabs");
      return run(command, args, options);
    };

    const result = await runInstaller({
      ...fixture.options,
      dryRun: false,
      env: { ...fixture.options.env, CLOUDX_INSTALL_UPDATED_COMMIT: git(fixture.root, "rev-parse", "HEAD") },
    });
    expect(result.restartServices).toBe(true);
  });

  it("stops before installation or restart when the legacy workspace cannot be backed up", async () => {
    const fixture = plannedUpdate();
    fs.mkdirSync(fixture.dataDir);
    fs.writeFileSync(path.join(fixture.dataDir, "workspace.json"), "{}");
    const write = fs.writeFileSync.bind(fs);
    const writeFailure = vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
      if (String(file).includes("terminal-upgrade-backup-")) throw Object.assign(new Error("Disk full"), { code: "ENOSPC" });
      return write(file, ...args);
    });
    onTestFinished(() => writeFailure.mockRestore());

    await expect(runInstaller({
      ...fixture.options,
      dryRun: false,
      env: { ...fixture.options.env, CLOUDX_INSTALL_UPDATED_COMMIT: git(fixture.root, "rev-parse", "HEAD") },
    })).rejects.toThrow("Could not preserve legacy workspace");
    expect(fixture.runner.commands.filter(command => !command.inspect)).toEqual([]);
    expect(fixture.runner.writes).toEqual([]);
  });

  it("warns about the custom service backup requirements before rebuilding or restarting", async () => {
    const fixture = plannedUpdate({ service: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const run = fixture.runner.run.bind(fixture.runner);
    fixture.runner.run = (command, args, options) => {
      expect(warn.mock.calls.flat().join("\n")).toContain("identify CLOUDX_DATA_DIR");
      return run(command, args, options);
    };
    const result = await runInstaller({
      ...fixture.options,
      dryRun: false,
      env: { ...fixture.options.env, CLOUDX_INSTALL_UPDATED_COMMIT: git(fixture.root, "rev-parse", "HEAD") },
    });
    expect(result.restartServices).toBe(true);
  });
});
