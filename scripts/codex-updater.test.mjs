import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireCodexInstallationLock,
  readCodexVersion,
  resolveCodexInstallation,
  updateCodexInstallation,
} from "./codex-updater.mjs";

const scratch = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function installation({ mode = "success", version = "1.0.0" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-shared-codex-"));
  scratch.push(root);
  const prefix = path.join(root, "custom prefix");
  const assistantBin = path.join(prefix, "bin/codex");
  const packageDir = path.join(prefix, "lib/node_modules/@openai/codex");
  const manifest = {
    name: "@openai/codex",
    version,
    bin: { codex: "bin/codex.js" },
  };
  fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(prefix, "bin"));
  fs.mkdirSync(path.join(root, "tools"));
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(
    path.join(packageDir, "bin/codex.js"),
    `#!${process.execPath}\nconst fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(packageDir, "package.json"))}, 'utf8'));
fs.appendFileSync(process.env.TEST_VERSION_LOG, 'version\\n');
if (process.env.TEST_MODE === 'version-escape') {
  const { spawn } = require('node:child_process');
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio:'inherit'});
  fs.writeFileSync(process.env.TEST_CHILD, String(descendant.pid));
  process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
  return;
}
if (process.env.TEST_MODE === 'verification' && manifest.version === '1.1.0') process.exit(1);
if (process.env.TEST_MODE === 'malformed-version') console.log('unexpected response');
else if (process.env.TEST_MODE === 'oversized-version') console.log('codex-cli 1.0.0-' + 'a'.repeat(129));
else console.log('codex-cli ' + manifest.version);
`,
    { mode: 0o755 },
  );
  fs.symlinkSync(path.join(packageDir, "bin/codex.js"), assistantBin);
  fs.writeFileSync(
    path.join(root, "tools/npm"),
    `#!${process.execPath}\nconst fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = process.env.TEST_MODE;
if (process.argv[2] === 'view') {
  if (mode === 'network') { console.error('ENOTFOUND registry.invalid SECRET-TOKEN'); process.exit(1); }
  console.log(mode === 'registry' ? 'bad json' : '"1.1.0"');
} else if (mode === 'failure' || mode === 'permission') {
  console.error(mode === 'permission' ? 'EACCES SECRET-TOKEN' : 'unclassified error SECRET-TOKEN'); process.exit(1);
} else if (mode === 'flood') process.stdout.write('x'.repeat(600000));
else if (mode === 'timeout' || mode === 'cancel' || mode === 'escaped-child') {
  const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {detached: mode === 'escaped-child', stdio:'inherit'});
  fs.writeFileSync(process.env.TEST_CHILD, String(descendant.pid));
  process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
} else {
  const file = ${JSON.stringify(path.join(packageDir, "package.json"))};
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.version = mode === 'wrong-version' ? '1.0.1' : '1.1.0';
  fs.writeFileSync(file, JSON.stringify(manifest));
}
`,
    { mode: 0o755 },
  );
  return {
    root,
    prefix,
    assistantBin,
    packageDir,
    env: {
      ...process.env,
      PATH: path.join(root, "tools"),
      TEST_MODE: mode,
      TEST_LOG: path.join(root, "commands"),
      TEST_CHILD: path.join(root, "child"),
      TEST_VERSION_LOG: path.join(root, "versions"),
    },
  };
}

