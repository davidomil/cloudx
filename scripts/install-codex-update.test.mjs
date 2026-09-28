import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireCodexInstallationLock } from "./codex-updater.mjs";
import {
  CLOUDX_NPM_GLOBAL_DIR,
  InstallerRunner,
  helpText,
  parseArgs,
  runInstaller,
} from "./install-cloudx.mjs";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal() }));

const scratch = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-codex-update-"));
  scratch.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const envPath = path.join(home, ".config/cloudx/cloudx.env");
  const prefix = path.join(home, CLOUDX_NPM_GLOBAL_DIR);
  const runner = new InstallerRunner({
    dryRun: true,
    cwd: root,
    log: () => {},
  });
  const options = {
    ...parseArgs(["--update-codex", "--dry-run"]),
    repoRoot: root,
    home,
    env: { PATH: "/usr/bin" },
    runner,
    osRelease: { ID: "ubuntu", VERSION_ID: "24.04" },
  };
  return { root, home, envPath, prefix, runner, options };
}

function saveConfig(envPath, content) {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, content);
}

describe("Codex-only update options", () => {
  it("accepts the standalone mode and advertises it in help", () => {
    expect(parseArgs(["--update-codex", "--dry-run", "--yes"])).toMatchObject({
      updateCodex: true,
      update: false,
      dryRun: true,
      yes: true,
    });
    expect(helpText()).toContain("--update-codex");
  });

  it.each([
    ["--update"],
    ["--uninstall"],
    ["--service", "preview.service", "--port", "3002"],
    ["--port", "3002"],
    ["--host", "::1"],
  ])("rejects conflicting options %j", (...args) => {
    expect(() => parseArgs(["--update-codex", ...args])).toThrow();
    expect(() => parseArgs([...args, "--update-codex"])).toThrow();
  });
});

