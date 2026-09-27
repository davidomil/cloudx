import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireCodexInstallationLock,
  discoverCodexReleases,
  readCodexSelection,
  resolveSelectedCodexBinary,
  readCodexVersion,
  resolveCodexInstallation,
  updateCodexInstallation,
} from "./codex-updater.mjs";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal() }));

const scratch = [];
beforeEach(() => {
  const spawn = childProcess.spawn;
  vi.spyOn(childProcess, "spawn").mockImplementation((command, args, options) => {
    const verifier = args?.findIndex(argument => String(argument).endsWith("/codex-runtime-verification.mjs")) ?? -1;
    if (verifier < 0) return spawn(command, args, options);
    const source = `
      const fs = require('node:fs');
      fs.appendFileSync(process.env.TEST_RUNTIME_LOG, process.argv[1] + '\\n');
      if (process.env.TEST_MODE === 'runtime') {
        console.error('SECRET-TOKEN: selected conversation was not saved'); process.exit(1);
      }
      if (process.env.TEST_MODE === 'runtime-timeout') {
        const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        fs.writeFileSync(process.env.TEST_CHILD, String(child.pid));
        setInterval(() => {}, 1000);
      }
    `;
    return spawn(command, [...args.slice(0, verifier), "-e", source, "--", ...args.slice(verifier + 1)], options);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
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
  fs.symlinkSync(
    execFileSync(
      "python3",
      ["-I", "-S", "-c", "import sys; print(sys.executable)"],
      { encoding: "utf8" },
    ).trim(),
    path.join(root, "tools/python3"),
  );
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(
    path.join(packageDir, "bin/codex.js"),
    `#!${process.execPath}\nconst fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../package.json'), 'utf8'));
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
  console.log(mode === 'registry' ? 'bad json' : JSON.stringify({versions: ['1.0.0', '1.1.0', '1.2.0-rc.1'], 'dist-tags': {latest: '1.1.0'}}));
} else if (mode === 'failure' || mode === 'permission') {
  console.error(mode === 'permission' ? 'EACCES SECRET-TOKEN' : 'unclassified error SECRET-TOKEN'); process.exit(1);
} else if (mode === 'flood') process.stdout.write('x'.repeat(600000));
else if (['timeout', 'cancel', 'escaped-child', 'escaped-silent', 'lost-owner', 'stalled-owner'].includes(mode)) {
  const descendant = spawn(process.execPath, ['-e', 'const fs = require("node:fs"); process.on("SIGTERM", () => {}); setInterval(() => fs.appendFileSync(process.env.TEST_WRITES, "x"), 10)'], {detached: mode !== 'timeout' && mode !== 'cancel', stdio: mode === 'escaped-child' || mode === 'timeout' || mode === 'cancel' ? 'inherit' : 'ignore'});
  fs.writeFileSync(process.env.TEST_CHILD, String(descendant.pid));
  if (mode.endsWith('owner')) {
    fs.writeFileSync(process.env.TEST_OWNER, JSON.stringify({ pid: process.ppid, directory: fs.readFileSync('/proc/' + process.ppid + '/cmdline', 'utf8').split('\\0')[4] }));
    const ready = setInterval(() => {
      if (!fs.existsSync(process.env.TEST_WRITES)) return;
      clearInterval(ready);
      process.kill(process.ppid, mode === 'lost-owner' ? 'SIGKILL' : 'SIGSTOP');
      if (mode === 'lost-owner') process.exit(0);
    }, 10);
  }
  process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
} else {
  const path = require('node:path');
  const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
  const target = process.argv.at(-1).replace('@openai/codex@', '');
  const dir = path.join(prefix, 'lib/node_modules/@openai/codex');
  fs.cpSync(${JSON.stringify(packageDir)}, dir, {recursive: true});
  const file = path.join(dir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.version = mode === 'wrong-version' ? '1.0.1' : target;
  fs.writeFileSync(file, JSON.stringify(manifest));
  fs.mkdirSync(path.join(prefix, 'bin'));
  fs.symlinkSync(path.join(dir, 'bin/codex.js'), path.join(prefix, 'bin/codex'));
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
      TEST_WRITES: path.join(root, "writes"),
      TEST_OWNER: path.join(root, "owner"),
      TEST_VERSION_LOG: path.join(root, "versions"),
      TEST_RUNTIME_LOG: path.join(root, "runtime-checks"),
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

function replaceSupervisorInterpreter(fixture, source) {
  const interpreter = path.join(fixture.root, "tools/python3");
  const python = fs.readlinkSync(interpreter);
  fs.unlinkSync(interpreter);
  fs.writeFileSync(interpreter, `#!${python}\n${source}\n`, { mode: 0o755 });
  return () => {
    fs.unlinkSync(interpreter);
    fs.symlinkSync(python, interpreter);
  };
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
    expect(result).toMatchObject({
      outcome: "updated",
      installedVersion: "1.1.0",
      previousVersion: "1.0.0",
    });
    expect(stages).toEqual(["checking", "updating", "verifying"]);
    expect(fs.readFileSync(fixture.env.TEST_RUNTIME_LOG, "utf8")).toBe(`${resolveSelectedCodexBinary(fixture)}\n`);
    expect(commands(fixture)).toEqual([
      ["view", "@openai/codex", "versions", "dist-tags", "--json"],
      ["i", "-g", "--prefix", path.dirname(path.dirname(resolveSelectedCodexBinary(fixture))), "@openai/codex@1.1.0"],
    ]);
    expect(
      fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock")),
    ).toBe(false);
  });

  it("verifies an already current executable without reinstalling", async () => {
    const fixture = installation({ version: "1.1.0" });
    await expect(updateCodexInstallation(fixture)).resolves.toMatchObject({
      outcome: "current",
      installedVersion: "1.1.0",
    });
    expect(commands(fixture)).toHaveLength(1);
    expect(fs.readFileSync(fixture.env.TEST_RUNTIME_LOG, "utf8")).toBe(`${fixture.assistantBin}\n`);
  });

  it.each(["1.0.0", "1.1.0"])("rejects a version-valid candidate when CloudX runtime verification fails (installed %s)", async version => {
    const fixture = installation({ mode: "runtime", version });
    const output = [];
    const error = await updateCodexInstallation({ ...fixture, onOutput: text => output.push(text) }).catch(error => error);
    expect(error).toMatchObject({ code: "runtime-verification", usableVersion: version, installedVersion: "1.1.0", message: expect.stringMatching(/CloudX tab launch.*private update log/) });
    expect(error.message).not.toContain("SECRET-TOKEN");
    expect(output.join("")).toContain("SECRET-TOKEN: selected conversation was not saved");
    expect(fs.readFileSync(fixture.env.TEST_RUNTIME_LOG, "utf8")).toContain("/bin/codex\n");
    expect(readCodexSelection(fixture)).toBeNull();
    expect(fs.readFileSync(fixture.env.TEST_VERSION_LOG, "utf8").trim().split("\n")).toHaveLength(version === "1.1.0" ? 1 : 2);
    expect(fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock"))).toBe(false);
  });

  it("reaps runtime-verifier descendants on timeout without claiming the unverified CLI is usable", async () => {
    const fixture = installation({ mode: "runtime-timeout" });
    await expect(updateCodexInstallation({ ...fixture, timeoutMs: 800 })).rejects.toMatchObject({ code: "timeout", usableVersion: "1.0.0" });
    const pid = Number(fs.readFileSync(fixture.env.TEST_CHILD, "utf8"));
    expect(fs.existsSync(`/proc/${pid}`)).toBe(false);
    expect(fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock"))).toBe(false);
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
          registry: "registry",
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

  it("reports npm executable permissions with the current usable version", async () => {
    const fixture = installation();
    fs.chmodSync(path.join(fixture.root, "tools/npm"), 0o600);
    await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({
      code: "permission",
      usableVersion: "1.0.0",
    });
  });

  it("settles with a safe error when completed command receipts cannot be removed", async () => {
    const fixture = installation();
    const remove = fs.rmSync;
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target).includes("cloudx-codex-command-")) {
        remove(target, options);
        throw Object.assign(new Error("EACCES private receipt path"), {
          code: "EACCES",
        });
      }
      return remove(target, options);
    });
    await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({
      code: "permission",
      message: expect.not.stringContaining("private receipt path"),
    });
    expect(
      fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock")),
    ).toBe(false);
  });

  it.each(["verification", "wrong-version"])(
    "never reports success when installed version verification fails: %s",
    async (mode) => {
      const fixture = installation({ mode });
      await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({
        code: "verification",
        usableVersion: "1.0.0",
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
      usableVersion: null,
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
    ).rejects.toMatchObject({ code: "cancelled", usableVersion: null });
    expect(fs.existsSync(fixture.env.TEST_LOG)).toBe(false);
    expect(
      fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock")),
    ).toBe(false);
  });

  it("bounds the update and reaps only its descendants before releasing the lock", async () => {
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
    "reaps detached descendants before releasing the installation lock: %s",
    async (mode) => {
      const fixture = installation({ mode });
      const started = Date.now();
      try {
        await expect(
          updateCodexInstallation({ ...fixture, timeoutMs: 800 }),
        ).rejects.toMatchObject({
          code: "timeout",
          usableVersion: mode === "version-escape" ? null : "1.0.0",
        });
        expect(Date.now() - started).toBeLessThan(
          mode === "version-escape" ? 7_000 : 4_000,
        );
        expect(
          fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock")),
        ).toBe(false);
        const pid = Number(fs.readFileSync(fixture.env.TEST_CHILD, "utf8"));
        expect(fs.existsSync(`/proc/${pid}`)).toBe(false);
      } finally {
        stopEscapedFixture(fixture);
      }
    },
    8_000,
  );

  it.each(["timeout", "shutdown"])(
    "confirms a detached writer with closed streams stopped before unlocking after %s",
    async (stop) => {
      const fixture = installation({ mode: "escaped-silent" });
      const controller = new AbortController();
      const result = updateCodexInstallation({
        ...fixture,
        timeoutMs: stop === "timeout" ? 800 : 5_000,
        signal: controller.signal,
      }).catch((error) => error);
      try {
        await vi.waitFor(() =>
          expect(fs.statSync(fixture.env.TEST_WRITES).size).toBeGreaterThan(0),
        );
        expect(() => acquireCodexInstallationLock(fixture.prefix)).toThrow(
          /Another CloudX installer/,
        );
        if (stop === "shutdown") controller.abort();
        expect(await result).toMatchObject({
          code: stop === "timeout" ? "timeout" : "cancelled",
        });
        const bytes = fs.statSync(fixture.env.TEST_WRITES).size;
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(fs.statSync(fixture.env.TEST_WRITES).size).toBe(bytes);
        const release = acquireCodexInstallationLock(fixture.prefix);
        release();
      } finally {
        controller.abort();
        await result;
        stopEscapedFixture(fixture);
      }
    },
  );

  it.each(["lost-owner", "stalled-owner"])(
    "retains the lock while cleanup is unconfirmed: %s",
    async (mode) => {
      const fixture = installation({ mode });
      try {
        await expect(
          updateCodexInstallation({ ...fixture, timeoutMs: 800 }),
        ).rejects.toMatchObject({
          code: "cleanup-incomplete",
          usableVersion: "1.0.0",
        });
        const bytes = fs.statSync(fixture.env.TEST_WRITES).size;
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(fs.statSync(fixture.env.TEST_WRITES).size).toBeGreaterThan(
          bytes,
        );
        expect(() => acquireCodexInstallationLock(fixture.prefix)).toThrow(
          /Another CloudX installer/,
        );
        expect(fs.readFileSync(fixture.env.TEST_VERSION_LOG, "utf8")).toBe(
          "version\n",
        );
      } finally {
        stopEscapedFixture(fixture);
        const owner = JSON.parse(
          fs.readFileSync(fixture.env.TEST_OWNER, "utf8"),
        );
        if (mode === "stalled-owner") {
          process.kill(owner.pid, "SIGCONT");
          await vi.waitFor(() =>
            expect(fs.existsSync(`/proc/${owner.pid}`)).toBe(false),
          );
        }
        fs.rmSync(owner.directory, { recursive: true, force: true });
      }
    },
  );

  it("confirms detached descendant cleanup from standalone version checks", async () => {
    const fixture = installation({ mode: "version-escape" });
    try {
      await expect(
        readCodexVersion(fixture.assistantBin, { ...fixture, timeoutMs: 800 }),
      ).rejects.toMatchObject({ code: "timeout" });
      const pid = Number(fs.readFileSync(fixture.env.TEST_CHILD, "utf8"));
      expect(fs.existsSync(`/proc/${pid}`)).toBe(false);
    } finally {
      stopEscapedFixture(fixture);
    }
  });

  it("reports missing process supervision before starting an installer", async () => {
    const fixture = installation();
    fs.unlinkSync(path.join(fixture.root, "tools/python3"));
    await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({
      code: "supervision-unavailable",
    });
    expect(fs.existsSync(fixture.env.TEST_LOG)).toBe(false);
    expect(
      fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock")),
    ).toBe(false);
  });

  it.each([
    ["Python is older than 3.9", "sys.version_info = (3, 8, 20)"],
    [
      "subreaper registration fails",
      "ctypes.CDLL = lambda *args, **kwargs: types.SimpleNamespace(prctl=rejected)",
    ],
    [
      "kernel child enumeration is unavailable",
      "pathlib.Path.read_text = missing_children",
    ],
  ])(
    "releases the lock after a startup rejection and permits a repaired retry: %s",
    async (_reason, rejectRequirement) => {
      const fixture = installation();
      const repair = replaceSupervisorInterpreter(
        fixture,
        `
import ctypes, os, pathlib, runpy, sys, types
def rejected(*args):
    ctypes.set_errno(1)
    return -1
def missing_children(*args, **kwargs):
    raise FileNotFoundError('Private kernel child enumeration diagnostic')
pathlib.Path(os.environ['TEST_OWNER']).write_text(sys.argv[4])
${rejectRequirement}
sys.argv = sys.argv[3:]
runpy.run_path(sys.argv[0], run_name='__main__')
`,
      );
      try {
        await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({
          code: "supervision-unavailable",
          message: expect.stringContaining("Python 3.9 or newer"),
          usableVersion: null,
        });
        expect(fs.existsSync(fixture.env.TEST_LOG)).toBe(false);
        expect(fs.existsSync(fixture.env.TEST_VERSION_LOG)).toBe(false);
        expect(
          fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock")),
        ).toBe(false);
        expect(
          fs.existsSync(fs.readFileSync(fixture.env.TEST_OWNER, "utf8")),
        ).toBe(false);
        repair();
        await expect(updateCodexInstallation(fixture)).resolves.toMatchObject({
          outcome: "updated",
          installedVersion: "1.1.0",
        });
      } finally {
        fs.rmSync(fs.readFileSync(fixture.env.TEST_OWNER, "utf8"), {
          recursive: true,
          force: true,
        });
      }
    },
  );

  it.each([
    ["missing error receipt", "pass", "sys.exit(125)"],
    [
      "malformed error receipt",
      "(directory / 'error.json').write_text('{')",
      "sys.exit(125)",
    ],
    [
      "different supervisor",
      "write('error', {'pid': os.getpid() + 1, 'message': 'private diagnostic'})",
      "sys.exit(125)",
    ],
    [
      "failure after readiness",
      "write('ready', {'pid': os.getpid()}); write('error', error)",
      "sys.exit(125)",
    ],
    [
      "unexpected supervisor death",
      "write('error', error)",
      "os.kill(os.getpid(), signal.SIGKILL)",
    ],
  ])(
    "retains the installation lock when startup rejection is unproven: %s",
    async (_reason, receipts, exit) => {
      const fixture = installation();
      replaceSupervisorInterpreter(
        fixture,
        `
import json, os, pathlib, signal, sys
directory = pathlib.Path(sys.argv[4])
pathlib.Path(os.environ['TEST_OWNER']).write_text(str(directory))
def write(name, value):
    (directory / (name + '.json')).write_text(json.dumps(value))
error = {'pid': os.getpid(), 'message': 'private diagnostic'}
${receipts}
${exit}
`,
      );
      try {
        await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({
          code: "cleanup-incomplete",
          message: expect.not.stringContaining("private diagnostic"),
        });
        expect(() => acquireCodexInstallationLock(fixture.prefix)).toThrow(
          /Another CloudX installer/,
        );
        expect(fs.existsSync(fixture.env.TEST_LOG)).toBe(false);
        expect(fs.existsSync(fixture.env.TEST_VERSION_LOG)).toBe(false);
      } finally {
        fs.rmSync(fs.readFileSync(fixture.env.TEST_OWNER, "utf8"), {
          recursive: true,
          force: true,
        });
      }
    },
  );

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

describe("exact Codex selection", () => {
  it.each([10.5, NaN, Infinity, -1, 0])("rejects invalid timeout %s without acquiring a lock", async timeoutMs => {
    const fixture = installation();
    await expect(updateCodexInstallation({ ...fixture, timeoutMs })).rejects.toMatchObject({ code: "invalid-timeout" });
    expect(fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock"))).toBe(false);
    expect(fs.existsSync(fixture.env.TEST_LOG)).toBe(false);
  });

  it("discovers published releases with an explicit stable target and labelled prerelease candidates", async () => {
    const fixture = installation();
    await expect(discoverCodexReleases(fixture)).resolves.toEqual({ latestStable: "1.1.0", versions: ["1.2.0-rc.1", "1.1.0", "1.0.0"] });
    expect(commands(fixture)).toEqual([["view", "@openai/codex", "versions", "dist-tags", "--json"]]);
  });

  it.each(["^1.0.0", "1", "v1.0.0", "01.0.0", "1.0.0-01", "1.0.0-", "1.0.0+", "@other/pkg", "https://example.org/pkg", "../pkg", "1.0.0;touch pwned", "1.0.0\n"])("rejects invalid selection %j before running npm", async targetVersion => {
    const fixture = installation();
    await expect(updateCodexInstallation({ ...fixture, targetVersion })).rejects.toMatchObject({ code: "invalid-version" });
    expect(fs.existsSync(fixture.env.TEST_LOG)).toBe(false);
    expect(readCodexSelection(fixture)).toBeNull();
  });

  it("rejects unpublished exact releases before installing or activating", async () => {
    const fixture = installation();
    await expect(updateCodexInstallation({ ...fixture, targetVersion: "9.9.9" })).rejects.toMatchObject({ code: "unpublished", usableVersion: "1.0.0", installedVersion: null });
    expect(commands(fixture).map(command => command[0])).toEqual(["view"]);
    expect(readCodexSelection(fixture)).toBeNull();
    expect(await readCodexVersion(fixture.assistantBin, fixture)).toBe("1.0.0");
  });

  it("pins an explicitly selected prerelease and keeps the original executable and its package intact", async () => {
    const fixture = installation();
    const original = fs.readFileSync(path.join(fixture.packageDir, "package.json"), "utf8");
    const targets = [];
    await expect(updateCodexInstallation({ ...fixture, targetVersion: "1.2.0-rc.1", onTarget: version => targets.push(version) })).resolves.toMatchObject({ activeVersion: "1.2.0-rc.1", previousVerifiedVersion: null });
    expect(targets).toEqual(["1.2.0-rc.1"]);
    expect(commands(fixture).at(-1).at(-1)).toBe("@openai/codex@1.2.0-rc.1");
    expect(fs.readFileSync(path.join(fixture.packageDir, "package.json"), "utf8")).toBe(original);
    expect(await readCodexVersion(fixture.assistantBin, fixture)).toBe("1.0.0");
    expect(await readCodexVersion(resolveSelectedCodexBinary(fixture), fixture)).toBe("1.2.0-rc.1");
    expect(readCodexSelection(fixture).active.version).toBe("1.2.0-rc.1");
  });

  it("verifies the current version, upgrades, and explicitly returns to the retained verified installation", async () => {
    const fixture = installation();
    await updateCodexInstallation({ ...fixture, targetVersion: "1.0.0" });
    const initial = readCodexSelection(fixture);
    expect(initial).toMatchObject({ active: { version: "1.0.0", assistantBin: fixture.assistantBin }, previous: null });
    await updateCodexInstallation({ ...fixture, targetVersion: "latest" });
    const upgraded = readCodexSelection(fixture);
    expect(upgraded.previous).toEqual(initial.active);
    await expect(updateCodexInstallation({ ...fixture, targetVersion: "previous" })).rejects.toMatchObject({ code: "downgrade-confirmation" });
    expect(readCodexSelection(fixture)).toEqual(upgraded);
    await expect(updateCodexInstallation({ ...fixture, targetVersion: "previous", acknowledgeDowngrade: true })).resolves.toMatchObject({ installedVersion: "1.0.0", activeVersion: "1.0.0", previousVerifiedVersion: "1.1.0" });
    expect(readCodexSelection(fixture)).toEqual({ schemaVersion: 1, active: initial.active, previous: upgraded.active });
    expect(commands(fixture).filter(command => command[0] === "i")).toHaveLength(1);
    expect(fs.existsSync(upgraded.active.assistantBin)).toBe(true);
  });

  it("never treats an unverified initial executable as a previous verified selection", async () => {
    const fixture = installation();
    await expect(updateCodexInstallation({ ...fixture, targetVersion: "previous" })).rejects.toMatchObject({ code: "no-previous" });
    expect(readCodexSelection(fixture)).toBeNull();
  });

  it.each(["failure", "network", "registry", "verification", "runtime", "wrong-version"])("preserves the selected installation and return target after %s", async mode => {
    const fixture = installation();
    await updateCodexInstallation({ ...fixture, targetVersion: "1.0.0" });
    const before = readCodexSelection(fixture);
    const error = await updateCodexInstallation({ ...fixture, env: { ...fixture.env, TEST_MODE: mode } }).catch(error => error);
    expect(error.usableVersion).toBe("1.0.0");
    expect(error.installedVersion).toBe(mode === "runtime" ? "1.1.0" : null);
    expect(readCodexSelection(fixture)).toEqual(before);
    expect(resolveSelectedCodexBinary(fixture)).toBe(fixture.assistantBin);
    expect(await readCodexVersion(fixture.assistantBin, fixture)).toBe("1.0.0");
  });

  it("leaves the prior manifest and installation intact when atomic activation is interrupted", async () => {
    const fixture = installation();
    await updateCodexInstallation({ ...fixture, targetVersion: "1.0.0" });
    const before = readCodexSelection(fixture);
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith(".cloudx-codex-selection.json")) throw Object.assign(new Error("activation interrupted"), { code: "EACCES" });
      return rename(from, to);
    });
    await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({ code: "permission", installedVersion: "1.1.0", usableVersion: "1.0.0" });
    expect(readCodexSelection(fixture)).toEqual(before);
    expect(await readCodexVersion(fixture.assistantBin, fixture)).toBe("1.0.0");
  });

  it("refuses corrupted persisted selections instead of silently launching another installation", async () => {
    const fixture = installation();
    fs.writeFileSync(path.join(fixture.prefix, ".cloudx-codex-selection.json"), JSON.stringify({ schemaVersion: 1, active: { version: "1.0.0", assistantBin: "/unrelated/bin/codex" }, previous: null }));
    expect(() => resolveSelectedCodexBinary(fixture)).toThrow(/Saved Codex selection/);
    expect(() => readCodexSelection(fixture)).toThrow(/Saved Codex selection/);
  });

  it("does not run fallible temporary-file cleanup after activation or remove the active candidate", async () => {
    const fixture = installation();
    const remove = fs.rmSync;
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target).endsWith(".tmp") && fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-selection.json"))) {
        throw Object.assign(new Error("cleanup after activation must not happen"), { code: "EIO" });
      }
      return remove(target, options);
    });
    await expect(updateCodexInstallation(fixture)).resolves.toMatchObject({ activeVersion: "1.1.0" });
    const selected = readCodexSelection(fixture).active;
    expect(fs.existsSync(selected.assistantBin)).toBe(true);
    expect(await readCodexVersion(selected.assistantBin, fixture)).toBe("1.1.0");
  });

  it("reports the committed active selection accurately if unlocking fails after activation", async () => {
    const fixture = installation();
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
      if (String(target).endsWith(".cloudx-codex-update.lock")) throw Object.assign(new Error("private lock diagnostic"), { code: "EACCES" });
      return unlink(target);
    });
    await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({ code: "permission", installedVersion: "1.1.0", usableVersion: "1.1.0", message: expect.not.stringContaining("private lock diagnostic") });
    expect(await readCodexVersion(readCodexSelection(fixture).active.assistantBin, fixture)).toBe("1.1.0");
    expect(fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock"))).toBe(true);
  });

  it("refuses changed selected package versions and leaves an unrelated shell command alone", async () => {
    const fixture = installation();
    await updateCodexInstallation(fixture);
    const selected = readCodexSelection(fixture).active;
    const manifestPath = path.join(path.dirname(path.dirname(selected.assistantBin)), "lib/node_modules/@openai/codex/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "9.9.9" }));
    expect(() => resolveSelectedCodexBinary(fixture)).toThrow(/selected Codex installation changed/);
    expect(resolveSelectedCodexBinary({ assistantBin: "codex", prefix: fixture.prefix })).toBe("codex");
    expect(resolveSelectedCodexBinary({ assistantBin: "/tools/custom-codex", prefix: fixture.prefix })).toBe("/tools/custom-codex");
    expect(readCodexSelection({ assistantBin: "/tools/custom-codex", prefix: fixture.prefix })).toBeNull();
  });
});