function commands(fixture) {
  return fs
    .readFileSync(fixture.env.TEST_LOG, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
}

describe("shared Codex update", () => {
  it("updates the selected npm prefix and verifies the resulting executable", async () => {
    const fixture = installation();
    const stages = [];
    const result = await updateCodexInstallation({
      ...fixture,
      prefix: "/other-prefix",
      onProgress: (stage) => stages.push(stage),
    });
    expect(result).toEqual({
      outcome: "updated",
      installedVersion: "1.1.0",
      previousVersion: "1.0.0",
    });
    expect(stages).toEqual(["checking", "updating", "verifying"]);
    expect(commands(fixture)).toEqual([
      ["view", "@openai/codex@latest", "version", "--json"],
      ["i", "-g", "--prefix", fixture.prefix, "@openai/codex@latest"],
    ]);
    expect(
      fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock")),
    ).toBe(false);
  });

  it("reports an already current executable without reinstalling", async () => {
    const fixture = installation({ version: "1.1.0" });
    await expect(updateCodexInstallation(fixture)).resolves.toMatchObject({
      outcome: "current",
      installedVersion: "1.1.0",
    });
    expect(commands(fixture)).toHaveLength(1);
  });

  it.each(["failure", "network", "permission", "registry"])(
    "reports safe actionable %s errors and the still usable version",
    async (mode) => {
      const fixture = installation({ mode });
      const output = [];
      const error = await updateCodexInstallation({
        ...fixture,
        onOutput: (text) => output.push(text),
      }).catch((error) => error);
      expect(error.code).toBe(
        {
          failure: "installation",
          network: "network",
          permission: "permission",
          registry: "installation",
        }[mode],
      );
      expect(error.usableVersion).toBe("1.0.0");
      expect(error.message).not.toContain("SECRET-TOKEN");
      if (mode !== "registry")
        expect(output.join("")).toContain("SECRET-TOKEN");
      expect(
        fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock")),
      ).toBe(false);
    },
  );

  it("reports missing npm with the current usable version", async () => {
    const fixture = installation();
    fs.unlinkSync(path.join(fixture.root, "tools/npm"));
    await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({
      code: "npm-unavailable",
      usableVersion: "1.0.0",
    });
  });

  it.each(["verification", "wrong-version"])(
    "never reports success when installed version verification fails: %s",
    async (mode) => {
      const fixture = installation({ mode });
      await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({
        code: "verification",
        usableVersion: mode === "verification" ? null : "1.0.1",
      });
    },
  );

  it.each(["malformed-version", "oversized-version"])(
    "rejects invalid version output: %s",
    async (mode) => {
      const fixture = installation({ mode });
      await expect(
        readCodexVersion(fixture.assistantBin, fixture),
      ).rejects.toMatchObject({ code: "verification" });
    },
  );

  it("recognizes versions with both prerelease and build metadata", async () => {
    const fixture = installation({ version: "1.1.0-rc.1+build.0" });
    await expect(readCodexVersion(fixture.assistantBin, fixture)).resolves.toBe(
      "1.1.0-rc.1+build.0",
    );
  });

  it("rejects a custom wrapper even if it is named prefix/bin/codex", async () => {
    const fixture = installation();
    fs.unlinkSync(fixture.assistantBin);
    fs.writeFileSync(fixture.assistantBin, "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(fs.existsSync(fixture.env.TEST_LOG)).toBe(false);
  });

  it("rejects a symlink to a custom wrapper outside the npm package", async () => {
    const fixture = installation();
    fs.unlinkSync(fixture.assistantBin);
    fs.writeFileSync(
      path.join(fixture.root, "wrapper"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    fs.symlinkSync(path.join(fixture.root, "wrapper"), fixture.assistantBin);
    await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("uses one lock for symlink aliases and rejects concurrent writers", async () => {
    const fixture = installation();
    const alias = path.join(fixture.root, "alias");
    fs.symlinkSync(fixture.prefix, alias);
    const release = acquireCodexInstallationLock(fixture.prefix);
    expect(() => acquireCodexInstallationLock(alias)).toThrow(
      /Another CloudX installer/,
    );
    await expect(
      updateCodexInstallation({
        ...fixture,
        assistantBin: path.join(alias, "bin/codex"),
      }),
    ).rejects.toMatchObject({ code: "busy" });
    release();
    await expect(updateCodexInstallation(fixture)).resolves.toMatchObject({
      outcome: "updated",
    });
  });

  it("stops excessive output and releases the installation lock", async () => {
    const fixture = installation({ mode: "flood" });
    let loggedBytes = 0;
    await expect(
      updateCodexInstallation({
        ...fixture,
        onOutput: (text) => {
          loggedBytes += Buffer.byteLength(text);
        },
      }),
    ).rejects.toMatchObject({ code: "output-limit", usableVersion: "1.0.0" });
    expect(loggedBytes).toBeLessThan(513 * 1024);
    expect(
      fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock")),
    ).toBe(false);
  });

  it("reports private log write failures without crashing or leaving the lock held", async () => {
    const fixture = installation();
    await expect(
      updateCodexInstallation({
        ...fixture,
        onOutput: () => {
          throw new Error("ENOSPC secret path");
        },
      }),
    ).rejects.toMatchObject({
      code: "log-unavailable",
      usableVersion: "1.0.0",
    });
    expect(
      fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock")),
    ).toBe(false);
    expect(fs.existsSync(fixture.env.TEST_LOG)).toBe(false);
  });

  it("checks an already aborted lifecycle before starting subprocesses and releases its lock", async () => {
    const fixture = installation();
    const controller = new AbortController();
    controller.abort();
    await expect(
      updateCodexInstallation({ ...fixture, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled", usableVersion: "1.0.0" });
    expect(fs.existsSync(fixture.env.TEST_LOG)).toBe(false);
    expect(
      fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock")),
    ).toBe(false);
  });

  it("bounds the update and kills only its subprocess group before releasing the lock", async () => {
    const fixture = installation({ mode: "timeout" });
    const start = Date.now();
    await expect(
      updateCodexInstallation({ ...fixture, timeoutMs: 800 }),
    ).rejects.toMatchObject({ code: "timeout", usableVersion: "1.0.0" });
    expect(Date.now() - start).toBeLessThan(3_000);
    const pid = Number(fs.readFileSync(fixture.env.TEST_CHILD, "utf8"));
    try {
      const state = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2];
      expect(state).toBe("Z");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    expect(
      fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock")),
    ).toBe(false);
  });

  it.each(["escaped-child", "version-escape"])(
    "retains the lock when an escaped subprocess prevents confirmed cleanup: %s",
    async (mode) => {
      const fixture = installation({ mode });
      const started = Date.now();
      try {
        await expect(
          updateCodexInstallation({ ...fixture, timeoutMs: 800 }),
        ).rejects.toMatchObject({
          code: "cleanup-incomplete",
          usableVersion: null,
        });
        expect(Date.now() - started).toBeLessThan(4_000);
        expect(
          fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock")),
        ).toBe(true);
        expect(() => acquireCodexInstallationLock(fixture.prefix)).toThrow(
          /Another CloudX installer/,
        );
        expect(fs.readFileSync(fixture.env.TEST_VERSION_LOG, "utf8")).toBe(
          "version\n",
        );
      } finally {
        stopEscapedFixture(fixture);
      }
    },
  );

  it("preserves incomplete cleanup errors from standalone version checks", async () => {
    const fixture = installation({ mode: "version-escape" });
    try {
      await expect(
        readCodexVersion(fixture.assistantBin, { ...fixture, timeoutMs: 800 }),
      ).rejects.toMatchObject({ code: "cleanup-incomplete" });
    } finally {
      stopEscapedFixture(fixture);
    }
  });

  it("rejects relative and empty destinations", () => {
    for (const prefix of ["", "relative"])
      expect(() => resolveCodexInstallation({ prefix })).toThrow(/absolute/);
    expect(() =>
      resolveCodexInstallation({ assistantBin: "codex", prefix: "/tmp" }),
    ).toThrow(/absolute/);
  });
});

function stopEscapedFixture(fixture) {
  if (!fs.existsSync(fixture.env.TEST_CHILD)) return;
  const pid = Number(fs.readFileSync(fixture.env.TEST_CHILD, "utf8"));
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