describe("updating only Codex", () => {
  it.each(["saved", "inherited", "default"])("verifies the %s service state locations without rewriting its configuration", async source => {
    const { root, home, prefix, envPath, options } = fixture();
    const packageDir = path.join(prefix, "lib/node_modules/@openai/codex");
    const assistantBin = path.join(prefix, "bin/codex");
    const tools = path.join(root, "tools");
    fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
    fs.mkdirSync(path.dirname(assistantBin), { recursive: true });
    fs.mkdirSync(tools);
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@openai/codex", version: "1.0.0", bin: { codex: "bin/codex.js" } }));
    fs.writeFileSync(path.join(packageDir, "bin/codex.js"), `#!${process.execPath}\nconsole.log('codex-cli 1.0.0');\n`, { mode: 0o700 });
    fs.symlinkSync(path.join(packageDir, "bin/codex.js"), assistantBin);
    fs.writeFileSync(path.join(tools, "npm"), `#!${process.execPath}\nconsole.log(JSON.stringify({ versions: ['1.0.0'], 'dist-tags': { latest: '1.0.0' } }));\n`, { mode: 0o700 });
    const saved = { CODEX_HOME: path.join(root, "saved codex home"), CODEX_SQLITE_HOME: path.join(root, "saved sqlite"), CLOUDX_DATA_DIR: path.join(root, "saved cloudx data") };
    const inherited = { CODEX_HOME: path.join(root, "inherited codex home"), CODEX_SQLITE_HOME: path.join(root, "inherited sqlite"), CLOUDX_DATA_DIR: path.join(root, "inherited cloudx data") };
    const config = [`CLOUDX_ASSISTANT_BIN=${assistantBin}`, "PRIVATE_SETTING=preserved-only-in-config",
      ...Object.entries(source === "saved" ? saved : {}).map(([key, value]) => `${key}='${value}'`), ""].join("\n");
    saveConfig(envPath, config);
    const expected = source === "saved" ? saved : source === "inherited" ? inherited
      : { CODEX_HOME: path.join(home, ".codex"), CLOUDX_DATA_DIR: path.join(root, ".cloudx") };
    let verification;
    const spawn = childProcess.spawn;
    vi.spyOn(childProcess, "spawn").mockImplementation((command, args, childOptions) => {
      const verifier = args?.findIndex(argument => String(argument).endsWith("/codex-runtime-verification.mjs")) ?? -1;
      if (verifier < 0) return spawn(command, args, childOptions);
      verification = { args: args.slice(verifier), env: childOptions.env };
      return spawn(command, [...args.slice(0, verifier), "-e", "process.exit(1)"], childOptions);
    });

    await expect(runInstaller({ ...options, dryRun: false,
      runner: new InstallerRunner({ cwd: root, log: () => {} }),
      env: { HOME: home, PATH: `${tools}:/usr/bin`, ...(source === "default" ? {} : inherited) },
    })).rejects.toThrow("failed CloudX tab launch");

    expect(verification.args).toEqual([path.join(process.cwd(), "scripts/codex-runtime-verification.mjs"), assistantBin,
      "--shared-state-home", expected.CODEX_HOME, "--cloudx-data-dir", expected.CLOUDX_DATA_DIR]);
    expect(verification.env.CODEX_HOME).toBe(source === "default" ? undefined : expected.CODEX_HOME);
    expect(verification.env.CODEX_SQLITE_HOME).toBe(expected.CODEX_SQLITE_HOME);
    expect(verification.env.CLOUDX_DATA_DIR).toBe(expected.CLOUDX_DATA_DIR);
    expect(verification.env.PRIVATE_SETTING).toBeUndefined();
    expect(fs.readFileSync(envPath, "utf8")).toBe(config);
    expect(fs.existsSync(path.join(prefix, ".cloudx-codex-selection.json"))).toBe(false);
  });

  it("plans the latest Codex package and CloudX runtime verification without changing a Git checkout or services", async () => {
    const { options, runner, prefix, envPath } = fixture();
    const result = await runInstaller(options);
    expect(result.assistantBin).toBe(path.join(prefix, "bin/codex"));
    expect(
      runner.commands.map(({ command, args }) => [command, ...args]),
    ).toEqual([
      ["node", "-v"],
      ["npm", "-v"],
      ["npm", "i", "-g", "--prefix", prefix, "@openai/codex@latest"],
      [path.join(prefix, "bin/codex"), "--version"],
      [process.execPath, path.join(process.cwd(), "scripts/codex-runtime-verification.mjs"), path.join(prefix, "bin/codex")],
    ]);
    expect(runner.commands[2].env).toEqual({
      NPM_CONFIG_PREFIX: prefix,
      npm_config_prefix: prefix,
      PATH: `${prefix}/bin:/usr/bin`,
    });
    expect(runner.commands[3].env).toEqual(runner.commands[2].env);
    expect(runner.writes).toEqual([]);
    expect(fs.existsSync(prefix)).toBe(false);
    expect(fs.existsSync(envPath)).toBe(false);
  });

  it.each(["saved executable", "saved prefix", "environment prefix"])(
    "uses the %s and preserves configuration and local files",
    async (source) => {
      const { root, envPath, options, runner } = fixture();
      const prefix = path.join(root, "custom prefix");
      const config = [
        "# keep configuration byte-for-byte",
        "CLOUDX_PORT=not-relevant-to-codex",
        ...(source === "saved executable"
          ? [`CLOUDX_ASSISTANT_BIN='${prefix}/bin/codex'`]
          : source === "saved prefix"
            ? [`CLOUDX_NPM_GLOBAL_DIR='${prefix}'`]
            : []),
        "",
      ].join("\n");
      saveConfig(envPath, config);
      options.env.CLOUDX_NPM_GLOBAL_DIR =
        source === "environment prefix"
          ? prefix
          : path.join(root, "other-prefix");
      const localFile = path.join(root, "local-work");
      fs.writeFileSync(localFile, "uncommitted work");
      const result = await runInstaller(options);
      expect(result.assistantBin).toBe(path.join(prefix, "bin/codex"));
      expect(runner.commands[2].args).toEqual([
        "i",
        "-g",
        "--prefix",
        prefix,
        "@openai/codex@latest",
      ]);
      expect(runner.writes).toEqual([]);
      expect(fs.readFileSync(envPath, "utf8")).toBe(config);
      expect(fs.readFileSync(localFile, "utf8")).toBe("uncommitted work");
    },
  );

  it.each([
    "CLOUDX_ASSISTANT_BIN=codex\n",
    "CLOUDX_ASSISTANT_BIN=/opt/codex-wrapper\n",
    "CLOUDX_ASSISTANT_BIN=\n",
    "CLOUDX_NPM_GLOBAL_DIR=relative-prefix\n",
    "CLOUDX_NPM_GLOBAL_DIR=\n",
  ])(
    "rejects an ambiguous install destination before running commands: %s",
    async (config) => {
      const { envPath, options, runner } = fixture();
      saveConfig(envPath, config);
      await expect(runInstaller(options)).rejects.toThrow(
        /absolute|bin\/codex/,
      );
      expect(runner.commands).toEqual([]);
      expect(runner.writes).toEqual([]);
      expect(fs.readFileSync(envPath, "utf8")).toBe(config);
    },
  );

  it.each(["npm prerequisite", "package update", "Codex version"])(
    "propagates a failed %s without reporting completion",
    async (failure) => {
      const { options, runner } = fixture();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const run = runner.run.bind(runner);
      vi.spyOn(runner, "run").mockImplementation((command, args, env) => {
        run(command, args, env);
        if (
          (failure === "npm prerequisite" &&
            command === "npm" &&
            args[0] === "-v") ||
          (failure === "package update" && args[0] === "i") ||
          (failure === "Codex version" && args[0] === "--version")
        )
          throw new Error(`${failure} failed`);
      });
      await expect(runInstaller(options)).rejects.toThrow(`${failure} failed`);
      expect(log.mock.calls.flat().join("\n")).not.toMatch(/update complete/i);
      expect(runner.commands).toHaveLength(
        failure === "npm prerequisite"
          ? 2
          : failure === "package update"
            ? 3
            : 4,
      );
      expect(runner.writes).toEqual([]);
    },
  );
});

