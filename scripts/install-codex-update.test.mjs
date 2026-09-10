import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUDX_NPM_GLOBAL_DIR,
  InstallerRunner,
  helpText,
  parseArgs,
  runInstaller,
} from "./install-cloudx.mjs";

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
  it("plans only the latest Codex package and version checks without a Git checkout or services", async () => {
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
  it.each(["success", "npm failure", "Codex failure"])(
    "runs the installer with isolated stand-in executables: %s",
    (outcome) => {
      const { root, home, envPath, prefix } = fixture();
      const bin = path.join(root, "tools");
      const commandLog = path.join(root, "commands.log");
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
      fs.symlinkSync(process.execPath, path.join(bin, "node"));
      fs.writeFileSync(
        path.join(bin, "npm"),
        '#!/bin/sh\nprintf "npm %s\\n" "$*" >> "$CLOUDX_TEST_COMMAND_LOG"\nif [ "$1" = i ]; then exit "$CLOUDX_TEST_NPM_STATUS"; fi\n',
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(prefix, "bin/codex"),
        '#!/bin/sh\nprintf "codex %s\\n" "$*" >> "$CLOUDX_TEST_COMMAND_LOG"\nexit "$CLOUDX_TEST_CODEX_STATUS"\n',
        { mode: 0o755 },
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
      expect(result.status).toBe(outcome === "success" ? 0 : 1);
      expect(result.stdout.includes("Codex CLI update complete")).toBe(
        outcome === "success",
      );
      expect(fs.readFileSync(commandLog, "utf8").trim().split("\n")).toEqual([
        "npm -v",
        `npm i -g --prefix ${prefix} @openai/codex@latest`,
        ...(outcome === "npm failure" ? [] : ["codex --version"]),
      ]);
      expect(fs.readFileSync(envPath, "utf8")).toBe(config);
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
