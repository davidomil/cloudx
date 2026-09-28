import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireCodexInstallationLock,
  listCodexReleases,
  readCodexVersion,
  resolveCodexInstallation,
  updateCodexInstallation,
} from "./codex-updater.mjs";
import { readCodexSelection, resolveSelectedCodexCommand, isExactCodexVersion } from "./codex-selection.mjs";

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
  console.log(mode === 'registry' ? 'bad json' : JSON.stringify({versions: ['0.9.0', '1.0.0', '1.1.0', '1.2.0-rc.1'], 'dist-tags': {latest: mode === 'prerelease-latest' ? '1.2.0-rc.1' : '1.1.0'}}));
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
  const packageDir = path.join(prefix, 'lib/node_modules/@openai/codex');
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(packageDir, "package.json"))}, 'utf8'));
  manifest.version = mode === 'wrong-version' ? '1.0.1' : process.argv.at(-1).slice('@openai/codex@'.length);
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(manifest));
  fs.copyFileSync(${JSON.stringify(path.join(packageDir, "bin/codex.js"))}, path.join(packageDir, 'bin/codex.js'));
  fs.symlinkSync(path.join(packageDir, 'bin/codex.js'), path.join(prefix, 'bin/codex'));
  if (mode === 'escaped-success') {
    const descendant = spawn(process.execPath, ['-e', 'const fs = require("node:fs"); fs.appendFileSync(process.env.TEST_WRITES, "x"); setInterval(() => fs.appendFileSync(process.env.TEST_WRITES, "x"), 10)'], {detached: true, stdio: 'ignore'});
    fs.writeFileSync(process.env.TEST_CHILD, String(descendant.pid));
    descendant.unref();
    const written = setInterval(() => {
      if (fs.existsSync(process.env.TEST_WRITES)) clearInterval(written);
    }, 10);
  }
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
  it("discovers published releases in version order and labels prereleases", async () => {
    const fixture = installation();
    await expect(listCodexReleases(fixture)).resolves.toEqual({
      latestStable: "1.1.0",
      versions: [
        { version: "1.2.0-rc.1", prerelease: true },
        { version: "1.1.0", prerelease: false },
        { version: "1.0.0", prerelease: false },
        { version: "0.9.0", prerelease: false },
      ],
    });
    await expect(listCodexReleases({ ...fixture, env: { ...fixture.env, TEST_MODE: "prerelease-latest" } })).rejects.toMatchObject({ code: "installation" });
  });

  it.each(["^1.0.0", "1.x", "01.0.0", "1.0.0-01", "1.0.0-", "1.0.0+", "1.0.0\n", "1.0.0\r", "@other/package", "https://example.com/package", "./local", "1.0.0; echo unsafe"])("rejects a non-exact selection before invoking npm: %s", async targetVersion => {
    const fixture = installation();
    expect(isExactCodexVersion(targetVersion)).toBe(false);
    await expect(updateCodexInstallation({ ...fixture, targetVersion })).rejects.toMatchObject({ code: "invalid-version" });
    expect(fs.existsSync(fixture.env.TEST_LOG)).toBe(false);
    expect(readCodexSelection(fixture.prefix)).toBeNull();
  });

  it("rejects an unpublished exact version before installing or activating", async () => {
    const fixture = installation();
    await expect(updateCodexInstallation({ ...fixture, targetVersion: "9.9.9" })).rejects.toMatchObject({ code: "unpublished-version", usableVersion: "1.0.0" });
    expect(commands(fixture)).toHaveLength(1);
    expect(readCodexSelection(fixture.prefix)).toBeNull();
    expect(fs.existsSync(path.join(fixture.prefix, ".cloudx-codex"))).toBe(false);
  });

  it("pins an exact downgrade, preserves both installations, and explicitly returns to the previous verified version", async () => {
    const fixture = installation();
    const originalPackage = fs.readFileSync(path.join(fixture.packageDir, "package.json"), "utf8");
    const targets = [], installed = [];
    const options = { ...fixture, onTarget: version => targets.push(version), onInstalled: version => installed.push(version) };
    await expect(updateCodexInstallation({ ...options, targetVersion: "1.0.0" })).resolves.toEqual({ outcome: "current", installedVersion: "1.0.0", activeVersion: "1.0.0", previousVersion: null });
    await expect(updateCodexInstallation({ ...options, targetVersion: "0.9.0" })).resolves.toEqual({ outcome: "updated", installedVersion: "0.9.0", activeVersion: "0.9.0", previousVersion: "1.0.0" });
    const downgraded = readCodexSelection(fixture.prefix);
    expect(resolveSelectedCodexCommand(fixture.assistantBin)).toBe(downgraded.active.assistantBin);
    expect(downgraded.previous).toEqual({ version: "1.0.0", assistantBin: fixture.assistantBin });
    expect(fs.readFileSync(path.join(fixture.packageDir, "package.json"), "utf8")).toBe(originalPackage);
    await expect(updateCodexInstallation({ ...options, targetVersion: "1.0.0" })).resolves.toEqual({ outcome: "updated", installedVersion: "1.0.0", activeVersion: "1.0.0", previousVersion: "0.9.0" });
    expect(commands(fixture).filter(args => args[0] === "i")).toHaveLength(1);
    expect(fs.existsSync(downgraded.active.assistantBin)).toBe(true);
    expect(targets).toEqual(["1.0.0", "0.9.0", "1.0.0"]);
    expect(installed).toEqual(targets);
    expect(resolveSelectedCodexCommand(fixture.assistantBin)).toBe(fixture.assistantBin);
  });

  it("selects prereleases only through an exact explicit request", async () => {
    const fixture = installation();
    await updateCodexInstallation({ ...fixture, targetVersion: "1.2.0-rc.1" });
    expect(readCodexSelection(fixture.prefix).active.version).toBe("1.2.0-rc.1");
    expect(commands(fixture).at(-1).at(-1)).toBe("@openai/codex@1.2.0-rc.1");
  });

  it("verifies shared Codex state and retained CloudX homes before activation", async () => {
    const fixture = installation();
    const codexHome = path.join(fixture.root, "codex state");
    const cloudxData = path.join(fixture.root, "cloudx data");
    await updateCodexInstallation({ ...fixture, env: { ...fixture.env, CODEX_HOME: codexHome, CLOUDX_DATA_DIR: cloudxData } });
    const verifier = childProcess.spawn.mock.calls.find(([, args]) => args.some(argument => String(argument).endsWith("/codex-runtime-verification.mjs")));
    expect(verifier[1].slice(-4)).toEqual(["--shared-state-home", codexHome, "--cloudx-data-dir", cloudxData]);
  });

  it("checks the verified active binary against candidate-migrated state before switching", async () => {
    const fixture = installation();
    await updateCodexInstallation({ ...fixture, targetVersion: "1.0.0" });
    await updateCodexInstallation({ ...fixture, targetVersion: "1.1.0" });
    const verifiers = childProcess.spawn.mock.calls.filter(([, args]) => args.some(argument => String(argument).endsWith("/codex-runtime-verification.mjs")));
    expect(verifiers.at(-1)[1].slice(-2)).toEqual(["--previous-bin", fixture.assistantBin]);
  });

  it.each(["", " \t"])("uses the launch default shared state when CODEX_HOME is blank %j", async codexHome => {
    const fixture = installation();
    await updateCodexInstallation({ ...fixture, env: { ...fixture.env, HOME: fixture.root, CODEX_HOME: codexHome, CLOUDX_DATA_DIR: undefined } });
    const verifier = childProcess.spawn.mock.calls.find(([, args]) => args.some(argument => String(argument).endsWith("/codex-runtime-verification.mjs")));
    expect(verifier[1].slice(-2)).toEqual(["--shared-state-home", path.join(fixture.root, ".codex")]);
  });

  it("cancels candidate verification without changing the persisted active version", async () => {
    const fixture = installation();
    await updateCodexInstallation({ ...fixture, targetVersion: "1.0.0" });
    const before = readCodexSelection(fixture.prefix);
    const controller = new AbortController();
    await expect(updateCodexInstallation({ ...fixture, signal: controller.signal, onInstalled: () => controller.abort() })).rejects.toMatchObject({ code: "cancelled", usableVersion: "1.0.0" });
    expect(readCodexSelection(fixture.prefix)).toEqual(before);
  });

  it.each(["network", "failure", "verification", "wrong-version", "runtime"])("keeps a verified selected installation intact after candidate %s failure", async mode => {
    const fixture = installation();
    await updateCodexInstallation({ ...fixture, targetVersion: "1.0.0" });
    const manifestPath = path.join(fixture.prefix, ".cloudx-codex-selection.json");
    const before = fs.readFileSync(manifestPath, "utf8");
    const installed = [];
    await expect(updateCodexInstallation({ ...fixture, env: { ...fixture.env, TEST_MODE: mode }, onInstalled: version => installed.push(version) })).rejects.toMatchObject({ usableVersion: "1.0.0" });
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
    expect(resolveSelectedCodexCommand(fixture.assistantBin)).toBe(fixture.assistantBin);
    expect(installed).toEqual(mode === "runtime" ? ["1.1.0"] : mode === "wrong-version" ? ["1.0.1"] : []);
  });

  it("preserves the old atomic selection if activation cannot rename its prepared manifest", async () => {
    const fixture = installation();
    await updateCodexInstallation({ ...fixture, targetVersion: "1.0.0" });
    const before = readCodexSelection(fixture.prefix);
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === path.join(fixture.prefix, ".cloudx-codex-selection.json")) throw Object.assign(new Error("EACCES private path"), { code: "EACCES" });
      return rename(source, destination);
    });
    await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({ code: "permission", usableVersion: "1.0.0" });
    expect(readCodexSelection(fixture.prefix)).toEqual(before);
    expect(fs.readdirSync(fixture.prefix).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each(["1.0.0", "1.1.0"])("reports the selected version if lock release fails after verification (original %s)", async version => {
    const fixture = installation({ version });
    const lock = path.join(fixture.prefix, ".cloudx-codex-update.lock");
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
      if (file === lock) throw Object.assign(new Error("EACCES private lock path"), { code: "EACCES" });
      return unlink(file);
    });
    await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({
      code: "lock-release", usableVersion: "1.1.0",
      message: expect.stringContaining("Codex 1.1.0 is selected for new launches"),
    });
    expect(readCodexSelection(fixture.prefix).active.version).toBe("1.1.0");
    expect(await readCodexVersion(resolveSelectedCodexCommand(fixture.assistantBin), fixture)).toBe("1.1.0");
    expect(fs.existsSync(lock)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.packageDir, "package.json"), "utf8")).version).toBe(version);
  });

  it("uses a saved selection through prefix aliases and leaves unrelated commands alone", async () => {
    const fixture = installation();
    await updateCodexInstallation(fixture);
    const alias = path.join(fixture.root, "prefix-alias");
    fs.symlinkSync(fixture.prefix, alias);
    expect(resolveSelectedCodexCommand(path.join(alias, "bin/codex"))).toBe(readCodexSelection(fixture.prefix).active.assistantBin);
    expect(resolveSelectedCodexCommand("codex")).toBe("codex");
    expect(resolveSelectedCodexCommand("/opt/custom-wrapper")).toBe("/opt/custom-wrapper");
    expect(resolveSelectedCodexCommand(path.join(fixture.root, "unrelated/bin/codex"))).toBe(path.join(fixture.root, "unrelated/bin/codex"));
  });

  it.each(["invalid-json", "version", "outside-prefix", "traversal", "missing", "symlinked-install", "symlinked-entrypoint"])("rejects a malformed or unavailable saved selection: %s", async mode => {
    const fixture = installation();
    await updateCodexInstallation(fixture);
    const selection = readCodexSelection(fixture.prefix);
    if (mode === "version") selection.active.version = "1.0.0";
    if (mode === "outside-prefix") selection.active.assistantBin = "/tmp/other/bin/codex";
    if (mode === "traversal") selection.active.assistantBin = path.join(fixture.prefix, ".cloudx-codex") + "/../bin/codex";
    if (mode === "missing") fs.unlinkSync(selection.active.assistantBin);
    if (mode === "symlinked-entrypoint") {
      const entrypoint = fs.realpathSync(selection.active.assistantBin);
      const outside = path.join(fixture.root, "outside-wrapper");
      fs.renameSync(entrypoint, outside);
      fs.symlinkSync(outside, entrypoint);
    }
    if (mode === "symlinked-install") {
      const location = path.dirname(path.dirname(selection.active.assistantBin));
      const moved = path.join(fixture.root, "moved");
      fs.renameSync(location, moved);
      fs.symlinkSync(moved, location);
    }
    fs.writeFileSync(path.join(fixture.prefix, ".cloudx-codex-selection.json"), mode === "invalid-json" ? "{" : JSON.stringify(selection));
    expect(() => resolveSelectedCodexCommand(fixture.assistantBin)).toThrow(/saved Codex selection/);
  });

  it.each(["oversized", "symlink", "directory"])("rejects an unsafe selection file before following or parsing it: %s", mode => {
    const fixture = installation();
    const manifestPath = path.join(fixture.prefix, ".cloudx-codex-selection.json");
    if (mode === "oversized") fs.writeFileSync(manifestPath, " ".repeat(64 * 1024 + 1));
    if (mode === "symlink") fs.symlinkSync(path.join(fixture.packageDir, "package.json"), manifestPath);
    if (mode === "directory") fs.mkdirSync(manifestPath);
    expect(() => readCodexSelection(fixture.prefix)).toThrow(/saved Codex selection/);
  });

  it("acknowledges version completion before the supervisor exits and removes its receipts", async () => {
    const fixture = installation();
    const diagnostics = path.join(fixture.root, "diagnostics");
    fixture.env.CLOUDX_TERMINAL_DIAGNOSTICS_DIR = diagnostics;

    await expect(readCodexVersion(fixture.assistantBin, fixture)).resolves.toBe("1.0.0");

    const launch = childProcess.spawn.mock.calls.find(([, args]) => args[2]?.endsWith("terminal-supervisor.py"));
    expect(launch).toBeDefined();
    expect(fs.existsSync(launch[1][3])).toBe(false);
    const retained = fs.readdirSync(diagnostics);
    expect(retained).toHaveLength(1);
    const evidence = JSON.parse(fs.readFileSync(path.join(diagnostics, retained[0], "lifecycle.json"), "utf8"));
    expect(evidence.events).toContainEqual(expect.objectContaining({ phase: "receipt-acknowledged" }));
    expect(evidence.events.at(-1).phase).toBe("ephemeral-receipts-removed");
    expect(fs.existsSync(`/proc/${evidence.pid}`)).toBe(false);
  });

  it("does not launch npm installation when its receipt watcher cannot be created", async () => {
    const fixture = installation({ mode: "escaped-silent" });
    const watch = fs.watch;
    const directories = [];
    vi.spyOn(fs, "watch").mockImplementation((directory, listener) => {
      directories.push(directory);
      if (directories.length === 3)
        throw Object.assign(new Error("ENOSPC private watcher path"), { code: "ENOSPC" });
      return watch(directory, listener);
    });

    try {
      await expect(updateCodexInstallation(fixture)).rejects.toMatchObject({
        code: "supervision-unavailable",
        usableVersion: "1.0.0",
        message: expect.stringContaining("filesystem watch limits"),
      });
      expect(commands(fixture)).toEqual([["view", "@openai/codex", "versions", "dist-tags", "--json"]]);
      expect(fs.existsSync(fixture.env.TEST_CHILD)).toBe(false);
      expect(fs.existsSync(fixture.env.TEST_WRITES)).toBe(false);
      expect(directories).toHaveLength(3);
      for (const directory of directories) expect(fs.existsSync(directory)).toBe(false);
      const release = acquireCodexInstallationLock(fixture.prefix);
      release();
    } finally {
      await finishFixtureSupervisors();
    }
  });

  it("stops an installation writer and retains its lock when receipt observation fails", async () => {
    const fixture = installation({ mode: "escaped-silent" });
    const watch = fs.watch;
    const watchers = [];
    vi.spyOn(fs, "watch").mockImplementation((directory, listener) => {
      const watcher = watch(directory, listener);
      watchers.push({ directory, watcher });
      return watcher;
    });
    const result = updateCodexInstallation(fixture).catch(error => error);
    try {
      await vi.waitFor(() => expect(fs.statSync(fixture.env.TEST_WRITES).size).toBeGreaterThan(0));
      expect(watchers).toHaveLength(3);
      const installationWatcher = watchers[2];
      installationWatcher.watcher.close();
      installationWatcher.watcher.emit("error", new Error("private observation failure"));

      expect(await result).toMatchObject({
        code: "cleanup-incomplete",
        message: expect.not.stringContaining("private observation failure"),
      });
      const pid = Number(fs.readFileSync(fixture.env.TEST_CHILD, "utf8"));
      expect(fs.existsSync(`/proc/${pid}`)).toBe(false);
      const bytes = fs.statSync(fixture.env.TEST_WRITES).size;
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(fs.statSync(fixture.env.TEST_WRITES).size).toBe(bytes);
      expect(() => acquireCodexInstallationLock(fixture.prefix)).toThrow(/Another CloudX installer/);
      expect(fs.existsSync(path.join(installationWatcher.directory, "complete.json"))).toBe(true);
    } finally {
      await finishFixtureSupervisors();
      await result;
      for (const { directory } of watchers) expect(fs.existsSync(directory)).toBe(false);
    }
  });

  it("completes updates and reaps detached writers when receipt notifications omit filenames", async () => {
    const fixture = installation({ mode: "escaped-success" });
    const watch = fs.watch;
    const directories = [];
    vi.spyOn(fs, "watch").mockImplementation((directory, listener) => {
      directories.push(directory);
      return watch(directory, event => listener(event, null));
    });

    try {
      await expect(updateCodexInstallation({ ...fixture, timeoutMs: 3_000 })).resolves.toMatchObject({
        outcome: "updated",
        installedVersion: "1.1.0",
      });
      const pid = Number(fs.readFileSync(fixture.env.TEST_CHILD, "utf8"));
      expect(fs.statSync(fixture.env.TEST_WRITES).size).toBeGreaterThan(0);
      expect(fs.existsSync(`/proc/${pid}`)).toBe(false);
      for (const directory of directories) expect(fs.existsSync(directory)).toBe(false);
      const release = acquireCodexInstallationLock(fixture.prefix);
      release();
      fs.rmSync(fixture.root, { recursive: true });
      expect(fs.existsSync(fixture.root)).toBe(false);
    } finally {
      await finishFixtureSupervisors();
    }
  });

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
      activeVersion: "1.1.0",
      previousVersion: null,
    });
    expect(stages).toEqual(["checking", "updating", "verifying"]);
    const selected = readCodexSelection(fixture.prefix).active.assistantBin;
    expect(selected).not.toBe(fixture.assistantBin);
    expect(fs.readFileSync(fixture.env.TEST_RUNTIME_LOG, "utf8")).toBe(`${selected}\n`);
    expect(commands(fixture)).toEqual([
      ["view", "@openai/codex", "versions", "dist-tags", "--json"],
      ["i", "-g", "--prefix", path.dirname(path.dirname(selected)), "@openai/codex@1.1.0"],
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
    expect(error).toMatchObject({ code: "runtime-verification", usableVersion: version, message: expect.stringMatching(/CloudX tab launch.*private update log/) });
    expect(error.message).not.toContain("SECRET-TOKEN");
    expect(output.join("")).toContain("SECRET-TOKEN: selected conversation was not saved");
    expect(fs.readFileSync(fixture.env.TEST_RUNTIME_LOG, "utf8")).toContain(version === "1.1.0" ? fixture.assistantBin : ".cloudx-codex/1.1.0-");
    expect(fs.readFileSync(fixture.env.TEST_VERSION_LOG, "utf8").trim().split("\n")).toHaveLength(version === "1.1.0" ? 1 : 2);
    expect(fs.existsSync(path.join(fixture.prefix, ".cloudx-codex-update.lock"))).toBe(false);
  });

  it("reaps candidate verifier descendants on timeout and preserves the active CLI", async () => {
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
          usableVersion: null,
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

async function finishFixtureSupervisors() {
  for (const [index, [, args]] of childProcess.spawn.mock.calls.entries()) {
    if (!args[2]?.endsWith("terminal-supervisor.py")) continue;
    const child = childProcess.spawn.mock.results[index].value;
    if (!child?.pid || !fs.existsSync(`/proc/${child.pid}`)) continue;
    const directory = args[3];
    child.kill("SIGTERM");
    await vi.waitFor(() => expect(fs.existsSync(path.join(directory, "complete.json"))).toBe(true));
    fs.writeFileSync(path.join(directory, "acknowledged.json"), JSON.stringify({ pid: child.pid }));
    await vi.waitFor(() => expect(fs.existsSync(`/proc/${child.pid}`)).toBe(false));
    expect(fs.existsSync(directory)).toBe(false);
  }
}