describe("Codex-only CLI entrypoints", () => {
  it.each(["runtime verification failure", "npm failure", "Codex failure"])(
    "runs the installer with isolated stand-in executables: %s",
    (outcome) => {
      const { root, home, envPath, prefix } = fixture();
      const bin = path.join(root, "tools");
      const commandLog = path.join(root, "commands.log");
      const packageDir = path.join(prefix, "lib/node_modules/@openai/codex");
      const manifestPath = path.join(packageDir, "package.json");
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
      fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          name: "@openai/codex",
          version: "1.0.0",
          bin: { codex: "bin/codex.js" },
        }),
      );
      fs.symlinkSync(process.execPath, path.join(bin, "node"));
      fs.symlinkSync(
        execFileSync(
          "python3",
          ["-I", "-S", "-c", "import sys; print(sys.executable)"],
          { encoding: "utf8" },
        ).trim(),
        path.join(bin, "python3"),
      );
      fs.writeFileSync(
        path.join(bin, "npm"),
        `#!${process.execPath}\nconst fs = require('node:fs');
fs.appendFileSync(process.env.CLOUDX_TEST_COMMAND_LOG, 'npm ' + process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === 'view') console.log(JSON.stringify({ versions: ['1.0.0', '1.1.0'], 'dist-tags': { latest: '1.1.0' } }));
else {
  if (Number(process.env.CLOUDX_TEST_NPM_STATUS)) process.exit(Number(process.env.CLOUDX_TEST_NPM_STATUS));
  const path = require('node:path');
  const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
  const packageDir = path.join(prefix, 'lib/node_modules/@openai/codex');
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(manifestPath)}, 'utf8'));
  manifest.version = '1.1.0'; fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(manifest));
  fs.copyFileSync(${JSON.stringify(path.join(packageDir, "bin/codex.js"))}, path.join(packageDir, 'bin/codex.js'));
  fs.symlinkSync(path.join(packageDir, 'bin/codex.js'), path.join(prefix, 'bin/codex'));
}\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(packageDir, "bin/codex.js"),
        `#!${process.execPath}\nconst fs = require('node:fs');
fs.appendFileSync(process.env.CLOUDX_TEST_COMMAND_LOG, 'codex ' + process.argv.slice(2).join(' ') + '\\n');
const version = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../package.json'), 'utf8')).version;
if (version === '1.1.0' && Number(process.env.CLOUDX_TEST_CODEX_STATUS)) process.exit(Number(process.env.CLOUDX_TEST_CODEX_STATUS));
console.log('codex-cli ' + version);\n`,
        { mode: 0o755 },
      );
      fs.symlinkSync(
        path.join(packageDir, "bin/codex.js"),
        path.join(prefix, "bin/codex"),
      );
      const config = `CLOUDX_ASSISTANT_BIN=${prefix}/bin/codex\n`;
      saveConfig(envPath, config);
      const result = spawnSync(
        process.execPath,
        ["scripts/install-cloudx.mjs", "--update-codex"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            HOME: home,
            PATH: bin,
            CLOUDX_TEST_COMMAND_LOG: commandLog,
            CLOUDX_TEST_NPM_STATUS: outcome === "npm failure" ? "23" : "0",
            CLOUDX_TEST_CODEX_STATUS: outcome === "Codex failure" ? "24" : "0",
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("Codex CLI update complete");
      if (outcome === "runtime verification failure") expect(result.stderr).toContain("failed CloudX tab launch");
      const candidateRoot = path.join(prefix, ".cloudx-codex");
      const candidate = path.join(candidateRoot, fs.readdirSync(candidateRoot)[0]);
      expect(fs.readFileSync(commandLog, "utf8").trim().split("\n").filter(line => line.startsWith("npm ") || line === "codex --version")).toEqual([
        "codex --version",
        "npm view @openai/codex versions dist-tags --json",
        `npm i -g --prefix ${candidate} @openai/codex@1.1.0`,
        ...(outcome === "npm failure" ? [] : ["codex --version"]),
      ]);
      expect(fs.readFileSync(envPath, "utf8")).toBe(config);
      expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).version).toBe("1.0.0");
      expect(fs.existsSync(path.join(prefix, ".cloudx-codex-selection.json"))).toBe(false);
    },
  );

  it.each(["shell", "node"])(
    "previews only Codex through the real %s entrypoint",
    (entry) => {
      const { home, envPath, prefix } = fixture();
      const config = `CLOUDX_ASSISTANT_BIN=${prefix}/bin/codex\nCLOUDX_PORT=3443\n`;
      saveConfig(envPath, config);
      const result = spawnSync(
        entry === "shell" ? "bash" : process.execPath,
        [
          entry === "shell" ? "install.sh" : "scripts/install-cloudx.mjs",
          "--update-codex",
          "--dry-run",
          "--yes",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, HOME: home, CLOUDX_NPM_GLOBAL_DIR: prefix },
        },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("@openai/codex@latest");
      expect(result.stdout).toContain(`${prefix}/bin/codex --version`);
      expect(result.stdout).not.toMatch(
        /sudo|apt-get|systemctl|git |npm ci|npm run|python|uv sync|login|write /,
      );
      expect(fs.readFileSync(envPath, "utf8")).toBe(config);
      expect(fs.existsSync(prefix)).toBe(false);
    },
  );

  it.each(["--update", "--uninstall"])(
    "rejects shell mode conflict %s before bootstrap",
    (mode) => {
      const result = spawnSync("bash", ["install.sh", "--update-codex", mode], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--update-codex cannot be combined");
      expect(result.stdout).toBe("");
    },
  );
});

describe("full installer coordination with Codex-only updates", () => {
  it("keeps a verified selection and original dependencies during installer maintenance", async () => {
    const { root, home, prefix } = fixture();
    const assistantBin = path.join(prefix, ".cloudx-codex/pinned/bin/codex");
    const packageDir = path.join(prefix, ".cloudx-codex/pinned/lib/node_modules/@openai/codex");
    fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
    fs.mkdirSync(path.dirname(assistantBin), { recursive: true });
    fs.mkdirSync(path.join(prefix, "lib/node_modules/@openai/codex"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.155.1", bin: { codex: "bin/codex.js" } }));
    fs.writeFileSync(path.join(packageDir, "bin/codex.js"), "pinned executable");
    fs.symlinkSync(path.join(packageDir, "bin/codex.js"), assistantBin);
    fs.writeFileSync(path.join(prefix, "lib/node_modules/@openai/codex/running-dependency"), "original dependencies");
    const selection = JSON.stringify({ schemaVersion: 1, active: { version: "0.155.1", assistantBin }, previous: null });
    fs.writeFileSync(path.join(prefix, ".cloudx-codex-selection.json"), selection);
    const runner = new InstallerRunner({ cwd: root, log: () => {} });
    vi.spyOn(runner, "run").mockReturnValue("");
    vi.spyOn(runner, "capture").mockReturnValue("git version 2.50.0");
    vi.spyOn(runner, "statusOk").mockReturnValue(false);
    await expect(runInstaller({
      repoRoot: root, home, runner, yes: true, answers: { runCodexLogin: false },
      env: { CLOUDX_INSTALL_BOOTSTRAPPED: "1", PATH: "/usr/bin" },
      osRelease: { ID: "ubuntu", VERSION_ID: "24.04" },
      gpuDetected: false, intelGpuDetected: false, cudaRuntimeReady: false,
    })).rejects.toThrow("Codex must be authenticated");
    expect(runner.run.mock.calls.map(([command, args]) => [command, ...args])).toEqual([
      ["node", "-v"], ["npm", "-v"], [assistantBin, "--version"]
    ]);
    expect(fs.readFileSync(path.join(prefix, ".cloudx-codex-selection.json"), "utf8")).toBe(selection);
    expect(fs.readFileSync(assistantBin, "utf8")).toBe("pinned executable");
    expect(fs.readFileSync(path.join(prefix, "lib/node_modules/@openai/codex/running-dependency"), "utf8")).toBe("original dependencies");
    expect(fs.existsSync(path.join(prefix, ".cloudx-codex-update.lock"))).toBe(false);
  });

  it.each(["busy", "failed install"])(
    "honors the same installation lock: %s",
    async (outcome) => {
      const { root, home, prefix } = fixture();
      const runner = new InstallerRunner({ cwd: root, log: () => {} });
      vi.spyOn(runner, "run").mockImplementation((command, args) => {
        if (command === "npm" && args[0] === "i")
          throw new Error("fixture npm failure");
        return "";
      });
      vi.spyOn(runner, "capture").mockReturnValue("git version 2.50.0");
      const release =
        outcome === "busy" ? acquireCodexInstallationLock(prefix) : null;
      try {
        await expect(
          runInstaller({
            repoRoot: root,
            home,
            runner,
            yes: true,
            env: { CLOUDX_INSTALL_BOOTSTRAPPED: "1", PATH: "/usr/bin" },
            osRelease: { ID: "ubuntu", VERSION_ID: "24.04" },
            gpuDetected: false,
            intelGpuDetected: false,
            cudaRuntimeReady: false,
          }),
        ).rejects.toThrow(
          outcome === "busy"
            ? /Another CloudX installer/
            : /fixture npm failure/,
        );
        expect(
          runner.run.mock.calls.some(
            ([command, args]) => command === "npm" && args[0] === "i",
          ),
        ).toBe(outcome !== "busy");
        expect(
          fs.existsSync(path.join(prefix, ".cloudx-codex-update.lock")),
        ).toBe(outcome === "busy");
      } finally {
        release?.();
      }
    },
  );
});
